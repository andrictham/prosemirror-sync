# Rules for this fork

This is a fork of [get-convex/prosemirror-sync](https://github.com/get-convex/prosemirror-sync) maintained by @andrictham. Every change listed here, with its reason and upstream status, is in [UPSTREAM-DIFF.md](./UPSTREAM-DIFF.md).

## Public repository

This repository is public. Never commit any of these:

- product or project names or codenames
- company names
- internal IDs, such as work queue, decision record or ticket numbers
- deployment names or hostnames
- internal file paths
- links to private tools, such as document, chat or agent tools
- email addresses other than a GitHub noreply address
- model or agent names, except the exact trailer `Co-Authored-By: Claude <noreply@anthropic.com>`
- secrets, tokens or keys
- customer or user data

This covers code, comments, tests, fixtures, docs, commit messages and branch names. Use generic wording, such as "an app using this library", and describe every change by its library behaviour only. If something slips in, stop and tell the maintainer. Never rewrite history without the maintainer's approval. History was rewritten once, on 2026-10-25, with the maintainer's approval, to remove disclosed patterns and to normalize commit authors and trailers.

Author and commit every commit as a GitHub noreply address (`<id>+<login>@users.noreply.github.com`). Set it with `git config user.email` once per clone. Workflows that commit use the `github-actions[bot]` noreply address.

Workflows in this repository run only on GitHub-hosted runners. Never add a self-hosted runner label.

`scripts/check-sensitive.sh` enforces this. It scans only what differs from upstream: added lines and file names, commit messages, commit author and committer emails, and branch names. Author and committer emails must be GitHub noreply addresses with a numeric ID, or a listed bot address. Commit messages may carry no model trailer other than the exact one above, and no agent-session trailer or link. A pushed range is scanned commit by commit, skipping commits reachable from `upstream/main` when an `upstream` remote is fetched, or else from the base in `fork-base.json`. It checks generic patterns from `.github/sensitive-patterns.txt`, common secret shapes, email addresses, workflow runner labels, gitleaks when installed, and private terms that never live in the repository. Those terms come from `$SENSITIVE_TERMS`, the file `$SENSITIVE_TERMS_FILE` names, or `~/.config/prosemirror-sync/sensitive-terms`, in that order, one per line. A line is a literal term matched as a whole word, or, when it starts with `re:`, an extended regular expression. Both ignore case, and neither is ever printed. A private match reports only its commit (or "staged changes", "commit message" or "branch name") and a count, never a file name, path or line, since those could reveal the term. Keep that file private (`chmod 600`). Patterns that would reveal what the terms protect, such as internal ID formats or private tool links, belong there as `re:` lines rather than in the public patterns file. Keep the public patterns file generic from the start: deleting a line from it leaves the line in public history. Without any terms, the script warns and checks only the generic patterns, unless `SENSITIVE_TERMS_REQUIRED=1` is set, when it fails.

The modes are `staged`, `message <file>`, `range <base> <head> [branch]`, `tree` (the tree diff from upstream) and `history` (every fork commit on its own, so content a later commit removed is still found).

- Run `npm run setup:hooks` once per clone, before the first commit. It sets `git config core.hooksPath .githooks`. It is deliberately not an install lifecycle script such as `prepare`: apps install this package from git, and some package managers refuse a dependency with install-time scripts unless the app allows them. `npm run verify:package` fails if the packed `package.json` has one. The `pre-commit` hook scans the staged diff, `commit-msg` the message, and `pre-push` the pushed commits, their messages and the branch name.
- Never bypass the hooks with `--no-verify`.
- The `sensitive-content` workflow job runs the same script on every pushed range and pull request, with gitleaks and the private terms, `re:` lines included, from the `SENSITIVE_TERMS` Actions secret. It sets `SENSITIVE_TERMS_REQUIRED=1`, so it fails when the terms are missing. GitHub withholds secrets from pull requests opened from other forks, so those fail until a maintainer pushes the branch into this repository.
- The `sensitive-history` workflow runs `history` mode weekly and on demand, with the terms required.

Where each rule is enforced:

- Local hooks are an early warning only. They are opt-in, can be skipped, and do not run for web-editor or API commits. Without private terms they warn rather than fail.
- The `sensitive-content` job is the gate for every push and pull request, and `sensitive-history` re-checks all published fork history against the current rules.
- Force-push, rebase and branch-deletion rules are not checked by any script. Only a repository ruleset can enforce them; until one exists they rely on review.

Workflows that build or test never hold a write token. `build-artifact.yml` and `upstream-sync.yml` run install, tests and the build in a job with `permissions: {}` and no persisted credentials, then hand the result to a second job, as a workflow artifact, that runs no repository code. That job's token is passed only to the step that pushes or opens the pull request.

## Change policy

- Keep changes small and additive. Put new behaviour in new modules behind optional options or callbacks. When an option is unset, upstream's code paths and defaults behave exactly as before. The history-paging and lifecycle fixes are in-place rewrites of upstream code; UPSTREAM-DIFF.md lists them under "Known departures from AGENTS.md".
- Do not reformat, rename, or make drive-by edits in upstream files.
- Give each concern one commit, shaped as a pull request that upstream could take, so it can be rebased onto a new upstream release on its own.
- Never add application-specific logic. The fork exposes only generic seams; app behaviour lives in the app.
- Every fork commit updates its ledger entry in UPSTREAM-DIFF.md in the same commit: an upstream candidate's entry (problem, change, commits, files and functions touched, verdict with reason, upstream PR link), or its line under "Not for upstream". A commit cannot cite its own SHA, so entries cite the commits that introduced the change, and the next commit to touch an entry adds the missing SHA. Ledger-only commits are fork-only.

## Branching policy

- `main` is upstream plus our changes, and it is the only long-lived branch for our work.
- `upstream-sync` is the only bot-owned branch. The weekly upstream-sync workflow keeps it current by merging main and then upstream into it, with merge commits only, and only ever opens a pull request into main.
- Work on one working branch at a time. Fast-forward `main` to it once its tests pass and it has been reviewed.
- Never force-push, and never rebase `main`. Bring in new upstream releases by merging them into `main`.
- CI publishes built packages to `artifacts/<source-sha>` branches. Keep each one only while an install pins it, and remove it when that pin moves.
- The maintainer approves every branch deletion.

## Installing

Consumers install a CI-built artifact commit, never a source branch:

```json
"@convex-dev/prosemirror-sync": "github:andrictham/prosemirror-sync#<artifact-commit-sha>"
```

Use the full SHA of the commit at the tip of `artifacts/<source-sha>`. Build artifacts only through `.github/workflows/build-artifact.yml`; never push a locally built `dist` or a hand-made artifacts branch.
