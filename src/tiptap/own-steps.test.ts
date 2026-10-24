/// <reference types="vite/client" />

import { describe, expect, test, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import type { ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import type { Editor } from "@tiptap/core";
import { Schema } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { Step } from "@tiptap/pm/transform";
import * as collab from "prosemirror-collab";
import { api } from "../component/_generated/api.js";
import componentSchema from "../component/schema.js";
import type { SyncApi } from "../client/index.js";
import { _flushPendingSteps, syncExtension } from "./index.js";

const syncApi = api.lib as unknown as SyncApi;
const modules = import.meta.glob("../component/**/*.*s");
const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
});

type Backend = TestConvex<typeof componentSchema>;

function stateAt(version: number, clientID: string | number) {
  return EditorState.create({
    schema,
    plugins: [collab.collab({ version, clientID })],
  });
}

function typeText(state: EditorState, text: string) {
  return state.apply(state.tr.insertText(text, 1));
}

function stepsJSON(state: EditorState) {
  return collab
    .sendableSteps(state)!
    .steps.map((step) => JSON.stringify(step.toJSON()));
}

async function seedSnapshot(t: Backend, id: string) {
  await t.mutation(api.lib.submitSnapshot, {
    id,
    version: 1,
    content: JSON.stringify(stateAt(1, "seed").doc.toJSON()),
  });
}

async function serverText(t: Backend, id: string) {
  let rebuilt = stateAt(1, "reader");
  let version = 1;
  const clientIds: (string | number)[] = [];
  for (;;) {
    const page = await t.query(api.lib.getSteps, { id, version });
    if (page.steps.length === 0) break;
    for (const serialized of page.steps) {
      rebuilt = rebuilt.apply(
        rebuilt.tr.step(Step.fromJSON(schema, JSON.parse(serialized))),
      );
    }
    clientIds.push(...page.clientIds);
    version = page.version;
  }
  return { text: rebuilt.doc.textContent, version, clientIds };
}

/**
 * A Convex client over a real component backend, with a live latest-version
 * watch. `hold` can keep chosen `submitSteps` calls in flight.
 */
function client(
  t: Backend,
  id: string,
  hold: (call: number) => Promise<void> = () => Promise.resolve(),
  watchedHead = 1,
) {
  let head: number | null = watchedHead;
  let calls = 0;
  const listeners = new Set<() => void>();
  const submitted: { clientId: string | number; status: string }[] = [];
  const convex = {
    watchQuery: () => ({
      localQueryResult: () => head,
      onUpdate: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }),
    query: (_reference: unknown, args: { id: string; version: number }) =>
      t.query(api.lib.getSteps, args),
    mutation: async (
      reference: SyncApi["submitSteps"],
      args: {
        id: string;
        version: number;
        clientId: string | number;
        steps: string[];
      },
    ) => {
      if (getFunctionName(reference) !== getFunctionName(syncApi.submitSteps)) {
        return null;
      }
      await hold(++calls);
      const result = await t.mutation(api.lib.submitSteps, args);
      submitted.push({ clientId: args.clientId, status: result.status });
      head = await t.query(api.lib.latestVersion, { id });
      for (const listener of [...listeners]) listener();
      return result;
    },
  } as unknown as ConvexReactClient;
  return { convex, submitted };
}

