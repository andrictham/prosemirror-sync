/// <reference types="vite/client" />

import { webcrypto as crypto } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import type { ConvexReactClient } from "convex/react";
import type { Editor } from "@tiptap/core";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { Step } from "@tiptap/pm/transform";
import * as collab from "prosemirror-collab";
import componentSchema from "../component/schema.js";
import { api } from "../component/_generated/api.js";
import type { SyncApi } from "../client/index.js";
import { _flushPendingSteps, stopDocSync, syncExtension } from "./index.js";

const modules = import.meta.glob("../component/**/*.*s");
const syncApi = api.lib as unknown as SyncApi;

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
});

function stateAt(version: number, clientID: string) {
  return EditorState.create({
    schema,
    plugins: [collab.collab({ version, clientID })],
  });
}

function typeText(state: EditorState, text: string) {
  return state.apply(state.tr.insertText(text, 1));
}

function clientOf(submitSteps: (args: unknown) => Promise<unknown>) {
  return {
    watchQuery: () => ({
      localQueryResult: () => undefined,
      onUpdate: () => () => {},
    }),
    mutation: (_reference: unknown, args: unknown) => submitSteps(args),
  } as unknown as ConvexReactClient;
}

class Dropped extends Error {}
class Refused extends Error {}
const isRetryable = (error: unknown) => error instanceof Dropped;

/** A small deterministic generator, so a failing seed can be replayed. */
function seeded(seed: number) {
  let value = seed >>> 0;
  return (bound: number) => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(value ^ (value >>> 15), value | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return (((mixed ^ (mixed >>> 14)) >>> 0) % bound) as number;
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("flush retry against the component", () => {
  /**
   * Domain: 1 to 4 local insertions, with or without another writer's step
   * already stored, and before each attempt that gets through, 0 to 3 dropped
   * attempts. A dropped attempt either never reached the server or was stored
   * and lost its response.
   * Oracle: replaying the stored steps into a fresh document. It never reads
   * the flush's own state.
   * Behaviour: the flush reports "flushed" and every local insertion is stored
   * exactly once.
   */
  test("stores every local step exactly once whatever attempts are dropped", async () => {
    for (let seed = 1; seed <= 80; seed++) {
      const next = seeded(seed);
      const t = convexTest(componentSchema, modules);
      const id = crypto.randomUUID();
      await t.run(async (ctx) => {
        await ctx.db.insert("snapshots", { id, version: 1, content: "{}" });
      });
      const foreign = next(2) === 1;
      if (foreign) {
        const steps = collab
          .sendableSteps(typeText(stateAt(1, "other"), "r"))!
          .steps.map((step) => JSON.stringify(step.toJSON()));
        await t.run(async (ctx) => {
          await ctx.db.insert("deltas", {
            id,
            version: 2,
            clientId: "other",
            steps,
          });
        });
      }
      let state = stateAt(1, "me");
      const typed = 1 + next(4);
      for (let index = 0; index < typed; index++) {
        state = typeText(state, "m");
      }

      let dropsLeft = next(4);
      const convex = clientOf(async (args) => {
        if (dropsLeft > 0) {
          dropsLeft--;
          if (next(2) === 1) {
            await t.mutation(api.lib.submitSteps, args as never);
          }
          throw new Dropped(`seed ${seed}`);
        }
        dropsLeft = next(4);
        return t.mutation(api.lib.submitSteps, args as never);
      });

      const outcome = await _flushPendingSteps(
        convex,
        syncApi,
        id,
        state,
        false,
        { isRetryable, initialMs: 0, maxMs: 0 },
      );

      expect(outcome, `seed ${seed}`).toBe("flushed");
      const server = await t.query(api.lib.getSteps, { id, version: 1 });
      let replayed = stateAt(1, "reader");
      for (const step of server.steps) {
        replayed = replayed.apply(
          replayed.tr.step(Step.fromJSON(schema, JSON.parse(step))),
        );
      }
      const text = replayed.doc.textContent;
      expect(text.replaceAll("r", ""), `seed ${seed}`).toBe("m".repeat(typed));
      expect(text.includes("r"), `seed ${seed}`).toBe(foreign);
    }
  });

  test("gives up after one call when the error is not retryable", async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const next = seeded(seed);
      const dropsBefore = next(4);
      let calls = 0;
      const convex = clientOf(() => {
        calls++;
        return Promise.reject(
          calls <= dropsBefore ? new Dropped("dropped") : new Refused("no"),
        );
      });

      const outcome = await _flushPendingSteps(
        convex,
        syncApi,
        "doc",
        typeText(stateAt(1, "me"), "hello"),
        false,
        { isRetryable, initialMs: 0, maxMs: 0 },
      );

      expect(outcome, `seed ${seed}`).toBe("gave-up");
      expect(calls, `seed ${seed}`).toBe(dropsBefore + 1);
    }
  });
});

