import type { EditorState, Transaction } from "@tiptap/pm/state";
import * as collab from "prosemirror-collab";
import type { Step } from "@tiptap/pm/transform";
import { getCollabClientID, getCollabState } from "./collab-state.js";

// NaN is never loosely equal to anything, itself included, so
// prosemirror-collab's own-prefix count always stops at it.
const NOT_OWN_CLIENT_ID = Number.NaN;

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
export function matchOwnSteps(
  state: EditorState,
  steps: readonly Step[],
  clientIds: readonly (string | number)[],
): OwnStepMatch {
  const ownID = getCollabClientID(state);
  const { unconfirmed } = getCollabState(state);
  const relabelled = [...clientIds];
  let confirmed = 0;
  let sawRemote = false;
  let stopped = false;
  let ownAfterStop = 0;
  for (let i = 0; i < relabelled.length; i++) {
    // Loose equality, exactly as prosemirror-collab compares client IDs.
    if (relabelled[i] != ownID) {
      sawRemote = true;
    } else if (
      !stopped &&
      confirmed < unconfirmed.length &&
      (sawRemote || sameStep(steps[i], unconfirmed[confirmed].step))
    ) {
      confirmed++;
    } else {
      stopped = true;
      ownAfterStop++;
      relabelled[i] = NOT_OWN_CLIENT_ID;
    }
  }
  const conflictCount = Math.min(ownAfterStop, unconfirmed.length - confirmed);
  return {
    clientIds: relabelled,
    confirmed,
    conflictCount,
    beyondSavedCount: ownAfterStop - conflictCount,
  };
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

/**
 * Split relabelled steps into batches for `receiveTransaction`, which confirms
 * only a leading run of own-labelled steps. Each batch starts with own steps,
 * if any, and is followed by the remote steps up to the next own one. Apply
 * the batches in order, each to the state the previous one produced.
 */
export function confirmationBatches(
  state: EditorState,
  steps: readonly Step[],
  clientIds: readonly (string | number)[],
): { steps: Step[]; clientIds: (string | number)[] }[] {
  const ownID = getCollabClientID(state);
  const batches: { steps: Step[]; clientIds: (string | number)[] }[] = [];
  for (let i = 0; i < steps.length; i++) {
    const own = clientIds[i] == ownID;
    const last = batches.at(-1);
    if (!last || (own && last.clientIds.at(-1) != ownID)) {
      batches.push({ steps: [steps[i]], clientIds: [clientIds[i]] });
    } else {
      last.steps.push(steps[i]);
      last.clientIds.push(clientIds[i]);
    }
  }
  return batches;
}

/**
 * The transaction that applies one batch from `confirmationBatches` to
 * `state`, and how many of its own-labelled steps were applied as remote.
 *
 * An earlier batch's rebase can drop an unconfirmed step, leaving fewer
 * unconfirmed steps than the batch's leading own run. prosemirror-collab
 * would count the surplus as confirmed and skip it, so the document would
 * miss server content. The surplus is relabelled as remote instead.
 */
export function receiveBatch(
  state: EditorState,
  batch: { steps: Step[]; clientIds: (string | number)[] },
): { transaction: Transaction; surplus: number } {
  const ownID = getCollabClientID(state);
  const room = getCollabState(state).unconfirmed.length;
  const clientIds = [...batch.clientIds];
  let surplus = 0;
  for (let i = room; i < clientIds.length && clientIds[i] == ownID; i++) {
    clientIds[i] = NOT_OWN_CLIENT_ID;
    surplus++;
  }
  return {
    transaction: collab.receiveTransaction(state, batch.steps, clientIds, {
      mapSelectionBackward: true,
    }),
    surplus,
  };
}
