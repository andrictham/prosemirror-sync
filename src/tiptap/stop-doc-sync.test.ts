import { describe, expect, test, vi } from "vitest";
import type { ConvexReactClient } from "convex/react";
import type { Editor } from "@tiptap/core";
import { Schema } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import * as collab from "prosemirror-collab";
import { api } from "../component/_generated/api.js";
import type { SyncApi } from "../client/index.js";
import { stopDocSync, syncExtension, type UseSyncOptions } from "./index.js";

const syncApi = api.lib as unknown as SyncApi;
const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
});

/**
 * A client whose watch reports version 1 and whose `submitSteps` waits for
 * `answer` before resolving with its result. Records each submission.
 */
function client() {
  const submissions: unknown[] = [];
  let answer: (outcome: () => unknown) => void = () => {};
  const convex = {
    watchQuery: () => ({
      localQueryResult: () => 1,
      onUpdate: () => () => {},
    }),
    mutation: (_reference: unknown, args: unknown) => {
      submissions.push(args);
      return new Promise((resolve, reject) => {
        answer = (outcome) => {
          try {
            resolve(outcome());
          } catch (error) {
            reject(error);
          }
        };
      });
    },
  } as unknown as ConvexReactClient;
  return {
    convex,
    submissions,
    answer: (outcome: () => unknown) => answer(outcome),
  };
}

function mount(convex: ConvexReactClient, opts: UseSyncOptions = {}) {
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("stopDocSync", () => {
  test("returns false for an editor the provider never mounted", () => {
    const { convex } = client();
    const editor = mount(convex);
    expect(stopDocSync(editor.editor, "discarded")).toBe(false);
  });

  test("stops submitting edits, and skips the destroy-time flush", async () => {
    const { convex, submissions } = client();
    const editor = mount(convex);
    editor.start();
    expect(stopDocSync(editor.editor, "accessLost")).toBe(true);

    editor.type("kept locally");
    await tick();
    editor.destroy();
    await tick();

    expect(submissions).toEqual([]);
    expect(editor.state.doc.textContent).toBe("kept locally");
    expect(collab.sendableSteps(editor.state)).not.toBeNull();
    expect(editor.errors).toEqual([]);
  });

  test("ignores the failure of a submission in flight when sync stopped", async () => {
    const { convex, submissions, answer } = client();
    const editor = mount(convex, { retry: true });
    editor.start();
    editor.type("hello");
    await tick();
    expect(submissions).toHaveLength(1);

    stopDocSync(editor.editor, "identityChanged");
    answer(() => {
      throw new Error("not allowed");
    });
    await tick();

    expect(editor.errors).toEqual([]);
    expect(submissions).toHaveLength(1);
    editor.destroy();
  });

  test("stops every editor the provider mounted, and a new mount stays stopped", async () => {
    const { convex, submissions } = client();
    const first = mount(convex);
    first.start();
    stopDocSync(first.editor, "discarded");
    first.type("one");
    // onCreate runs again for the same editor, as a remount would.
    first.start();
    await tick();
    expect(submissions).toEqual([]);
    first.destroy();
  });

  test("does not submit when a synchronous submit observer stops sync", async () => {
    const { convex, submissions } = client();
    const editor = mount(convex, {
      onSyncObservation: (event) => {
        if (event.kind === "submit") stopDocSync(event.editor, "accessLost");
      },
    });
    editor.start();
    editor.type("kept locally");
    await tick();
    editor.destroy();
    await tick();

    expect(submissions).toEqual([]);
    expect(editor.state.doc.textContent).toBe("kept locally");
    expect(editor.errors).toEqual([]);
  });

  test("leaves the steps to the flush when a submit observer destroys the editor", async () => {
    const { convex, submissions } = client();
    const editor = mount(convex, {
      onSyncObservation: (event) => {
        if (event.kind !== "submit") return;
        (event.editor as { isDestroyed: boolean }).isDestroyed = true;
        editor.destroy();
      },
    });
    editor.start();
    editor.type("hello");
    await tick();

    // Only the destroy-time flush submits; the sync loop does not send the
    // same steps a second time.
    expect(submissions).toHaveLength(1);
  });

  test("requests no further history page when a receive observer stops sync", async () => {
    const remote = mount(client().convex);
    const remoteSteps = remote.state.tr
      .insertText("remote", 1)
      .steps.map((step) => JSON.stringify(step.toJSON()));
    const queries: unknown[] = [];
    const convex = {
      watchQuery: () => ({
        localQueryResult: () => 3,
        onUpdate: () => () => {},
      }),
      // A nonterminal page: version 2 is short of the watched version 3.
      query: (_reference: unknown, args: unknown) => {
        queries.push(args);
        return Promise.resolve({
          steps: remoteSteps,
          clientIds: remoteSteps.map(() => "peer"),
          version: 2,
        });
      },
      mutation: () => new Promise(() => {}),
    } as unknown as ConvexReactClient;
    const editor = mount(convex, {
      onSyncObservation: (event) => {
        if (event.kind === "receive") stopDocSync(event.editor, "accessLost");
      },
    });
    editor.start();
    await tick();
    await tick();

    expect(queries).toHaveLength(1);
    expect(editor.state.doc.textContent).toBe("remote");
    expect(editor.errors).toEqual([]);
    editor.destroy();
  });

  test("leaves sync running when it is never called", async () => {
    const { convex, submissions, answer } = client();
    const editor = mount(convex);
    editor.start();
    editor.type("hello");
    await vi.waitFor(() => expect(submissions).toHaveLength(1));
    answer(() => ({ status: "synced" }));
    await vi.waitFor(() => expect(collab.getVersion(editor.state)).toBe(2));
    editor.destroy();
  });
});
