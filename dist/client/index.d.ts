import { type ApiFromModules, type GenericActionCtx, type GenericDataModel, type GenericMutationCtx, type GenericQueryCtx } from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";
import { Schema, Node } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
export type SyncApi = ApiFromModules<{
    sync: ReturnType<ProsemirrorSync["syncApi"]>;
}>["sync"];
export type MutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runQuery" | "runMutation">;
export type ActionCtx = Pick<GenericActionCtx<GenericDataModel>, "runQuery" | "runMutation" | "runAction">;
export declare class ProsemirrorSync<Id extends string = string> {
    component: ComponentApi;
    /**
     * Backend API for the ProsemirrorSync component.
     * Responsible for exposing the `sync` API to the client, and having
     * convenience methods for interacting with the component from the backend.
     *
     * Typically used like:
     *
     * ```ts
     * const prosemirrorSync = new ProsemirrorSync(components.prosemirrorSync);
     * export const {
     * ... // see {@link syncApi} docstring for details
     * } = prosemirrorSync.syncApi({...});
     * ```
     *
     * @param component - Generally `components.prosemirrorSync` from
     * `./_generated/api` once you've configured it in `convex.config.ts`.
     */
    constructor(component: ComponentApi);
    /**
     * Create a new document with the given ID and content.
     *
     * @param ctx - A Convex mutation context.
     * @param id - The document ID.
     * @param content - The document content. Should be ProseMirror JSON.
     * @returns A promise that resolves when the document is created.
     */
    create(ctx: MutationCtx | ActionCtx, id: Id, content: object): Promise<null>;
    /**
     * Get the latest document version and content.
     * History pages share the caller's transaction limits in a mutation; this
     * method does not make arbitrarily large histories fit one transaction.
     *
     * @param ctx - A Convex mutation context.
     * @param id - The document ID.
     * @param schema - Your ProseMirror schema.
     *   For Tiptap, use `getSchema(extensions)`.
     *   For BlockNote, use `editor.pmSchema`.
     * @returns The latest ProseMirror doc (Node) and version.
     */
    getDoc(ctx: MutationCtx | ActionCtx, id: Id, schema: Schema): Promise<{
        version: number;
        doc: Node;
    }>;
    /**
     * Transform the document by applying the given function to the document.
     *
     * This will keep applying the function until the document is synced,
     * so ensure that the function is idempotent (can be applied multiple times).
     *
     * e.g.
     * ```ts
     * import { getSchema } from "@tiptap/core";
     * import { Transform } from "@tiptap/pm/transform";
     *
     * const schema = getSchema(extensions);
     * await prosemirrorSync.transform(ctx, id, schema, (doc) => {
     *   const tr = new Transform(doc);
     *   tr.insert(0, schema.text("Hello world"));
     *   return tr;
     * });
     * ```
     *
     * @param ctx - A Convex mutation context.
     * @param id - The document ID.
     * @param schema - The document schema.
     * @param fn - A function that takes the document and returns a Transform
     *   or null if no changes are needed.
     * @returns A promise that resolves with the transformed document.
     */
    transform(ctx: MutationCtx | ActionCtx, id: Id, schema: Schema, fn: (node: Node, version: number) => Transform | null | Promise<Transform | null>, opts?: {
        clientId?: string;
    }): Promise<Node>;
    /**
     * Expose the sync API to the client for use with the `useTiptapSync` hook.
     * If you export these in `convex/prosemirror.ts`, pass `api.prosemirror`
     * to the `useTiptapSync` hook.
     *
     * It allows you to define optional read and write permissions, along with
     * a callback when new snapshots are available.
     *
     * You can pass the optional type argument `<DataModel>` to have the `ctx`
     * parameter specific to your tables.
     *
     * ```ts
     * import { DataModel } from "./convex/_generated/dataModel";
     * // ...
     * export const { ... } = prosemirrorSync.syncApi<DataModel>({...});
     * ```
     *
     * To define just one function to use for both, you can define it like this:
     * ```ts
     * async function checkPermissions(ctx: QueryCtx, id: string) {
     *   const user = await getAuthUser(ctx);
     *   if (!user || !(await canUserAccessDocument(user, id))) {
     *     throw new Error("Unauthorized");
     *   }
     * }
     * ```
     * @param opts - Optional callbacks.
     * @returns functions to export, so the `useTiptapSync` hook can use them.
     */
    syncApi<DataModel extends GenericDataModel>(opts?: {
        /**
         * Optional callback to check read permissions.
         * Throw an error if the user is not authorized to read the document.
         * @param ctx - A Convex query context.
         * @param id - The document ID.
         */
        checkRead?: (ctx: GenericQueryCtx<DataModel>, id: Id) => void | Promise<void>;
        /**
         * Optional callback to check write permissions.
         * Throw an error if the user is not authorized to write to the document.
         * @param ctx - A Convex mutation context.
         * @param id - The document ID.
         */
        checkWrite?: (ctx: GenericMutationCtx<DataModel>, id: Id) => void | Promise<void>;
        /**
         * Optional callback to run when a new snapshot is available.
         * Version 1 is the initial content.
         * @param ctx - A Convex mutation context.
         * @param id - The document ID.
         * @param snapshot - The snapshot content, as stringified ProseMirror JSON.
         * @param version - The version this snapshot represents.
         */
        onSnapshot?: (ctx: GenericMutationCtx<DataModel>, id: Id, snapshot: string, version: number) => void | Promise<void>;
        /**
         * Whether to prune old snapshots.
         * If set to true, only the original and newest snapshots are kept.
         * @default true
         */
        pruneSnapshots?: boolean;
    }): {
        getSnapshot: import("convex/server").RegisteredQuery<"public", {
            version?: number | undefined;
            id: Id;
        }, Promise<{
            content: null;
        } | {
            content: string;
            version: number;
        }>>;
        submitSnapshot: import("convex/server").RegisteredMutation<"public", {
            id: Id;
            version: number;
            content: string;
        }, Promise<void>>;
        latestVersion: import("convex/server").RegisteredQuery<"public", {
            id: Id;
        }, Promise<number | null>>;
        getSteps: import("convex/server").RegisteredQuery<"public", {
            id: Id;
            version: number;
        }, Promise<{
            clientIds: Array<string | number>;
            steps: Array<string>;
            version: number;
        }>>;
        submitSteps: import("convex/server").RegisteredMutation<"public", {
            id: Id;
            version: number;
            clientId: string | number;
            steps: string[];
        }, Promise<{
            clientIds: Array<string | number>;
            status: "needs-rebase";
            steps: Array<string>;
        } | {
            status: "synced";
        }>>;
    };
}
//# sourceMappingURL=index.d.ts.map