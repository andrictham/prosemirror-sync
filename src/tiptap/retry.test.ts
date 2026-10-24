import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

/**
 * A client whose `submitSteps` fails with each error in `failures`, in order,
 * then succeeds. It records when each submission was attempted.
 */
function client(failures: Error[]) {
  const attempts: number[] = [];
  const convex = {
    watchQuery: () => ({
      localQueryResult: () => 1,
      onUpdate: () => () => {},
    }),
    mutation: async () => {
      attempts.push(Date.now());
      const failure = failures.shift();
      if (failure) throw failure;
      return { status: "synced" };
    },
  } as unknown as ConvexReactClient;
  return { convex, attempts };
}

function mount(convex: ConvexReactClient, opts: UseSyncOptions) {
  const initial = EditorState.create({
    schema,
    plugins: [collab.collab({ version: 1, clientID: "me" })],
  });
  let state = initial.apply(initial.tr.insertText("hello", 1));
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
    { initialVersion: 1, initialContent: initial.doc.toJSON() },
    {
      warnOnUnsyncedClose: false,
      snapshotDebounceMs: 3_600_000,
      onSyncError: (error) => errors.push(error),
      ...opts,
    },
  );
  const hooks = extension.config as unknown as {
    onCreate: (this: { editor: Editor }) => void;
    onDestroy: (this: { editor: Editor }) => void;
  };
  return {
    errors,
    get state() {
      return state;
    },
    start: () => hooks.onCreate.call({ editor }),
    destroy: () => hooks.onDestroy.call({ editor }),
  };
}

const transient = () => new Error("connection lost");

describe("retry", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("does not retry by default", async () => {
    const { convex, attempts } = client([transient()]);
    const editor = mount(convex, {});
    editor.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(attempts).toEqual([0]);
    expect(editor.errors).toHaveLength(1);
    expect(collab.sendableSteps(editor.state)).not.toBeNull();
  });

  test("backs off from 1 second to a 30 second maximum, then succeeds", async () => {
    const { convex, attempts } = client(
      Array.from({ length: 7 }, () => transient()),
    );
    const editor = mount(convex, { retry: true });
    editor.start();
    await vi.advanceTimersByTimeAsync(200_000);
    // Delays of 1, 2, 4, 8, 16, 30 and 30 seconds.
    expect(attempts).toEqual([
      0, 1_000, 3_000, 7_000, 15_000, 31_000, 61_000, 91_000,
    ]);
    expect(collab.sendableSteps(editor.state)).toBeNull();
    expect(editor.errors).toHaveLength(7);
    editor.destroy();
  });

  test("resets the backoff after a successful sync", async () => {
    const failures = [transient(), transient()];
    const { convex, attempts } = client(failures);
    const editor = mount(convex, { retry: { initialMs: 100, maxMs: 1_000 } });
    editor.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toEqual([0, 100, 300]);
    expect(collab.sendableSteps(editor.state)).toBeNull();
    editor.destroy();

    // The next failure starts again from the initial delay.
    failures.push(transient());
    const next = mount(convex, { retry: { initialMs: 100, maxMs: 1_000 } });
    next.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts.slice(3).map((time) => time - attempts[3])).toEqual([
      0, 100,
    ]);
    next.destroy();
  });

  test("stops when the last editor is destroyed", async () => {
    const { convex, attempts } = client([transient(), transient()]);
    const editor = mount(convex, { retry: true });
    editor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toEqual([0]);
    // The destroy-time flush makes the only further attempt.
    editor.destroy();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(attempts).toEqual([0, 0]);
  });

  test("stops on an error classified as terminal", async () => {
    const terminal = new Error("history conflict");
    const { convex, attempts } = client([transient(), terminal]);
    const isTerminalError = vi.fn((error: unknown) => error === terminal);
    const editor = mount(convex, { retry: true, isTerminalError });
    editor.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(attempts).toEqual([0, 1_000]);
    expect(isTerminalError).toHaveBeenCalledWith(terminal);
    expect(editor.errors).toEqual([expect.any(Error), terminal]);
    editor.destroy();
  });

  test("stops on a terminal schema failure", async () => {
    const { convex, attempts } = client([
      transient(),
      new Error("Unknown node type: callout"),
    ]);
    const editor = mount(convex, { retry: true });
    editor.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(attempts).toEqual([0, 1_000]);
    expect(editor.errors.at(-1)?.message).toContain("Unknown node type");
    editor.destroy();
  });

  test("keeps one timer when several attempts fail before it fires", async () => {
    const { convex, attempts } = client([transient(), transient()]);
    const editor = mount(convex, { retry: true });
    editor.start();
    // A second attempt fails while the first retry is waiting.
    editor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toEqual([0, 0]);
    await vi.advanceTimersByTimeAsync(10_000);
    // One retry at 1 second, which succeeds.
    expect(attempts).toEqual([0, 0, 1_000]);
    editor.destroy();
  });
});
