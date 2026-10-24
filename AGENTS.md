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

This covers code, comments, tests, fixtures, docs, commit messages and branch names. Use generic wording, such as "an app using this library", and describe every change by its library behaviour only. If something slips in, stop and tell the maintainer. Never rewrite history without the maintainer's approval.

Author and commit every commit as a GitHub noreply address (`<id>+<login>@users.noreply.github.com`). Set it with `git config user.email` once per clone. Commits made before this rule keep their original author.

Workflows in this repository run only on GitHub-hosted runners. Never add a self-hosted runner label.

`scripts/check-sensitive.sh` enforces this. It scans only what differs from upstream: added lines and file names, commit messages and branch names. A pushed range is scanned commit by commit, skipping commits reachable from `upstream/main` when an `upstream` remote is fetched, or else from the base in `fork-base.json`. It checks generic patterns from `.github/sensitive-patterns.txt`, common secret shapes, email addresses, workflow runner labels, gitleaks when installed, and private terms that never live in the repository. Those terms come from `$SENSITIVE_TERMS`, the file `$SENSITIVE_TERMS_FILE` names, or `~/.config/prosemirror-sync/sensitive-terms`, in that order, one per line. A line is a literal term matched as a whole word, or, when it starts with `re:`, an extended regular expression. Both ignore case, and neither is ever printed. Keep that file private (`chmod 600`). Patterns that would reveal what the terms protect, such as internal ID formats or private tool links, belong there as `re:` lines rather than in the public patterns file. Without any terms, the script warns and checks only the generic patterns.

- Run `npm run setup:hooks` once per clone, before the first commit. It sets `git config core.hooksPath .githooks`. It is deliberately not an install lifecycle script such as `prepare`: apps install this package from git, and some package managers refuse a dependency with install-time scripts unless the app allows them. `npm run verify:package` fails if the packed `package.json` has one. The `pre-commit` hook scans the staged diff, `commit-msg` the message, and `pre-push` the pushed commits, their messages and the branch name.
- Never bypass the hooks with `--no-verify`.
- The `sensitive-content` workflow job runs the same script on every pushed range and pull request, with gitleaks and the private terms, `re:` lines included, from the `SENSITIVE_TERMS` Actions secret or variable.

## Change policy

- Keep changes small and additive. Put new behaviour in new modules behind optional options or callbacks. When an option is unset, upstream's code paths and defaults behave exactly as before.
- Do not reformat, rename, or make drive-by edits in upstream files.
- Give each concern one commit, shaped as a pull request that upstream could take, so it can be rebased onto a new upstream release on its own.
- Never add application-specific logic. The fork exposes only generic seams; app behaviour lives in the app.
- Update UPSTREAM-DIFF.md in the same commit as any change it lists.

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
