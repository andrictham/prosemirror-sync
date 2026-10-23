/// <reference types="vite/client" />

import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { getConvexSize } from "convex/values";
import schema from "./schema.js";
import { api } from "./_generated/api.js";

const modules = import.meta.glob("./**/*.*s");
const maxPageSteps = 6_144;
const maxPageBytes = 6 * 1_024 * 1_024;
const utf8 = new TextEncoder();

function setup() {
  return convexTest({ schema, modules, transactionLimits: true });
}

function stepBytes(steps: string[]) {
  return steps.reduce((bytes, step) => bytes + utf8.encode(step).byteLength, 0);
}

function numberedSteps(start: number, count: number) {
  return Array.from({ length: count }, (_, index) => `step-${start + index}`);
}

function largeStep(index: number) {
  return `${index.toString().padStart(2, "0")}:${"é".repeat(449_000)}`;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("bounded history pages", () => {
  test("bounds complete query and rebase responses when client IDs expand per step", async () => {
    const t = setup();
    const id = "expanded-client-ids";
    const clientId = "é".repeat(900);
    const expected = numberedSteps(0, 4_000);
    for (let index = 0; index < 4; index++) {
      await t.run(async (ctx) => {
        await ctx.db.insert("deltas", {
          id,
          version: (index + 1) * 1_000,
          clientId,
          steps: expected.slice(index * 1_000, (index + 1) * 1_000),
        });
      });
    }

    const queried: string[] = [];
    let version = 0;
    let pages = 0;
    while (version < 4_000) {
      const page = await t.query(api.lib.getSteps, { id, version });
      expect(page.steps.length).toBeGreaterThan(0);
      expect(page.steps.length).toBeLessThanOrEqual(maxPageSteps);
      expect(stepBytes(page.steps)).toBeLessThanOrEqual(maxPageBytes);
      expect(getConvexSize(page)).toBeLessThanOrEqual(maxPageBytes);
      expect(page.clientIds.length).toBe(page.steps.length);
      expect(page.clientIds.every((value) => value === clientId)).toBe(true);
      queried.push(...page.steps);
      version = page.version;
      pages++;
    }
    expect(pages).toBeGreaterThan(1);
    expect(queried).toEqual(expected);

    const rebased: string[] = [];
    version = 0;
    while (version < 4_000) {
      const result = await t.mutation(api.lib.submitSteps, {
        id,
        version,
        clientId: "writer",
        steps: ["local"],
      });
      if (result.status !== "needs-rebase") {
        throw new Error("Stale writer was accepted before all foreign steps");
      }
      expect(result.steps.length).toBeGreaterThan(0);
      expect(result.steps.length).toBeLessThanOrEqual(maxPageSteps);
      expect(stepBytes(result.steps)).toBeLessThanOrEqual(maxPageBytes);
      expect(getConvexSize(result)).toBeLessThanOrEqual(maxPageBytes);
      expect(result.clientIds.length).toBe(result.steps.length);
      expect(result.clientIds.every((value) => value === clientId)).toBe(true);
      rebased.push(...result.steps);
      version += result.steps.length;
    }
    expect(rebased).toEqual(expected);
  });

  test("returns two 5000-step submissions once in order with their clients", async () => {
    const t = setup();
    const id = "step-pages";
    const expected = numberedSteps(0, 10_000);
    for (let batch = 0; batch < 2; batch++) {
      expect(
        await t.mutation(api.lib.submitSteps, {
          id,
          version: batch * 5_000,
          clientId: `client-${batch}`,
          steps: expected.slice(batch * 5_000, (batch + 1) * 5_000),
        }),
      ).toEqual({ status: "synced" });
    }

    const received: string[] = [];
    const clients: (string | number)[] = [];
    const pageLengths: number[] = [];
    let version = 0;
    while (version < expected.length) {
      const page = await t.query(api.lib.getSteps, { id, version });
      expect(page.steps.length).toBeGreaterThan(0);
      expect(page.steps.length).toBeLessThanOrEqual(maxPageSteps);
      expect(stepBytes(page.steps)).toBeLessThanOrEqual(maxPageBytes);
      expect(page.version).toBe(version + page.steps.length);
      received.push(...page.steps);
      clients.push(...page.clientIds);
      pageLengths.push(page.steps.length);
      version = page.version;
    }
    expect(pageLengths).toEqual([5_000, 5_000]);
    expect(received).toEqual(expected);
    expect(clients).toEqual([
      ...Array.from({ length: 5_000 }, () => "client-0"),
      ...Array.from({ length: 5_000 }, () => "client-1"),
    ]);
    expect(await t.query(api.lib.getSteps, { id, version })).toEqual({
      steps: [],
      clientIds: [],
      version: 10_000,
    });
  });

  test("pages 19 near-limit UTF-8 records without exceeding transaction reads", async () => {
    const t = setup();
    const id = "byte-pages";
    // Each fixture row is its own transaction; the setup also obeys read/write limits.
    for (let index = 0; index < 19; index++) {
      await t.run(async (ctx) => {
        await ctx.db.insert("deltas", {
          id,
          version: index + 1,
          clientId: index,
          steps: [largeStep(index)],
        });
      });
    }

    const labels: string[] = [];
    const clients: (string | number)[] = [];
    let version = 0;
    let pages = 0;
    while (version < 19) {
      const page = await t.query(api.lib.getSteps, { id, version });
      expect(page.steps.length).toBeGreaterThan(0);
      expect(page.steps.length).toBeLessThanOrEqual(maxPageSteps);
      expect(stepBytes(page.steps)).toBeLessThanOrEqual(maxPageBytes);
      expect(
        page.steps.every((step, index) => step === largeStep(version + index)),
      ).toBe(true);
      expect(page.version).toBe(version + page.steps.length);
      labels.push(...page.steps.map((step) => step.slice(0, 3)));
      clients.push(...page.clientIds);
      version = page.version;
      pages++;
    }
    expect(pages).toBeGreaterThan(1);
    expect(labels).toEqual(
      Array.from(
        { length: 19 },
        (_, index) => `${index.toString().padStart(2, "0")}:`,
      ),
    );
    expect(clients).toEqual(Array.from({ length: 19 }, (_, index) => index));
  });

  test("a stale writer rebases bounded prefixes and converges at the advanced version", async () => {
    const t = setup();
    const id = "stale-writer";
    const expected = numberedSteps(0, 10_000);
    for (let batch = 0; batch < 2; batch++) {
      await t.mutation(api.lib.submitSteps, {
        id,
        version: batch * 5_000,
        clientId: `foreign-${batch}`,
        steps: expected.slice(batch * 5_000, (batch + 1) * 5_000),
      });
    }

    const received: string[] = [];
    const clients: (string | number)[] = [];
    let version = 0;
    const statuses: string[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const result = await t.mutation(api.lib.submitSteps, {
        id,
        version,
        clientId: "writer",
        steps: ["writer-step"],
      });
      statuses.push(result.status);
      if (result.status === "synced") break;
      expect(result.steps.length).toBeGreaterThan(0);
      expect(result.steps.length).toBeLessThanOrEqual(maxPageSteps);
      expect(stepBytes(result.steps)).toBeLessThanOrEqual(maxPageBytes);
      received.push(...result.steps);
      clients.push(...result.clientIds);
      version += result.steps.length;
    }
    expect(statuses).toEqual(["needs-rebase", "needs-rebase", "synced"]);
    expect(received).toEqual(expected);
    expect(clients).toEqual([
      ...Array.from({ length: 5_000 }, () => "foreign-0"),
      ...Array.from({ length: 5_000 }, () => "foreign-1"),
    ]);
    expect(await t.query(api.lib.getSteps, { id, version })).toEqual({
      steps: ["writer-step"],
      clientIds: ["writer"],
      version: 10_001,
    });
  });

  test("slices the first record at the requested version", async () => {
    const t = setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("deltas", {
        id: "slice",
        version: 3,
        clientId: "first",
        steps: ["a", "b", "c"],
      });
      await ctx.db.insert("deltas", {
        id: "slice",
        version: 4,
        clientId: "second",
        steps: ["d"],
      });
    });
    expect(
      await t.query(api.lib.getSteps, { id: "slice", version: 1 }),
    ).toEqual({
      steps: ["b", "c", "d"],
      clientIds: ["first", "first", "second"],
      version: 4,
    });
  });

  test("a stale submit inside the first record rebases only its unseen suffix", async () => {
    const t = setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("deltas", {
        id: "rebase-slice",
        version: 3,
        clientId: "first",
        steps: ["a", "b", "c"],
      });
      await ctx.db.insert("deltas", {
        id: "rebase-slice",
        version: 4,
        clientId: "second",
        steps: ["d"],
      });
    });
    expect(
      await t.mutation(api.lib.submitSteps, {
        id: "rebase-slice",
        version: 1,
        clientId: "writer",
        steps: ["local"],
      }),
    ).toEqual({
      status: "needs-rebase",
      steps: ["b", "c", "d"],
      clientIds: ["first", "first", "second"],
    });
  });

  test("a stale writer pages byte-heavy history before its own submission is accepted", async () => {
    const t = setup();
    const id = "byte-rebase";
    for (let index = 0; index < 19; index++) {
      await t.run(async (ctx) => {
        await ctx.db.insert("deltas", {
          id,
          version: index + 1,
          clientId: index,
          steps: [largeStep(index)],
        });
      });
    }

    const receivedClients: (string | number)[] = [];
    const statuses: string[] = [];
    let version = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await t.mutation(api.lib.submitSteps, {
        id,
        version,
        clientId: "writer",
        steps: ["writer-step"],
      });
      statuses.push(result.status);
      if (result.status === "synced") break;
      expect(result.steps.length).toBeGreaterThan(0);
      expect(result.steps.length).toBeLessThanOrEqual(maxPageSteps);
      expect(stepBytes(result.steps)).toBeLessThanOrEqual(maxPageBytes);
      expect(
        result.steps.every(
          (step, index) => step === largeStep(version + index),
        ),
      ).toBe(true);
      receivedClients.push(...result.clientIds);
      version += result.steps.length;
    }
    expect(statuses).toEqual([
      "needs-rebase",
      "needs-rebase",
      "needs-rebase",
      "synced",
    ]);
    expect(receivedClients).toEqual(
      Array.from({ length: 19 }, (_, index) => index),
    );
    expect(await t.query(api.lib.getSteps, { id, version })).toEqual({
      steps: ["writer-step"],
      clientIds: ["writer"],
      version: 20,
    });
  });

  test("preserves Missing steps when the first record starts after the requested version", async () => {
    const t = setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("deltas", {
        id: "gap",
        version: 5,
        clientId: "client",
        steps: ["d", "e"],
      });
    });
    await expect(
      t.query(api.lib.getSteps, { id: "gap", version: 1 }),
    ).rejects.toThrow("Missing steps 2...3");
  });
});

