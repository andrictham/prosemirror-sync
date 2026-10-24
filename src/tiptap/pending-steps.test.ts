/// <reference types="vite/client" />

import { describe, expect, test, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import type { ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import type { Content, Editor } from "@tiptap/core";
import { type Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import { EditorState, type Plugin, type Transaction } from "@tiptap/pm/state";
import { Step } from "@tiptap/pm/transform";
import * as collab from "prosemirror-collab";
import { api } from "../component/_generated/api.js";
import componentSchema from "../component/schema.js";
import type { SyncApi } from "../client/index.js";
import {
  type PendingSteps,
  type SyncBase,
  syncExtension,
  type UseSyncOptions,
} from "./index.js";

const syncApi = api.lib as unknown as SyncApi;
const modules = import.meta.glob("../component/**/*.*s");
const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
});
const emptyDoc = EditorState.create({ schema }).doc;

type Backend = TestConvex<typeof componentSchema>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * A Convex client over a real component backend with a live latest-version
 * watch. `hold` can keep chosen `submitSteps` calls in flight.
 */
function client(
  t: Backend,
  id: string,
  {
    watchedHead = 1,
    hold = () => Promise.resolve(),
  }: { watchedHead?: number; hold?: (call: number) => Promise<void> } = {},
) {
  let head: number | null = watchedHead;
  let calls = 0;
  const listeners = new Set<() => void>();
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
      head = await t.query(api.lib.latestVersion, { id });
      for (const listener of [...listeners]) listener();
      return result;
    },
  } as unknown as ConvexReactClient;
  return {
    convex,
    async notify() {
      head = await t.query(api.lib.latestVersion, { id });
      for (const listener of [...listeners]) listener();
    },
  };
}

/** Mount an editor on the extension's own plugins, with Tiptap's hooks. */
function mount(
  convex: ConvexReactClient,
  id: string,
  opts: UseSyncOptions,
  initial: {
    initialContent: Content;
    initialVersion: number;
    restoredSteps?: object[];
  } = { initialContent: emptyDoc.toJSON(), initialVersion: 1 },
) {
  const errors: Error[] = [];
  const extension = syncExtension(convex, id, syncApi, initial, {
    warnOnUnsyncedClose: false,
    snapshotDebounceMs: 60_000,
    onSyncError: (error) => errors.push(error),
    ...opts,
  });
  const hooks = extension.config as unknown as {
    addProseMirrorPlugins: () => Plugin[];
    onCreate: (this: { editor: Editor }) => void;
    onTransaction: (this: { editor: Editor }) => void;
    onUpdate: (this: { editor: Editor }) => void;
    onDestroy: (this: { editor: Editor }) => void;
  };
  let state = EditorState.create({
    doc: schema.nodeFromJSON(initial.initialContent),
    plugins: hooks.addProseMirrorPlugins(),
  });
  const editor = {
    get state() {
      return state;
    },
    schema,
    isDestroyed: false,
    view: {
      dispatch(transaction: Transaction) {
        state = state.apply(transaction);
        // Tiptap emits "transaction" for every dispatch, then "update" when
        // the document changed.
        hooks.onTransaction.call({ editor });
        if (transaction.docChanged) hooks.onUpdate.call({ editor });
      },
    },
  } as unknown as Editor;
  return {
    editor,
    errors,
    get state() {
      return state;
    },
    type(text: string) {
      editor.view.dispatch(state.tr.insertText(text, 1));
    },
    start: () => hooks.onCreate.call({ editor }),
    destroy: () => hooks.onDestroy.call({ editor }),
  };
}

/** Record every report, keeping the latest base, starting from the mount base. */
function recorder(initialBase: SyncBase) {
  const pending: (PendingSteps | null)[] = [];
  const bases: SyncBase[] = [];
  return {
    pending,
    bases,
    get base() {
      return bases.at(-1) ?? initialBase;
    },
    options: {
      onPendingChange: (report: PendingSteps | null) => pending.push(report),
      onBaseChange: (base: SyncBase) => bases.push(base),
    } satisfies UseSyncOptions,
  };
}

