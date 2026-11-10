export declare const vClientId: import("convex/values").VUnion<string | number, [import("convex/values").VString<string, "required">, import("convex/values").VFloat64<number, "required">], "required", never>;
declare const _default: import("convex/server").SchemaDefinition<{
    snapshots: import("convex/server").TableDefinition<import("convex/values").VObject<{
        id: string;
        version: number;
        content: string;
    }, {
        id: import("convex/values").VString<string, "required">;
        version: import("convex/values").VFloat64<number, "required">;
        content: import("convex/values").VString<string, "required">;
    }, "required", "id" | "version" | "content">, {
        id_version: ["id", "version", "_creationTime"];
    }, {}, {}>;
    deltas: import("convex/server").TableDefinition<import("convex/values").VObject<{
        id: string;
        version: number;
        clientId: string | number;
        steps: string[];
    }, {
        id: import("convex/values").VString<string, "required">;
        version: import("convex/values").VFloat64<number, "required">;
        clientId: import("convex/values").VUnion<string | number, [import("convex/values").VString<string, "required">, import("convex/values").VFloat64<number, "required">], "required", never>;
        steps: import("convex/values").VArray<string[], import("convex/values").VString<string, "required">, "required">;
    }, "required", "id" | "version" | "clientId" | "steps">, {
        id_version: ["id", "version", "_creationTime"];
    }, {}, {}>;
}, true>;
export default _default;
//# sourceMappingURL=schema.d.ts.map