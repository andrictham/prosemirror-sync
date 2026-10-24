import { describe, expect, test, vi } from "vitest";
import type { ConvexReactClient } from "convex/react";
import type { Editor } from "@tiptap/core";
import { Schema } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
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

/**
 * A client whose latest-version watch throws `failure` while it is set, as
 * Convex does for a query that failed, and reports version 1 otherwise.
 */
function client() {
  let failure: Error | undefined;
  const listeners = new Set<() => void>();
  const submissions: unknown[] = [];
  const convex = {
    watchQuery: () => ({
      localQueryResult: () => {
        if (failure) throw failure;
        return 1;
      },
      onUpdate: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }),
    mutation: async (_reference: unknown, args: unknown) => {
      submissions.push(args);
      return { status: "synced" };
    },
  } as unknown as ConvexReactClient;
  return {
    convex,
    submissions,
    fail(error: Error | undefined) {
      failure = error;
    },
    update() {
      for (const listener of [...listeners]) listener();
    },
  };
}

describe("a failed latest-version read", () => {
  test("is reported and leaves sync ready for the watch's next update", async () => {
    const watch = client();
    const initial = EditorState.create({
      schema,
      plugins: [collab.collab({ version: 1, clientID: "me" })],
    });
    let state = initial.apply(initial.tr.insertText("hello", 1));
    const errors: Error[] = [];
    const extension = syncExtension(
      watch.convex,
      "doc",
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
    const denied = new Error("not allowed to read this document");
    watch.fail(denied);
    try {
      hooks.onCreate.call({ editor });
      await vi.waitFor(() => expect(errors).toEqual([denied]));
      expect(watch.submissions).toEqual([]);

      // The query recovers and the watch reports it.
      watch.fail(undefined);
      watch.update();
      await vi.waitFor(() => expect(collab.getVersion(state)).toBe(2));
      expect(watch.submissions).toHaveLength(1);
      expect(errors).toEqual([denied]);
    } finally {
      hooks.onDestroy.call({ editor });
    }
  });
});
