import { useConvex, useMutation, useQuery, } from "convex/react";
import { Extension, } from "@tiptap/core";
import * as collab from "prosemirror-collab";
import { Step } from "@tiptap/pm/transform";
import { useCallback, useMemo, useRef } from "react";
import { countDroppedSteps, droppedStepsReport, } from "./dropped-steps.js";
import { matchOwnSteps } from "./own-steps.js";
import { createPendingStepsReporter, } from "./pending-steps.js";
import { createRetryTimer } from "./retry.js";
import { isTerminalSchemaError } from "./sync-lifecycle.js";
import { createSyncObserver, } from "./sync-observations.js";
// How many steps we will attempt to sync in one request.
const MAX_STEPS_SYNC = 1000;
const SNAPSHOT_DEBOUNCE_MS = 1000;
// Set in `onCreate`, so only an editor this extension mounted can be stopped.
const docSyncStoppers = new WeakMap();
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
export function stopDocSync(editor, reason) {
    const stop = docSyncStoppers.get(editor);
    if (!stop) {
        return false;
    }
    stop(reason);
    return true;
}
export function useTiptapSync(syncApi, id, opts) {
    const log = opts?.debug ? console.debug : () => { };
    const convex = useConvex();
    const initial = useInitialState(syncApi, id);
    const extension = useMemo(() => {
        const { loading, ...initialState } = initial;
        if (loading || !initialState.initialContent)
            return null;
        return syncExtension(convex, id, syncApi, initialState, opts);
        // // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [convex, id, initial.loading, initial.initialContent]);
    const submitSnapshot = useMutation(syncApi.submitSnapshot).withOptimisticUpdate((localQueryStore, args) => {
        // This update will allow the useInitialState to respond immediately to
        // creating documents, as if it came from the server.
        const existing = localQueryStore.getQuery(syncApi.getSnapshot, { id });
        if (!existing?.content) {
            localQueryStore.setQuery(syncApi.getSnapshot, { id }, {
                version: args.version,
                content: args.content,
            });
        }
        const version = localQueryStore.getQuery(syncApi.latestVersion, { id });
        if (version === null) {
            localQueryStore.setQuery(syncApi.latestVersion, { id }, args.version);
        }
    });
    const create = useCallback(async (content) => {
        log("Creating new document", { id });
        await submitSnapshot({
            id,
            version: 1,
            content: JSON.stringify(content),
        });
    }, [convex, id]);
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
        };
    }
    if (!initial.initialContent) {
        return {
            extension: null,
            isLoading: false,
            initialContent: null,
            create,
        };
    }
    return {
        extension: extension,
        isLoading: false,
        initialContent: initial.initialContent,
    };
}
/**
 * Synchronize complete history through successive bounded pages. Backend and
 * provider versions should be upgraded together: an older provider applies
 * only one catch-up page and can remain stale until another change arrives.
 */
