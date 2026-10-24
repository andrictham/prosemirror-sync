import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import { getCollabClientID, getCollabState } from "./collab-state.js";

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
export function countDroppedSteps(
  before: EditorState,
  after: EditorState,
  confirmed: number,
): number {
  const remaining = getCollabState(before).unconfirmed.slice(confirmed);
  if (remaining.length === 0) return 0;
  const origins = new Set(remaining.map(({ origin }) => origin));
  const survived = getCollabState(after).unconfirmed.filter(({ origin }) =>
    origins.has(origin),
  ).length;
  return remaining.length - survived;
}

/** Build a dropped-steps report for `editor`, whose state is now `after`. */
export function droppedStepsReport(
  editor: Editor,
  before: EditorState,
  droppedCount: number,
  own: Readonly<{ conflictCount: number; beyondSavedCount: number }>,
): StepsDropped {
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