/** A live editor stand-in, driven through the extension's lifecycle hooks. */
function editorFor(
  convex: ConvexReactClient,
  id: string,
  initial: EditorState,
) {
  let state = initial;
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
    { initialVersion: 1, initialContent: initial.doc.toJSON() },
    {
      warnOnUnsyncedClose: false,
      snapshotDebounceMs: 60_000,
      onSyncError: (error) => errors.push(error),
    },
  );
  const hooks = extension.config as unknown as {
    onCreate: (this: { editor: Editor }) => void;
    onDestroy: (this: { editor: Editor }) => void;
  };
  return {
    get state() {
      return state;
    },
    errors,
    start: () => hooks.onCreate.call({ editor }),
    destroy: () => hooks.onDestroy.call({ editor }),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("own-step confirmation by content", () => {
  test("two editors under one client ID keep both writers' steps and converge", async () => {
    const t = convexTest(componentSchema, modules);
    const id = "shared-client";
    await seedSnapshot(t, id);
    const first = deferred();
    const second = deferred();
    // Hold the first two submissions, one from each editor, both at v1.
    const { convex, submitted } = client(t, id, (call) =>
      call === 1
        ? first.promise
        : call === 2
          ? second.promise
          : Promise.resolve(),
    );
    const winner = editorFor(convex, id, typeText(stateAt(1, "shared"), "aaa"));
    // The loser has a tail beyond the step the server will mistake for its own.
    const loser = editorFor(
      convex,
      id,
      typeText(typeText(stateAt(1, "shared"), "b2"), "b1"),
    );
    try {
      winner.start();
      loser.start();
      first.resolve();
      await vi.waitFor(() => expect(collab.getVersion(winner.state)).toBe(2));
      second.resolve();

      await vi.waitFor(async () => {
        expect((await serverText(t, id)).version).toBe(4);
        expect(collab.getVersion(winner.state)).toBe(4);
        expect(collab.getVersion(loser.state)).toBe(4);
      });
      const server = await serverText(t, id);
      expect(server.text).toContain("aaa");
      expect(server.text).toContain("b1");
      expect(server.text).toContain("b2");
      expect(server.text).toHaveLength(7);
      expect(winner.state.doc.textContent).toBe(server.text);
      expect(loser.state.doc.textContent).toBe(server.text);
      expect(collab.sendableSteps(winner.state)).toBeNull();
      expect(collab.sendableSteps(loser.state)).toBeNull();
      expect(submitted.map(({ status }) => status)).toEqual([
        "synced",
        "needs-rebase",
        "synced",
      ]);
      expect([...winner.errors, ...loser.errors]).toEqual([]);
    } finally {
      winner.destroy();
      loser.destroy();
    }
  });

  test("confirms its own submission without writing it twice", async () => {
    const t = convexTest(componentSchema, modules);
    const id = "own-confirmation";
    await seedSnapshot(t, id);
    const { convex, submitted } = client(t, id);
    const editor = editorFor(convex, id, typeText(stateAt(1, "me"), "hello"));
    try {
      editor.start();
      await vi.waitFor(() => expect(collab.getVersion(editor.state)).toBe(2));
      expect(collab.sendableSteps(editor.state)).toBeNull();
      expect(editor.state.doc.textContent).toBe("hello");
      expect(await serverText(t, id)).toEqual({
        text: "hello",
        version: 2,
        clientIds: ["me"],
      });
      expect(submitted).toEqual([{ clientId: "me", status: "synced" }]);
    } finally {
      editor.destroy();
    }
  });

  test("confirms its own steps that landed before the response was lost", async () => {
    const t = convexTest(componentSchema, modules);
    const id = "landed-own-steps";
    await seedSnapshot(t, id);
    const typed = typeText(stateAt(1, "me"), "hello");
    await t.mutation(api.lib.submitSteps, {
      id,
      version: 1,
      clientId: "me",
      steps: stepsJSON(typed),
    });
    const { convex, submitted } = client(t, id, undefined, 2);
    const editor = editorFor(convex, id, typed);
    try {
      editor.start();
      await vi.waitFor(() => expect(collab.getVersion(editor.state)).toBe(2));
      expect(collab.sendableSteps(editor.state)).toBeNull();
      expect(editor.state.doc.textContent).toBe("hello");
      expect((await serverText(t, id)).text).toBe("hello");
      // Catch-up confirmed the steps, so nothing was submitted again.
      expect(submitted).toEqual([]);
    } finally {
      editor.destroy();
    }
  });

  test("rebases over another client's steps", async () => {
    const t = convexTest(componentSchema, modules);
    const id = "ordinary-rebase";
    await seedSnapshot(t, id);
    await t.mutation(api.lib.submitSteps, {
      id,
      version: 1,
      clientId: "other",
      steps: stepsJSON(typeText(stateAt(1, "other"), "theirs")),
    });
    const { convex, submitted } = client(t, id);
    const editor = editorFor(convex, id, typeText(stateAt(1, "me"), "mine"));
    try {
      // The watch has not seen the foreign step yet, so the first submit is
      // stale and rebases.
      editor.start();
      await vi.waitFor(() => expect(collab.getVersion(editor.state)).toBe(3));
      const server = await serverText(t, id);
      expect(server.clientIds).toEqual(["other", "me"]);
      expect(editor.state.doc.textContent).toBe(server.text);
      expect(server.text).toBe("theirsmine");
      expect(submitted.map(({ status }) => status)).toEqual([
        "needs-rebase",
        "synced",
      ]);
    } finally {
      editor.destroy();
    }
  });

  test("the destroy-time flush submits steps that only share its client ID", async () => {
    const t = convexTest(componentSchema, modules);
    const id = "shared-client-flush";
    await seedSnapshot(t, id);
    await t.mutation(api.lib.submitSteps, {
      id,
      version: 1,
      clientId: "shared",
      steps: stepsJSON(typeText(stateAt(1, "shared"), "other tab")),
    });
    const { convex } = client(t, id);

    expect(
      await _flushPendingSteps(
        convex,
        syncApi,
        id,
        typeText(stateAt(1, "shared"), "mine"),
      ),
    ).toBe("flushed");

    const server = await serverText(t, id);
    expect(server.clientIds).toEqual(["shared", "shared"]);
    expect(server.text).toBe("other tabmine");
  });
});
