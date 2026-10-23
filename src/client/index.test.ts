/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { componentsGeneric, defineSchema } from "convex/server";
import { Schema } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import type { ComponentApi } from "../component/_generated/component.js";
import { register } from "../test.js";
import { ProsemirrorSync } from "./index.js";

const references = componentsGeneric().prosemirrorSync.lib;
const component: ComponentApi = {
  lib: {
    deleteDocument: references.deleteDocument,
    deleteSnapshots: references.deleteSnapshots,
    deleteSteps: references.deleteSteps,
    getSnapshot: references.getSnapshot,
    getSteps: references.getSteps,
    latestVersion: references.latestVersion,
    submitSnapshot: references.submitSnapshot,
    submitSteps: references.submitSteps,
  },
};
const sync = new ProsemirrorSync(component);
const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*" },
    text: {},
  },
});
const emptyDoc = schema.node("doc", null, [schema.node("paragraph")]);

function setup() {
  const t = convexTest({
    schema: defineSchema({}),
    modules: import.meta.glob("../component/**/*.ts"),
    transactionLimits: true,
  });
  register(t);
  return t;
}

function insertStep(text: string) {
  const transform = new Transform(emptyDoc).insert(1, schema.text(text));
  return JSON.stringify(transform.steps[0].toJSON());
}

describe("getDoc history paging", () => {
  test.each([
    { budget: "record", records: 105, stepsPerRecord: 1 },
    { budget: "step", records: 2, stepsPerRecord: 5_000 },
  ])(
    "reconstructs every $budget page and returns the final version",
    async ({ records, stepsPerRecord }) => {
      const t = setup();
      const id = "paged-document";
      await t.run((ctx) => sync.create(ctx, id, emptyDoc.toJSON()));
      const textByRecord: string[] = [];
      for (let index = 0; index < records; index++) {
        const text = String.fromCharCode(65 + (index % 26));
        textByRecord.push(text.repeat(stepsPerRecord));
        await t.mutation(component.lib.submitSteps, {
          id,
          version: 1 + index * stepsPerRecord,
          clientId: index,
          steps: Array.from({ length: stepsPerRecord }, () => insertStep(text)),
        });
      }

      const result = await t.run(async (ctx) => {
        const { doc, version } = await sync.getDoc(ctx, id, schema);
        return { text: doc.textContent, version };
      });
      expect(result.version).toBe(1 + records * stepsPerRecord);
      expect(result.text === textByRecord.reverse().join("")).toBe(true);
    },
  );

  test("keeps the aggregate mutation read limit across individually bounded pages", async () => {
    const t = setup();
    const id = "transaction-limit";
    await t.run((ctx) => sync.create(ctx, id, emptyDoc.toJSON()));
    const step = insertStep("é".repeat(448_000));
    for (let index = 0; index < 19; index++) {
      await t.mutation(component.lib.submitSteps, {
        id,
        version: index + 1,
        clientId: index,
        steps: [step],
      });
    }

    await expect(
      t.run(async (ctx) => {
        const { doc, version } = await sync.getDoc(ctx, id, schema);
        return { textLength: doc.textContent.length, version };
      }),
    ).rejects.toThrow("Read too much data in a single function execution");
  });
});
