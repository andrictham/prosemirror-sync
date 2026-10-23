import { ConvexError, getConvexSize, getDocumentSize, v } from "convex/values";
import {
  mutation,
  type MutationCtx,
  query,
  type QueryCtx,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { vClientId } from "./schema";
import { api } from "./_generated/api";

// Each returned array has its own 8,192-element limit. Keep 2,048 elements of
// headroom while allowing the app's whole 5,000-step submissions to fit.
const MAX_HISTORY_PAGE_STEPS = 6_144;
// Count full stored rows, not just returned steps. The 6 MiB target plus one
// maximum Convex document (1 MiB) of lookahead and a 6 MiB response stays below
// 16 MiB, leaving room for callers' other work. Expanded clientIds count toward
// the response target too, since each stored ID is repeated for every step.
const MAX_HISTORY_PAGE_BYTES = 6 * 1024 * 1024;
// Cover the query/rebase response's object fields and array framing.
const HISTORY_RESPONSE_OVERHEAD_BYTES = 128;
// Independently bound scans, including histories containing empty delta rows.
const MAX_HISTORY_PAGE_RECORDS = 100;
const MAX_SNAPSHOT_FETCH = 10;

export const submitSnapshot = mutation({
  args: {
    id: v.string(),
    version: v.number(),
    content: v.string(),
    pruneSnapshots: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("snapshots")
      .withIndex("id_version", (q) =>
        q.eq("id", args.id).eq("version", args.version),
      )
      .first();
    if (existing) {
      if (existing.content === args.content) {
        return;
      }
      throw new Error(
        `Snapshot ${args.id} at version ${args.version} already exists ` +
          `with different content: ${existing.content} !== ${args.content}`,
      );
    }
    await ctx.db.insert("snapshots", {
      id: args.id,
      version: args.version,
      content: args.content,
    });
    if (args.version > 1 && args.pruneSnapshots) {
      // Delete all older snapshots, except the original one.
      await deleteSnapshotsHelper(ctx, {
        id: args.id,
        afterVersion: 1,
        beforeVersion: args.version,
      });
    }
  },
});

export const latestVersion = query({
  args: { id: v.string() },
  returns: v.union(v.null(), v.number()),
  handler: async (ctx, args) => {
    const latestDelta = await ctx.db
      .query("deltas")
      .withIndex("id_version", (q) => q.eq("id", args.id))
      .order("desc")
      .first();
    if (latestDelta) {
      return latestDelta.version;
    }
    const latestSnapshot = await ctx.db
      .query("snapshots")
      .withIndex("id_version", (q) => q.eq("id", args.id))
      .order("desc")
      .first();
    return latestSnapshot?.version ?? null;
  },
});

export const submitSteps = mutation({
  args: {
    id: v.string(),
    version: v.number(),
    clientId: vClientId,
    steps: v.array(v.string()),
  },
  returns: v.union(
    v.object({
      status: v.literal("needs-rebase"),
      clientIds: v.array(vClientId),
      steps: v.array(v.string()),
    }),
    v.object({ status: v.literal("synced") }),
  ),
  handler: async (ctx, args) => {
    if (args.steps.length > MAX_HISTORY_PAGE_STEPS) {
      throw new ConvexError(
        "Step submission exceeds history page limit of 6,144 steps",
      );
    }
    const delta = {
      id: args.id,
      version: args.version + args.steps.length,
      clientId: args.clientId,
      steps: args.steps,
    };
    // Whole-record paging must always admit its first record to make progress.
    // Validate before reading history, even for a stale writer, so no newly
    // accepted record can exceed either the read or expanded response budget.
    if (
      getDocumentSize(delta) > MAX_HISTORY_PAGE_BYTES ||
      HISTORY_RESPONSE_OVERHEAD_BYTES + historyResponseBytes(delta) >
        MAX_HISTORY_PAGE_BYTES
    ) {
      throw new ConvexError(
        "Step submission exceeds history page limit of 6 MiB",
      );
    }
    const [steps, clientIds] = await fetchSteps(ctx, args.id, args.version);
    if (steps.length > 0) {
      return { status: "needs-rebase", clientIds, steps } as const;
    }
    await ctx.db.insert("deltas", delta);
    return { status: "synced" } as const;
  },
});

function stepsAndClientIds(deltas: Doc<"deltas">[]) {
  const clientIds = [];
  const steps = [];
  for (const delta of deltas) {
    for (const step of delta.steps) {
      clientIds.push(delta.clientId);
      steps.push(step);
    }
  }
  return [steps, clientIds] as const;
}

function historyResponseBytes(
  delta: Pick<Doc<"deltas">, "steps" | "clientId">,
) {
  return (
    getConvexSize(delta.steps) +
    getConvexSize(delta.clientId) * delta.steps.length
  );
}

export const getSnapshot = query({
  args: { id: v.string(), version: v.optional(v.number()) },
  returns: v.union(
    v.object({
      content: v.null(),
    }),
    v.object({
      content: v.string(),
      version: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const snapshot = await ctx.db
      .query("snapshots")
      .withIndex("id_version", (q) =>
        q.eq("id", args.id).lte("version", args.version ?? Infinity),
      )
      .order("desc")
      .first();
    if (!snapshot) {
      return {
        content: null,
      };
    }
    return {
      content: snapshot.content,
      version: snapshot.version,
    };
  },
});

/**
 * Read a whole-record prefix. submitSteps bounds each new record to 6,144
 * steps and 6 MiB of stored and expanded response data, including repeated
 * client IDs and response framing. A first record is always included so paging
 * makes progress. Records written before admission checks must also satisfy
 * these limits; reading cannot repair an already-stored oversized record.
 */
async function readHistoryPage(
  ctx: QueryCtx,
  id: string,
  afterVersion: number,
) {
  const deltas: Doc<"deltas">[] = [];
  let steps = 0;
  let bytesRead = 0;
  let responseBytes = HISTORY_RESPONSE_OVERHEAD_BYTES;
  const history = ctx.db
    .query("deltas")
    .withIndex("id_version", (q) => q.eq("id", id).gt("version", afterVersion));
  for await (const delta of history) {
    // Even the row rejected at the boundary has been read in full. Its bytes
    // consume the one-document reserve; slicing the first row cannot save IO.
    bytesRead += getConvexSize(delta);
    const deltaResponseBytes = historyResponseBytes(delta);
    if (
      deltas.length > 0 &&
      (steps + delta.steps.length > MAX_HISTORY_PAGE_STEPS ||
        bytesRead > MAX_HISTORY_PAGE_BYTES ||
        responseBytes + deltaResponseBytes > MAX_HISTORY_PAGE_BYTES)
    ) {
      break;
    }
    deltas.push(delta);
    steps += delta.steps.length;
    responseBytes += deltaResponseBytes;
    if (
      deltas.length >= MAX_HISTORY_PAGE_RECORDS ||
      steps >= MAX_HISTORY_PAGE_STEPS ||
      bytesRead >= MAX_HISTORY_PAGE_BYTES ||
      responseBytes >= MAX_HISTORY_PAGE_BYTES
    ) {
      break;
    }
  }
  return deltas;
}

async function fetchSteps(ctx: QueryCtx, id: string, afterVersion: number) {
  const deltas = await readHistoryPage(ctx, id, afterVersion);
  if (deltas.length > 0) {
    const firstDelta = deltas[0];
    if (firstDelta.version - firstDelta.steps.length > afterVersion) {
      throw new Error(
        `Missing steps ${afterVersion + 1}...${
          firstDelta.version - firstDelta.steps.length
        }`,
      );
    } else if (firstDelta.version - firstDelta.steps.length < afterVersion) {
      firstDelta.steps = firstDelta.steps.slice(
        afterVersion - (firstDelta.version - firstDelta.steps.length),
      );
    }
  }
  return stepsAndClientIds(deltas);
}

export const getSteps = query({
  args: { id: v.string(), version: v.number() },
  returns: v.object({
    steps: v.array(v.string()),
    clientIds: v.array(vClientId),
    version: v.number(),
  }),
  handler: async (ctx, args) => {
    const [steps, clientIds] = await fetchSteps(ctx, args.id, args.version);
    return { steps, clientIds, version: args.version + steps.length };
  },
});

/**
 * Delete snapshots in the given range, not including the bounds.
 * To clean up old snapshots, call this with the current version as the
 * beforeVersion and the first version (1) as the afterVersion.
 */
export const deleteSnapshots = mutation({
  args: {
    id: v.string(),
    afterVersion: v.optional(v.number()),
    beforeVersion: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await deleteSnapshotsHelper(ctx, args);
  },
});

async function deleteSnapshotsHelper(
  ctx: MutationCtx,
  args: { id: string; afterVersion?: number; beforeVersion?: number },
) {
  const versions = await ctx.db
    .query("snapshots")
    .withIndex("id_version", (q) => {
      const eq = q.eq("id", args.id);
      const after =
        args.afterVersion !== undefined
          ? eq.gt("version", args.afterVersion)
          : eq;
      const before =
        args.beforeVersion !== undefined
          ? after.lt("version", args.beforeVersion)
          : after;
      return before;
    })
    .take(MAX_SNAPSHOT_FETCH);
  await Promise.all(versions.map((doc) => ctx.db.delete("snapshots", doc._id)));
  if (versions.length === MAX_SNAPSHOT_FETCH) {
    await ctx.scheduler.runAfter(0, api.lib.deleteSnapshots, {
      id: args.id,
      beforeVersion: args.beforeVersion,
      afterVersion: versions[versions.length - 1].version,
    });
  }
}

/**
 * Delete steps before some timestamp.
 * To clean up old steps, call this with a date in the past for beforeTs.
 * By default it will ensure that all steps are older than the latest snapshot.
 */
export const deleteSteps = mutation({
  args: {
    id: v.string(),
    afterVersion: v.optional(v.number()),
    beforeTs: v.number(),
    deleteNewerThanLatestSnapshot: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    let beforeTs = args.beforeTs;
    if (!args.deleteNewerThanLatestSnapshot) {
      const latestSnapshot = await ctx.db
        .query("snapshots")
        .withIndex("id_version", (q) => q.eq("id", args.id))
        .order("desc")
        .first();
      if (latestSnapshot) {
        beforeTs = Math.min(beforeTs, latestSnapshot._creationTime);
      }
    }
    const history = ctx.db
      .query("deltas")
      .withIndex("id_version", (q) =>
        q.eq("id", args.id).gt("version", args.afterVersion ?? -Infinity),
      );
    let records = 0;
    let steps = 0;
    let bytesRead = 0;
    for await (const delta of history) {
      // Creation times and versions increase together per document, so the
      // first ineligible row ends the eligible prefix. Never reschedule it.
      if (delta._creationTime >= beforeTs) {
        break;
      }
      bytesRead += getConvexSize(delta);
      records++;
      steps += delta.steps.length;
      await ctx.db.delete("deltas", delta._id);
      // Unlike a returned page, deletion consumes the crossing row too. Every
      // walked row has now been deleted, so this cursor cannot skip a row.
      // Reads/writes stay below 6 MiB + one 1 MiB document, with at most 100
      // rows. No large array is returned, so the step threshold may overshoot
      // by one whole record as well.
      if (
        records >= MAX_HISTORY_PAGE_RECORDS ||
        steps >= MAX_HISTORY_PAGE_STEPS ||
        bytesRead >= MAX_HISTORY_PAGE_BYTES
      ) {
        await ctx.scheduler.runAfter(0, api.lib.deleteSteps, {
          id: args.id,
          beforeTs,
          afterVersion: delta.version,
          // Preserve the timestamp already clamped to the latest snapshot.
          deleteNewerThanLatestSnapshot: true,
        });
        break;
      }
    }
  },
});

/**
 * Delete a document and all its snapshots & steps.
 */
export const deleteDocument = mutation({
  args: { id: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runMutation(api.lib.deleteSnapshots, { id: args.id });
    await ctx.scheduler.runAfter(0, api.lib.deleteSteps, {
      id: args.id,
      beforeTs: Infinity,
      deleteNewerThanLatestSnapshot: true,
    });
  },
});
