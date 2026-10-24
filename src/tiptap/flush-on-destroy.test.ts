import { describe, expect, test, vi } from "vitest";
import type { ConvexReactClient } from "convex/react";
import type { Editor } from "@tiptap/core";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import * as collab from "prosemirror-collab";
import { api } from "../component/_generated/api.js";
import type { SyncApi } from "../client/index.js";
import { syncExtension } from "./index.js";

const syncApi = api.lib as unknown as SyncApi;
const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
});

/** Mount and destroy an editor with an unconfirmed step and a stalled server. */
async function destroyWithPendingSteps(flushOnDestroy?: boolean) {
  const mutation = vi.fn(() => Promise.reject(new Error("offline")));
  const convex = {
    watchQuery: () => ({
      // The latest version never loads, so the live editor never submits.
      localQueryResult: () => undefined,
      onUpdate: () => () => {},
    }),
    mutation,
  } as unknown as ConvexReactClient;
  const initial = EditorState.create({
    schema,
    plugins: [collab.collab({ version: 1, clientID: "me" })],
  });
  const editor = {
    state: initial.apply(initial.tr.insertText("hello", 1)),
  } as unknown as Editor;
  const onSyncError = vi.fn();
  const extension = syncExtension(
    convex,
    "doc",
    syncApi,
    { initialVersion: 1, initialContent: initial.doc.toJSON() },
    { warnOnUnsyncedClose: false, onSyncError, flushOnDestroy },
  );
  const hooks = extension.config as unknown as {
    onCreate: (this: { editor: Editor }) => void;
    onDestroy: (this: { editor: Editor }) => void;
  };
  hooks.onCreate.call({ editor });
  hooks.onDestroy.call({ editor });
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { mutation, onSyncError };
}

describe("flushOnDestroy", () => {
  test("flushes unconfirmed steps by default", async () => {
    const { mutation, onSyncError } = await destroyWithPendingSteps();
    expect(mutation).toHaveBeenCalledOnce();
    expect(onSyncError).toHaveBeenCalledOnce();
  });

  test("leaves unconfirmed steps to the app when false", async () => {
    const { mutation, onSyncError } = await destroyWithPendingSteps(false);
    expect(mutation).not.toHaveBeenCalled();
    expect(onSyncError).not.toHaveBeenCalled();
  });
});
