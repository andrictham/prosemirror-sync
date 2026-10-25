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
import {
  confirmationBatches,
  matchOwnSteps,
  receiveBatch,
} from "./own-steps.js";

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
    schema: initial.schema,
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

const richSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "text*",
      marks: "_",
      attrs: { align: { default: null } },
      toDOM: () => ["p", 0],
    },
    blockquote: {
      group: "block",
      content: "block+",
      toDOM: () => ["blockquote", 0],
    },
    text: {},
  },
  marks: {
    strong: { toDOM: () => ["strong", 0] },
  },
});

/** One paragraph, "hello", whose first two letters are bold. */
function richStateAt(version: number, clientID: string | number) {
  const strong = richSchema.marks.strong.create();
  const doc = richSchema.node("doc", null, [
    richSchema.node("paragraph", null, [
      richSchema.text("he", [strong]),
      richSchema.text("llo"),
    ]),
  ]);
  return EditorState.create({
    doc,
    plugins: [collab.collab({ version, clientID })],
  });
}

const richEdits = {
  ReplaceAroundStep: (state: EditorState) => {
    const range = state.doc.resolve(1).blockRange(state.doc.resolve(6))!;
    return state.tr.wrap(range, [{ type: richSchema.nodes.blockquote }]);
  },
  AddMarkStep: (state: EditorState) =>
    state.tr.addMark(3, 6, richSchema.marks.strong.create()),
  RemoveMarkStep: (state: EditorState) =>
    state.tr.removeMark(1, 3, richSchema.marks.strong),
  AttrStep: (state: EditorState) =>
    state.tr.setNodeAttribute(0, "align", "center"),
} satisfies Record<string, (state: EditorState) => Transaction>;

describe("own-step content comparison", () => {
  for (const [stepClass, edit] of Object.entries(richEdits)) {
    test(`confirms a ${stepClass} that went through Step.fromJSON`, () => {
      const before = richStateAt(1, "me");
      const state = before.apply(edit(before));
      const local = collab.sendableSteps(state)!.steps;
      expect(local.map((step) => step.constructor.name)).toEqual([stepClass]);
      const persisted = local.map((step) =>
        Step.fromJSON(richSchema, JSON.parse(JSON.stringify(step.toJSON()))),
      );

      expect(matchOwnSteps(state, persisted, ["me"])).toEqual({
        clientIds: ["me"],
        confirmed: 1,
        conflictCount: 0,
        beyondSavedCount: 0,
      });
    });

    test(`a synced ${stepClass} replays as confirmed without being submitted again`, async () => {
      const t = convexTest(componentSchema, modules);
      const id = `synced-${stepClass}`;
      const before = richStateAt(1, "me");
      await t.mutation(api.lib.submitSnapshot, {
        id,
        version: 1,
        content: JSON.stringify(before.doc.toJSON()),
      });
      const edited = before.apply(edit(before));
      const { convex, submitted } = client(t, id);
      // None of the content-matching options is set, so the replay goes
      // through the default decoder: Step.fromJSON over the submitted JSON.
      const editor = editorFor(convex, id, edited);
      try {
        editor.start();
        await vi.waitFor(() => expect(collab.getVersion(editor.state)).toBe(2));
        expect(collab.sendableSteps(editor.state)).toBeNull();
        expect(editor.state.doc.toJSON()).toEqual(edited.doc.toJSON());
        const page = await t.query(api.lib.getSteps, { id, version: 1 });
        expect(page.clientIds).toEqual(["me"]);
        // A relabelled replay would rebase the local step over its own copy
        // and submit it a second time.
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(submitted).toEqual([{ clientId: "me", status: "synced" }]);
        expect(editor.errors).toEqual([]);
      } finally {
        editor.destroy();
      }
    });
  }

  test("ignores key order and undefined fields", () => {
    const state = typeText(stateAt(1, "me"), "hi");
    const [local] = collab.sendableSteps(state)!.steps;
    const json = local.toJSON() as Record<string, unknown>;
    const reordered = Object.fromEntries(
      [...Object.entries(json), ["structure", undefined]].reverse(),
    );
    const decoded = { toJSON: () => reordered } as unknown as Step;

    expect(matchOwnSteps(state, [decoded], ["me"])).toEqual({
      clientIds: ["me"],
      confirmed: 1,
      conflictCount: 0,
      beyondSavedCount: 0,
    });
  });

  test("relabels a step under its client ID whose content differs", () => {
    const state = typeText(stateAt(1, "me"), "hi");
    const other = collab.sendableSteps(typeText(stateAt(1, "me"), "ho"))!.steps;

    const match = matchOwnSteps(state, other, ["me"]);
    expect(match.confirmed).toBe(0);
    expect(match.conflictCount).toBe(1);
    expect(match.beyondSavedCount).toBe(0);
    expect(match.clientIds[0]).toBeNaN();
  });

  test("counts own steps past its unconfirmed ones apart from conflicts", () => {
    const saved = typeText(stateAt(1, "me"), "a");
    const sent = typeText(typeText(stateAt(1, "me"), "a"), "b");
    const steps = collab.sendableSteps(sent)!.steps;
    expect(steps).toHaveLength(2);

    const match = matchOwnSteps(saved, steps, ["me", "me"]);
    expect(match.confirmed).toBe(1);
    expect(match.conflictCount).toBe(0);
    expect(match.beyondSavedCount).toBe(1);
    expect(match.clientIds[0]).toBe("me");
    expect(match.clientIds[1]).toBeNaN();
  });

  test("counts a conflict and the own steps beyond it separately", () => {
    const saved = typeText(stateAt(1, "me"), "a");
    const other = typeText(typeText(stateAt(1, "me"), "x"), "y");
    const steps = collab.sendableSteps(other)!.steps;

    const match = matchOwnSteps(saved, steps, ["me", "me"]);
    expect(match.confirmed).toBe(0);
    expect(match.conflictCount).toBe(1);
    expect(match.beyondSavedCount).toBe(1);
  });
});

