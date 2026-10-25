export function isTerminalSchemaError(error) {
    if (!(error instanceof Error)) {
        return false;
    }
    return (error.name === "EditorSchemaDecodeError" ||
        /unknown node type|no node type/i.test(error.message));
}
//# sourceMappingURL=sync-lifecycle.js.map