describe("bounded history deletion", () => {
  test.each([
    {
      budget: "steps",
      records: 3,
      stepsPerRecord: 5_000,
      firstDeletedRecords: 2,
      cursor: 10_000,
    },
    {
      budget: "bytes",
      records: 19,
      stepsPerRecord: 1,
      firstDeletedRecords: 8,
      cursor: 8,
    },
  ])(
    "continues after the $budget budget using the last walked and deleted row",
    async ({
      budget,
      records,
      stepsPerRecord,
      firstDeletedRecords,
      cursor,
    }) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const t = setup();
      const id = `delete-${budget}`;
      for (let index = 0; index < records; index++) {
        await t.run(async (ctx) => {
          await ctx.db.insert("deltas", {
            id,
            version: (index + 1) * stepsPerRecord,
            clientId: "client",
            steps:
              budget === "bytes"
                ? [largeStep(index)]
                : numberedSteps(index * stepsPerRecord, stepsPerRecord),
          });
        });
      }

      await t.mutation(api.lib.deleteSteps, {
        id,
        beforeTs: 2_000,
        deleteNewerThanLatestSnapshot: true,
      });
      const remaining = await t.run(async (ctx) =>
        (await ctx.db.query("deltas").collect()).map((row) => row.version),
      );
      expect(remaining).toEqual(
        Array.from(
          { length: records - firstDeletedRecords },
          (_, index) => (index + firstDeletedRecords + 1) * stepsPerRecord,
        ),
      );
      const scheduled = await t.run((ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      );
      expect(scheduled.map((job) => job.args)).toEqual([
        [
          {
            id,
            beforeTs: 2_000,
            afterVersion: cursor,
            deleteNewerThanLatestSnapshot: true,
          },
        ],
      ]);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await t.run((ctx) => ctx.db.query("deltas").collect())).toEqual(
        [],
      );
      const jobs = await t.run((ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      );
      expect(jobs.every((job) => job.state.kind === "success")).toBe(true);
    },
  );

  test("continues after 100 records and preserves rows at the timestamp cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const t = setup();
    const id = "record-deletion";
    await t.run(async (ctx) => {
      for (let version = 1; version <= 205; version++) {
        await ctx.db.insert("deltas", {
          id,
          version,
          clientId: "client",
          steps: [String(version)],
        });
      }
    });
    vi.setSystemTime(2_000);
    const cutoff = await t.run(async (ctx) => {
      const rowId = await ctx.db.insert("deltas", {
        id,
        version: 206,
        clientId: "client",
        steps: ["retained"],
      });
      return (await ctx.db.get("deltas", rowId))?._creationTime;
    });
    if (cutoff === undefined) throw new Error("Missing cutoff fixture");
    await t.mutation(api.lib.deleteSteps, {
      id,
      beforeTs: cutoff,
      deleteNewerThanLatestSnapshot: true,
    });
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled.map((job) => job.args)).toEqual([
      [
        {
          id,
          beforeTs: cutoff,
          afterVersion: 100,
          deleteNewerThanLatestSnapshot: true,
        },
      ],
    ]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      await t.run(async (ctx) =>
        (await ctx.db.query("deltas").collect()).map((row) => row.version),
      ),
    ).toEqual([206]);
    const jobs = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(jobs.map((job) => job.state.kind)).toEqual(["success", "success"]);
  });

  test("stops at the first ineligible record without scheduling another walk", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const t = setup();
    await t.run(async (ctx) => {
      for (let version = 1; version <= 110; version++) {
        await ctx.db.insert("deltas", {
          id: "cutoff",
          version,
          clientId: "client",
          steps: [String(version)],
        });
      }
    });
    await t.mutation(api.lib.deleteSteps, {
      id: "cutoff",
      beforeTs: 0,
      deleteNewerThanLatestSnapshot: true,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      await t.run((ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      ),
    ).toEqual([]);
    expect(
      await t.run(
        async (ctx) => (await ctx.db.query("deltas").collect()).length,
      ),
    ).toBe(110);
  });

  test("clamps deletion to the latest snapshot unless explicitly overridden", async () => {
    vi.useFakeTimers();
    const t = setup();
    vi.setSystemTime(1_000);
    await t.run(async (ctx) => {
      await ctx.db.insert("deltas", {
        id: "snapshot-cutoff",
        version: 1,
        clientId: "client",
        steps: ["old"],
      });
    });
    vi.setSystemTime(2_000);
    await t.mutation(api.lib.submitSnapshot, {
      id: "snapshot-cutoff",
      version: 1,
      content: "snapshot",
    });
    vi.setSystemTime(3_000);
    await t.run(async (ctx) => {
      await ctx.db.insert("deltas", {
        id: "snapshot-cutoff",
        version: 2,
        clientId: "client",
        steps: ["new"],
      });
    });
    await t.mutation(api.lib.deleteSteps, {
      id: "snapshot-cutoff",
      beforeTs: 4_000,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      await t.run(async (ctx) =>
        (await ctx.db.query("deltas").collect()).map((row) => row.version),
      ),
    ).toEqual([2]);
    await t.mutation(api.lib.deleteSteps, {
      id: "snapshot-cutoff",
      beforeTs: 4_000,
      deleteNewerThanLatestSnapshot: true,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.query("deltas").collect())).toEqual([]);
  });
});