describe("flush retry timing", () => {
  test("without the option, one failed submit ends the flush", async () => {
    let calls = 0;
    const convex = clientOf(() => {
      calls++;
      return Promise.reject(new Dropped("dropped"));
    });

    expect(
      await _flushPendingSteps(
        convex,
        syncApi,
        "doc",
        typeText(stateAt(1, "me"), "hello"),
      ),
    ).toBe("gave-up");
    expect(calls).toBe(1);
  });

  test("backs off 1, 2, 4, 8 and 16 seconds, and never past 60 seconds", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const callTimes: number[] = [];
    const convex = clientOf(() => {
      callTimes.push(Date.now() - started);
      return Promise.reject(new Dropped("dropped"));
    });

    const flush = _flushPendingSteps(
      convex,
      syncApi,
      "doc",
      typeText(stateAt(1, "me"), "hello"),
      false,
      { isRetryable, deadlineMs: 10 * 60_000 },
    );
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(await flush).toBe("gave-up");
    expect(callTimes).toEqual([0, 1000, 3000, 7000, 15_000, 31_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("honours a shorter deadline", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const convex = clientOf(() => {
      calls++;
      return Promise.reject(new Dropped("dropped"));
    });

    const flush = _flushPendingSteps(
      convex,
      syncApi,
      "doc",
      typeText(stateAt(1, "me"), "hello"),
      false,
      { isRetryable, deadlineMs: 3000 },
    );
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await flush).toBe("gave-up");
    // Attempts at 0, 1 and 3 seconds; the next would be at 7.
    expect(calls).toBe(3);
  });

  test("stops while waiting to retry, and calls nothing afterwards", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const convex = clientOf(() => {
      calls++;
      return Promise.reject(new Dropped("dropped"));
    });
    const stop = new AbortController();

    const flush = _flushPendingSteps(
      convex,
      syncApi,
      "doc",
      typeText(stateAt(1, "me"), "hello"),
      false,
      { isRetryable, signal: stop.signal },
    );
    await vi.advanceTimersByTimeAsync(500);
    stop.abort();

    expect(await flush).toBe("stopped");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(1);
  });
});

describe("flushRetry option", () => {
  function mount(convex: ConvexReactClient) {
    const errors: Error[] = [];
    const extension = syncExtension(
      convex,
      "doc",
      syncApi,
      { initialVersion: 1, initialContent: stateAt(1, "me").doc.toJSON() },
      {
        warnOnUnsyncedClose: false,
        snapshotDebounceMs: 60_000,
        onSyncError: (error) => errors.push(error),
        flushRetry: { isRetryable },
      },
    );
    const hooks = extension.config as unknown as {
      onCreate: (this: { editor: Editor }) => void;
      onDestroy: (this: { editor: Editor }) => void;
    };
    const editor = {
      state: stateAt(1, "me"),
      schema,
      isDestroyed: false,
      view: { dispatch: vi.fn() },
    };
    const context = { editor: editor as unknown as Editor };
    return {
      errors,
      editor: context.editor,
      /** Mount, type without syncing, then destroy, leaving the flush to send. */
      leaveWithUnsentText() {
        hooks.onCreate.call(context);
        editor.state = typeText(editor.state, "hello");
        hooks.onDestroy.call(context);
        editor.isDestroyed = true;
      },
    };
  }

  test("retries the destroy-time flush until the submit gets through", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const convex = clientOf(() => {
      calls++;
      return calls < 3
        ? Promise.reject(new Dropped("dropped"))
        : Promise.resolve({ status: "synced" });
    });
    const mounted = mount(convex);

    mounted.leaveWithUnsentText();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(calls).toBe(3);
    expect(mounted.errors).toEqual([]);
  });

  test("reports lost steps once when the error is not retryable", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const convex = clientOf(() => {
      calls++;
      return Promise.reject(new Refused("no"));
    });
    const mounted = mount(convex);

    mounted.leaveWithUnsentText();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(calls).toBe(1);
    expect(mounted.errors.map((error) => error.message)).toEqual([
      "Unsynced steps could not be flushed after destroy",
    ]);
  });

  test("a stop ends a waiting retry without a report", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const convex = clientOf(() => {
      calls++;
      return Promise.reject(new Dropped("dropped"));
    });
    const mounted = mount(convex);

    mounted.leaveWithUnsentText();
    await vi.advanceTimersByTimeAsync(500);
    expect(stopDocSync(mounted.editor, "accessLost")).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(calls).toBe(1);
    expect(mounted.errors).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
