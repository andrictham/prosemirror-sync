import type { Editor } from "@tiptap/core";
import type { Step } from "@tiptap/pm/transform";
/** A batch of local steps about to be submitted at `version`. */
export type SyncSubmission = Readonly<{
    kind: "submit";
    editor: Editor;
    version: number;
    clientId: string | number;
    /** The serialized steps exactly as submitted. */
    steps: readonly string[];
    /** Whether more sendable steps remain beyond this batch. */
    truncated: boolean;
}>;
/** Confirmed steps that collab applied, moving the editor from `fromVersion` to `toVersion`. */
export type SyncReceipt = Readonly<{
    kind: "receive";
    editor: Editor;
    fromVersion: number;
    toVersion: number;
    steps: readonly Step[];
    clientIds: readonly (string | number)[];
}>;
export type SyncObservation = SyncSubmission | SyncReceipt;
/** Isolate optional observers from the content synchronization protocol. */
export declare function createSyncObserver(onObservation: ((event: SyncObservation) => void) | undefined, log: typeof console.log): (event: SyncObservation) => void;
//# sourceMappingURL=sync-observations.d.ts.map