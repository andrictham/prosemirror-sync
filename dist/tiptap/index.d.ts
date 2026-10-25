import { type ConvexReactClient } from "convex/react";
import { type AnyExtension, type Content, type Editor, type JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import { Step } from "@tiptap/pm/transform";
import type { SyncApi } from "../client/index.js";
import { type StepsDropped } from "./dropped-steps.js";
import { type PendingSteps, type SyncBase } from "./pending-steps.js";
import { type RetryOptions } from "./retry.js";
import { type SyncObservation } from "./sync-observations.js";
export type { SyncSubmission, SyncReceipt, SyncObservation, } from "./sync-observations.js";
export type { PendingSteps, StepJSON, SyncBase } from "./pending-steps.js";
export type { RetryOptions } from "./retry.js";
export type { StepsDropped } from "./dropped-steps.js";
export type UseSyncOptions = {
    /**
     * Called when syncing fails, including for background work that has no
     * caller to propagate to (the debounced snapshot submit, and the flush of
     * unconfirmed steps when the editor is destroyed).
     *
     * Most errors are informational: the extension keeps syncing and retries on
     * the next local change or update from the server, and a failed snapshot
     * submit costs nothing since snapshots only save replaying steps.
     *
     * The exception is "Unsynced steps could not be flushed after destroy",
     * which means local steps never reached the server before the editor went
     * away. Without a handler that one surfaces as an unhandled rejection
     * rather than being dropped silently.
     */
    onSyncError?: (error: Error) => void;
    snapshotDebounceMs?: number;
    debug?: boolean;
    /**
     * Whether to show a browser warning when closing the tab with unsynced
     * changes. This prevents accidental data loss when the user has local
     * edits that haven't been sent to the server yet.
     * @default true
     */
    warnOnUnsyncedClose?: boolean;
    /**
     * Decode the initial snapshot against the live schema before a writable
     * editor is constructed. Throw to refuse the document without installing
     * the collaboration extension on a live editor.
     */
    decodeInitialContent?: (schema: Schema, content: JSONContent) => ProseMirrorNode;
    /**
     * Decode a persisted collaboration step received as JSON text. Throw to
     * refuse applying it and enter the provider's terminal schema-failure state.
     */
    decodeCollaborationStep?: (schema: Schema, serializedStep: string) => Step;
    /**
     * Decode a restored local step already parsed as JSON. Throw to refuse
     * replay and enter the provider's terminal schema-failure state.
     */
    decodeRestoredStep?: (schema: Schema, restoredStep: object) => Step;
    /**
     * Observes the sync protocol without taking part in it. A `submit` event
     * fires synchronously immediately before each `submitSteps` attempt,
     * including retries of the same batch, so the observer sees the editor state
     * at submission time. A `receive` event fires after collab applies exactly
     * the confirmed steps, excluding any appended normalization, and only while
     * the editor's subscription is live and sync has not failed terminally.
     * Observer exceptions are isolated and never interrupt sync. Submissions
     * made by the headless flush after an editor is destroyed
     * (`_flushPendingSteps`) are not observed.
     */
    onSyncObservation?: (event: SyncObservation) => void;
    /**
     * The collab client ID this editor labels its steps with. By default
     * prosemirror-collab picks a random one for each editor.
     *
     * Set it to resume a saved editing session: pass the client ID the saved
     * steps were made under, so steps that already reached the server are
     * recognized as this editor's own and confirmed instead of submitted
     * again. Two live editors should not share a client ID. If they do, own
     * steps are still confirmed only when their content matches.
     */
    clientID?: string | number;
    /**
     * Called after a transaction changes the editor's unconfirmed local steps:
     * local edits, restored steps, confirmations and rebases. `null` means
     * nothing is left unconfirmed. Steps received from other clients while
     * nothing is unconfirmed do not report.
     *
     * To resume the session later, mount with this `clientID`, the latest
     * {@link SyncBase} as `initialContent` and `initialVersion` (its `doc` as
     * JSON and its `version`), and `steps` as `restoredSteps`.
     *
     * Changes made before Tiptap's deferred `create` event, such as content
     * set right after the editor is constructed, are reported once at create.
     * Reports stop when the editor is destroyed, so they do not cover the
     * destroy-time flush. Exceptions are isolated and never interrupt sync.
     */
    onPendingChange?: (pending: PendingSteps | null, editor: Editor) => void;
    /**
     * Called when the collab version changes, with the confirmed document at
     * the new version: the editor's document without its unconfirmed steps.
     * The base at mount is the `initialContent` and `initialVersion` the
     * extension was created with, and is not reported. When one transaction
     * changes both, this fires before `onPendingChange`. Exceptions are
     * isolated and never interrupt sync.
     */
    onBaseChange?: (base: SyncBase, editor: Editor) => void;
    /**
     * Retry sync on a timer after a failed attempt, instead of waiting for the
     * next local change or server update. `true` waits 1, 2, 4, 8 and 16
     * seconds, then every 30 seconds. One timer serves all of this extension's
     * editors. A sync that submits and confirms steps resets the backoff. The
     * timer stops when the last editor is destroyed, on a terminal schema
     * failure, and on an error that `isTerminalError` classifies as terminal,
     * and a failure after the last editor is gone schedules nothing. Each
     * failure is still
     * reported through `onSyncError`.
     * @default false
     */
    retry?: boolean | RetryOptions;
    /**
     * Classify a sync error as terminal, so `retry` stops instead of
     * scheduling another attempt. Sync still runs again on the next local
     * change or server update.
     */
    isTerminalError?: (error: unknown) => boolean;
    /**
     * Called when applying confirmed steps from the server cost local edits:
     * unconfirmed steps that no longer applied after a rebase were discarded,
     * or steps under this editor's client ID did not match its own and were
     * applied as another writer's. Of those, only `conflictCount` means another
     * writer shares the client ID. `beyondSavedCount` is expected after
     * resuming from a saved list of steps shorter than what reached the server.
     * `docBefore` still holds every local edit, so the app can keep a copy.
     * Fires at most once per batch of received
     * steps, only for a live editor. The destroy-time flush does not report.
     * Exceptions are isolated and never interrupt sync.
     */
    onStepsDropped?: (event: StepsDropped) => void;
    /**
     * Whether destroying an editor that still has unconfirmed steps submits
     * them headlessly (`_flushPendingSteps`). Set `false` when the app keeps
     * its own copy of unsent steps, for example from `onPendingChange`, and
     * submits them itself later. Those steps are then neither flushed nor
     * reported as lost.
     * @default true
     */
    flushOnDestroy?: boolean;
    /**
     * Classify an error the sync loop raised as terminal: retrying can never
     * succeed, for example because the server refused the pending steps for
     * their size or shape. The loop calls this for every error it catches,
     * including catch-up query failures, so return true only for errors that
     * are permanent. The debounced snapshot submission is not classified. Return true to enter the provider's terminal state,
     * which stops watches, snapshot timers, `trySync` retries, and the
     * post-destroy flush, then reports the error through `onSyncError`.
     *
     * `isTerminalError` only stops the `retry` timer and keeps syncing on the
     * next change. This one stops sync for good, as a schema failure does.
     */
    isTerminalSyncError?: (error: Error) => boolean;
};
/**
 * Why the app stopped a document's sync for good.
 *
 * - `accessLost`: the backend now rejects this person for the document.
 * - `identityChanged`: the signed-in identity is no longer the one the editor
 *   was created under.
 * - `discarded`: the person chose to leave without saving.
 */
export type DocSyncStopReason = "accessLost" | "identityChanged" | "discarded";
/**
 * Stop syncing the document behind `editor`, permanently.
 *
 * After this the provider submits no steps or snapshots, including the flush
 * it would otherwise run when the editor is destroyed, and removes its
 * `beforeunload` warning. Local edits stay in the editor state; whether to
 * keep or drop them is the caller's decision.
 *
 * @returns `false` when the provider never mounted `editor`.
 */
export declare function stopDocSync(editor: Editor, reason: DocSyncStopReason): boolean;
export declare function useTiptapSync(syncApi: SyncApi, id: string, opts?: UseSyncOptions): {
    readonly extension: null;
    readonly isLoading: true;
    readonly initialContent: null;
    /**
     * Create the document without waiting to hear from the server.
     * Warning: Only call this if you just created the document id.
     * It's safer to wait until loading is false.
     * It's also best practice to pass in the same initial content everywhere,
     * so if two clients create the same document id, they'll both end up
     * with the same initial content. Otherwise the second client will
     * throw an exception on the snapshot creation.
     */
    readonly create: (content: JSONContent) => Promise<void>;
} | {
    readonly extension: null;
    readonly isLoading: false;
    readonly initialContent: null;
    readonly create: (content: JSONContent) => Promise<void>;
} | {
    readonly extension: AnyExtension;
    readonly isLoading: false;
    readonly initialContent: string | JSONContent | JSONContent[];
    readonly create?: undefined;
};
/**
 * Synchronize complete history through successive bounded pages. Backend and
 * provider versions should be upgraded together: an older provider applies
 * only one catch-up page and can remain stale until another change arrives.
 */
export declare function syncExtension(convex: ConvexReactClient, id: string, syncApi: SyncApi, initialState: InitialState, opts?: UseSyncOptions): AnyExtension;
/**
 * Submit a destroyed editor's unconfirmed local steps: the doSync send loop,
 * run headlessly against the captured EditorState, which is immutable and
 * outlives the view. prosemirror-collab's receiveTransaction behaves as it
 * would live — own-clientID steps confirm (the in-flight submit at destroy may
 * have landed them), foreign steps rebase ours.
 *
 * Best-effort: resolves "gave-up" if the submit fails or a retry budget runs
 * out, and rejects if a step won't apply to the captured state. Any remaining
 * local steps are lost, and `onDestroy` reports both through `onSyncError`.
 *
 * @internal Exported for tests, hence the underscore. Not a supported API.
 */
export declare function _flushPendingSteps(convex: ConvexReactClient, syncApi: SyncApi, id: string, state: EditorState, debug?: boolean): Promise<"flushed" | "gave-up">;
type InitialState = {
    initialContent: Content;
    initialVersion: number;
    restoredSteps?: object[];
};
export declare function useInitialState(syncApi: SyncApi, id: string, cacheKeyPrefix?: string): {
    initialContent: Content;
    initialVersion: number;
    restoredSteps?: object[];
    loading: boolean;
} | {
    loading: boolean;
    initialContent: null;
} | {
    loading: boolean;
    initialContent?: undefined;
};
//# sourceMappingURL=index.d.ts.map