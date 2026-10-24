import { describe, expect, test, vi } from "vitest";
import type { ConvexReactClient } from "convex/react";
import type { Editor } from "@tiptap/core";
import { Schema } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import * as collab from "prosemirror-collab";
import { api } from "../component/_generated/api.js";
import type { SyncApi } from "../client/index.js";
import { syncExtension, type UseSyncOptions } from "./index.js";

const syncApi = api.lib as unknown as SyncApi;
const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
});

/** A client whose `submitSteps` throws each of `failures` in turn, then syncs. */
function client(failures: Error[]) {
  const submissions: number[] = [];
  const convex = {
    watchQuery: () => ({
      localQueryResult: () => 1,
      onUpdate: () => () => {},
    }),
    mutation: async () => {
      submissions.push(submissions.length);
      const failure = failures.shift();
      if (failure) throw failure;
      return { status: "synced" };
    },
  } as unknown as ConvexReactClient;
  return { convex, submissions };
}

function mount(convex: ConvexReactClient, opts: UseSyncOptions) {
  const initial = EditorState.create({
    schema,
    plugins: [collab.collab({ version: 1, clientID: "me" })],
  });
  let state = initial;
  const errors: Error[] = [];
  const extension = syncExtension(
    convex,
    "doc",
    syncApi,
    { initialVersion: 1, initialContent: initial.doc.toJSON() },
    {
      warnOnUnsyncedClose: false,
      snapshotDebounceMs: 60_000,
      onSyncError: (error) => errors.push(error),
      ...opts,
    },
  );
  const hooks = extension.config as unknown as {
    onCreate: (this: { editor: Editor }) => void;
    onUpdate: (this: { editor: Editor }) => void;
    onDestroy: (this: { editor: Editor }) => void;
  };
  const editor = {
    get state() {
      return state;
    },
    schema,
    isDestroyed: false,
    view: {
      dispatch(transaction: Transaction) {
        state = state.apply(transaction);
        if (transaction.docChanged) hooks.onUpdate.call({ editor });
      },
    },
  } as unknown as Editor;
  return {
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("isTerminalSyncError", () => {
  test("stops sync for good on an error it classifies as terminal", async () => {
    const refused = new Error("submission refused");
    const { convex, submissions } = client([refused]);
    const isTerminalSyncError = vi.fn((error: Error) => error === refused);
    const editor = mount(convex, { isTerminalSyncError, retry: true });
    editor.start();
    editor.type("too big");
    await vi.waitFor(() => expect(editor.errors).toEqual([refused]));
    expect(isTerminalSyncError).toHaveBeenCalledWith(refused);

    // Later edits, retries and the destroy-time flush send nothing.
    editor.type("more");
    await tick();
    editor.destroy();
    await tick();
    expect(submissions).toHaveLength(1);
    expect(collab.sendableSteps(editor.state)).not.toBeNull();
  });

  test("keeps syncing after an error it does not classify as terminal", async () => {
    const transient = new Error("connection lost");
    const { convex, submissions } = client([transient]);
    const editor = mount(convex, { isTerminalSyncError: () => false });
    editor.start();
    editor.type("hello");
    await vi.waitFor(() => expect(editor.errors).toEqual([transient]));
    editor.type("again");
    await vi.waitFor(() => expect(collab.getVersion(editor.state)).toBe(3));
    expect(submissions).toHaveLength(2);
    editor.destroy();
  });
});
