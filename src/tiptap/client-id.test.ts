/// <reference types="vite/client" />

import { describe, expect, test, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import type { ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import type { Editor } from "@tiptap/core";
import { Schema } from "@tiptap/pm/model";
import { EditorState, type Plugin, type Transaction } from "@tiptap/pm/state";
import * as collab from "prosemirror-collab";
import { api } from "../component/_generated/api.js";
import componentSchema from "../component/schema.js";
import type { SyncApi } from "../client/index.js";
import { syncExtension, type UseSyncOptions } from "./index.js";

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

function client(t: Backend, id: string, watchedHead: number) {
  const submitted: { clientId: string | number; status: string }[] = [];
  const convex = {
    watchQuery: () => ({
      localQueryResult: () => watchedHead,
      onUpdate: () => () => {},
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
      const result = await t.mutation(api.lib.submitSteps, args);
      submitted.push({ clientId: args.clientId, status: result.status });
      return result;
    },
  } as unknown as ConvexReactClient;
  return { convex, submitted };
}

/** Mount an editor on the plugins the extension itself provides. */
function mount(
  convex: ConvexReactClient,
  id: string,
  opts: UseSyncOptions,
  restoredSteps?: object[],
) {
  const extension = syncExtension(
    convex,
    id,
    syncApi,
    { initialVersion: 1, initialContent: emptyDoc.toJSON(), restoredSteps },
    { warnOnUnsyncedClose: false, snapshotDebounceMs: 60_000, ...opts },
  );
  const hooks = extension.config as unknown as {
    addProseMirrorPlugins: () => Plugin[];
    onCreate: (this: { editor: Editor }) => void;
    onDestroy: (this: { editor: Editor }) => void;
  };
  let state = EditorState.create({
    doc: emptyDoc,
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
      },
    },
  } as unknown as Editor;
  return {
    get state() {
      return state;
    },
    type(text: string) {
      state = state.apply(state.tr.insertText(text, 1));
    },
    start: () => hooks.onCreate.call({ editor }),
    destroy: () => hooks.onDestroy.call({ editor }),
  };
}

async function seed(t: Backend, id: string) {
  await t.mutation(api.lib.submitSnapshot, {
    id,
    version: 1,
    content: JSON.stringify(emptyDoc.toJSON()),
  });
}

describe("clientID option", () => {
  test("labels submitted steps with the given client ID", async () => {
    const t = convexTest(componentSchema, modules);
    await seed(t, "doc");
    const { convex, submitted } = client(t, "doc", 1);
    const editor = mount(convex, "doc", { clientID: "saved-session" });
    editor.type("hello");
    expect(collab.sendableSteps(editor.state)?.clientID).toBe("saved-session");
    try {
      editor.start();
      await vi.waitFor(() => expect(submitted).toHaveLength(1));
      expect(submitted).toEqual([
        { clientId: "saved-session", status: "synced" },
      ]);
    } finally {
      editor.destroy();
    }
  });

  test("keeps prosemirror-collab's random client ID by default", () => {
    const { convex } = client(convexTest(componentSchema, modules), "doc", 1);
    const first = mount(convex, "doc", {});
    const second = mount(convex, "doc", {});
    first.type("a");
    second.type("b");
    const firstID = collab.sendableSteps(first.state)!.clientID;
    expect(typeof firstID).toBe("number");
    expect(collab.sendableSteps(second.state)!.clientID).not.toBe(firstID);
  });

  test.each([
    { watchedHead: 2, path: "catch-up" },
    { watchedHead: 1, path: "a stale resubmission" },
  ])(
    "confirms restored steps the server already accepted, through $path",
    async ({ watchedHead }) => {
      const t = convexTest(componentSchema, modules);
      await seed(t, "doc");
      // The earlier session submitted its step, then went away before it
      // learned that the step landed.
      const { convex: earlier } = client(t, "doc", 1);
      const previous = mount(earlier, "doc", { clientID: "saved-session" });
      previous.type("hello");
      const saved = collab
        .sendableSteps(previous.state)!
        .steps.map((step) => step.toJSON() as object);
      await t.mutation(api.lib.submitSteps, {
        id: "doc",
        version: 1,
        clientId: "saved-session",
        steps: saved.map((step) => JSON.stringify(step)),
      });

      const { convex, submitted } = client(t, "doc", watchedHead);
      const resumed = mount(
        convex,
        "doc",
        { clientID: "saved-session" },
        saved,
      );
      try {
        resumed.start();
        await vi.waitFor(() =>
          expect(collab.getVersion(resumed.state)).toBe(2),
        );
        expect(collab.sendableSteps(resumed.state)).toBeNull();
        expect(resumed.state.doc.textContent).toBe("hello");
        expect(submitted.every(({ status }) => status !== "synced")).toBe(true);
        const server = await t.query(api.lib.getSteps, {
          id: "doc",
          version: 1,
        });
        expect(server.clientIds).toEqual(["saved-session"]);
        expect(server.version).toBe(2);
      } finally {
        resumed.destroy();
      }
    },
  );
});