/** The document the last report describes: its steps applied to the base. */
function rebuild(base: SyncBase, report: PendingSteps | null) {
  let doc: ProseMirrorNode = base.doc;
  for (const json of report?.steps ?? []) {
    doc = Step.fromJSON(schema, json).apply(doc).doc!;
  }
  return doc;
}

async function seed(t: Backend, id: string) {
  await t.mutation(api.lib.submitSnapshot, {
    id,
    version: 1,
    content: JSON.stringify(emptyDoc.toJSON()),
  });
}

const mountBase = Object.freeze({ version: 1, doc: emptyDoc });

describe("onPendingChange and onBaseChange", () => {
  test("report typing, partial confirmation and full confirmation", async () => {
    const t = convexTest(componentSchema, modules);
    await seed(t, "doc");
    const first = deferred();
    const { convex } = client(t, "doc", {
      hold: (call) => (call === 1 ? first.promise : Promise.resolve()),
    });
    const reports = recorder(mountBase);
    const editor = mount(convex, "doc", { clientID: "me", ...reports.options });
    try {
      editor.start();
      // Let the mount's sync finish, so "one" is submitted on its own.
      await new Promise((resolve) => setTimeout(resolve, 0));
      editor.type("one");
      expect(reports.pending).toHaveLength(1);
      expect(reports.pending[0]).toMatchObject({ clientID: "me", version: 1 });
      expect(reports.pending[0]!.steps).toHaveLength(1);
      // Typed while the first submission is in flight.
      editor.type("two");
      expect(reports.pending[1]!.steps).toHaveLength(2);
      expect(
        rebuild(reports.base, reports.pending[1]).eq(editor.state.doc),
      ).toBe(true);

      first.resolve();
      await vi.waitFor(() => expect(collab.getVersion(editor.state)).toBe(3));
      // The first confirmation left "two" unconfirmed on top of "one".
      expect(reports.bases.map((base) => base.version)).toEqual([2, 3]);
      expect(reports.bases[0].doc.textContent).toBe("one");
      expect(reports.pending[2]).toMatchObject({ version: 2 });
      expect(reports.pending[2]!.steps).toHaveLength(1);
      expect(rebuild(reports.bases[0], reports.pending[2]).textContent).toBe(
        "twoone",
      );
      expect(reports.pending.at(-1)).toBeNull();
      expect(reports.pending).toHaveLength(4);
      expect(reports.base.doc.eq(editor.state.doc)).toBe(true);
      expect(editor.errors).toEqual([]);
    } finally {
      editor.destroy();
    }
  });

  test("report a rebase over another client's steps", async () => {
    const t = convexTest(componentSchema, modules);
    await seed(t, "doc");
    const other = EditorState.create({
      doc: emptyDoc,
      plugins: [collab.collab({ version: 1, clientID: "other" })],
    });
    await t.mutation(api.lib.submitSteps, {
      id: "doc",
      version: 1,
      clientId: "other",
      steps: collab
        .sendableSteps(other.apply(other.tr.insertText("theirs", 1)))!
        .steps.map((step) => JSON.stringify(step.toJSON())),
    });
    const hold = deferred();
    // The watch has not seen the foreign step, so the first submit is stale.
    // Hold the resubmission so the rebased state can be inspected.
    const { convex } = client(t, "doc", {
      hold: (call) => (call === 2 ? hold.promise : Promise.resolve()),
    });
    const reports = recorder(mountBase);
    const editor = mount(convex, "doc", { clientID: "me", ...reports.options });
    try {
      editor.type("mine");
      editor.start();
      await vi.waitFor(() => expect(collab.getVersion(editor.state)).toBe(2));
      expect(reports.bases).toHaveLength(1);
      expect(reports.bases[0].version).toBe(2);
      expect(reports.bases[0].doc.textContent).toBe("theirs");
      const rebased = reports.pending.at(-1)!;
      expect(rebased.version).toBe(2);
      expect(rebuild(reports.base, rebased).eq(editor.state.doc)).toBe(true);

      hold.resolve();
      await vi.waitFor(() => expect(reports.pending.at(-1)).toBeNull());
      expect(reports.base.doc.eq(editor.state.doc)).toBe(true);
    } finally {
      editor.destroy();
    }
  });

  test("report only the base for another client's steps when nothing is pending", async () => {
    const t = convexTest(componentSchema, modules);
    await seed(t, "doc");
    const { convex, notify } = client(t, "doc");
    const reports = recorder(mountBase);
    const editor = mount(convex, "doc", { clientID: "me", ...reports.options });
    try {
      editor.start();
      const other = EditorState.create({
        doc: emptyDoc,
        plugins: [collab.collab({ version: 1, clientID: "other" })],
      });
      await t.mutation(api.lib.submitSteps, {
        id: "doc",
        version: 1,
        clientId: "other",
        steps: collab
          .sendableSteps(other.apply(other.tr.insertText("theirs", 1)))!
          .steps.map((step) => JSON.stringify(step.toJSON())),
      });
      await notify();
      await vi.waitFor(() => expect(collab.getVersion(editor.state)).toBe(2));
      expect(reports.pending).toEqual([]);
      expect(reports.bases).toHaveLength(1);
      expect(reports.bases[0].doc.textContent).toBe("theirs");
    } finally {
      editor.destroy();
    }
  });

  test("isolates exceptions thrown by the callbacks", async () => {
    const t = convexTest(componentSchema, modules);
    await seed(t, "doc");
    const { convex } = client(t, "doc");
    const onPendingChange = vi.fn(() => {
      throw new Error("observer failed");
    });
    const onBaseChange = vi.fn(() => {
      throw new Error("observer failed");
    });
    const editor = mount(convex, "doc", {
      clientID: "me",
      onPendingChange,
      onBaseChange,
    });
    try {
      editor.start();
      editor.type("hello");
      await vi.waitFor(() => expect(collab.getVersion(editor.state)).toBe(2));
      expect(collab.sendableSteps(editor.state)).toBeNull();
      expect(onPendingChange).toHaveBeenCalledTimes(2);
      expect(onBaseChange).toHaveBeenCalledOnce();
      expect(editor.errors).toEqual([]);
    } finally {
      editor.destroy();
    }
  });

  test("seed a new editor from the client ID, the latest base and the pending steps", async () => {
    const t = convexTest(componentSchema, modules);
    await seed(t, "doc");
    // The first session confirms "one", then loses its connection with "two"
    // still unconfirmed.
    const offline = deferred();
    const { convex: firstClient } = client(t, "doc", {
      hold: (call) => (call === 1 ? Promise.resolve() : offline.promise),
    });
    const reports = recorder(mountBase);
    const first = mount(firstClient, "doc", {
      clientID: "saved",
      ...reports.options,
    });
    first.start();
    first.type("one");
    await vi.waitFor(() => expect(reports.base.version).toBe(2));
    first.type("two");
    const saved = { base: reports.base, pending: reports.pending.at(-1)! };
    expect(saved.pending.version).toBe(2);
    const firstDoc = first.state.doc;
    first.destroy();

    const { convex } = client(t, "doc", { watchedHead: 2 });
    const resumed = mount(
      convex,
      "doc",
      { clientID: saved.pending.clientID },
      {
        initialContent: saved.base.doc.toJSON(),
        initialVersion: saved.base.version,
        restoredSteps: [...saved.pending.steps],
      },
    );
    try {
      resumed.start();
      expect(resumed.state.doc.eq(firstDoc)).toBe(true);
      await vi.waitFor(() => expect(collab.getVersion(resumed.state)).toBe(3));
      expect(collab.sendableSteps(resumed.state)).toBeNull();
      const server = await t.query(api.lib.getSteps, {
        id: "doc",
        version: 1,
      });
      expect(server.clientIds).toEqual(["saved", "saved"]);
      expect(resumed.state.doc.textContent).toBe("twoone");
      expect(resumed.errors).toEqual([]);
    } finally {
      resumed.destroy();
    }
  });
});
