import * as collab from "prosemirror-collab";
// prosemirror-collab does not export its plugin key, but every plugin it
// creates carries the same key in its spec, so a throwaway plugin exposes it.
const collabKey = collab.collab().spec.key;
/** Read the collab plugin's state. Throws if the plugin is not installed. */
export function getCollabState(state) {
    const collabState = collabKey.getState(state);
    if (!collabState) {
        throw new Error("The collab plugin is not installed");
    }
    return collabState;
}
/** The client ID the collab plugin labels this state's local steps with. */
export function getCollabClientID(state) {
    const plugin = collabKey.get(state);
    if (!plugin) {
        throw new Error("The collab plugin is not installed");
    }
    return plugin.spec.config.clientID;
}
//# sourceMappingURL=collab-state.js.map