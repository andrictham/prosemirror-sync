import { getCollabClientID, getCollabState } from "./collab-state.js";
// NaN is never loosely equal to anything, itself included, so
// prosemirror-collab's own-prefix count always stops at it.
const NOT_OWN_CLIENT_ID = Number.NaN;
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
export function matchOwnSteps(state, steps, clientIds) {
    const ownID = getCollabClientID(state);
    const { unconfirmed } = getCollabState(state);
    let own = 0;
    // Loose equality, exactly as prosemirror-collab counts its own prefix.
    while (own < clientIds.length && clientIds[own] == ownID) {
        own++;
    }
    let confirmed = 0;
    while (confirmed < own &&
        confirmed < unconfirmed.length &&
        sameStep(steps[confirmed], unconfirmed[confirmed].step)) {
        confirmed++;
    }
    if (confirmed === own) {
        return {
            clientIds: [...clientIds],
            confirmed,
            conflictCount: 0,
            beyondSavedCount: 0,
        };
    }
    const relabelled = [...clientIds];
    relabelled[confirmed] = NOT_OWN_CLIENT_ID;
    const withinUnconfirmed = Math.min(own, unconfirmed.length);
    return {
        clientIds: relabelled,
        confirmed,
        conflictCount: withinUnconfirmed - confirmed,
        beyondSavedCount: own - withinUnconfirmed,
    };
}
function sameStep(a, b) {
    return a === b || sameJSON(a.toJSON(), b.toJSON());
}
/**
 * Structural equality of two JSON values. Object key order is ignored, and a
 * key whose value is undefined counts as missing, as it does once the value
 * is serialized. A step that went through `JSON.stringify` and back, or
 * through a decoder that rebuilds its objects, still equals the original.
 */
function sameJSON(a, b) {
    if (a === b)
        return true;
    if (typeof a !== "object" ||
        typeof b !== "object" ||
        a === null ||
        b === null) {
        return false;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
        return (Array.isArray(a) &&
            Array.isArray(b) &&
            a.length === b.length &&
            a.every((item, i) => sameJSON(item, b[i])));
    }
    const left = a;
    const right = b;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
        if (!sameJSON(left[key], right[key]))
            return false;
    }
    return true;
}
//# sourceMappingURL=own-steps.js.map