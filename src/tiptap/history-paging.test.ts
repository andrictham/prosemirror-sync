/// <reference types="vite/client" />

import { describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import type { FunctionArgs } from "convex/server";
import { getConvexSize } from "convex/values";
import type { Editor } from "@tiptap/core";
import { Schema } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { Step } from "@tiptap/pm/transform";
import type { ConvexReactClient } from "convex/react";
import * as collab from "prosemirror-collab";
import { api } from "../component/_generated/api.js";
import componentSchema from "../component/schema.js";
import type { SyncApi } from "../client/index.js";
import { _flushPendingSteps, syncExtension } from "./index.js";

const syncApi = api.lib as unknown as SyncApi;
const modules = import.meta.glob("../component/**/*.*s");
const utf8 = new TextEncoder();
const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
});

function stateAt(version: number, clientID = "me") {
  return EditorState.create({
    schema,
    plugins: [collab.collab({ version, clientID })],
  });
}

function insert(text: string, position: number) {
  return JSON.stringify({
    stepType: "replace",
    from: position,
    to: position,
    slice: { content: [{ type: "text", text }] },
  });
}

function provider(convex: ConvexReactClient, id: string) {
  let state = stateAt(1);
  const editor = {
    get state() {
      return state;
    },
    schema,
    isDestroyed: false,
    view: {
      dispatch(transaction: Transaction) {
        state = state.apply(transaction);
      },
    },
  } as unknown as Editor;
  const errors: Error[] = [];
  const extension = syncExtension(
    convex,
    id,
    syncApi,
    { initialVersion: 1, initialContent: state.doc.toJSON() },
    { warnOnUnsyncedClose: false, onSyncError: (error) => errors.push(error) },
  );
  const config = extension.config as unknown as {
    onCreate: (this: { editor: Editor }) => void;
    onDestroy: (this: { editor: Editor }) => void;
  };
  return {
    get state() {
      return state;
    },
    errors,
    start: () => config.onCreate.call({ editor }),
    destroy: () => config.onDestroy.call({ editor }),
  };
}

