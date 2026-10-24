/// <reference types="vite/client" />

import { describe, expect, test, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import type { ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import type { Editor } from "@tiptap/core";
import { Schema } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import * as collab from "prosemirror-collab";
import { api } from "../component/_generated/api.js";
import componentSchema from "../component/schema.js";
import type { SyncApi } from "../client/index.js";
import { type StepsDropped, syncExtension } from "./index.js";

const syncApi = api.lib as unknown as SyncApi;
const modules = import.meta.glob("../component/**/*.*s");
const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
});
const startDoc = schema.node("doc", null, [
  schema.node("paragraph", null, [schema.text("abcdef")]),
]);

type Backend = TestConvex<typeof componentSchema>;

function stateAt(clientID: string) {
  return EditorState.create({
    doc: startDoc,
    plugins: [collab.collab({ version: 1, clientID })],
  });
}

function stepsJSON(state: EditorState) {
  return collab
    .sendableSteps(state)!
    .steps.map((step) => JSON.stringify(step.toJSON()));
}

/** Put another writer's edit on the server, unseen by the editor's watch. */
async function seed(
  t: Backend,
  edit?: { clientId: string; change: (state: EditorState) => EditorState },
) {
  await t.mutation(api.lib.submitSnapshot, {
    id: "doc",
    version: 1,
    content: JSON.stringify(startDoc.toJSON()),
  });
  if (edit) {
    await t.mutation(api.lib.submitSteps, {
      id: "doc",
      version: 1,
      clientId: edit.clientId,
      steps: stepsJSON(edit.change(stateAt(edit.clientId))),
    });
  }
}

function mount(
  t: Backend,
  initial: EditorState,
  onStepsDropped: (event: StepsDropped) => void,
) {
  let state = initial;
  const convex = {
    watchQuery: () => ({
      localQueryResult: () => 1,
      onUpdate: () => () => {},
    }),
    query: (_reference: unknown, args: { id: string; version: number }) =>
      t.query(api.lib.getSteps, args),
    mutation: (reference: SyncApi["submitSteps"], args: never) =>
      getFunctionName(reference) === getFunctionName(syncApi.submitSteps)
        ? t.mutation(api.lib.submitSteps, args)
        : Promise.resolve(null),
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
    { initialVersion: 1, initialContent: startDoc.toJSON() },
    {
      warnOnUnsyncedClose: false,
      snapshotDebounceMs: 60_000,
      onSyncError: (error) => errors.push(error),
      onStepsDropped,
    },
  );
  const hooks = extension.config as unknown as {
    onCreate: (this: { editor: Editor }) => void;
    onDestroy: (this: { editor: Editor }) => void;
  };
  return {
    editor,
    errors,
    get state() {
      return state;
    },
    start: () => hooks.onCreate.call({ editor }),
    destroy: () => hooks.onDestroy.call({ editor }),
  };
}

async function settle(harness: { state: EditorState }, version: number) {
  await vi.waitFor(() => {
    expect(collab.getVersion(harness.state)).toBe(version);
    expect(collab.sendableSteps(harness.state)).toBeNull();
  });
}

const insertX = (state: EditorState) =>
  state.apply(state.tr.insertText("X", 4));

describe("onStepsDropped", () => {
  test("reports a local insert that another writer's deletion removed", async () => {
    const t = convexTest(componentSchema, modules);
    await seed(t, {
      clientId: "other",
      change: (state) => state.apply(state.tr.delete(2, 6)),
    });
    const events: StepsDropped[] = [];
    const harness = mount(t, insertX(stateAt("me")), (event) =>
      events.push(event),
    );
    try {
      harness.start();
      await settle(harness, 2);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        editor: harness.editor,
        clientID: "me",
        version: 2,
        droppedCount: 1,
        conflictCount: 0,
        beyondSavedCount: 0,
      });
      expect(events[0].docBefore.textContent).toBe("abcXdef");
      expect(harness.state.doc.textContent).toBe("af");
      expect(harness.errors).toEqual([]);
    } finally {
      harness.destroy();
    }
  });

  test("stays quiet for a rebase that keeps every local step", async () => {
    const t = convexTest(componentSchema, modules);
    await seed(t, {
      clientId: "other",
      change: (state) => state.apply(state.tr.insertText("Y", 7)),
    });
    const onStepsDropped = vi.fn();
    const harness = mount(t, insertX(stateAt("me")), onStepsDropped);
    try {
      harness.start();
      await settle(harness, 3);
      expect(harness.state.doc.textContent).toBe("abcXdefY");
      expect(onStepsDropped).not.toHaveBeenCalled();
    } finally {
      harness.destroy();
    }
  });

  test("stays quiet when its own steps are confirmed", async () => {
    const t = convexTest(componentSchema, modules);
    await seed(t, { clientId: "me", change: insertX });
    const onStepsDropped = vi.fn();
    const harness = mount(t, insertX(stateAt("me")), onStepsDropped);
    try {
      harness.start();
      await settle(harness, 2);
      expect(harness.state.doc.textContent).toBe("abcXdef");
      expect(onStepsDropped).not.toHaveBeenCalled();
    } finally {
      harness.destroy();
    }
  });

  test("reports steps under its client ID that it did not make", async () => {
    const t = convexTest(componentSchema, modules);
    await seed(t, {
      clientId: "shared",
      change: (state) => state.apply(state.tr.insertText("Y", 7)),
    });
    const events: StepsDropped[] = [];
    const harness = mount(t, insertX(stateAt("shared")), (event) =>
      events.push(event),
    );
    try {
      harness.start();
      await settle(harness, 3);
      expect(harness.state.doc.textContent).toBe("abcXdefY");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        clientID: "shared",
        version: 2,
        droppedCount: 0,
        conflictCount: 1,
        beyondSavedCount: 0,
      });
    } finally {
      harness.destroy();
    }
  });

  test("reports its own steps beyond a shorter saved list apart from conflicts", async () => {
    const t = convexTest(componentSchema, modules);
    // Both steps reached the server, but the editor resumes with only the
    // first one saved as pending.
    await seed(t, {
      clientId: "me",
      change: (state) => {
        const typed = insertX(state);
        return typed.apply(typed.tr.insertText("Z", 8));
      },
    });
    const events: StepsDropped[] = [];
    const harness = mount(t, insertX(stateAt("me")), (event) =>
      events.push(event),
    );
    try {
      harness.start();
      await settle(harness, 3);
      expect(harness.state.doc.textContent).toBe("abcXdefZ");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        clientID: "me",
        version: 3,
        droppedCount: 0,
        conflictCount: 0,
        beyondSavedCount: 1,
      });
    } finally {
      harness.destroy();
    }
  });

  test("isolates an exception thrown by the callback", async () => {
    const t = convexTest(componentSchema, modules);
    await seed(t, {
      clientId: "other",
      change: (state) => state.apply(state.tr.delete(2, 6)),
    });
    const onStepsDropped = vi.fn(() => {
      throw new Error("observer failed");
    });
    const harness = mount(t, insertX(stateAt("me")), onStepsDropped);
    try {
      harness.start();
      await settle(harness, 2);
      expect(onStepsDropped).toHaveBeenCalledOnce();
      expect(harness.errors).toEqual([]);
    } finally {
      harness.destroy();
    }
  });
});
