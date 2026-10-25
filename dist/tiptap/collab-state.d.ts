import type { EditorState } from "@tiptap/pm/state";
import type { Step, Transform } from "@tiptap/pm/transform";
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
/** Read the collab plugin's state. Throws if the plugin is not installed. */
export declare function getCollabState(state: EditorState): CollabPluginState;
/** The client ID the collab plugin labels this state's local steps with. */
export declare function getCollabClientID(state: EditorState): string | number;
//# sourceMappingURL=collab-state.d.ts.map