export function isTerminalSchemaError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === "EditorSchemaDecodeError" ||
    /unknown node type|no node type/i.test(error.message)
  );
}
