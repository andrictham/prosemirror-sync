import type { EditorState } from "@tiptap/pm/state";
import type { Step } from "@tiptap/pm/transform";
import { getCollabClientID, getCollabState } from "./collab-state.js";

// NaN is never loosely equal to anything, itself included, so
// prosemirror-collab's own-prefix count always stops at it.
const NOT_OWN_CLIENT_ID = Number.NaN;

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
   * How many leading steps carry this state's client ID but do not match its
   * unconfirmed steps. They came from another writer using the same client ID.
   */
  unmatched: number;
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
export function matchOwnSteps(
  state: EditorState,
  steps: readonly Step[],
  clientIds: readonly (string | number)[],
): OwnStepMatch {
  const ownID = getCollabClientID(state);
  const { unconfirmed } = getCollabState(state);
  let own = 0;
  // Loose equality, exactly as prosemirror-collab counts its own prefix.
  while (own < clientIds.length && clientIds[own] == ownID) {
    own++;
  }
  let confirmed = 0;
  while (
    confirmed < own &&
    confirmed < unconfirmed.length &&
    sameStep(steps[confirmed], unconfirmed[confirmed].step)
  ) {
    confirmed++;
  }
  if (confirmed === own) {
    return { clientIds: [...clientIds], confirmed, unmatched: 0 };
  }
  const relabelled = [...clientIds];
  relabelled[confirmed] = NOT_OWN_CLIENT_ID;
  return { clientIds: relabelled, confirmed, unmatched: own - confirmed };
}

function sameStep(a: Step, b: Step) {
  return a === b || sameJSON(a.toJSON(), b.toJSON());
}

/**
 * Structural equality of two JSON values. Object key order is ignored, and a
 * key whose value is undefined counts as missing, as it does once the value
 * is serialized. A step that went through `JSON.stringify` and back, or
 * through a decoder that rebuilds its objects, still equals the original.
 */
function sameJSON(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => sameJSON(item, b[i]))
    );
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!sameJSON(left[key], right[key])) return false;
  }
  return true;
}
