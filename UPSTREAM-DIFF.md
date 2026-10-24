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

- **What:** `AGENTS.md` sets the fork's change and branching rules. `CLAUDE.md`
  points coding agents at it. This file lists every change.
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
  leading steps that carry its own client ID with its unconfirmed steps, by step
  JSON (`matchOwnSteps` in `src/tiptap/own-steps.ts`). Only the matching prefix
  is confirmed. The first mismatching step is relabelled with a client ID that
  never matches, so collab rebases the remaining local steps over it instead of
  dropping it. This applies to live catch-up, `needs-rebase` responses and the
  destroy-time flush. A mismatch is logged when `debug` is set.
  `src/tiptap/collab-state.ts` reads collab's plugin state and client ID through
  its plugin key.
- **Why:** prosemirror-collab counts its own prefix by client ID alone. When two
  writers share a client ID, for example two tabs restored from one saved
  session, it drops the other writer's steps from the document and marks local
  steps as confirmed that the server never received, so the documents diverge
  and edits are lost. With distinct client IDs the behaviour is unchanged.
- **Files:** `src/tiptap/own-steps.ts`, `src/tiptap/own-steps.test.ts`,
  `src/tiptap/collab-state.ts`, plus `applyConfirmedSteps` and the flush's
  rebase branch in `src/tiptap/index.ts`.
- **Commits:** feat(tiptap): Confirm own steps by content.
- **Upstream status:** Not submitted. Shaped as its own upstream pull request.
- **Size:** own files: 3 files, +438. `index.ts`: +13 / -5.

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
    extension's `onTransaction` hook. Nothing is tracked when neither callback
    is set. The "TODO: verify that restoring local steps works" comment is
    removed, since a test now covers resuming from these reports.
- **Why:** An app can keep its own durable copy of unsent edits and resume them
  later with `clientID`, the latest base as `initialContent` and
  `initialVersion`, and the pending steps as `restoredSteps`.
- **Files:** `src/tiptap/pending-steps.ts`, `src/tiptap/pending-steps.test.ts`,
  plus the options, type exports and hook calls in `src/tiptap/index.ts`.
- **Commits:** feat(tiptap): Report pending steps.
- **Upstream status:** Not submitted. Shaped as its own upstream pull request,
  after the client ID option.
- **Size:** own files: 2 files, +562. `index.ts`: +36 / -1.

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