describe("history page catch-up", () => {
  test("reconstructs real component pages without another watch notification", async () => {
    const t = convexTest({
      schema: componentSchema,
      modules,
      transactionLimits: true,
    });
    const id = "real-catch-up";
    const text = Array.from({ length: 105 }, (_, index) =>
      String.fromCharCode(65 + (index % 26)),
    ).join("");
    await t.run(async (ctx) => {
      await ctx.db.insert("snapshots", {
        id,
        version: 1,
        content: JSON.stringify(stateAt(1).doc.toJSON()),
      });
      for (let index = 0; index < text.length; index++) {
        await ctx.db.insert("deltas", {
          id,
          version: index + 2,
          clientId: "other",
          steps: [insert(text[index], index + 1)],
        });
      }
    });
    const head = await t.query(api.lib.latestVersion, { id });
    const requestedVersions: number[] = [];
    const convex = {
      watchQuery: () => ({
        localQueryResult: () => head,
        onUpdate: () => () => {},
      }),
      query: (
        _reference: unknown,
        args: FunctionArgs<typeof api.lib.getSteps>,
      ) => {
        requestedVersions.push(args.version);
        return t.query(api.lib.getSteps, args);
      },
    } as unknown as ConvexReactClient;
    const harness = provider(convex, id);
    try {
      harness.start();
      await vi.waitFor(() =>
        expect(collab.getVersion(harness.state)).toBe(106),
      );
      expect(harness.state.doc.textContent).toBe(text);
      expect(requestedVersions).toEqual([1, 101]);
      expect(harness.errors).toEqual([]);
    } finally {
      harness.destroy();
    }
  });

  test("terminates an empty component page when the watched head is ahead", async () => {
    const t = convexTest({
      schema: componentSchema,
      modules,
      transactionLimits: true,
    });
    const id = "empty-page";
    await t.mutation(api.lib.submitSnapshot, {
      id,
      version: 1,
      content: JSON.stringify(stateAt(1).doc.toJSON()),
    });
    const requestedVersions: number[] = [];
    let completeQuery = () => {};
    const queryCompleted = new Promise<void>((resolve) => {
      completeQuery = resolve;
    });
    const convex = {
      watchQuery: () => ({
        localQueryResult: () => 2,
        onUpdate: () => () => {},
      }),
      query: async (
        _reference: unknown,
        args: FunctionArgs<typeof api.lib.getSteps>,
      ) => {
        requestedVersions.push(args.version);
        if (requestedVersions.length > 1)
          throw new Error("Retried a terminal empty page");
        const page = await t.query(api.lib.getSteps, args);
        completeQuery();
        return page;
      },
    } as unknown as ConvexReactClient;
    const harness = provider(convex, id);
    vi.useFakeTimers();
    try {
      harness.start();
      await queryCompleted;
      await vi.advanceTimersByTimeAsync(0);
      expect(requestedVersions).toEqual([1]);
      expect(collab.getVersion(harness.state)).toBe(1);
      expect(harness.state.doc.textContent).toBe("");
      expect(harness.errors).toEqual([]);
    } finally {
      harness.destroy();
      vi.useRealTimers();
    }
  });

  test("continues a short page while more server history remains", async () => {
    let state = stateAt(1);
    const requestedVersions: number[] = [];
    const history = ["a", "b", "c", "d"].map((text, index) =>
      insert(text, index + 1),
    );
    const convex = {
      watchQuery: () => ({
        localQueryResult: () => 5,
        onUpdate: () => () => {},
      }),
      query: async (_reference: unknown, args: { version: number }) => {
        requestedVersions.push(args.version);
        const steps = history.slice(args.version - 1, args.version);
        return {
          steps,
          clientIds: steps.map(() => "other"),
          version: args.version + steps.length,
        };
      },
    } as unknown as ConvexReactClient;
    const editor = {
      get state() {
        return state;
      },
      schema,
      isDestroyed: false,
      view: {
        dispatch(transaction: Transaction) {
          state = state.apply(transaction);
        },
      },
    } as unknown as Editor;
    const errors: Error[] = [];
    const extension = syncExtension(
      convex,
      "doc",
      syncApi,
      { initialVersion: 1, initialContent: state.doc.toJSON() },
      {
        warnOnUnsyncedClose: false,
        onSyncError: (error) => errors.push(error),
      },
    );
    const config = extension.config as unknown as {
      onCreate: (this: { editor: Editor }) => void;
      onDestroy: (this: { editor: Editor }) => void;
    };
    try {
      config.onCreate.call({ editor });
      await vi.waitFor(() => expect(collab.getVersion(state)).toBe(5));
      expect(state.doc.textContent).toBe("abcd");
      expect(requestedVersions).toEqual([1, 2, 3, 4]);
      expect(errors).toEqual([]);
    } finally {
      config.onDestroy.call({ editor });
    }
  });

  test("skips concurrent receipts relative to each page's requested version", async () => {
    let state = stateAt(1);
    const history = [insert("a", 1), insert("b", 2), insert("c", 3)];
    const requestedVersions: number[] = [];
    const convex = {
      watchQuery: () => ({
        localQueryResult: () => 4,
        onUpdate: () => () => {},
      }),
      query: async (_reference: unknown, args: { version: number }) => {
        requestedVersions.push(args.version);
        if (args.version === 2) {
          // Another receipt advances the live state while this page is in flight.
          state = state.apply(
            collab.receiveTransaction(
              state,
              [Step.fromJSON(schema, JSON.parse(history[1]))],
              ["other"],
            ),
          );
        }
        const steps = history.slice(
          args.version - 1,
          args.version === 1 ? 1 : 3,
        );
        return {
          steps,
          clientIds: steps.map(() => "other"),
          version: args.version + steps.length,
        };
      },
    } as unknown as ConvexReactClient;
    const editor = {
      get state() {
        return state;
      },
      schema,
      isDestroyed: false,
      view: {
        dispatch(transaction: Transaction) {
          state = state.apply(transaction);
        },
      },
    } as unknown as Editor;
    const errors: Error[] = [];
    const extension = syncExtension(
      convex,
      "doc",
      syncApi,
      { initialVersion: 1, initialContent: state.doc.toJSON() },
      {
        warnOnUnsyncedClose: false,
        onSyncError: (error) => errors.push(error),
      },
    );
    const config = extension.config as unknown as {
      onCreate: (this: { editor: Editor }) => void;
      onDestroy: (this: { editor: Editor }) => void;
    };
    try {
      config.onCreate.call({ editor });
      await vi.waitFor(() => expect(collab.getVersion(state)).toBe(4));
      expect(state.doc.textContent).toBe("abc");
      expect(requestedVersions).toEqual([1, 2]);
      expect(errors).toEqual([]);
    } finally {
      config.onDestroy.call({ editor });
    }
  });
});