/** Insert at the end of the first paragraph. */
function append(state: EditorState, text: string) {
  return state.apply(state.tr.insertText(text, state.doc.content.size - 1));
}

function unconfirmedSteps(state: EditorState) {
  return collab.sendableSteps(state)?.steps ?? [];
}

/** Apply a catch-up batch the way the provider does. */
function catchUp(
  state: EditorState,
  steps: Step[],
  clientIds: (string | number)[],
) {
  for (const batch of confirmationBatches(
    state,
    steps,
    matchOwnSteps(state, steps, clientIds).clientIds,
  )) {
    state = state.apply(receiveBatch(state, batch).transaction);
  }
  return state;
}

/** Replay steps on a plain state, as the server's document. */
function serverDoc(steps: Step[], base = stateAt(1, "server")) {
  let state = base;
  for (const step of steps) state = state.apply(state.tr.step(step));
  return state.doc;
}

describe("own steps anywhere in a catch-up batch", () => {
  test("a restored step that landed behind a remote step shows once", () => {
    // Another copy of "me" submitted "a0" after "other" wrote "H", so the
    // server rebased it.
    const [heading] = unconfirmedSteps(typeText(stateAt(1, "other"), "H"));
    const copy = collab.receiveTransaction(
      typeText(stateAt(1, "me"), "a0"),
      [heading],
      ["other"],
    );
    const copyState = typeText(stateAt(1, "me"), "a0").apply(copy);
    const [landed] = unconfirmedSteps(copyState);
    const steps = [heading, landed];

    // This tab restores the unconfirmed "a0" and catches up.
    const restored = catchUp(typeText(stateAt(1, "me"), "a0"), steps, [
      "other",
      "me",
    ]);

    expect(restored.doc.textContent).toBe("Ha0");
    expect(restored.doc.toJSON()).toEqual(serverDoc(steps).toJSON());
    expect(collab.getVersion(restored)).toBe(3);
    expect(collab.sendableSteps(restored)).toBeNull();
  });

  test("a landed step whose saved row was lost in a crash shows once", () => {
    // The send of "a0" landed after remote "b0" and was rebased, but the
    // crash dropped the saved row that recorded it. The restored row still
    // holds "a0" as unconfirmed.
    const [remote] = unconfirmedSteps(append(stateAt(1, "other"), "b0"));
    const sent = typeText(stateAt(1, "me"), "a0");
    const [landed] = unconfirmedSteps(
      sent.apply(collab.receiveTransaction(sent, [remote], ["other"])),
    );
    const steps = [remote, landed];

    const restored = catchUp(typeText(stateAt(1, "me"), "a0"), steps, [
      "other",
      "me",
    ]);

    expect(restored.doc.toJSON()).toEqual(serverDoc(steps).toJSON());
    expect(restored.doc.textContent).toBe("b0a0");
    expect(collab.sendableSteps(restored)).toBeNull();
  });

  test("own steps at the front still confirm before remote steps", () => {
    const mine = typeText(stateAt(1, "me"), "a0");
    const [own] = unconfirmedSteps(mine);
    const [remote] = unconfirmedSteps(
      append(typeText(stateAt(1, "x"), "a0"), "R"),
    ).slice(1);
    const steps = [own, remote];

    const caughtUp = catchUp(mine, steps, ["me", "other"]);

    expect(caughtUp.doc.textContent).toBe("a0R");
    expect(collab.getVersion(caughtUp)).toBe(3);
    expect(collab.sendableSteps(caughtUp)).toBeNull();
  });

  test("own steps interleaved with remote steps confirm in order", () => {
    const local = append(typeText(stateAt(1, "me"), "o1"), "o2");
    const [r1] = unconfirmedSteps(typeText(stateAt(1, "other"), "R1"));
    // The other copy of "me" sends o1 after R1, then o2 after R2.
    let copy = local.apply(collab.receiveTransaction(local, [r1], ["other"]));
    const [o1] = unconfirmedSteps(copy);
    copy = copy.apply(collab.receiveTransaction(copy, [o1], ["me"]));
    const r2 = unconfirmedSteps(
      append(
        stateAt(1, "other").apply(stateAt(1, "other").tr.step(r1).step(o1)),
        "R2",
      ),
    ).at(-1)!;
    copy = copy.apply(collab.receiveTransaction(copy, [r2], ["other"]));
    const [o2] = unconfirmedSteps(copy);
    const steps = [r1, o1, r2, o2];

    const restored = catchUp(local, steps, ["other", "me", "other", "me"]);

    expect(restored.doc.toJSON()).toEqual(serverDoc(steps).toJSON());
    expect(restored.doc.textContent).toBe("R1o1R2o2");
    expect(collab.getVersion(restored)).toBe(5);
    expect(collab.sendableSteps(restored)).toBeNull();
  });

  test("an own step past the unconfirmed ones is applied as remote", () => {
    const local = typeText(stateAt(1, "me"), "a0");
    const [heading] = unconfirmedSteps(typeText(stateAt(1, "other"), "H"));
    const copy = local.apply(
      collab.receiveTransaction(local, [heading], ["other"]),
    );
    const [landed] = unconfirmedSteps(copy);
    const extra = unconfirmedSteps(append(copy, "b1")).at(-1)!;
    const steps = [heading, landed, extra];

    const match = matchOwnSteps(local, steps, ["other", "me", "me"]);
    expect(match.clientIds[2]).toBeNaN();
    expect(match.confirmed).toBe(1);
    expect(match.conflictCount).toBe(0);
    expect(match.beyondSavedCount).toBe(1);

    const restored = catchUp(local, steps, ["other", "me", "me"]);
    expect(restored.doc.toJSON()).toEqual(serverDoc(steps).toJSON());
    expect(collab.sendableSteps(restored)).toBeNull();
  });

  test("an unconfirmed step dropped by an earlier batch does not hide server steps", () => {
    const base = EditorState.create({
      doc: schema.node("doc", null, [
        schema.node("paragraph", null, [schema.text("abcd")]),
      ]),
      plugins: [collab.collab({ version: 1, clientID: "me" })],
    });
    // Two local inserts: "X" between b and c, then "Y" at the end.
    const local = append(base.apply(base.tr.insertText("X", 3)), "Y");
    expect(unconfirmedSteps(local)).toHaveLength(2);
    // Another writer deletes "bc", which drops the local "X" in the rebase.
    const [deletion] = unconfirmedSteps(base.apply(base.tr.delete(2, 4)));
    // The other copy of "me" lost "X" the same way, landed "Y" after the
    // deletion, then one more step this row never saved.
    const copy = local.apply(
      collab.receiveTransaction(local, [deletion], ["other"]),
    );
    expect(unconfirmedSteps(copy)).toHaveLength(1);
    const [first, second] = unconfirmedSteps(append(copy, "Q"));
    const steps = [deletion, first, second];

    const restored = catchUp(local, steps, ["other", "me", "me"]);

    expect(restored.doc.toJSON()).toEqual(serverDoc(steps, base).toJSON());
    expect(collab.getVersion(restored)).toBe(4);
    expect(collab.sendableSteps(restored)).toBeNull();
  });
});
