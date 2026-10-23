/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { getConvexSize, getDocumentSize } from "convex/values";
import schema from "./schema.js";
import { api } from "./_generated/api.js";

const modules = import.meta.glob("./**/*.*s");
const pageBytes = 6 * 1_024 * 1_024;

describe("history record admission", () => {
  test.each([
    { name: "step count", bound: "6,144 steps", kind: "steps" },
    { name: "stored bytes", bound: "6 MiB", kind: "bytes" },
    { name: "expanded client IDs", bound: "6 MiB", kind: "clientIds" },
  ])(
    "rejects a record above the $name page bound without persisting it",
    async ({ bound, kind }) => {
      const t = convexTest({ schema, modules, transactionLimits: true });
      const steps =
        kind === "bytes"
          ? ["x".repeat(pageBytes)]
          : Array.from({ length: kind === "steps" ? 6_145 : 5_000 }, () => "s");
      const clientId = kind === "clientIds" ? "é".repeat(2_000) : "writer";

      await expect(
        t.mutation(api.lib.submitSteps, {
          id: kind,
          version: 0,
          steps,
          clientId,
        }),
      ).rejects.toMatchObject({
        data: `Step submission exceeds history page limit of ${bound}`,
      });
      expect(await t.query(api.lib.latestVersion, { id: kind })).toBeNull();
      expect(await t.query(api.lib.getSteps, { id: kind, version: 0 })).toEqual(
        {
          steps: [],
          clientIds: [],
          version: 0,
        },
      );
    },
  );

  test("rejects an oversized stale submission before returning a rebase page", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    await t.mutation(api.lib.submitSteps, {
      id: "stale",
      version: 0,
      clientId: "other",
      steps: ["accepted"],
    });
    await expect(
      t.mutation(api.lib.submitSteps, {
        id: "stale",
        version: 0,
        clientId: "writer",
        steps: Array.from({ length: 6_145 }, () => "s"),
      }),
    ).rejects.toThrow(
      "Step submission exceeds history page limit of 6,144 steps",
    );
    expect(
      await t.query(api.lib.getSteps, { id: "stale", version: 0 }),
    ).toEqual({
      steps: ["accepted"],
      clientIds: ["other"],
      version: 1,
    });
  });

  test("counts stored metadata even when the response fits its byte budget", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const id = "01234567-89ab-cdef-0123-456789abcdef";
    const emptyRow = { id, version: 1, clientId: "writer", steps: [""] };
    const steps = ["x".repeat(pageBytes - getDocumentSize(emptyRow) + 1)];
    const row = { ...emptyRow, steps };
    expect(getDocumentSize(row)).toBe(pageBytes + 1);
    expect(
      getConvexSize(steps) + getConvexSize("writer") + 128,
    ).toBeLessThanOrEqual(pageBytes);
    await expect(
      t.mutation(api.lib.submitSteps, {
        id,
        version: 0,
        clientId: "writer",
        steps,
      }),
    ).rejects.toThrow("Step submission exceeds history page limit of 6 MiB");
    expect(await t.query(api.lib.latestVersion, { id })).toBeNull();
  });

  test("accepts the maximum step count when the complete response fits", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const clientId = "é".repeat(509);
    const steps = Array.from({ length: 6_144 }, () => "s");
    expect(
      await t.mutation(api.lib.submitSteps, {
        id: "boundary",
        version: 0,
        clientId,
        steps,
      }),
    ).toEqual({ status: "synced" });
    const page = await t.query(api.lib.getSteps, {
      id: "boundary",
      version: 0,
    });
    expect(page.version).toBe(6_144);
    expect(page.steps).toEqual(steps);
    expect(page.clientIds).toEqual(steps.map(() => clientId));
    expect(getConvexSize(page)).toBeLessThanOrEqual(pageBytes);
  });

  test("reserves response framing at the expanded-byte boundary", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    // Per-step values alone use exactly 6 MiB; the response fields exceed it.
    const clientId = `${"é".repeat(509)}x`;
    const steps = Array.from({ length: 6_144 }, () => "s");
    expect(
      steps.reduce(
        (total, step) => total + getConvexSize(step) + getConvexSize(clientId),
        0,
      ),
    ).toBe(pageBytes);
    await expect(
      t.mutation(api.lib.submitSteps, {
        id: "response-framing",
        version: 0,
        clientId,
        steps,
      }),
    ).rejects.toThrow("Step submission exceeds history page limit of 6 MiB");
    expect(
      await t.query(api.lib.latestVersion, { id: "response-framing" }),
    ).toBeNull();
  });
});