test("destroyed flush preserves local edits beyond 20 advancing rebase pages", async () => {
  const initial = stateAt(1);
  const state = initial.apply(initial.tr.insertText("mine", 1));
  const accepted: { steps: string[]; clientIds: (string | number)[] } = {
    steps: [],
    clientIds: [],
  };
  const history = Array.from({ length: 25 }, (_, index) =>
    insert("x", index + 1),
  );
  const requestedVersions: number[] = [];
  const convex = {
    mutation: async (
      _reference: unknown,
      args: { version: number; steps: string[]; clientId: string | number },
    ) => {
      requestedVersions.push(args.version);
      if (args.version <= history.length) {
        return {
          status: "needs-rebase",
          steps: [history[args.version - 1]],
          clientIds: ["other"],
        };
      }
      accepted.steps.push(...args.steps);
      accepted.clientIds.push(...args.steps.map(() => args.clientId));
      return { status: "synced" };
    },
  } as unknown as ConvexReactClient;

  expect(await _flushPendingSteps(convex, syncApi, "doc", state)).toBe(
    "flushed",
  );
  expect(requestedVersions).toEqual(
    Array.from({ length: 26 }, (_, i) => i + 1),
  );
  let rebuilt = initial;
  for (const serialized of [...history, ...accepted.steps]) {
    rebuilt = rebuilt.apply(
      rebuilt.tr.step(Step.fromJSON(schema, JSON.parse(serialized))),
    );
  }
  expect(rebuilt.doc.textContent).toBe(`${"x".repeat(25)}mine`);
  expect(accepted.clientIds).toEqual(["me"]);
});

test("destroyed flush preserves every foreign step and local edit across 21 real component pages", async () => {
  const t = convexTest({
    schema: componentSchema,
    modules,
    transactionLimits: true,
  });
  const id = "real-destroyed-flush";
  const initial = stateAt(1);
  const state = initial.apply(initial.tr.insertText("mine", 1));
  const foreignText = Array.from({ length: 2_100 }, (_, index) =>
    String.fromCharCode(65 + (index % 26)),
  ).join("");
  const foreignSteps = [...foreignText].map((text, index) =>
    insert(text, index + 1),
  );
  await t.run(async (ctx) => {
    await ctx.db.insert("snapshots", {
      id,
      version: 1,
      content: JSON.stringify(initial.doc.toJSON()),
    });
    for (let index = 0; index < foreignSteps.length; index++) {
      await ctx.db.insert("deltas", {
        id,
        version: index + 2,
        clientId: "other",
        steps: [foreignSteps[index]],
      });
    }
  });
  const requestedVersions: number[] = [];
  const convex = {
    mutation: (
      _reference: unknown,
      args: FunctionArgs<typeof api.lib.submitSteps>,
    ) => {
      requestedVersions.push(args.version);
      return t.mutation(api.lib.submitSteps, args);
    },
  } as unknown as ConvexReactClient;
  expect(await _flushPendingSteps(convex, syncApi, id, state)).toBe("flushed");
  expect(requestedVersions).toEqual(
    Array.from({ length: 22 }, (_, index) => 1 + index * 100),
  );

  let rebuilt = initial;
  let version = 1;
  const received: string[] = [];
  const clients: (string | number)[] = [];
  while (version < 2_102) {
    const page = await t.query(api.lib.getSteps, { id, version });
    expect(page.steps.length).toBeGreaterThan(0);
    expect(page.steps.length).toBeLessThanOrEqual(6_144);
    expect(
      page.steps.reduce(
        (bytes, step) => bytes + utf8.encode(step).byteLength,
        0,
      ),
    ).toBeLessThanOrEqual(6 * 1_024 * 1_024);
    expect(getConvexSize(page)).toBeLessThanOrEqual(6 * 1_024 * 1_024);
    for (const serialized of page.steps) {
      rebuilt = rebuilt.apply(
        rebuilt.tr.step(Step.fromJSON(schema, JSON.parse(serialized))),
      );
    }
    received.push(...page.steps);
    clients.push(...page.clientIds);
    expect(page.version).toBe(version + page.steps.length);
    version = page.version;
  }
  expect(received.slice(0, 2_100)).toEqual(foreignSteps);
  expect(received.length).toBe(2_101);
  expect(clients).toEqual([
    ...Array.from({ length: 2_100 }, () => "other"),
    "me",
  ]);
  expect(rebuilt.doc.textContent).toBe(`${foreignText}mine`);
  expect(version).toBe(2_102);
});