export function syncExtension(convex, id, syncApi, initialState, opts) {
    const log = opts?.debug ? console.debug : () => { };
    // Background work has no caller to propagate a failure to, so it reports
    // through one of these two. The split is whether local edits were lost.
    // Lost work: tell the app even if it didn't ask to be told, since silently
    // dropping a user's edits is never the right default. Rethrowing from here
    // surfaces as an unhandled rejection, matching `trySync`.
    const reportDataLoss = (error) => {
        if (opts?.onSyncError) {
            opts.onSyncError(error);
        }
        else {
            throw error;
        }
    };
    // Nothing durable lost: report it if the app is listening, then carry on.
    const reportRecoverable = (error) => {
        log("Ignoring recoverable sync error", error);
        opts?.onSyncError?.(error);
    };
    let snapshotTimer;
    const trySubmitSnapshot = (version, content) => {
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
    let stopReason;
    const isSyncStopped = () => stopReason !== undefined;
    let active = false;
    let pending;
    // Every editor that queued behind the active sync, so the retry in
    // `finally` serves all of them.
    const pendingEditors = new Set();
    function resolvePendingWithoutRetry() {
        pendingEditors.clear();
        if (!pending) {
            return;
        }
        const { resolve } = pending;
        pending = undefined;
        resolve();
    }
    function stopSync(reason) {
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
    function enterTerminalSyncFailure(error) {
        stopSync("syncFatal");
        if (opts?.onSyncError) {
            opts.onSyncError(error);
            return;
        }
        throw error;
    }
    function readPersistedStep(schema, serializedStep) {
        return opts?.decodeCollaborationStep
            ? opts.decodeCollaborationStep(schema, serializedStep)
            : Step.fromJSON(schema, JSON.parse(serializedStep));
    }
    // Editor-keyed, not shared closure variables: StrictMode's double-mount
    // briefly gives two live editors the same extension instance, and each must
    // tear down only its own subscription.
    const subscriptions = new Map();
    const beforeUnloadHandlers = new Map();
    const restoredEditors = new WeakSet();
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
    const observe = createSyncObserver((event) => opts?.onSyncObservation?.(event), log);
    function observeSubmission(editor, version, clientId, steps, truncated) {
        observe(Object.freeze({
            kind: "submit",
            editor,
            version,
            clientId,
            steps: Object.freeze([...steps]),
            truncated,
        }));
    }
    function applyConfirmedSteps(editor, steps, clientIds) {
        const fromVersion = collab.getVersion(editor.state);
        const before = editor.state;
        const own = matchOwnSteps(editor.state, steps, clientIds);
        if (own.conflictCount > 0 || own.beyondSavedCount > 0) {
            log("Applying steps that share this client ID as another writer's", {
                conflictCount: own.conflictCount,
                beyondSavedCount: own.beyondSavedCount,
            });
        }
        receiveSteps(editor, steps, own.clientIds);
        if (isSyncStopped() || editor.isDestroyed || !subscriptions.has(editor))
            return;
        observe(Object.freeze({
            kind: "receive",
            editor,
            fromVersion,
            toVersion: fromVersion + steps.length,
            steps: Object.freeze([...steps]),
            clientIds: Object.freeze([...clientIds]),
        }));
        if (opts?.onStepsDropped) {
            const dropped = countDroppedSteps(before, editor.state, own.confirmed);
            if (dropped > 0 || own.conflictCount > 0 || own.beyondSavedCount > 0) {
                const report = droppedStepsReport(editor, before, dropped, own);
                try {
                    opts.onStepsDropped(report);
                }
                catch (error) {
                    log("Ignoring onStepsDropped failure", error);
                }
            }
        }
    }
    function releaseEditorResources(editor) {
        subscriptions.get(editor)?.unsubscribe();
        subscriptions.delete(editor);
        pendingEditors.delete(editor);
        const beforeUnloadHandler = beforeUnloadHandlers.get(editor);
        if (beforeUnloadHandler) {
            window.removeEventListener?.("beforeunload", beforeUnloadHandler);
            beforeUnloadHandlers.delete(editor);
        }
    }
    async function trySync(editor) {
        if (isSyncStopped()) {
            return;
        }
        const subscription = subscriptions.get(editor);
        let serverVersion;
        try {
            // Convex rethrows a failed query here, for example once the backend
            // rejects this person for the document. Most failures are transient,
            // so with `onSyncError` set, report and wait for the watch's next update
            // instead of throwing. Without it, the error propagates as before. This
            // read stays before `active = true` so a throw cannot leave it set.
            serverVersion = subscription?.watch.localQueryResult();
        }
        catch (error) {
            if (!opts?.onSyncError) {
                throw error;
            }
            reportRecoverable(error instanceof Error ? error : new Error("Sync query failed"));
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
                let resolve = () => { };
                let reject = () => { };
                const promise = new Promise((res, rej) => {
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
            if (await doSync(editor, convex, syncApi, id, serverVersion, initialState, opts?.debug, readPersistedStep, () => isSyncStopped() || subscriptions.get(editor) !== subscription, observeSubmission, applyConfirmedSteps)) {
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
        }
        catch (error) {
            // A request that was in flight when the app stopped sync can still
            // fail; the app has already decided what that document's fate is.
            if (stopReason !== undefined && stopReason !== "syncFatal") {
                return;
            }
            if (isTerminalSchemaError(error)) {
                enterTerminalSyncFailure(error instanceof Error
                    ? error
                    : new Error("Editor schema rejected structured content"));
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
            }
            else if (subscriptions.size > 0) {
                // With no editor left there is nothing to retry; the last destroy
                // already cancelled the timer.
                retry?.failed();
            }
            if (opts?.onSyncError) {
                opts.onSyncError(error);
            }
            else {
                throw error;
            }
        }
        finally {
            active = false;
            if (isSyncStopped()) {
                resolvePendingWithoutRetry();
            }
            else if (pending) {
                const { resolve, reject } = pending;
                pending = undefined;
                // Retry every still-subscribed editor that queued — the closure's
                // `editor` may be the destroyed StrictMode twin.
                const targets = [...pendingEditors].filter((e) => subscriptions.has(e));
                pendingEditors.clear();
                if (targets.length > 0) {
                    Promise.all(targets.map((e) => trySync(e))).then(() => resolve(), reject);
                }
                else {
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
            if (wasActive &&
                !isSyncStopped() &&
                opts?.flushOnDestroy !== false &&
                collab.sendableSteps(state)) {
                void _flushPendingSteps(convex, syncApi, id, state, opts?.debug).then((outcome) => {
                    if (outcome === "gave-up") {
                        reportDataLoss(new Error("Unsynced steps could not be flushed after destroy"));
                    }
                }, 
                // The flush resolves "gave-up" for a failed submit but rejects for a
                // step that won't apply, and both mean the steps are lost.
                reportDataLoss);
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
                        tr.step(opts?.decodeRestoredStep
                            ? opts.decodeRestoredStep(editor.schema, step)
                            : Step.fromJSON(editor.schema, step));
                    }
                    editor.view.dispatch(tr);
                }
                catch (error) {
                    if (isTerminalSchemaError(error)) {
                        enterTerminalSyncFailure(error instanceof Error
                            ? error
                            : new Error("Editor schema rejected structured content"));
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
            if (opts?.warnOnUnsyncedClose !== false &&
                typeof window !== "undefined" &&
                typeof window.addEventListener === "function") {
                const beforeUnloadHandler = (e) => {
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
async function doSync(editor, convex, syncApi, id, serverVersion, initialState, debug, readPersistedStep, isStopped, observeSubmission, applyConfirmedSteps) {
    const log = debug ? console.debug : () => { };
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
        }
        else {
            // TODO: Handle deletion gracefully
            throw new Error("Syncing a document that doesn't exist server-side");
        }
    }
    if (isStopped() || editor.isDestroyed)
        return false;
    while (serverVersion !== null &&
        serverVersion > collab.getVersion(editor.state)) {
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
        if (isStopped() || editor.isDestroyed)
            return false;
        // Apply only the steps we don't already have: the local version can
        // advance during the await. Re-applying a prefix would push our version
        // past the server's, and the next submitSteps would then write a delta
        // with a version gap, which no client can read past.
        const skip = collab.getVersion(editor.state) - requestedVersion;
        if (skip >= 0 && skip < steps.steps.length) {
            applyConfirmedSteps(editor, steps.steps
                .slice(skip)
                .map((step) => readPersistedStep(editor.schema, step)), steps.clientIds.slice(skip));
            // A receive observer may have stopped sync or destroyed the editor.
            if (isStopped() || editor.isDestroyed)
                return false;
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
        if (isStopped() || editor.isDestroyed)
            return false;
        const sendable = collab.sendableSteps(editor.state);
        if (!sendable) {
            break;
        }
        const steps = sendable.steps
            .slice(0, MAX_STEPS_SYNC)
            .map((step) => JSON.stringify(step.toJSON()));
        observeSubmission(editor, sendable.version, sendable.clientID, steps, sendable.steps.length > steps.length);
        // The submit observer may have stopped sync, or destroyed the editor,
        // which hands these steps to onDestroy's flush.
        if (isStopped() || editor.isDestroyed)
            return false;
        log("Sending steps", { steps, version: sendable.version });
        const result = await convex.mutation(syncApi.submitSteps, {
            id,
            steps,
            version: sendable.version,
            clientId: sendable.clientID,
        });
        // Destroy may have cleared the schema while the submit was in flight.
        // onDestroy's flush now owns the unconfirmed steps.
        if (editor.isDestroyed)
            return false;
        if (isStopped())
            return false;
        if (result.status === "synced") {
            anyChanges = true;
            // We replay the steps locally to avoid refetching them.
            applyConfirmedSteps(editor, steps.map((step) => readPersistedStep(editor.schema, step)), steps.map(() => sendable.clientID));
            log("Synced", {
                steps,
                version: sendable.version,
                newVersion: collab.getVersion(editor.state),
            });
            continue;
        }
        if (result.status === "needs-rebase") {
            applyConfirmedSteps(editor, result.steps.map((step) => readPersistedStep(editor.schema, step)), result.clientIds);
            log("Rebased", {
                steps,
                newVersion: collab.getVersion(editor.state),
            });
        }
    }
    return anyChanges;
}
function receiveSteps(editor, steps, clientIds) {
    editor.view.dispatch(collab.receiveTransaction(editor.state, steps, clientIds, {
        mapSelectionBackward: true,
    }));
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
export async function _flushPendingSteps(convex, syncApi, id, state, debug) {
    const log = debug ? console.debug : () => { };
    let rebases = 0;
    let rounds = 0;
    while (rebases < MAX_FLUSH_REBASES && rounds < MAX_FLUSH_ROUNDS) {
        const sendable = collab.sendableSteps(state);
        if (!sendable)
            return "flushed";
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
        }
        catch (error) {
            log("Flush after destroy failed", { id, error });
            return "gave-up";
        }
        if (result.status === "synced") {
            state = state.apply(collab.receiveTransaction(state, toSend, toSend.map(() => sendable.clientID), { mapSelectionBackward: true }));
        }
        else {
            const steps = result.steps.map((step) => Step.fromJSON(state.schema, JSON.parse(step)));
            state = state.apply(collab.receiveTransaction(state, steps, matchOwnSteps(state, steps, result.clientIds).clientIds, { mapSelectionBackward: true }));
        }
        rebases = collab.getVersion(state) > sendable.version ? 0 : rebases + 1;
    }
    return collab.sendableSteps(state) ? "gave-up" : "flushed";
}
export function useInitialState(syncApi, id, cacheKeyPrefix) {
    const serverRef = useRef({ id });
    const cachedState = useMemo(() => {
        return getCachedState(id, cacheKeyPrefix);
    }, [id, cacheKeyPrefix]);
    const serverInitial = useQuery(syncApi.getSnapshot, serverRef.current.snapshot && serverRef.current.id === id ? "skip" : { id });
    const snapshot = useMemo(() => {
        return (serverInitial &&
            serverInitial.content !== null && {
            initialContent: JSON.parse(serverInitial.content),
            initialVersion: serverInitial.version,
        });
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
function getCachedState(id, cacheKeyPrefix) {
    if (typeof window === "undefined") {
        return undefined;
    }
    // TODO: Verify that this works
    const cacheKey = `${cacheKeyPrefix ?? "convex-sync"}-${id}`;
    const cache = sessionStorage.getItem(cacheKey);
    if (cache) {
        const { content, version, steps } = JSON.parse(cache);
        return {
            initialContent: content,
            initialVersion: Number(version),
            restoredSteps: (steps ?? []),
        };
    }
}
//# sourceMappingURL=index.js.map