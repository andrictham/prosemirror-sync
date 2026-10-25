import {
  type ConvexReactClient,
  useConvex,
  useMutation,
  useQuery,
  type Watch,
} from "convex/react";
import {
  type AnyExtension,
  type Content,
  type Editor,
  Extension,
  type JSONContent,
} from "@tiptap/core";
import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import * as collab from "prosemirror-collab";
import { Step } from "@tiptap/pm/transform";
import { useCallback, useMemo, useRef } from "react";
import type { SyncApi } from "../client/index.js";
import {
  countDroppedSteps,
  droppedStepsReport,
  type StepsDropped,
} from "./dropped-steps.js";
import {
  confirmationBatches,
  matchOwnSteps,
  receiveBatch,
} from "./own-steps.js";
import {
  createPendingStepsReporter,
  type PendingSteps,
  type SyncBase,
} from "./pending-steps.js";
import { createRetryTimer, type RetryOptions } from "./retry.js";
import { isTerminalSchemaError } from "./sync-lifecycle.js";
import {
  createSyncObserver,
  type SyncObservation,
} from "./sync-observations.js";
export type {
  SyncSubmission,
  SyncReceipt,
  SyncObservation,
} from "./sync-observations.js";
export type { PendingSteps, StepJSON, SyncBase } from "./pending-steps.js";
export type { RetryOptions } from "./retry.js";
export type { StepsDropped } from "./dropped-steps.js";

// How many steps we will attempt to sync in one request.
const MAX_STEPS_SYNC = 1000;
const SNAPSHOT_DEBOUNCE_MS = 1000;

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
  decodeInitialContent?: (
    schema: Schema,
    content: JSONContent,
  ) => ProseMirrorNode;
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

// Set in `onCreate`, so only an editor this extension mounted can be stopped.
const docSyncStoppers = new WeakMap<
  Editor,
  (reason: DocSyncStopReason) => void
>();

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
export function stopDocSync(
  editor: Editor,
  reason: DocSyncStopReason,
): boolean {
  const stop = docSyncStoppers.get(editor);
  if (!stop) {
    return false;
  }
  stop(reason);
  return true;
}

