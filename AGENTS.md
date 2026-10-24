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

Workflows in this repository run only on GitHub-hosted runners. Never add a self-hosted runner label.

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
