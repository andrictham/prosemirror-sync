import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Step } from "@tiptap/pm/transform";
import {
  type CollabPluginState,
  getCollabClientID,
  getCollabState,
} from "./collab-state.js";

/** A step serialized with `Step.toJSON`. */
export type StepJSON = { stepType: string; [key: string]: unknown };

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

type Tracked = {
  collab: CollabPluginState;
  /** The document at `collab.version`, when known. */
  base: ProseMirrorNode | undefined;
};

/**
 * Report changes to an editor's unconfirmed steps and confirmed base, keyed on
 * the identity of the collab plugin's state. Returns undefined when neither
 * callback is set, so nothing is tracked.
 */
export function createPendingStepsReporter(
  callbacks: PendingStepsCallbacks | undefined,
  log: typeof console.log,
) {
  const onPendingChange = callbacks?.onPendingChange;
  const onBaseChange = callbacks?.onBaseChange;
  if (!onPendingChange && !onBaseChange) {
    return undefined;
  }
  const tracked = new WeakMap<Editor, Tracked>();
  // Rebases replace steps, but appending to the unconfirmed list keeps the
  // existing ones, so most reports reuse every serialized step.
  const serialized = new WeakMap<Step, StepJSON>();

  function toJSON(step: Step): StepJSON {
    let json = serialized.get(step);
    if (!json) {
      json = step.toJSON() as StepJSON;
      serialized.set(step, json);
    }
    return json;
  }

  function isolate(name: string, report: () => void) {
    try {
      report();
    } catch (error) {
      log(`Ignoring ${name} failure`, error);
    }
  }

  /** Report whatever changed since the last call. */
  function update(editor: Editor) {
    const entry = tracked.get(editor);
    if (!entry) return;
    const previous = entry.collab;
    const next = getCollabState(editor.state);
    if (next === previous) return;
    entry.collab = next;
    if (next.version !== previous.version) {
      if (onBaseChange) {
        const doc = nextBase(previous, next, entry.base, editor.state.doc);
        entry.base = doc;
        const base = Object.freeze({ version: next.version, doc });
        isolate("onBaseChange", () => onBaseChange(base, editor));
      } else {
        entry.base = undefined;
      }
    }
    if (!onPendingChange) return;
    if (previous.unconfirmed.length === 0 && next.unconfirmed.length === 0) {
      return;
    }
    const pending =
      next.unconfirmed.length === 0
        ? null
        : Object.freeze({
            clientID: getCollabClientID(editor.state),
            version: next.version,
            steps: Object.freeze(next.unconfirmed.map((u) => toJSON(u.step))),
          });
    isolate("onPendingChange", () => onPendingChange(pending, editor));
  }

  return {
    /**
     * Begin tracking. Tiptap emits `create` a tick after the editor exists,
     * and transactions dispatched before then, such as content set right
     * after construction, are not tracked yet. So the first start compares
     * against the collab plugin's initial state, at `initialVersion` with
     * nothing unconfirmed, and reports once whatever changed since. Starting
     * an editor that is already tracked only reports what changed.
     */
    start(editor: Editor, initialVersion: number) {
      if (!tracked.has(editor)) {
        tracked.set(editor, {
          collab: Object.freeze({ version: initialVersion, unconfirmed: [] }),
          base: undefined,
        });
      }
      update(editor);
      const entry = tracked.get(editor)!;
      if (!entry.base && entry.collab.unconfirmed.length === 0) {
        entry.base = editor.state.doc;
      }
    },
    stop(editor: Editor) {
      tracked.delete(editor);
    },
    /** Report whatever changed since the last call. Call after each transaction. */
    update,
  };
}

/**
 * The document at `next.version`. An own confirmation moves the base forward
 * by the confirmed steps; anything else, such as a rebase, inverts the
 * remaining unconfirmed steps from the current document.
 */
function nextBase(
  previous: CollabPluginState,
  next: CollabPluginState,
  previousBase: ProseMirrorNode | undefined,
  doc: ProseMirrorNode,
): ProseMirrorNode {
  if (next.unconfirmed.length === 0) {
    return doc;
  }
  const confirmed = next.version - previous.version;
  if (previousBase && keepsRemainder(previous, next, confirmed)) {
    let base: ProseMirrorNode | null = previousBase;
    for (let i = 0; i < confirmed && base; i++) {
      base = previous.unconfirmed[i].step.apply(base).doc;
    }
    if (base) return base;
  }
  let base = doc;
  for (let i = next.unconfirmed.length - 1; i >= 0; i--) {
    const result = next.unconfirmed[i].inverted.apply(base);
    if (!result.doc) {
      throw new Error(result.failed ?? "Could not invert an unconfirmed step");
    }
    base = result.doc;
  }
  return base;
}

/**
 * Whether `next` confirmed the first `confirmed` unconfirmed steps of
 * `previous` and kept exactly the rest unchanged. A version move by another
 * writer's steps leaves all of ours unconfirmed, so the counts differ.
 */
function keepsRemainder(
  previous: CollabPluginState,
  next: CollabPluginState,
  confirmed: number,
) {
  if (confirmed <= 0 || confirmed > previous.unconfirmed.length) return false;
  const remaining = previous.unconfirmed.length - confirmed;
  if (next.unconfirmed.length !== remaining) return false;
  for (let i = 0; i < remaining; i++) {
    if (next.unconfirmed[i] !== previous.unconfirmed[confirmed + i]) {
      return false;
    }
  }
  return true;
}