export function useTiptapSync(
  syncApi: SyncApi,
  id: string,
  opts?: UseSyncOptions,
) {
  const log: typeof console.log = opts?.debug ? console.debug : () => {};
  const convex = useConvex();
  const initial = useInitialState(syncApi, id);
  const extension: AnyExtension | null = useMemo(() => {
    const { loading, ...initialState } = initial;
    if (loading || !initialState.initialContent) return null;
    return syncExtension(convex, id, syncApi, initialState, opts);
    // // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convex, id, initial.loading, initial.initialContent]);
  const submitSnapshot = useMutation(
    syncApi.submitSnapshot,
  ).withOptimisticUpdate((localQueryStore, args) => {
    // This update will allow the useInitialState to respond immediately to
    // creating documents, as if it came from the server.
    const existing = localQueryStore.getQuery(syncApi.getSnapshot, { id });
    if (!existing?.content) {
      localQueryStore.setQuery(
        syncApi.getSnapshot,
        { id },
        {
          version: args.version,
          content: args.content,
        },
      );
    }
    const version = localQueryStore.getQuery(syncApi.latestVersion, { id });
    if (version === null) {
      localQueryStore.setQuery(syncApi.latestVersion, { id }, args.version);
    }
  });
  const create = useCallback(
    async (content: JSONContent) => {
      log("Creating new document", { id });
      await submitSnapshot({
        id,
        version: 1,
        content: JSON.stringify(content),
      });
    },
    [convex, id],
  );
  if (initial.loading) {
    return {
      extension: null,
      isLoading: true,
      initialContent: null,
      /**
       * Create the document without waiting to hear from the server.
       * Warning: Only call this if you just created the document id.
       * It's safer to wait until loading is false.
       * It's also best practice to pass in the same initial content everywhere,
       * so if two clients create the same document id, they'll both end up
       * with the same initial content. Otherwise the second client will
       * throw an exception on the snapshot creation.
       */
      create,
    } as const;
  }
  if (!initial.initialContent) {
    return {
      extension: null,
      isLoading: false,
      initialContent: null,
      create,
    } as const;
  }
  return {
    extension: extension!,
    isLoading: false,
    initialContent: initial.initialContent,
  } as const;
}

/**
 * Synchronize complete history through successive bounded pages. Backend and
 * provider versions should be upgraded together: an older provider applies
 * only one catch-up page and can remain stale until another change arrives.
 */
export function syncExtension(
  convex: ConvexReactClient,
  id: string,
  syncApi: SyncApi,
  initialState: InitialState,
  opts?: UseSyncOptions,
): AnyExtension {
  const log: typeof console.log = opts?.debug ? console.debug : () => {};
  // Background work has no caller to propagate a failure to, so it reports
  // through one of these two. The split is whether local edits were lost.

  // Lost work: tell the app even if it didn't ask to be told, since silently
  // dropping a user's edits is never the right default. Rethrowing from here
  // surfaces as an unhandled rejection, matching `trySync`.
  const reportDataLoss = (error: Error) => {
    if (opts?.onSyncError) {
      opts.onSyncError(error);
    } else {
      throw error;
    }
  };
  // Nothing durable lost: report it if the app is listening, then carry on.
  const reportRecoverable = (error: Error) => {
    log("Ignoring recoverable sync error", error);
    opts?.onSyncError?.(error);
  };
  let snapshotTimer: NodeJS.Timeout | undefined;
  const trySubmitSnapshot = (version: number, content: string) => {
    if (isSyncStopped()) {
      return;
    }
    if (snapshotTimer) {
      clearTimeout(snapshotTimer);
    }
    snapshotTimer = setTimeout(() => {
      snapshotTimer = undefined;
      if (isSyncStopped()) {
        return;
      }
      // Snapshots are an optimization over replaying steps, and the next one
      // supersedes this one, so a failure here costs us nothing.
      void convex
        .mutation(syncApi.submitSnapshot, { id, version, content })
        .catch(reportRecoverable);
    }, opts?.snapshotDebounceMs ?? SNAPSHOT_DEBOUNCE_MS);
  };

  // Set once, never cleared: a stopped provider makes no further server calls
  // for any editor it mounted. "syncFatal" is the terminal failure state.
  let stopReason: DocSyncStopReason | "syncFatal" | undefined;
  const isSyncStopped = () => stopReason !== undefined;
  let active: boolean = false;
  let pending:
    | { resolve: () => void; reject: () => void; promise: Promise<void> }
    | undefined;
  // Every editor that queued behind the active sync, so the retry in
  // `finally` serves all of them.
  const pendingEditors = new Set<Editor>();

  function resolvePendingWithoutRetry() {
    pendingEditors.clear();
    if (!pending) {
      return;
    }
    const { resolve } = pending;
    pending = undefined;
    resolve();
  }

  function stopSync(reason: DocSyncStopReason | "syncFatal") {
    if (stopReason !== undefined) {
      return;
    }
    stopReason = reason;
    retry?.cancel();
    if (snapshotTimer) {
      clearTimeout(snapshotTimer);
      snapshotTimer = undefined;
    }
    // Releasing every subscription also makes `onDestroy` skip its flush.
    for (const subscribed of [...subscriptions.keys()]) {
      releaseEditorResources(subscribed);
    }
    resolvePendingWithoutRetry();
  }

  function enterTerminalSyncFailure(error: Error) {
    stopSync("syncFatal");
    if (opts?.onSyncError) {
      opts.onSyncError(error);
      return;
    }
    throw error;
  }

  function readPersistedStep(schema: Schema, serializedStep: string): Step {
    return opts?.decodeCollaborationStep
      ? opts.decodeCollaborationStep(schema, serializedStep)
      : Step.fromJSON(schema, JSON.parse(serializedStep));
  }

  // Editor-keyed, not shared closure variables: StrictMode's double-mount
  // briefly gives two live editors the same extension instance, and each must
  // tear down only its own subscription.
  const subscriptions = new Map<
    Editor,
    { watch: Watch<number | null>; unsubscribe: () => void }
  >();
  const beforeUnloadHandlers = new Map<
    Editor,
    (e: BeforeUnloadEvent) => void
  >();
  const restoredEditors = new WeakSet<Editor>();

  const pendingSteps = createPendingStepsReporter(opts, log);

  // Retries every subscribed editor, so a StrictMode twin that was destroyed
  // after failing is not retried.
  const retry = opts?.retry
    ? createRetryTimer(opts.retry, () => {
        for (const editor of [...subscriptions.keys()]) {
          void trySync(editor);
        }
      })
    : undefined;

  const observe = createSyncObserver(
    (event) => opts?.onSyncObservation?.(event),
    log,
  );

  function observeSubmission(
    editor: Editor,
    version: number,
    clientId: string | number,
    steps: readonly string[],
    truncated: boolean,
  ) {
    observe(
      Object.freeze({
        kind: "submit",
        editor,
        version,
        clientId,
        steps: Object.freeze([...steps]),
        truncated,
      }),
    );
  }

  function applyConfirmedSteps(
    editor: Editor,
    steps: Step[],
    clientIds: (string | number)[],
  ) {
    const fromVersion = collab.getVersion(editor.state);
    const before = editor.state;
    const match = matchOwnSteps(editor.state, steps, clientIds);
    const surplus = receiveSteps(editor, steps, match.clientIds);
    // Own steps beyond what an earlier batch's rebase left unconfirmed were
    // applied as another writer's, like steps beyond the saved ones, and
    // confirmed nothing. Leaving them out of `confirmed` lets the drop count
    // include the step that rebase dropped.
    const own = {
      ...match,
      confirmed: match.confirmed - surplus,
      beyondSavedCount: match.beyondSavedCount + surplus,
    };
    if (own.conflictCount > 0 || own.beyondSavedCount > 0) {
      log("Applying steps that share this client ID as another writer's", {
        conflictCount: own.conflictCount,
        beyondSavedCount: own.beyondSavedCount,
      });
    }
    if (isSyncStopped() || editor.isDestroyed || !subscriptions.has(editor))
      return;
    observe(
      Object.freeze({
        kind: "receive",
        editor,
        fromVersion,
        toVersion: fromVersion + steps.length,
        steps: Object.freeze([...steps]),
        clientIds: Object.freeze([...clientIds]),
      }),
    );
    if (opts?.onStepsDropped) {
      const dropped = countDroppedSteps(before, editor.state, own.confirmed);
      if (dropped > 0 || own.conflictCount > 0 || own.beyondSavedCount > 0) {
        const report = droppedStepsReport(editor, before, dropped, own);
        try {
          opts.onStepsDropped(report);
        } catch (error) {
          log("Ignoring onStepsDropped failure", error);
        }
      }
    }
  }

  function releaseEditorResources(editor: Editor) {
    subscriptions.get(editor)?.unsubscribe();
    subscriptions.delete(editor);
    pendingEditors.delete(editor);
    const beforeUnloadHandler = beforeUnloadHandlers.get(editor);
    if (beforeUnloadHandler) {
      window.removeEventListener?.("beforeunload", beforeUnloadHandler);
      beforeUnloadHandlers.delete(editor);
    }
  }

  async function trySync(editor: Editor) {
    if (isSyncStopped()) {
      return;
    }
    const subscription = subscriptions.get(editor);
    let serverVersion: number | null | undefined;
    try {
      // Convex rethrows a failed query here, for example once the backend
      // rejects this person for the document. Most failures are transient,
      // so with `onSyncError` set, report and wait for the watch's next update
      // instead of throwing. Without it, the error propagates as before. This
      // read stays before `active = true` so a throw cannot leave it set.
      serverVersion = subscription?.watch.localQueryResult();
    } catch (error) {
      if (!opts?.onSyncError) {
        throw error;
      }
      reportRecoverable(
        error instanceof Error ? error : new Error("Sync query failed"),
      );
      return;
    }
    if (serverVersion === undefined) {
      return;
    }
    if (serverVersion && serverVersion > collab.getVersion(editor.state)) {
      clearTimeout(snapshotTimer);
      snapshotTimer = undefined;
    }
    if (active) {
      pendingEditors.add(editor);
      if (!pending) {
        let resolve = () => {};
        let reject = () => {};
        const promise = new Promise<void>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        pending = { resolve, reject, promise };
      }
      return pending.promise;
    }
    active = true;

    try {
      if (isSyncStopped()) {
        return;
      }
      if (
        await doSync(
          editor,
          convex,
          syncApi,
          id,
          serverVersion,
          initialState,
          opts?.debug,
          readPersistedStep,
          () => isSyncStopped() || subscriptions.get(editor) !== subscription,
          observeSubmission,
          applyConfirmedSteps,
        )
      ) {
        if (isSyncStopped()) {
          return;
        }
        const version = collab.getVersion(editor.state);
        const content = JSON.stringify(editor.state.doc.toJSON());
        if (collab.sendableSteps(editor.state)) {
          throw new Error("Synced but still have sendable steps");
        }
        trySubmitSnapshot(version, content);
        // Only a sync that submitted and confirmed steps resets the backoff.
        // False also means the editor was destroyed or its subscription
        // replaced, which says nothing about whether the server is reachable.
        retry?.succeeded();
      }
    } catch (error) {
      // A request that was in flight when the app stopped sync can still
      // fail; the app has already decided what that document's fate is.
      if (stopReason !== undefined && stopReason !== "syncFatal") {
        return;
      }
      if (isTerminalSchemaError(error)) {
        enterTerminalSyncFailure(
          error instanceof Error
            ? error
            : new Error("Editor schema rejected structured content"),
        );
        return;
      }
      // A refused submission would otherwise be resent with every later edit
      // and version update, and each edit typed after it would join it.
      if (error instanceof Error && opts?.isTerminalSyncError?.(error)) {
        enterTerminalSyncFailure(error);
        return;
      }
      if (opts?.isTerminalError?.(error)) {
        retry?.cancel();
      } else if (subscriptions.size > 0) {
        // With no editor left there is nothing to retry; the last destroy
        // already cancelled the timer.
        retry?.failed();
      }
      if (opts?.onSyncError) {
        opts.onSyncError(error as Error);
      } else {
        throw error;
      }
    } finally {
      active = false;
      if (isSyncStopped()) {
        resolvePendingWithoutRetry();
      } else if (pending) {
        const { resolve, reject } = pending;
        pending = undefined;
        // Retry every still-subscribed editor that queued — the closure's
        // `editor` may be the destroyed StrictMode twin.
        const targets = [...pendingEditors].filter((e) => subscriptions.has(e));
        pendingEditors.clear();
        if (targets.length > 0) {
          Promise.all(targets.map((e) => trySync(e))).then(
            () => resolve(),
            reject,
          );
        } else {
          resolve();
        }
      }
    }
  }

  return Extension.create({
    name: "convex-sync",
    onDestroy() {
      log("destroying");
      const editor = this.editor;
      const wasActive = subscriptions.has(editor);
      releaseEditorResources(editor);
      pendingSteps?.stop(editor);
      if (subscriptions.size === 0) {
        retry?.cancel();
      }
      // A snapshot may belong to an editor that's still live, so only cancel
      // it once the last one is gone.
      if (subscriptions.size === 0 && snapshotTimer) {
        clearTimeout(snapshotTimer);
        snapshotTimer = undefined;
      }
      // Unconfirmed steps outlive the view: they're the only record of these
      // edits, and `warnOnUnsyncedClose` covers tab close but can't cover an
      // in-app unmount. 'destroy' fires before the view is torn down and the
      // state is immutable, so it's safe to capture and use afterwards.
      const state = editor.state;
      if (
        wasActive &&
        !isSyncStopped() &&
        opts?.flushOnDestroy !== false &&
        collab.sendableSteps(state)
      ) {
        void _flushPendingSteps(convex, syncApi, id, state, opts?.debug).then(
          (outcome) => {
            if (outcome === "gave-up") {
              reportDataLoss(
                new Error("Unsynced steps could not be flushed after destroy"),
              );
            }
          },
          // The flush resolves "gave-up" for a failed submit but rejects for a
          // step that won't apply, and both mean the steps are lost.
          reportDataLoss,
        );
      }
    },
    onCreate() {
      const editor = this.editor;
      releaseEditorResources(editor);
      docSyncStoppers.set(editor, stopSync);
      if (isSyncStopped()) {
        return;
      }
      pendingSteps?.start(editor, initialState.initialVersion);
      if (initialState.restoredSteps?.length && !restoredEditors.has(editor)) {
        restoredEditors.add(editor);
        log("Restoring local steps", initialState.restoredSteps);
        try {
          const tr = editor.state.tr;
          for (const step of initialState.restoredSteps) {
            tr.step(
              opts?.decodeRestoredStep
                ? opts.decodeRestoredStep(editor.schema, step)
                : Step.fromJSON(editor.schema, step),
            );
          }
          editor.view.dispatch(tr);
        } catch (error) {
          if (isTerminalSchemaError(error)) {
            enterTerminalSyncFailure(
              error instanceof Error
                ? error
                : new Error("Editor schema rejected structured content"),
            );
            return;
          }
          throw error;
        }
      }
      const watch = convex.watchQuery(syncApi.latestVersion, { id });
      const unsubscribe = watch.onUpdate(() => {
        void trySync(editor);
      });
      subscriptions.set(editor, { watch, unsubscribe });
      void trySync(editor);
      // Install beforeunload handler if not explicitly disabled.
      if (
        opts?.warnOnUnsyncedClose !== false &&
        typeof window !== "undefined" &&
        typeof window.addEventListener === "function"
      ) {
        const beforeUnloadHandler = (e: BeforeUnloadEvent) => {
          if (collab.sendableSteps(editor.state)) {
            e.preventDefault();
            // Required for older browsers.
            e.returnValue = "";
          }
        };
        beforeUnloadHandlers.set(editor, beforeUnloadHandler);
        window.addEventListener("beforeunload", beforeUnloadHandler);
      }
    },
    onTransaction() {
      pendingSteps?.update(this.editor);
    },
    onUpdate() {
      if (isSyncStopped()) {
        return;
      }
      void trySync(this.editor);
    },
    addProseMirrorPlugins() {
      log("Adding collab plugin", {
        version: initialState.initialVersion,
      });
      return [
        collab.collab({
          version: initialState.initialVersion,
          clientID: opts?.clientID,
        }),
      ];
    },
  });
}

async function doSync(
  editor: Editor,
  convex: ConvexReactClient,
  syncApi: SyncApi,
  id: string,
  serverVersion: number | null,
  initialState: InitialState,
  debug: boolean | undefined,
  readPersistedStep: (schema: Schema, serializedStep: string) => Step,
  isStopped: () => boolean,
  observeSubmission: (
    editor: Editor,
    version: number,
    clientId: string | number,
    steps: readonly string[],
    truncated: boolean,
  ) => void,
  applyConfirmedSteps: (
    editor: Editor,
    steps: Step[],
    clientIds: (string | number)[],
  ) => void,
) {
  const log: typeof console.log = debug ? console.debug : () => {};
  if (serverVersion === null) {
    if (initialState.initialVersion <= 1) {
      // This is a new document, so we can create it on the server.
      // Note: this should only happen if the initial version is loaded from
      // a local cache. Creating a new document on the client will set the
      // initial version to 1 optimistically.
      log("Syncing new document", { id });
      await convex.mutation(syncApi.submitSnapshot, {
        id,
        version: initialState.initialVersion,
        content: JSON.stringify(initialState.initialContent),
      });
    } else {
      // TODO: Handle deletion gracefully
      throw new Error("Syncing a document that doesn't exist server-side");
    }
  }
  if (isStopped() || editor.isDestroyed) return false;
  while (
    serverVersion !== null &&
    serverVersion > collab.getVersion(editor.state)
  ) {
    const requestedVersion = collab.getVersion(editor.state);
    log("Updating to server version", {
      id,
      version: requestedVersion,
      serverVersion,
    });
    const steps = await convex.query(syncApi.getSteps, {
      id,
      version: requestedVersion,
    });
    if (isStopped() || editor.isDestroyed) return false;
    // Apply only the steps we don't already have: the local version can
    // advance during the await. Re-applying a prefix would push our version
    // past the server's, and the next submitSteps would then write a delta
    // with a version gap, which no client can read past.
    const skip = collab.getVersion(editor.state) - requestedVersion;
    if (skip >= 0 && skip < steps.steps.length) {
      applyConfirmedSteps(
        editor,
        steps.steps
          .slice(skip)
          .map((step) => readPersistedStep(editor.schema, step)),
        steps.clientIds.slice(skip),
      );
      // A receive observer may have stopped sync or destroyed the editor.
      if (isStopped() || editor.isDestroyed) return false;
    }
    // Byte or record limits can stop even a very short nonterminal page.
    // Only the watched head or an empty page establishes completion.
    if (steps.version >= serverVersion || steps.steps.length === 0) {
      break;
    }
  }
  let anyChanges = false;
  while (true) {
    // Stop once the view is gone: dispatching to it is a silent no-op, so
    // editor.state would never advance and this loop would resubmit forever.
    // onDestroy owns the remaining steps from here. Reporting no changes is
    // required — the state still has sendable steps, which trySync treats as
    // an invariant violation on a successful sync.
    if (isStopped() || editor.isDestroyed) return false;
    const sendable = collab.sendableSteps(editor.state);
    if (!sendable) {
      break;
    }
    const steps = sendable.steps
      .slice(0, MAX_STEPS_SYNC)
      .map((step) => JSON.stringify(step.toJSON()));
    observeSubmission(
      editor,
      sendable.version,
      sendable.clientID,
      steps,
      sendable.steps.length > steps.length,
    );
    // The submit observer may have stopped sync, or destroyed the editor,
    // which hands these steps to onDestroy's flush.
    if (isStopped() || editor.isDestroyed) return false;
    log("Sending steps", { steps, version: sendable.version });
    const result = await convex.mutation(syncApi.submitSteps, {
      id,
      steps,
      version: sendable.version,
      clientId: sendable.clientID,
    });
    // Destroy may have cleared the schema while the submit was in flight.
    // onDestroy's flush now owns the unconfirmed steps.
    if (editor.isDestroyed) return false;
    if (isStopped()) return false;
    if (result.status === "synced") {
      anyChanges = true;
      // We replay the steps locally to avoid refetching them.
      applyConfirmedSteps(
        editor,
        steps.map((step) => readPersistedStep(editor.schema, step)),
        steps.map(() => sendable.clientID),
      );
      log("Synced", {
        steps,
        version: sendable.version,
        newVersion: collab.getVersion(editor.state),
      });
      continue;
    }
    if (result.status === "needs-rebase") {
      applyConfirmedSteps(
        editor,
        result.steps.map((step) => readPersistedStep(editor.schema, step)),
        result.clientIds,
      );
      log("Rebased", {
        steps,
        newVersion: collab.getVersion(editor.state),
      });
    }
  }
  return anyChanges;
}

function receiveSteps(
  editor: Editor,
  steps: Step[],
  clientIds: (string | number)[],
) {
  let surplus = 0;
  for (const batch of confirmationBatches(editor.state, steps, clientIds)) {
    const received = receiveBatch(editor.state, batch);
    surplus += received.surplus;
    editor.view.dispatch(received.transaction);
  }
  return surplus;
}

// How many consecutive rebase rounds without version progress the post-destroy
// flush attempts before reporting the steps as lost. Advancing history pages
// and successful submissions reset the count, even when catch-up takes more
// than 20 pages.
// The flush has no editor and no user behind it, and the page may be unloading,
// so it cannot keep retrying a stalled server indefinitely.
const MAX_FLUSH_REBASES = 20;
// Bound total post-destroy work, including advancing pages and successful
// batches. Remaining local edits may be lost when this budget runs out;
// onDestroy reports that outcome through the existing onSyncError handler.
const MAX_FLUSH_ROUNDS = 100;

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
export async function _flushPendingSteps(
  convex: ConvexReactClient,
  syncApi: SyncApi,
  id: string,
  state: EditorState,
  debug?: boolean,
): Promise<"flushed" | "gave-up"> {
  const log: typeof console.log = debug ? console.debug : () => {};
  let rebases = 0;
  let rounds = 0;
  while (rebases < MAX_FLUSH_REBASES && rounds < MAX_FLUSH_ROUNDS) {
    const sendable = collab.sendableSteps(state);
    if (!sendable) return "flushed";
    rounds++;
    // Confirm only what is actually sent this round — the remainder past
    // MAX_STEPS_SYNC drains on the next iteration.
    const toSend = sendable.steps.slice(0, MAX_STEPS_SYNC);
    let result;
    try {
      result = await convex.mutation(syncApi.submitSteps, {
        id,
        version: sendable.version,
        clientId: sendable.clientID,
        steps: toSend.map((step) => JSON.stringify(step.toJSON())),
      });
    } catch (error) {
      log("Flush after destroy failed", { id, error });
      return "gave-up";
    }
    if (result.status === "synced") {
      state = state.apply(
        collab.receiveTransaction(
          state,
          toSend,
          toSend.map(() => sendable.clientID),
          { mapSelectionBackward: true },
        ),
      );
    } else {
      const steps = result.steps.map((step) =>
        Step.fromJSON(state.schema, JSON.parse(step)),
      );
      const { clientIds } = matchOwnSteps(state, steps, result.clientIds);
      for (const batch of confirmationBatches(state, steps, clientIds)) {
        state = state.apply(receiveBatch(state, batch).transaction);
      }
    }
    rebases = collab.getVersion(state) > sendable.version ? 0 : rebases + 1;
  }
  return collab.sendableSteps(state) ? "gave-up" : "flushed";
}

type InitialState = {
  initialContent: Content;
  initialVersion: number;
  restoredSteps?: object[];
};

export function useInitialState(
  syncApi: SyncApi,
  id: string,
  cacheKeyPrefix?: string,
) {
  const serverRef = useRef<{
    id: string;
    snapshot?: InitialState;
  }>({ id });
  const cachedState = useMemo(() => {
    return getCachedState(id, cacheKeyPrefix);
  }, [id, cacheKeyPrefix]);
  const serverInitial = useQuery(
    syncApi.getSnapshot,
    serverRef.current.snapshot && serverRef.current.id === id ? "skip" : { id },
  );
  const snapshot = useMemo(() => {
    return (
      serverInitial &&
      serverInitial.content !== null && {
        initialContent: JSON.parse(serverInitial.content) as Content,
        initialVersion: serverInitial.version,
      }
    );
  }, [serverInitial]);
  if (snapshot || serverRef.current.id !== id) {
    serverRef.current = { id, snapshot: snapshot || undefined };
  }
  const data = serverRef.current.snapshot || cachedState;

  if (data) {
    return {
      loading: false,
      ...data,
    };
  }
  if (!cachedState && serverInitial?.content === null) {
    // We couldn't find it locally or on the server.
    // We could dynamically create a new document here,
    // not sure if that's generally the right pattern (vs. explicit creation).
    return {
      loading: false,
      initialContent: null,
    };
  }
  return {
    loading: true,
  };
}

function getCachedState(
  id: string,
  cacheKeyPrefix?: string,
): InitialState | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  // TODO: Verify that this works
  const cacheKey = `${cacheKeyPrefix ?? "convex-sync"}-${id}`;
  const cache = sessionStorage.getItem(cacheKey);
  if (cache) {
    const { content, version, steps } = JSON.parse(cache);
    return {
      initialContent: content as Content,
      initialVersion: Number(version),
      restoredSteps: (steps ?? []) as object[],
    };
  }
}
