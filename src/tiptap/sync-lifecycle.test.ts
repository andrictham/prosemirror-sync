import { describe, expect, test } from "vitest";
import { isTerminalSchemaError } from "./sync-lifecycle.js";

describe("terminal schema classification", () => {
  test("recognizes the decoder contract and unsupported node failures", () => {
    const decoded = new Error("unsupported snapshot");
    decoded.name = "EditorSchemaDecodeError";
    expect(isTerminalSchemaError(decoded)).toBe(true);
    expect(isTerminalSchemaError(new Error("Unknown node type: widget"))).toBe(
      true,
    );
    expect(isTerminalSchemaError(new Error("No node type named widget"))).toBe(
      true,
    );
  });
  test("does not stop synchronization for transport errors or arbitrary thrown values", () => {
    expect(isTerminalSchemaError(new Error("connection interrupted"))).toBe(
      false,
    );
    expect(isTerminalSchemaError("Unknown node type")).toBe(false);
    expect(isTerminalSchemaError(null)).toBe(false);
  });
});
