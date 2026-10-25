import { getCollabClientID, getCollabState } from "./collab-state.js";
/**
 * How many of the steps still unconfirmed after the first `confirmed` did not
 * survive into `after`. A rebase replaces each surviving step but keeps its
 * origin transaction, and steps appended afterwards have new origins.
 */
export function countDroppedSteps(before, after, confirmed) {
    const remaining = getCollabState(before).unconfirmed.slice(confirmed);
    if (remaining.length === 0)
        return 0;
    const origins = new Set(remaining.map(({ origin }) => origin));
    const survived = getCollabState(after).unconfirmed.filter(({ origin }) => origins.has(origin)).length;
    return remaining.length - survived;
}
/** Build a dropped-steps report for `editor`, whose state is now `after`. */
export function droppedStepsReport(editor, before, droppedCount, own) {
    return Object.freeze({
        editor,
        clientID: getCollabClientID(editor.state),
        version: getCollabState(editor.state).version,
        docBefore: before.doc,
        droppedCount,
        conflictCount: own.conflictCount,
        beyondSavedCount: own.beyondSavedCount,
    });
}
//# sourceMappingURL=dropped-steps.js.map