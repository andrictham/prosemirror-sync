import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
/** A step serialized with `Step.toJSON`. */
export type StepJSON = {
    stepType: string;
    [key: string]: unknown;
};
/**
 * The editor's unconfirmed local steps. Applying `steps` in order to the
 * document at `version` (the latest {@link SyncBase}) gives the editor's
 * current document.
 */
export type PendingSteps = Readonly<{
    clientID: string | number;
    /** The collab version the steps apply to. */
    version: number;
    /** Treat as immutable: the objects are shared between reports. */
    steps: readonly StepJSON[];
}>;
/** The confirmed document at a collab version: the editor's document without its unconfirmed steps. */
export type SyncBase = Readonly<{
    version: number;
    doc: ProseMirrorNode;
}>;
export type PendingStepsCallbacks = {
    onPendingChange?: (pending: PendingSteps | null, editor: Editor) => void;
    onBaseChange?: (base: SyncBase, editor: Editor) => void;
};
/**
 * Report changes to an editor's unconfirmed steps and confirmed base, keyed on
 * the identity of the collab plugin's state. Returns undefined when neither
 * callback is set, so nothing is tracked.
 */
export declare function createPendingStepsReporter(callbacks: PendingStepsCallbacks | undefined, log: typeof console.log): {
    /**
     * Begin tracking. Tiptap emits `create` a tick after the editor exists,
     * and transactions dispatched before then, such as content set right
     * after construction, are not tracked yet. So the first start compares
     * against the collab plugin's initial state, at `initialVersion` with
     * nothing unconfirmed, and reports once whatever changed since. Starting
     * an editor that is already tracked only reports what changed.
     */
    start(editor: Editor, initialVersion: number): void;
    stop(editor: Editor): void;
    /** Report whatever changed since the last call. Call after each transaction. */
    update: (editor: Editor) => void;
} | undefined;
//# sourceMappingURL=pending-steps.d.ts.map