export declare const submitSnapshot: import("convex/server").RegisteredMutation<"public", {
    pruneSnapshots?: boolean | undefined;
    id: string;
    version: number;
    content: string;
}, Promise<void>>;
export declare const latestVersion: import("convex/server").RegisteredQuery<"public", {
    id: string;
}, Promise<number | null>>;
export declare const submitSteps: import("convex/server").RegisteredMutation<"public", {
    id: string;
    version: number;
    clientId: string | number;
    steps: string[];
}, Promise<{
    readonly status: "needs-rebase";
    readonly clientIds: (string | number)[];
    readonly steps: string[];
} | {
    readonly status: "synced";
    readonly clientIds?: undefined;
    readonly steps?: undefined;
}>>;
export declare const getSnapshot: import("convex/server").RegisteredQuery<"public", {
    version?: number | undefined;
    id: string;
}, Promise<{
    content: null;
    version?: undefined;
} | {
    content: string;
    version: number;
}>>;
export declare const getSteps: import("convex/server").RegisteredQuery<"public", {
    id: string;
    version: number;
}, Promise<{
    steps: string[];
    clientIds: (string | number)[];
    version: number;
}>>;
/**
 * Delete snapshots in the given range, not including the bounds.
 * To clean up old snapshots, call this with the current version as the
 * beforeVersion and the first version (1) as the afterVersion.
 */
export declare const deleteSnapshots: import("convex/server").RegisteredMutation<"public", {
    afterVersion?: number | undefined;
    beforeVersion?: number | undefined;
    id: string;
}, Promise<void>>;
/**
 * Delete steps before some timestamp.
 * To clean up old steps, call this with a date in the past for beforeTs.
 * By default it will ensure that all steps are older than the latest snapshot.
 */
export declare const deleteSteps: import("convex/server").RegisteredMutation<"public", {
    afterVersion?: number | undefined;
    deleteNewerThanLatestSnapshot?: boolean | undefined;
    id: string;
    beforeTs: number;
}, Promise<void>>;
/**
 * Delete a document and all its snapshots & steps.
 */
export declare const deleteDocument: import("convex/server").RegisteredMutation<"public", {
    id: string;
}, Promise<void>>;
//# sourceMappingURL=lib.d.ts.map