import type { EditorState } from "@tiptap/pm/state";
import type { Step } from "@tiptap/pm/transform";
export type OwnStepMatch = {
    /**
     * The client IDs to pass to `receiveTransaction`. The first own-labelled
     * step whose content does not match is relabelled, so collab confirms only
     * the matching prefix and rebases the rest instead of dropping it.
     */
    clientIds: (string | number)[];
    /** How many leading steps confirm unconfirmed local steps. */
    confirmed: number;
    /**
     * How many leading steps carry this state's client ID at positions this
     * state still has unconfirmed steps for, from the first one whose content
     * differs. Only another writer using the same client ID produces these.
     */
    conflictCount: number;
    /**
     * How many leading steps carry this state's client ID beyond the end of its
     * unconfirmed steps. This is expected when an editor resumes from a saved
     * list of pending steps that is shorter than what reached the server: the
     * extra steps were this client's, but the document does not contain them.
     */
    beyondSavedCount: number;
};
/**
 * Check the leading confirmed steps that carry this state's client ID against
 * its unconfirmed steps, by step JSON.
 *
 * prosemirror-collab treats every leading step with its own client ID as one
 * of its unconfirmed steps, without comparing content. When two writers share
 * a client ID, it then drops the other writer's steps from this document and
 * marks local steps as confirmed that the server never received. Confirming
 * only the matching prefix keeps both writers' steps.
 */
export declare function matchOwnSteps(state: EditorState, steps: readonly Step[], clientIds: readonly (string | number)[]): OwnStepMatch;
//# sourceMappingURL=own-steps.d.ts.map