test.each([
  { foreignRounds: 101, localSteps: 1, outcome: "gave-up", accepted: 0 },
  { foreignRounds: 99, localSteps: 1_001, outcome: "gave-up", accepted: 1_000 },
  { foreignRounds: 98, localSteps: 1_001, outcome: "flushed", accepted: 1_001 },
])(
  "destroyed flush stops at 100 total submissions with $foreignRounds competing edits and $localSteps local steps",
  async ({ foreignRounds, localSteps, outcome, accepted }) => {
    const t = convexTest({
      schema: componentSchema,
      modules,
      transactionLimits: true,
    });
    const id = "competing-destroyed-flush";
    const initial = stateAt(1);
    let state = initial;
    for (let index = 0; index < localSteps; index++) {
      state = state.apply(state.tr.insertText("m", 1));
    }
    await t.mutation(api.lib.submitSnapshot, {
      id,
      version: 1,
      content: JSON.stringify(initial.doc.toJSON()),
    });
    const requestedVersions: number[] = [];
    const responses: string[] = [];
    let serverVersion = 1;
    let foreignCalls = 0;
    const convex = {
      mutation: async (
        _reference: unknown,
        args: FunctionArgs<typeof api.lib.submitSteps>,
      ) => {
        requestedVersions.push(args.version);
        // A finite foreign writer makes each local request stale. Every
        // rebase still advances through nonempty, production-owned history.
        if (
          foreignCalls < foreignRounds &&
          (localSteps === 1 || requestedVersions.length > 1)
        ) {
          const foreign = await t.mutation(api.lib.submitSteps, {
            id,
            version: serverVersion,
            clientId: "other",
            steps: [insert("x", 1)],
          });
          expect(foreign.status).toBe("synced");
          foreignCalls++;
          serverVersion++;
        }
        const result = await t.mutation(api.lib.submitSteps, args);
        if (result.status === "synced") serverVersion += args.steps.length;
        if (result.status === "needs-rebase") {
          expect(result.steps).toHaveLength(1);
          expect(result.clientIds).toEqual(["other"]);
        }
        responses.push(result.status);
        return result;
      },
    } as unknown as ConvexReactClient;

    expect(await _flushPendingSteps(convex, syncApi, id, state)).toBe(outcome);
    expect(requestedVersions).toHaveLength(100);
    expect(responses.filter((status) => status === "synced")).toHaveLength(
      Math.ceil(accepted / 1_000),
    );

    let rebuilt = initial;
    let version = 1;
    const clientIds: (string | number)[] = [];
    const foreignAccepted = Math.min(
      foreignRounds,
      localSteps === 1 ? 100 : 99,
    );
    while (version < 1 + foreignAccepted + accepted) {
      const page = await t.query(api.lib.getSteps, { id, version });
      expect(page.steps.length).toBeGreaterThan(0);
      for (const serialized of page.steps) {
        rebuilt = rebuilt.apply(
          rebuilt.tr.step(Step.fromJSON(schema, JSON.parse(serialized))),
        );
      }
      clientIds.push(...page.clientIds);
      version = page.version;
    }
    expect(rebuilt.doc.textContent).toBe(
      `${"x".repeat(foreignAccepted)}${"m".repeat(accepted)}`,
    );
    expect(clientIds.filter((clientId) => clientId === "other")).toHaveLength(
      foreignAccepted,
    );
    expect(clientIds.filter((clientId) => clientId === "me")).toHaveLength(
      accepted,
    );
  },
);
