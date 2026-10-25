import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
/**
 * Applying confirmed steps lost local edits, or applied steps under this
 * editor's client ID as another writer's.
 */
export type StepsDropped = Readonly<{
    editor: Editor;
    clientID: string | number;
    /** The collab version after the confirmed steps were applied. */
    version: number;
    /** The document before they were applied, with every local edit in it. */
    docBefore: ProseMirrorNode;
    /** Unconfirmed local steps that could not be rebased and were discarded. */
    droppedCount: number;
    /**
     * Confirmed steps that carry this editor's client ID at positions where it
     * still had unconfirmed steps, from the first one whose content differs.
     * They were applied as another writer's. Only this count means another
     * writer shares the client ID.
     */
    conflictCount: number;
    /**
     * Confirmed steps that carry this editor's client ID beyond the end of its
     * unconfirmed steps. They were applied as another writer's, which is
     * expected after resuming from a saved list of pending steps shorter than
     * what reached the server. Nonzero does not mean the client ID is shared.
     */
    beyondSavedCount: number;
}>;
/**
 * How many of the steps still unconfirmed after the first `confirmed` did not
 * survive into `after`. A rebase replaces each surviving step but keeps its
 * origin transaction, and steps appended afterwards have new origins.
 */
export declare function countDroppedSteps(before: EditorState, after: EditorState, confirmed: number): number;
/** Build a dropped-steps report for `editor`, whose state is now `after`. */
export declare function droppedStepsReport(editor: Editor, before: EditorState, droppedCount: number, own: Readonly<{
    conflictCount: number;
    beyondSavedCount: number;
}>): StepsDropped;
//# sourceMappingURL=dropped-steps.d.ts.map