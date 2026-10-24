# Changes from upstream

This fork is based on upstream
[convex/prosemirror-sync](https://github.com/convex/prosemirror-sync) 0.2.7, at
upstream `main` commit `6d6009e` ("Rename GitHub org references from get-convex
to convex", #283). Upstream was merged in with an ordinary merge commit, as
[AGENTS.md](./AGENTS.md) requires.

None of the changes below has been submitted upstream yet.

Diff sizes come from `git diff --shortstat origin/main...` at the time this file
was written, where `origin/main` was upstream `6d6009e`. `src/tiptap/index.ts`
and `src/tiptap/index.test.ts` carry parts of several concerns, so their lines
are counted once under
[Shared Tiptap provider files](#shared-tiptap-provider-files), with each
commit's own contribution listed there.

## Fork policy

- **What:** `AGENTS.md` sets the fork's public-repository, change and branching
  rules. `CLAUDE.md` points coding agents at it. This file lists every change.
- **Why:** Keeps the fork small, additive and easy to merge with new upstream
  releases.
- **Files:** `AGENTS.md`, `CLAUDE.md`, `UPSTREAM-DIFF.md`.
- **Upstream status:** Fork-only. Not for upstream.
- **Size:** `AGENTS.md` and `CLAUDE.md`: 2 files, +30.

## Pinned artifact publication

- **What:** CI builds the package with a locked Node 24.20.0, npm 11.19.0 and
  TypeScript toolchain, verifies the packed exports
  (`scripts/verify-package.mjs`, `npm run build:artifact`), and publishes the
  built `dist` to an immutable `artifacts/<source-sha>` branch. Consumers
  install that artifact commit. `fork-base.json` records the upstream base and
  the contracts the fork's changes provide.
- **Why:** The package is installed from GitHub, so it needs a built `dist` that
  nobody pushes by hand.
- **Files:** `.github/workflows/build-artifact.yml`, `fork-base.json`,
  `scripts/verify-package.mjs`, plus `package.json` (`verify:package` and
  `build:artifact` scripts, `packageManager`, `engines`, `overrides`) and
  `package-lock.json`.
- **Commits:** `7d9dff6` chore(build): Add pinned artifact publication.
  `dde0bd4` also added `history-paging` to the workflow's publishing branches.
- **Upstream status:** Fork-only. Not for upstream.
- **Size:** workflow, `fork-base.json` and script: 3 files, +128. `package.json`
  and `package-lock.json`, which also carry the dependency changes below: 2
  files, +1,889 / -1,226 (the lockfile is +1,860 / -1,210 of that).

## Weekly upstream sync

- **What:** A weekly workflow, also runnable by hand, does nothing when `main`
  already contains upstream `main`. Otherwise it merges `main` and then upstream
  `main` into the bot-owned `upstream-sync` branch with merge commits only, runs
  `npm ci`, `npm test` and `npm run build:artifact`, pushes the branch without
  force, and opens or updates one pull request into `main` titled "Merge
  upstream <version>" with each step's result. Conflict markers are committed so
  the pull request shows them. It never pushes to `main` and never merges.
- **Why:** New upstream releases arrive as a reviewable merge, as
  [AGENTS.md](./AGENTS.md) requires, without anyone watching upstream by hand.
- **Files:** `.github/workflows/upstream-sync.yml`, plus the `upstream-sync`
  line in `AGENTS.md`.
- **Upstream status:** Fork-only. Not for upstream.
- **Size:** 1 file, +126, and 1 line in `AGENTS.md`.

## Sensitive-content guard

- **What:**
  - `scripts/check-sensitive.sh` scans added lines, added file names, commit
    messages and branch names that differ from upstream for secrets, generic
    denylist patterns (`.github/sensitive-patterns.txt`), email addresses other
    than noreply ones, private terms supplied from outside the repository (whole
    words, ignoring case), and workflow runner labels that are not
    GitHub-hosted. It runs gitleaks when installed.
  - Private terms come from `SENSITIVE_TERMS`, the file `SENSITIVE_TERMS_FILE`
    names, or `~/.config/prosemirror-sync/sensitive-terms`. A line starting with
    `re:` is an extended regular expression, matched ignoring case. The public
    patterns file keeps only generic shapes, such as home-directory and
    temporary paths and model names. Patterns that would reveal what the private
    terms protect live with them as `re:` lines. Neither terms nor patterns are
    ever printed, and an invalid pattern fails the scan instead of disabling it.
  - A pushed range is scanned one commit at a time, so content a later commit
    removed is still caught. Commits reachable from upstream are skipped: from
    `upstream/main` when an `upstream` remote is fetched, as the workflow does,
    or else from the base in `fork-base.json`. A merge commit contributes only
    what is new against every parent, so merging an upstream release does not
    fail on upstream's own content.
  - Diff lines are read with `>` and `<` as the added and removed markers, and
    file headers only before a file's first hunk, so an added line that starts
    with `++ ` cannot pass for a header.
  - The `pre-commit`, `commit-msg` and `pre-push` hooks in `.githooks` and the
    `sensitive-content` workflow job all call it. `pre-push` runs each scan with
    no standard input, so a scan cannot consume the rest of the pushed refs. The
    `prepare` script sets `core.hooksPath` in a local git checkout, and does
    nothing in CI or outside a checkout. The workflow never cancels a run, and
    groups runs by commit, because each run scans only its own pushed range.
  - `scripts/check-sensitive.test.sh` (`npm run test:sensitive`, also a step of
    the workflow) plants content in throwaway repositories and checks the
    scanner's and hooks' verdicts.
  - Every workflow now pins `ubuntu-24.04` instead of `ubuntu-latest`.
- **Why:** The repository is public, and the rules in `AGENTS.md` need a check
  that runs before content leaves a machine and again in CI.
- **Files:** `scripts/check-sensitive.sh`, `scripts/check-sensitive.test.sh`,
  `.githooks/*`, `.github/sensitive-patterns.txt`,
  `.github/workflows/sensitive-content.yml`, plus the `runs-on` lines of the
  other workflows, the `prepare` and `test:sensitive` scripts in `package.json`,
  and `AGENTS.md`.
- **Commits:** ci: Guard against sensitive content. ci: Never cancel a
  sensitive-content run. ci: Read added diff lines unambiguously. ci: Match
  private terms regardless of case. ci: Skip upstream's commits in the scan. ci:
  Scan every ref in pre-push. ci: Keep private patterns with the private terms.
- **Upstream status:** Fork-only. Not for upstream. The `runs-on` change touches
  upstream's `test.yml`.

## Development dependency alignment

- **What:** Raises the BlockNote dev dependencies from 0.51.3 to 0.54.0 and
  Tiptap from 3.24.0 to 3.31.2, and pins `@tiptap/core`, `@tiptap/pm`,
  `prosemirror-model` and `prosemirror-view` with `overrides`.
- **Why:** The BlockNote conversion change below uses the newer `nodeToBlock`
  API, and source and declarations must compile together against one ProseMirror
  copy.
- **Files:** `package.json`, `package-lock.json` (counted above).
- **Commits:** `7d9dff6`.
- **Upstream status:** Not submitted.

## Schema and lifecycle guards

- **What:**
  - Optional decoders: `decodeInitialContent`, `decodeCollaborationStep` and
    `decodeRestoredStep` let the app decode snapshots and steps against the live
    schema and refuse content it cannot represent.
  - Terminal schema failure: a schema rejection (`isTerminalSchemaError` in
    `src/tiptap/sync-lifecycle.ts`) stops syncing, cancels snapshots, releases
    every editor's subscription and reports through `onSyncError`, instead of
    retrying forever.
  - Observation: `onSyncObservation` reports each `submit` attempt and each
    applied `receive` without taking part in sync. Observer exceptions are
    isolated (`src/tiptap/sync-observations.ts`).
  - Lifecycle: restored local steps are replayed once per editor, `onCreate`
    releases a stale subscription before subscribing again, a sync loop whose
    subscription was replaced stops (`isStopped`), and `onDestroy` only flushes
    for an editor that was subscribed.
  - BlockNote: `useBlockNoteSync` converts the snapshot through a headless
    converter that is always destroyed, uses `decodeInitialContent` when set,
    and fails closed. A conversion failure returns no editor and no `create`,
    and is reported once through `onSyncError`. `create` is therefore optional
    in the result type.
- **Why:** The app must refuse documents its schema cannot represent without
  corrupting them or looping, and must observe sync for its own diagnostics
  without forking the provider.
- **Files:** `src/tiptap/sync-lifecycle.ts`,
  `src/tiptap/sync-lifecycle.test.ts`, `src/tiptap/sync-observations.ts`,
  `src/blocknote/index.ts`, plus parts of the shared Tiptap files.
- **Commits:** `3acfe6e` fix(sync): Preserve schema and lifecycle guards. This
  was first published on the `sync-seams-0.2.6` branch.
- **Upstream status:** Not submitted.
- **Size:** own files: 4 files, +137 / -27.

### Overlap with upstream #281

Upstream #281 ("guard pending step submissions after editor destruction",
released in 0.2.7) added `if (editor.isDestroyed) return false;` after the
in-flight `submitSteps` await in `doSync`, so that `onDestroy`'s flush owns
unconfirmed steps. Our `3acfe6e` had already guarded the same point with
`if (isStopped() || editor.isDestroyed) return false;`.

The merge takes upstream's comment and guard verbatim. It keeps only our
addition, `if (isStopped()) return false;`, on its own line after upstream's
guard. Our other `isStopped() || editor.isDestroyed` guards, before catch-up,
after each `getSteps` await and at the top of the send loop, have no upstream
counterpart and are unchanged. Upstream's #281 test ("destroy during sync") and
our tests are both kept.

## Bounded history paging

- **What:**
  - `getSteps` and stale `submitSteps` responses return whole delta records as
    contiguous pages of at most 6,144 steps, 6 MiB of stored and expanded
    response data, and 100 records. The old 100-record `take` and its silent
    truncation and target-version splitting are removed.
  - `deleteSteps` streams deletion and reschedules itself with a continuation
    after the last deleted row.
  - The Tiptap provider's catch-up, the `getLatestVersion` server helper, and
    the destroy-time flush loop over pages until they reach the watched version
    or an empty page.
  - The flush counts only consecutive rebases without version progress toward
    its 20-round limit.
  - The `convex` peer minimum rises to `^1.31.7` for `getConvexSize` and
    `getDocumentSize`.
- **Why:** Large histories could exceed Convex's per-transaction read and return
  limits, or be cut off silently, which left clients stale or broke document
  reconstruction.
- **Files:** `src/component/lib.ts`, `src/component/lib.paging.test.ts`,
  `src/client/index.ts`, `src/client/index.test.ts`,
  `src/tiptap/history-paging.test.ts`, `package.json`, plus parts of the shared
  Tiptap files.
- **Commits:** `dde0bd4` fix(sync): Bound history reads and catch-up.
- **Upstream status:** Not submitted.
- **Size:** with admission limits below, own files: 6 files, +1,493 / -78.

## History record admission limits

- **What:** `submitSteps` rejects a submission over 6,144 steps or 6 MiB,
  counting stored metadata, repeated client IDs and response framing, before it
  reads history or inserts a delta. It reports the reason through `ConvexError`
  data.
- **Why:** Whole-record paging can only make progress if every stored record
  fits one page.
- **Files:** `src/component/lib.ts`, `src/component/lib.admission.test.ts`.
- **Commits:** `db9a5a1` fix(sync): Reject oversized history records.
- **Upstream status:** Not submitted.
- **Size:** counted with bounded history paging. The commit itself is +183 /
  -18.

## Flush budget and debug versions

- **What:** The destroy-time flush stops after 100 total submissions, and
  reports a drained final round as flushed. `Synced` debug events log each
  submitted batch's version rather than the version from before catch-up.
- **Why:** A foreign writer that keeps advancing could otherwise keep a
  destroyed editor's flush alive indefinitely, and the logged version was wrong
  after catch-up or rebase.
- **Files:** shared Tiptap files and `src/tiptap/history-paging.test.ts`.
- **Commits:** `5580872` fix(sync): Cap flushes and log batch versions.
- **Upstream status:** Not submitted.
- **Size:** counted in the shared Tiptap files and history paging tests. The
  commit itself is +209 / -8.

## Example create guard

- **What:** The BlockNote example calls `sync.create` only when the result
  exposes it.
- **Why:** After the BlockNote conversion change, a failed conversion returns no
  `create`. The example otherwise fails the full typecheck.
- **Files:** `example/src/BlockNoteExample.tsx`.
- **Commits:** `0fa3547` fix(example): Guard missing create capability.
- **Upstream status:** Not submitted. Only needed together with the BlockNote
  change.
- **Size:** 1 file, +5 / -1.

## Content-checked own-step confirmation

- **What:** Before collab applies confirmed steps, the provider compares the
  leading steps that carry its own client ID with its unconfirmed steps, by
  structural equality of their `toJSON()` output, ignoring key order and
  treating an undefined field as missing (`matchOwnSteps` in
  `src/tiptap/own-steps.ts`). Only the matching prefix is confirmed. The first
  mismatching step is relabelled with a client ID that never matches, so collab
  rebases the remaining local steps over it instead of dropping it. This applies
  to live catch-up, `needs-rebase` responses and the destroy-time flush. A
  mismatch is logged when `debug` is set. `src/tiptap/collab-state.ts` reads
  collab's plugin state and client ID through its plugin key.
- **Why:** prosemirror-collab counts its own prefix by client ID alone. When two
  writers share a client ID, for example two tabs restored from one saved
  session, it drops the other writer's steps from the document and marks local
  steps as confirmed that the server never received, so the documents diverge
  and edits are lost. With distinct client IDs the behaviour is unchanged. The
  check runs on every received batch, with or without any option set. Tests
  round-trip replace-around, add-mark, remove-mark and attribute steps through
  `Step.fromJSON` and through a live synced replay, and none is relabelled.
- **Files:** `src/tiptap/own-steps.ts`, `src/tiptap/own-steps.test.ts`,
  `src/tiptap/collab-state.ts`, plus `applyConfirmedSteps` and the flush's
  rebase branch in `src/tiptap/index.ts`.
- **Commits:** feat(tiptap): Confirm own steps by content. fix(tiptap): Compare
  own steps structurally.
- **Upstream status:** Not submitted. Shaped as its own upstream pull request.
- **Size:** own files: 3 files, +646. `index.ts`: +13 / -5.

## Client ID option

- **What:** `UseSyncOptions.clientID` sets the collab client ID the editor
  labels its steps with. Unset, prosemirror-collab still picks a random one per
  editor.
- **Why:** An app that saves unconfirmed steps and restores them through
  `restoredSteps` must resume under the same client ID. Otherwise steps that
  already reached the server are not recognized as the editor's own and are
  submitted a second time.
- **Files:** `src/tiptap/client-id.test.ts`, plus the option and the
  `collab.collab` call in `src/tiptap/index.ts`.
- **Commits:** feat(tiptap): Accept a clientID option.
- **Upstream status:** Not submitted. Shaped as its own upstream pull request.
- **Size:** own files: 1 file, +192. `index.ts`: +12.

## Pending-step and base reports

- **What:** Two optional callbacks, isolated from sync like `onSyncObservation`:
  - `onPendingChange(pending | null, editor)` reports the editor's unconfirmed
    steps as `{ clientID, version, steps }`, with steps as `Step.toJSON`
    objects, whenever a transaction replaces the collab plugin's state and
    something was or is unconfirmed: local edits, restored steps, confirmations
    and rebases. Steps received while nothing is unconfirmed do not report.
  - `onBaseChange(base, editor)` reports `{ version, doc }`, the confirmed
    document without the unconfirmed steps, only when the collab version
    changes. An own confirmation moves the base forward by the confirmed steps.
    Other changes, such as a rebase, invert the remaining unconfirmed steps from
    the current document.
  - Tracking reads collab's state through its plugin key and runs in the
    extension's `onTransaction` hook. Tiptap emits `create` a tick after the
    editor exists, so tracking starts at `onCreate` from collab's initial state
    (`initialVersion`, nothing unconfirmed), and reports once any change made
    before then. Nothing is tracked when neither callback is set. The "TODO:
    verify that restoring local steps works" comment is removed, since a test
    now covers resuming from these reports.
- **Why:** An app can keep its own durable copy of unsent edits and resume them
  later with `clientID`, the latest base as `initialContent` and
  `initialVersion`, and the pending steps as `restoredSteps`.
- **Files:** `src/tiptap/pending-steps.ts`, `src/tiptap/pending-steps.test.ts`,
  plus the options, type exports and hook calls in `src/tiptap/index.ts`.
- **Commits:** feat(tiptap): Report pending steps. fix(tiptap): Report pending
  steps made before create.
- **Upstream status:** Not submitted. Shaped as its own upstream pull request,
  after the client ID option.
- **Size:** own files: 2 files, +614. `index.ts`: +36 / -1, then +3 / -1 in the
  fix.

## Sync retry after failures

- **What:** `retry: true` (or `{ initialMs, maxMs }`) retries sync on one timer
  after a failed attempt, waiting 1, 2, 4, 8 and 16 seconds, then 30 seconds
  between attempts. A sync that submits and confirms steps resets the backoff.
  One with nothing to send, or one that stops because its editor was destroyed
  or its subscription replaced, does not. The timer stops when the last editor
  is destroyed, on a terminal schema failure, and on an error that the optional
  `isTerminalError(error)` classifier marks as terminal. A failure after the
  last editor is gone schedules nothing. Unset or `false`, sync waits for the
  next local change or server update, as upstream does.
- **Why:** After a transient failure, such as a dropped connection, upstream
  does not try again until something else changes, so unsent edits can wait
  indefinitely. The classifier lets an app stop retrying errors that will never
  succeed without the library knowing the app's error codes.
- **Files:** `src/tiptap/retry.ts`, `src/tiptap/retry.test.ts`, plus the options
  and the timer calls in `src/tiptap/index.ts`.
- **Commits:** feat(tiptap): Retry sync after transient failures. fix(tiptap):
  Retry only for live, unfinished syncs.
- **Upstream status:** Not submitted. Shaped as its own upstream pull request.
- **Size:** own files: 2 files, +308. `index.ts`: +39, then +12 / -5 in the fix.

## Dropped-step reports

- **What:** The optional `onStepsDropped(event)` callback fires when applying a
  batch of confirmed steps to a live editor cost local edits or applied steps
  under its client ID as another writer's. The event has three counts:
  - `droppedCount`: unconfirmed steps that no longer applied after a rebase and
    were discarded, matched by their origin transaction.
  - `conflictCount`: steps under the editor's client ID, at positions where it
    still had unconfirmed steps, from the first whose content differs. Only this
    count means another writer shares the client ID.
  - `beyondSavedCount`: steps under the editor's client ID past the end of its
    unconfirmed steps. This is expected when an editor resumes from a saved list
    of pending steps shorter than what reached the server.

  The event carries `docBefore`, the document with every local edit, plus the
  client ID and new version. It is isolated like `onSyncObservation`. The
  destroy-time flush does not report.

- **Why:** prosemirror-collab discards a rebased step that no longer applies
  without telling anyone. An app can keep `docBefore` so the user's edit is not
  lost silently, and can rebuild an editor whose client ID is shared.
- **Files:** `src/tiptap/dropped-steps.ts`, `src/tiptap/dropped-steps.test.ts`,
  plus the option and `applyConfirmedSteps` in `src/tiptap/index.ts`.
- **Commits:** feat(tiptap): Report steps dropped by rebase. fix(tiptap): Count
  ID conflicts apart from resumes.
- **Upstream status:** Not submitted. Shaped as its own upstream pull request,
  after content-checked own-step confirmation.
- **Size:** own files: 2 files, +344. `index.ts`: +33, then +10 / -11 in the
  fix.

## Optional destroy-time flush

- **What:** `flushOnDestroy: false` skips the headless submission of unconfirmed
  steps when an editor is destroyed, along with its data-loss report. The
  default, `true`, keeps the flush.
- **Why:** An app that keeps its own durable copy of unsent steps, for example
  from `onPendingChange`, submits them itself later. A concurrent flush from the
  destroyed editor would race that resubmission.
- **Files:** `src/tiptap/flush-on-destroy.test.ts`, plus the option and the
  `onDestroy` condition in `src/tiptap/index.ts`.
- **Commits:** feat(tiptap): Make the destroy-time flush optional.
- **Upstream status:** Not submitted. Shaped as its own upstream pull request.
- **Size:** own files: 1 file, +68. `index.ts`: +15 / -1.

## App-initiated sync stop

- **What:** `stopDocSync(editor, reason)` stops the provider that mounted
  `editor`, for good, and returns `false` if no provider did.
  `DocSyncStopReason` is `"accessLost"`, `"identityChanged"` or `"discarded"`.
  After a stop the provider submits no steps or snapshots, skips the
  destroy-time flush, cancels its retry timer and removes its `beforeunload`
  warning. A request already in flight that then fails is not reported. Local
  edits stay in the editor state. Until the app calls it, nothing changes.
- **Why:** When an app learns that a document must not be written any more, for
  example because access was revoked or the signed-in identity changed, it needs
  to stop sync without destroying the editor, and without the flush sending the
  edits anyway.
- **Reused:** The stop builds on the terminal schema-failure path. Its
  `schemaFatal` flag becomes a `stopReason`, with `"syncFatal"` for the terminal
  failure, and its teardown moves into a shared `stopSync(reason)` that the
  terminal failure also calls.
- **Files:** `src/tiptap/stop-doc-sync.test.ts`, plus the export, the stop state
  and the `onCreate` registration in `src/tiptap/index.ts`.
- **Commits:** feat(tiptap): Let the app stop a document's sync.
- **Upstream status:** Not submitted. Shaped as its own upstream pull request.
- **Size:** own files: 1 file, +171. `index.ts`: +70 / -14.

## Terminal sync-error classifier

- **What:** The optional `isTerminalSyncError(error)` classifies an error the
  sync loop caught as permanent. True enters the terminal state that a schema
  failure enters: no further watches, snapshots, retries or destroy-time flush,
  and the error goes to `onSyncError`. Unset, errors are handled as before.
- **Why:** A submission the server refuses for good, for example for its size or
  shape, is otherwise resent with every later edit and version update, and each
  new edit joins it.
- **Reused:** The terminal state from
  [App-initiated sync stop](#app-initiated-sync-stop), entered through the
  existing terminal failure path, renamed `enterTerminalSyncFailure` because it
  no longer serves only schema failures. The retry option's `isTerminalError`
  stays as it is: it only stops the retry timer and keeps syncing on the next
  change.
- **Files:** `src/tiptap/terminal-sync-error.test.ts`, plus the option and the
  check in `trySync` in `src/tiptap/index.ts`.
- **Commits:** feat(tiptap): Classify terminal sync errors.
- **Upstream status:** Not submitted. Shaped as its own upstream pull request,
  after the app-initiated sync stop.
- **Size:** own files: 1 file, +122. `index.ts`: +22 / -3.

## Shared Tiptap provider files

`src/tiptap/index.ts` and `src/tiptap/index.test.ts`: 2 files, +384 / -60
against `origin/main`.

Each commit's own changes to these two files, against its parent:

| Commit         | Concern                                | `index.ts` | `index.test.ts` |
| -------------- | -------------------------------------- | ---------- | --------------- |
| `3acfe6e`      | Schema and lifecycle guards            | +230 / -27 | +12 / -11       |
| `dde0bd4`      | Bounded history paging                 | +24 / -9   | +5 / -5         |
| `5580872`      | Flush budget and debug versions        | +12 / -7   | +101 / -1       |
| merge of 0.2.7 | Keep `isStopped()` beside #281's guard | +1         | test union only |

The table and total above predate the Tiptap seams added after the 0.2.7 merge.
From
[Content-checked own-step confirmation](#content-checked-own-step-confirmation)
on, each section's **Size** line gives its own `index.ts` change, and those
seams keep their tests in their own files.

## Known departures from AGENTS.md

These changes predate `AGENTS.md` and break its rules. They are listed here, not
fixed.

- **Upstream code edited in place rather than added behind options.** With every
  new option unset, behaviour still differs from upstream:
  - `src/component/lib.ts` rewrites `submitSteps`, `fetchSteps` and
    `deleteSteps`. `MAX_DELTA_FETCH` is replaced, `fetchSteps` loses its
    `targetVersion` parameter, and oversized submissions now throw. This is
    inherent to the paging fix, but it is not additive.
  - `src/client/index.ts` replaces `getLatestVersion`'s single `getSteps` call
    with a page loop.
  - `src/tiptap/index.ts` turns catch-up into a loop, adds the 100-round flush
    cap, changes how flush rebases are counted, makes `onCreate` release a
    previous subscription and replay restored steps once, and stops on any error
    message matching `unknown node type` or `no node type` even when no decoder
    is set.
  - `src/blocknote/index.ts` rewrites the body of `useBlockNoteSync`: it renames
    `editor` to `converter` and `conversion`, wraps the conversion in
    `try`/`finally`, and catches conversion errors that upstream throws.
- **Public type change:** `useBlockNoteSync`'s missing-document result now has
  `create?` instead of `create`. That forced the example change in `0fa3547`.
- **Drive-by edits in upstream code:**
  - `onDestroy`'s cleanup is moved into a new `releaseEditorResources` helper.
  - `doSync`'s `debug?: boolean` becomes `debug: boolean | undefined`, followed
    by four more positional parameters.
  - Every `receiveSteps` call in `doSync` goes through `applyConfirmedSteps`.
  - The comments on `MAX_FLUSH_REBASES` and `_flushPendingSteps` are reworded.
  - The `debug` log's `version` field changes meaning.
- **Upstream tests rewritten:** the `_flushPendingSteps` test "gives up instead
  of rebasing forever" became "gives up after repeated rebase responses without
  version progress", using a different server response. The `destroy` test
  helper now runs `onCreate` before `onDestroy`, and `fakeClient` gains a
  `watchQuery` stub.
- **More than one concern per commit:**
  - `7d9dff6` mixes artifact publication with BlockNote and Tiptap dependency
    bumps and overrides.
  - `3acfe6e` mixes schema decoders, terminal failure, observation, lifecycle
    fixes and BlockNote conversion.
  - `dde0bd4` also changes the CI publishing branches and the `convex` peer
    minimum.
- **Upstream contract changes in `package.json`:** the `convex` peer minimum is
  raised, and `engines` pins exact Node and npm versions for anyone working in
  the package.
- **Branching:** `build-artifact.yml` publishes from `sync-seams-0.2.6` and
  `history-paging`, not from `main`, the only long-lived branch under
  `AGENTS.md`.
- **Stale base record:** `fork-base.json` still records upstream 0.2.6 at
  `4d7b011` under the old `get-convex` URL.
- **Lint:** `npm run lint` reports three errors that predate the merge.
  `scripts/verify-package.mjs` uses the `process` and `console` globals without
  Node globals configured (`no-undef`). `src/tiptap/index.ts` returns inside
  `trySync`'s `finally` when sync has failed terminally (`no-unsafe-finally`).
