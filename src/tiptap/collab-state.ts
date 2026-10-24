import type { EditorState, PluginKey } from "@tiptap/pm/state";
import type { Step, Transform } from "@tiptap/pm/transform";
import * as collab from "prosemirror-collab";

/** One unconfirmed local step, as prosemirror-collab tracks it. */
export type UnconfirmedStep = Readonly<{
  step: Step;
  /** The step's inverse, applicable to the document after `step`. */
  inverted: Step;
  /** The original transaction. A rebase keeps it while replacing `step`. */
  origin: Transform;
}>;

/**
 * prosemirror-collab's plugin state. Collab replaces the object whenever the
 * version or the unconfirmed steps change, so identity marks a change.
 */
export type CollabPluginState = Readonly<{
  version: number;
  unconfirmed: readonly UnconfirmedStep[];
}>;

// prosemirror-collab does not export its plugin key, but every plugin it
// creates carries the same key in its spec, so a throwaway plugin exposes it.
const collabKey = collab.collab().spec.key as PluginKey<CollabPluginState>;

/** Read the collab plugin's state. Throws if the plugin is not installed. */
export function getCollabState(state: EditorState): CollabPluginState {
  const collabState = collabKey.getState(state);
  if (!collabState) {
    throw new Error("The collab plugin is not installed");
  }
  return collabState;
}

/** The client ID the collab plugin labels this state's local steps with. */
export function getCollabClientID(state: EditorState): string | number {
  const plugin = collabKey.get(state);
  if (!plugin) {
    throw new Error("The collab plugin is not installed");
  }
  return plugin.spec.config.clientID;
}
