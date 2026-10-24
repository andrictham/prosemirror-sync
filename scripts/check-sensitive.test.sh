#!/usr/bin/env bash
# Tests for scripts/check-sensitive.sh and the hooks in .githooks.
#
# Each case builds a throwaway repository holding copies of the scanner, its
# patterns file and the hooks, then plants content and checks the verdict.
# Text the scanner would flag in this file is assembled at run time, so the
# file itself passes the scan.
#
# Usage: scripts/check-sensitive.test.sh
set -euo pipefail
export LC_ALL=C

source_root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# A HOME without a private terms file, so only what a case sets is loaded.
export HOME="$work/home"
mkdir -p "$HOME"
unset SENSITIVE_TERMS SENSITIVE_TERMS_FILE
# A stand-in gitleaks that, like many tools, reads its standard input.
mkdir -p "$work/bin"
printf '#!/bin/sh\ncat >/dev/null\nexit 0\n' >"$work/bin/gitleaks"
chmod +x "$work/bin/gitleaks"
export PATH="$work/bin:$PATH"
export GIT_CONFIG_GLOBAL="$work/gitconfig"
export GIT_CONFIG_NOSYSTEM=1
git config --global user.name "Test"
git config --global user.email "test@users.noreply.github.com"
git config --global init.defaultBranch main

passed=0
failed=0
output="$work/output"

# Create a repository with the scanner and a first commit that plays the
# upstream base recorded in fork-base.json. Prints its path.
new_repo() {
  local repo
  repo=$(mktemp -d "$work/repo.XXXXXX")
  git -C "$repo" init -q
  mkdir -p "$repo/scripts" "$repo/.github" "$repo/.githooks"
  cp "$source_root/scripts/check-sensitive.sh" "$repo/scripts/"
  cp "$source_root/.github/sensitive-patterns.txt" "$repo/.github/"
  cp "$source_root/.githooks/"* "$repo/.githooks/"
  echo "upstream" >"$repo/README.md"
  git -C "$repo" add -A
  git -C "$repo" commit -q -m "Upstream base"
  printf '{ "upstreamCommit": "%s" }\n' "$(git -C "$repo" rev-parse HEAD)" \
    >"$repo/fork-base.json"
  git -C "$repo" add fork-base.json
  git -C "$repo" commit -q -m "Record the fork base"
  printf '%s\n' "$repo"
}

# Commit a file with the given content. Prints nothing.
commit_file() {
  local repo=$1 path=$2 content=$3 message=${4:-"Add $2"}
  mkdir -p "$(dirname "$repo/$path")"
  printf '%s\n' "$content" >"$repo/$path"
  git -C "$repo" add "$path"
  git -C "$repo" commit -q -m "$message"
}

# Run a command in a repository, with no standard input, and record whether
# it failed as expected.
# Usage: expect pass|fail <name> <repo> <command...>
expect() {
  local want=$1 name=$2 repo=$3 status=0
  shift 3
  (cd "$repo" && "$@") </dev/null >"$output" 2>&1 || status=$?
  if { [ "$want" = pass ] && [ "$status" -eq 0 ]; } ||
    { [ "$want" = fail ] && [ "$status" -eq 1 ]; }; then
    passed=$((passed + 1))
    return 0
  fi
  failed=$((failed + 1))
  echo "not ok - $name: expected $want, got exit $status" >&2
  sed 's/^/    /' "$output" >&2
  return 1
}

# Check that the last command's output contains, or lacks, a fixed string.
expect_output() {
  local name=$1 mode=$2 text=$3
  if grep -q -F -- "$text" "$output"; then
    [ "$mode" = has ] && { passed=$((passed + 1)); return 0; }
  else
    [ "$mode" = lacks ] && { passed=$((passed + 1)); return 0; }
  fi
  failed=$((failed + 1))
  if [ "$mode" = has ]; then
    echo "not ok - $name: output lacks '$text'" >&2
  else
    echo "not ok - $name: output contains '$text'" >&2
  fi
  sed 's/^/    /' "$output" >&2
  return 1
}

scan() { scripts/check-sensitive.sh "$@"; }

# --- Diff parsing ---------------------------------------------------------

repo=$(new_repo)
printf 'first\n++ zebrafruit here\n' >"$repo/notes.txt"
git -C "$repo" add notes.txt
SENSITIVE_TERMS=zebrafruit expect fail "an added line starting with ++ is scanned" \
  "$repo" scan staged || true
expect_output "an added line starting with ++ reports its own path" has \
  "notes.txt:2" || true

repo=$(new_repo)
commit_file "$repo" notes.txt "-- old line"
printf '++ zebrafruit\n' >"$repo/notes.txt"
git -C "$repo" add notes.txt
SENSITIVE_TERMS=zebrafruit expect fail "a removed -- line followed by an added ++ line" \
  "$repo" scan staged || true

repo=$(new_repo)
printf 'nothing to see\n' >"$repo/clean.txt"
git -C "$repo" add clean.txt
SENSITIVE_TERMS=zebrafruit expect pass "a clean staged change passes" \
  "$repo" scan staged || true

echo "check-sensitive tests: $passed passed, $failed failed"
[ "$failed" -eq 0 ]
