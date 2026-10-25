import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Step } from "@tiptap/pm/transform";
export type OwnStepMatch = {
    /**
     * The client IDs to pass to `confirmationBatches`. Own-labelled steps that
     * do not confirm an unconfirmed step are relabelled as remote.
     */
    clientIds: (string | number)[];
    /** How many steps confirm unconfirmed local steps. */
    confirmed: number;
    /**
     * How many steps carry this state's client ID at positions this state
     * still has unconfirmed steps for, from the first one whose content
     * differs. Only another writer using the same client ID produces these.
     */
    conflictCount: number;
    /**
     * How many steps carry this state's client ID beyond the end of its
     * unconfirmed steps. This is expected when an editor resumes from a saved
     * list of pending steps that is shorter than what reached the server: the
     * extra steps were this client's, but the document does not contain them.
     */
    beyondSavedCount: number;
};
/**
 * Match the confirmed steps that carry this state's client ID, wherever they
 * sit in the batch, against its unconfirmed steps in order.
 *
 * prosemirror-collab treats every leading step with its own client ID as one
 * of its unconfirmed steps, without comparing content. When two writers share
 * a client ID, it then drops the other writer's steps from this document and
 * marks local steps as confirmed that the server never received. So an own
 * step before any remote step must also match by step JSON.
 *
 * After a remote step the server has rebased our steps, so their content no
 * longer equals the unconfirmed steps. They are matched by client ID and order
 * alone. Pass the returned client IDs to `confirmationBatches`, because collab
 * only confirms a leading run of own steps.
 *
 * Matching stops at the first own step that does not match, or that is beyond
 * the unconfirmed steps. From there every step is relabelled as remote, so
 * collab rebases the rest instead of dropping it.
 */
export declare function matchOwnSteps(state: EditorState, steps: readonly Step[], clientIds: readonly (string | number)[]): OwnStepMatch;
/**
 * Split relabelled steps into batches for `receiveTransaction`, which confirms
 * only a leading run of own-labelled steps. Each batch starts with own steps,
 * if any, and is followed by the remote steps up to the next own one. Apply
 * the batches in order, each to the state the previous one produced.
 */
export declare function confirmationBatches(state: EditorState, steps: readonly Step[], clientIds: readonly (string | number)[]): {
    steps: Step[];
    clientIds: (string | number)[];
}[];
/**
 * The transaction that applies one batch from `confirmationBatches` to
 * `state`, and how many of its own-labelled steps were applied as remote.
 *
 * An earlier batch's rebase can drop an unconfirmed step, leaving fewer
 * unconfirmed steps than the batch's leading own run. prosemirror-collab
 * would count the surplus as confirmed and skip it, so the document would
 * miss server content. The surplus is relabelled as remote instead.
 */
export declare function receiveBatch(state: EditorState, batch: {
    steps: Step[];
    clientIds: (string | number)[];
}): {
    transaction: Transaction;
    surplus: number;
};
//# sourceMappingURL=own-steps.d.ts.map