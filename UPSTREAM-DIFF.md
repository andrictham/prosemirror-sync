# Upstream-candidate ledger

This fork is based on upstream
[convex/prosemirror-sync](https://github.com/convex/prosemirror-sync) 0.2.7, at
upstream `main` commit `6d6009e` ("Rename GitHub org references from get-convex
to convex", #283). Upstream was merged in with an ordinary merge commit,
`d97c08b`, as [AGENTS.md](./AGENTS.md) requires.

This file is a ledger of every change on `main` since `6d6009e`
(`git log 6d6009e..main`). [Upstream candidates](#upstream-candidates) lists
changes that could become upstream pull requests. [Not for upstream](#not-for-upstream)
lists fork-only tooling. Every fork commit updates its entry here in the same
commit. A commit cannot cite its own SHA, so an entry cites the commits that
introduced its change, and a later commit adds the SHA of the one before it
when it touches the entry again.

Each candidate entry gives:

- **Problem:** what goes wrong upstream without the change.
- **Change:** what the change does.
- **Commits:** short SHA and subject on `main`.
- **Touches:** files, with functions or line ranges on `main` where relevant.
  Line ranges are as of the commit that last edited the entry.
- **Verdict:** yes, no, or fork-only, with the reason.
- **Upstream PR:** the pull request or issue link, or "none yet".

Line ranges for `src/tiptap/index.ts`: options type 45-197, `stopDocSync`
225-235, `useTiptapSync` 314-772 (with `stopSync` from 389,
`enterTerminalSyncFailure` from 406, `applyConfirmedSteps` 470-509,
`releaseEditorResources` from 510, `trySync` from 521, and `onCreate` /
`onDestroy` after it), `doSync` 774-917, `_flushPendingSteps` 956-1010.

## Upstream candidates

### 1. Schema and lifecycle guards

- **Problem:** A document the app's schema cannot represent loops or corrupts
  instead of failing, a re-created editor keeps a stale subscription, restored
  steps can be replayed twice, and an app cannot observe sync without forking
  the provider.
- **Change:**
  - Optional decoders `decodeInitialContent`, `decodeCollaborationStep` and
    `decodeRestoredStep` decode snapshots and steps against the live schema.
  - A schema rejection (`isTerminalSchemaError` in
    `src/tiptap/sync-lifecycle.ts`) stops syncing, cancels snapshots, releases
    every editor's subscription and reports through `onSyncError`.
  - `onSyncObservation` reports each `submit` attempt and each applied
    `receive`; observer exceptions are isolated
    (`src/tiptap/sync-observations.ts`).
  - Restored steps replay once per editor, `onCreate` releases a stale
    subscription, a sync loop whose subscription was replaced stops
    (`isStopped`), and `onDestroy` flushes only for a subscribed editor.
  - `useBlockNoteSync` converts the snapshot through a headless converter that
    is always destroyed, uses `decodeInitialContent` when set, and fails closed:
    no editor and no `create`, reported once through `onSyncError`. `create` is
    therefore optional in the result type.
- **Commits:** `3129388` fix(sync): Preserve schema and lifecycle guards.
  The merge `d97c08b` keeps upstream #281's `editor.isDestroyed` guard in
  `doSync` verbatim and adds `if (isStopped()) return false;` on its own line
  after it.
- **Touches:** `src/tiptap/sync-lifecycle.ts`,
  `src/tiptap/sync-lifecycle.test.ts`, `src/tiptap/sync-observations.ts`,
  `src/blocknote/index.ts` `useBlockNoteSync` (from line 54),
  `src/tiptap/index.ts` options, `onCreate`, `onDestroy`, `doSync`,
  `src/tiptap/index.test.ts`.
- **Verdict:** yes, after splitting. It mixes five concerns and rewrites
  upstream code in place, including an error-message match on `unknown node
  type` / `no node type` that applies with no decoder set. Propose the decoders,
  the observer and the lifecycle fixes as separate pull requests.
- **Upstream PR:** none yet.

### 2. Development dependency alignment

- **Problem:** The BlockNote change in entry 1 needs the newer `nodeToBlock`
  API, and source and declarations must compile against one ProseMirror copy.
- **Change:** BlockNote dev dependencies 0.51.3 to 0.54.0, Tiptap 3.24.0 to
  3.31.2, and `overrides` pinning `@tiptap/core`, `@tiptap/pm`,
  `prosemirror-model` and `prosemirror-view`.
- **Commits:** `399c49e` chore(build): Add pinned artifact publication (mixed
  with the fork-only artifact build).
- **Touches:** `package.json` `devDependencies` and `overrides`,
  `package-lock.json`.
- **Verdict:** yes, only together with entry 1, and with the lockfile
  regenerated on upstream's toolchain.
- **Upstream PR:** none yet.

### 3. Bounded history paging

- **Problem:** Large histories exceed Convex's per-transaction read and return
  limits, or are cut off silently by the 100-record `take`, which leaves clients
  stale or breaks document reconstruction.
- **Change:**
  - `getSteps` and stale `submitSteps` responses return whole delta records as
    contiguous pages of at most 6,144 steps, 6 MiB and 100 records.
    `MAX_DELTA_FETCH` and target-version splitting are removed.
  - `deleteSteps` streams deletion and reschedules itself with a continuation.
  - Tiptap catch-up, the `getLatestVersion` server helper and the destroy-time
    flush loop over pages until the watched version or an empty page.
  - The flush counts only consecutive rebases without version progress toward
    `MAX_FLUSH_REBASES` (20).
  - The `convex` peer minimum rises to `^1.31.7` for `getConvexSize` and
    `getDocumentSize`.
- **Commits:** `afbf270` fix(sync): Bound history reads and catch-up.
- **Touches:** `src/component/lib.ts` `submitSteps` (87-133),
  `stepsAndClientIds` (135-145), `historyResponseBytes` (147-154),
  `readHistoryPage` (194-232), `fetchSteps` (234-251), `getSteps` (253-264),
  `deleteSteps` (317-376); `src/client/index.ts` `getLatestVersion` (317-341);
  `src/tiptap/index.ts` `doSync` catch-up and `_flushPendingSteps`;
  `package.json` peer range; tests `src/component/lib.paging.test.ts`,
  `src/client/index.test.ts`, `src/tiptap/history-paging.test.ts`,
  `src/tiptap/index.test.ts`.
- **Verdict:** yes. It fixes silent truncation upstream. It is an in-place
  rewrite and changes `fetchSteps`'s signature, so it needs discussion first.
- **Upstream PR:** none yet.

### 4. History record admission limits

- **Problem:** Whole-record paging only makes progress if every stored record
  fits one page.
- **Change:** `submitSteps` rejects a submission over 6,144 steps or 6 MiB,
  counting stored metadata, repeated client IDs and response framing, before it
  reads history or inserts a delta, and reports the reason in `ConvexError`
  data.
- **Commits:** `6c43fc1` fix(sync): Reject oversized history records.
- **Touches:** `src/component/lib.ts` `submitSteps` (87-133) and
  `historyResponseBytes` (147-154); `src/component/lib.admission.test.ts`.
- **Verdict:** yes, in the same pull request as entry 3.
- **Upstream PR:** none yet.

### 5. Flush budget and debug versions

- **Problem:** A foreign writer that keeps advancing can keep a destroyed
  editor's flush alive indefinitely, and `Synced` debug events log the version
  from before catch-up.
- **Change:** The destroy-time flush stops after `MAX_FLUSH_ROUNDS` (100)
  submissions and reports a drained final round as flushed. Debug events log
  each submitted batch's version.
- **Commits:** `705ba71` fix(sync): Cap flushes and log batch versions.
- **Touches:** `src/tiptap/index.ts` `_flushPendingSteps` (956-1010) and the
  `debug` log in `doSync`; `src/tiptap/index.test.ts`,
  `src/tiptap/history-paging.test.ts`.
- **Verdict:** yes, with entry 3.
- **Upstream PR:** none yet.

### 6. Example create guard

- **Problem:** After entry 1, a failed BlockNote conversion returns no `create`,
  and the example fails the full typecheck.
- **Change:** The BlockNote example calls `sync.create` only when present.
- **Commits:** `c5a0188` fix(example): Guard missing create capability.
- **Touches:** `example/src/BlockNoteExample.tsx`.
- **Verdict:** yes, only together with entry 1.
- **Upstream PR:** none yet.

### 7. Baseline lint fixes

- **Problem:** Upstream's tree had three lint errors.
- **Change:** Clears them.
- **Commits:** `69e7271` fix(lint): Clear the three baseline lint errors.
- **Touches:** `src/tiptap/index.ts` (3 lines), `scripts/verify-package.mjs`
  (1 line, fork-only file).
- **Verdict:** yes for the `src/tiptap/index.ts` part, if upstream's lint still
  reports them; the script line is fork-only.
- **Upstream PR:** none yet.

### 8. Content-checked own-step confirmation

- **Problem:** prosemirror-collab counts its own prefix by client ID alone. Two
  writers sharing a client ID, such as two tabs restored from one saved session,
  drop each other's steps and mark unsent local steps confirmed, so documents
  diverge.
- **Change:** Before collab applies confirmed steps, the provider compares the
  leading own-client-ID steps with its unconfirmed steps by structural equality
  of `toJSON()` (`matchOwnSteps`). Only the matching prefix is confirmed; the
  first mismatch is relabelled so collab rebases over it. Applies to catch-up,
  `needs-rebase` responses and the flush. With distinct client IDs nothing
  changes.
- **Commits:** `cf6d427` feat(tiptap): Confirm own steps by content. `ce0867b`
  fix(tiptap): Compare own steps structurally. `d7e80ca` fix(tiptap): Count ID
  conflicts apart from resumes.
- **Touches:** `src/tiptap/own-steps.ts`, `src/tiptap/own-steps.test.ts`,
  `src/tiptap/collab-state.ts`; `src/tiptap/index.ts` `applyConfirmedSteps`
  (470-509) and the rebase branch of `_flushPendingSteps`.
- **Verdict:** yes. It fixes silent data loss for any app that reuses client
  IDs. Runs with no option set, so upstream should review the cost.
- **Upstream PR:** none yet.

### 9. Client ID option

- **Problem:** An app that restores unconfirmed steps through `restoredSteps`
  must resume under the same client ID, or steps that already reached the server
  are submitted twice.
- **Change:** `UseSyncOptions.clientID` sets the collab client ID. Unset,
  collab picks a random one as before.
- **Commits:** `4a52831` feat(tiptap): Accept a clientID option.
- **Touches:** `src/tiptap/index.ts` option (line 117) and the `collab.collab`
  call (line 767); `src/tiptap/client-id.test.ts`.
- **Verdict:** yes. Small, additive, and makes `restoredSteps` usable.
- **Upstream PR:** none yet.

### 10. Pending-step and base reports

- **Problem:** An app cannot keep a durable copy of unsent edits to resume
  later; upstream leaves a "TODO: verify that restoring local steps works".
- **Change:** `onPendingChange(pending | null, editor)` reports unconfirmed
  steps as `{ clientID, version, steps }`; `onBaseChange(base, editor)` reports
  the confirmed document when the collab version changes. Tracking starts at
  `onCreate` and reports changes made before it. Nothing is tracked when neither
  is set. The TODO is removed because a test now covers resuming.
- **Commits:** `6d1eb4f` feat(tiptap): Report pending steps. `78c512e`
  fix(tiptap): Report pending steps made before create.
- **Touches:** `src/tiptap/pending-steps.ts`, `src/tiptap/pending-steps.test.ts`;
  `src/tiptap/index.ts` options (from line 117), type exports and the
  `onTransaction` / `onCreate` hooks.
- **Verdict:** yes, after entry 9.
- **Upstream PR:** none yet.

### 11. Sync retry after failures

- **Problem:** After a transient failure upstream does not try again until
  something else changes, so unsent edits can wait indefinitely.
- **Change:** `retry: true` or `{ initialMs, maxMs }` retries on one timer with
  backoff 1, 2, 4, 8, 16 then 30 seconds, reset by a sync that confirms steps.
  It stops when the last editor is destroyed, on terminal failure, or when
  `isTerminalError(error)` says so. Unset, behaviour is upstream's.
- **Commits:** `9c91384` feat(tiptap): Retry sync after transient failures.
  `d9e77c1` fix(tiptap): Retry only for live, unfinished syncs.
- **Touches:** `src/tiptap/retry.ts`, `src/tiptap/retry.test.ts`;
  `src/tiptap/index.ts` options (line 155) and the timer in `useTiptapSync`
  (from line 438) and `trySync`.
- **Verdict:** yes. Additive and generic.
- **Upstream PR:** none yet.

### 12. Dropped-step reports

- **Problem:** prosemirror-collab discards a rebased step that no longer applies
  without telling anyone.
- **Change:** `onStepsDropped(event)` reports `droppedCount`, `conflictCount`
  and `beyondSavedCount`, with `docBefore`, the client ID and the new version.
  Isolated like `onSyncObservation`; the flush does not report.
- **Commits:** `8c74265` feat(tiptap): Report steps dropped by rebase.
  `d7e80ca` fix(tiptap): Count ID conflicts apart from resumes.
- **Touches:** `src/tiptap/dropped-steps.ts`, `src/tiptap/dropped-steps.test.ts`;
  `src/tiptap/index.ts` option (line 174) and `applyConfirmedSteps` (470-509).
- **Verdict:** yes, after entry 8.
- **Upstream PR:** none yet.

### 13. Optional destroy-time flush

- **Problem:** An app that resubmits its own durable copy of unsent steps races
  the destroyed editor's flush.
- **Change:** `flushOnDestroy: false` skips the flush and its data-loss report.
  Default `true`.
- **Commits:** `3fec367` feat(tiptap): Make the destroy-time flush optional.
- **Touches:** `src/tiptap/index.ts` option (line 183) and the `onDestroy`
  condition (line 678); `src/tiptap/flush-on-destroy.test.ts`.
- **Verdict:** yes. One option, default unchanged.
- **Upstream PR:** none yet.

### 14. App-initiated sync stop

- **Problem:** When access is revoked or the identity changes, an app cannot
  stop sync without destroying the editor, and the flush would send the edits
  anyway.
- **Change:** `stopDocSync(editor, reason)` stops the provider for good:
  no steps, snapshots, flush, retry or `beforeunload` warning. Local edits stay.
  A stop from inside `onSyncObservation` takes effect at once. The terminal
  schema path's `schemaFatal` flag becomes `stopReason`, with teardown in a
  shared `stopSync`.
- **Commits:** `65b3042` feat(tiptap): Let the app stop a document's sync.
  `04e90ab` fix(tiptap): Honour a stop from a sync observer.
- **Touches:** `src/tiptap/index.ts` `stopDocSync` (225-235), `stopSync` (from
  line 389), the `onCreate` registration and the guards after each observation
  in `doSync` (774-917); `src/tiptap/stop-doc-sync.test.ts`.
- **Verdict:** yes. Additive; nothing changes until the app calls it. Depends
  on the terminal path from entry 1.
- **Upstream PR:** none yet.

### 15. Terminal sync-error classifier

- **Problem:** A submission the server refuses for good is resent with every
  later edit and version update.
- **Change:** `isTerminalSyncError(error)` marks a caught error as permanent,
  entering the same terminal state as a schema failure (renamed
  `enterTerminalSyncFailure`). Unset, errors are handled as before.
- **Commits:** `a8d9c36` feat(tiptap): Classify terminal sync errors.
- **Touches:** `src/tiptap/index.ts` option (line 196),
  `enterTerminalSyncFailure` (from line 406) and the check in `trySync`
  (line 614); `src/tiptap/terminal-sync-error.test.ts`.
- **Verdict:** yes, after entry 14.
- **Upstream PR:** none yet.

### 16. Failed latest-version reads

- **Problem:** The Convex client rethrows a failed query from
  `localQueryResult()`, which in `trySync` became an unhandled rejection on
  every update.
- **Change:** The read is wrapped in `try`. With `onSyncError` set, the error is
  reported through the existing `reportRecoverable` path and the attempt ends;
  without it the error propagates as before.
- **Commits:** `d5efd89` fix(tiptap): Report failed latest-version reads.
- **Touches:** `src/tiptap/index.ts` `trySync` (line 533);
  `src/tiptap/watch-read-failure.test.ts`.
- **Verdict:** yes. Small and additive.
- **Upstream PR:** none yet.

### 17. Gaps between step records

- **Problem:** `fetchSteps` checks only that the first record of a page starts
  at the requested version. A gap between later records in the same page is
  joined silently, so clients apply steps against the wrong document. When the
  gap is shorter than the next record, the next page re-reads that record's
  tail, so step counts can add up while the content is wrong.
- **Change:** `fetchSteps` checks that every record starts where the previous
  one ended and throws the existing `Missing steps` error otherwise. No option.
- **Commits:** `b743c3b` fix(sync): Refuse gaps between step records.
- **Touches:** `src/component/lib.ts` `fetchSteps` (234-257);
  `src/component/lib.paging.test.ts`.
- **Verdict:** yes. Small and generic, in the same pull request as entry 3.
- **Upstream PR:** none yet.

### 18. Own-confirmation check for base reports

- **Problem:** Follow-up to entry 8. `onBaseChange` read a version move of k
  steps as confirmation of the first k unconfirmed steps. When another writer's
  k steps moved the version instead, the reported base was the old base plus
  our own steps. An app that restored from that base showed our typing twice
  and lost the other writer's.
- **Change:** `keepsRemainder` also requires the new unconfirmed count to equal
  the remainder. Otherwise the base is rebuilt by inverting the unconfirmed
  steps.
- **Commits:** `a5e0c4f` fix(tiptap): Confirm only our own remaining steps.
- **Touches:** `src/tiptap/pending-steps.ts` `keepsRemainder`;
  `src/tiptap/pending-steps.test.ts`.
- **Verdict:** yes, but only together with entry 8; it corrects the base
  reports of entry 10 under content-checked confirmation.
- **Upstream PR:** none yet.

### 19. Own steps anywhere in a catch-up batch

- **Problem:** Follow-up to entry 8. `matchOwnSteps` counted own steps only at
  the front of a catch-up batch. When another copy of this client ID had landed
  our steps behind a remote step, the landed copy was applied as remote and the
  restored unconfirmed step was rebased on top, so the typing showed twice.
- **Change:** Own-client-ID steps anywhere in the batch confirm our unconfirmed
  steps in order; the steps between them stay remote. Content is compared only
  before the first remote step, because a server rebase changes it.
  `confirmationBatches` splits the result into runs that each start with own
  steps, and the provider passes each run to `receiveTransaction` in turn, so
  collab's own leading-run confirmation does the matching. `receiveBatch`
  relabels own steps beyond the unconfirmed steps an earlier batch's rebase
  left, so collab applies them instead of skipping them; they count as
  `beyondSavedCount`.
- **Commits:** `<SHA>` fix(tiptap): Find own steps anywhere in catch-up.
- **Touches:** `src/tiptap/own-steps.ts`, `src/tiptap/own-steps.test.ts`,
  `src/tiptap/dropped-steps.test.ts`; `src/tiptap/index.ts`
  `applyConfirmedSteps`, `receiveSteps` and the rebase branch of
  `_flushPendingSteps`.
- **Verdict:** yes, but only together with entry 8.
- **Upstream PR:** none yet.

### Known departures from AGENTS.md

Entries 1 to 5 predate `AGENTS.md` and break its change policy. They are listed,
not fixed:

- With every option unset, behaviour still differs from upstream: the
  `src/component/lib.ts` and `src/client/index.ts` paging rewrites, the
  catch-up loop, flush cap and rebase counting in `src/tiptap/index.ts`, the
  `onCreate` replay and subscription release, the schema error-message match,
  and the `useBlockNoteSync` rewrite.
- Public type change: `useBlockNoteSync`'s missing-document result has
  `create?` instead of `create` (hence entry 6).
- Drive-by edits: `releaseEditorResources` extracted from `onDestroy`; `doSync`
  gains positional parameters; every `receiveSteps` call goes through
  `applyConfirmedSteps`; the `MAX_FLUSH_REBASES` and `_flushPendingSteps`
  comments are reworded; the `debug` log's `version` changes meaning.
- Upstream tests rewritten: "gives up instead of rebasing forever" became
  "gives up after repeated rebase responses without version progress"; the
  `destroy` helper runs `onCreate` first; `fakeClient` gains `watchQuery`.
- More than one concern per commit: `399c49e` (artifact build and dependency
  bumps), `3129388` (five concerns), `afbf270` (also CI branches and the
  `convex` peer minimum).
- `package.json`: the `convex` peer minimum is raised, and `engines` pins exact
  Node and npm versions.

### No change: version-ahead submissions

The fork deliberately adds no check to `submitSteps` rejecting steps that claim
a version ahead of stored history. An app is expected to call the component
through its own wrapper mutation, which checks access and rejects those first.
Verdict: not proposed; there is no change.

## Not for upstream

Fork-only tooling, guards, CI and policy. Verdict for each: fork-only.

- **Fork policy and this ledger:** `AGENTS.md`, `CLAUDE.md`, `UPSTREAM-DIFF.md`.
  `7ba9d37` docs: Add fork change and branching policy. `4b578c8` docs: List
  fork changes against upstream 0.2.7. `8617dcf` docs: Make fork policy
  maintainer-neutral. `66e7091` docs(agents): Require a noreply commit email.
  `ee79a5a` docs(agents): Describe the enforced guards. The commit that turned
  this file into a ledger is also fork-only.
- **Pinned artifact publication:** CI builds with locked Node, npm and
  TypeScript, verifies the packed exports, and publishes `dist` to immutable
  `artifacts/<source-sha>` branches; the build job holds no token.
  `.github/workflows/build-artifact.yml`, `fork-base.json`,
  `scripts/verify-package.mjs`, `package.json` scripts, `packageManager` and
  `engines`. `399c49e` chore(build): Add pinned artifact publication.
  `aeb5ecd` ci: Publish artifacts from main on 0.2.7 base. `f740a78` ci:
  Publish artifacts only from main. `9b7ffd2` ci(workflows): Keep write tokens
  away from builds.
- **Weekly upstream sync:** merges `main` and upstream into the bot-owned
  `upstream-sync` branch, tests and builds without a token, and opens one pull
  request into `main`. `.github/workflows/upstream-sync.yml`. `c396eca` ci: Sync
  upstream releases weekly. `9b7ffd2` ci(workflows): Keep write tokens away from
  builds.
- **Upstream merge:** `d97c08b` Merge upstream 0.2.7 and later main into the
  fork.
- **Sensitive-content guard:** `scripts/check-sensitive.sh` and its test, the
  `.githooks`, `.github/sensitive-patterns.txt`, the `sensitive-content` and
  `sensitive-history` workflows, `ubuntu-24.04` runner pins (including
  upstream's `test.yml`), the `setup:hooks` and `test:sensitive` scripts, and
  the install-script check in `scripts/verify-package.mjs`. How it works is in
  [AGENTS.md](./AGENTS.md). `d383f7c` ci: Guard against sensitive content.
  `9d13362` ci: Never cancel a sensitive-content run. `05fa1fe` ci: Read added
  diff lines unambiguously. `2052b4e` ci: Match private terms regardless of
  case. `cfdbe96` ci: Skip upstream's commits in the scan. `671fe2e` ci: Scan
  every ref in pre-push. `869cd40` ci: Keep private patterns with the private
  terms. `6b1806d` ci: Install hooks without a lifecycle script. `2c02bd6`
  ci(sensitive): Require terms and check identities. History was rewritten
  once, on 2026-10-25, with the maintainer's approval.
