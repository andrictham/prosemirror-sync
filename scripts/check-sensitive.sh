#!/usr/bin/env bash
# Fail when content that must not be committed to this public repository is
# about to be committed or pushed. See "Public repository" in AGENTS.md.
#
# Usage:
#   scripts/check-sensitive.sh staged              # the staged diff
#   scripts/check-sensitive.sh message <file>      # a commit message file
#   scripts/check-sensitive.sh range <base> <head> [branch]
#                                                  # a pushed range
#   scripts/check-sensitive.sh tree                # everything not in upstream
#
# Each mode scans only added lines, added file names, commit messages and the
# branch name, so upstream's own content is never scanned. Every mode also
# checks that workflows use GitHub-hosted runners.
#
# Private terms are read from $SENSITIVE_TERMS (newline-separated), or from
# ~/.config/prosemirror-sync/sensitive-terms. They match whole words,
# ignoring case, and are never printed. Matches report only their location.
set -euo pipefail
export LC_ALL=C

root=$(git rev-parse --show-toplevel)
cd "$root"
patterns_file=.github/sensitive-patterns.txt
terms_file_default="$HOME/.config/prosemirror-sync/sensitive-terms"
allowed_trailer='Co-Authored-By: Claude <noreply@anthropic.com>'
zero_sha=0000000000000000000000000000000000000000

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
locations="$scratch/locations"
texts="$scratch/texts"
: >"$locations"
: >"$texts"
failures=0

fail() {
  echo "sensitive-content: $*" >&2
  failures=$((failures + 1))
}

# Record one line of text to scan, with the location to report it under.
add_line() {
  printf '%s\n' "$1" >>"$locations"
  printf '%s\n' "$2" >>"$texts"
}

# Record the added lines and added file names of `git diff <args>`.
#
# Added and removed lines are marked with ">" and "<" instead of "+" and "-",
# so an added line whose text starts with "++ " can never be mistaken for the
# "+++ <path>" file header.
add_diff() {
  git diff -U0 --no-color --no-ext-diff --no-prefix \
    --output-indicator-new='>' --output-indicator-old='<' \
    --output-indicator-context='=' "$@" |
    awk -v locations="$locations" -v texts="$texts" '
      /^\+\+\+ / { path = substr($0, 5); next }
      /^@@ / { split($3, range, ","); line = substr(range[1], 2) + 0; next }
      /^>/ {
        print path ":" line >> locations
        print substr($0, 2) >> texts
        line++
      }
    '
  local name
  while IFS= read -r name; do
    add_line "file name $name" "$name"
  done < <(git diff --name-only --diff-filter=AR "$@")
}

# Record a commit message, without git's comment lines or the allowed trailer.
add_message() {
  local where=$1 file=$2 line
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      "# ------------------------ >8 ------------------------"*) break ;;
      "#"*) continue ;;
      "$allowed_trailer") continue ;;
    esac
    add_line "$where" "$line"
  done <"$file"
}

add_commit_messages() {
  local commit
  for commit in $(git rev-list "$1"); do
    git log -1 --format=%B "$commit" >"$scratch/message"
    add_message "commit $(git rev-parse --short "$commit") message" \
      "$scratch/message"
  done
}

upstream_commit() {
  sed -n 's/.*"upstreamCommit": *"\([0-9a-f]*\)".*/\1/p' fork-base.json
}

# The base for a pushed range whose remote side is new or unknown.
default_base() {
  local head=$1 base
  for base in origin/main main; do
    if git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
      git merge-base "$base" "$head" && return
    fi
  done
  upstream_commit
}

load_terms() {
  local source
  if [ -n "${SENSITIVE_TERMS:-}" ]; then
    printf '%s\n' "$SENSITIVE_TERMS" >"$scratch/terms.raw"
    source="SENSITIVE_TERMS"
  elif [ -n "${SENSITIVE_TERMS_FILE:-}" ] && [ -f "$SENSITIVE_TERMS_FILE" ]; then
    cat "$SENSITIVE_TERMS_FILE" >"$scratch/terms.raw"
    source="\$SENSITIVE_TERMS_FILE"
  elif [ -f "$terms_file_default" ]; then
    cat "$terms_file_default" >"$scratch/terms.raw"
    source="$terms_file_default"
  else
    : >"$scratch/terms.raw"
  fi
  tr -d '\r' <"$scratch/terms.raw" | grep -v '^[[:space:]]*$' \
    >"$scratch/terms" || true
  if [ ! -s "$scratch/terms" ]; then
    {
      echo "##################################################################"
      echo "WARNING: no private terms loaded. Only generic patterns are checked."
      echo "Set SENSITIVE_TERMS, or create $terms_file_default"
      echo "with one term per line."
      echo "##################################################################"
    } >&2
  else
    echo "sensitive-content: checking $(wc -l <"$scratch/terms" | tr -d ' ') private terms from $source" >&2
  fi
}

# Report the location of each texts line number read from stdin.
report() {
  local what=$1
  local line
  sort -un | while IFS= read -r line; do
    printf '%s\n' "sensitive-content: $(sed -n "${line}p" "$locations"): $what" >&2
  done
}

# Run grep over the texts and report every matching line under `what`.
check() {
  local what=$1
  shift
  local hits="$scratch/hits"
  if grep -n "$@" "$texts" | cut -d: -f1 >"$hits" && [ -s "$hits" ]; then
    report "$what" <"$hits"
    failures=$((failures + $(sort -u "$hits" | wc -l)))
  fi
}

scan_texts() {
  check "possible secret" -E \
    -e 'ghp_[A-Za-z0-9]{36}' \
    -e 'gh[ousr]_[A-Za-z0-9]{36}' \
    -e 'github_pat_[A-Za-z0-9_]{22,}' \
    -e 'sk-[A-Za-z0-9_-]{20,}' \
    -e 'AKIA[0-9A-Z]{16}' \
    -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' \
    -e 'xox[abposr]-[A-Za-z0-9-]{10,}'

  # The patterns file matches itself, so skip its own lines here.
  grep -v '^[[:space:]]*\(#\|$\)' "$patterns_file" >"$scratch/patterns"
  paste -d '\t' "$locations" "$texts" |
    awk -F '\t' -v skip="$patterns_file:" \
      'index($1, skip) == 1 { print ""; next } { print substr($0, length($1) + 2) }' \
      >"$scratch/texts.generic"
  if grep -n -E -f "$scratch/patterns" "$scratch/texts.generic" |
    cut -d: -f1 >"$scratch/hits" && [ -s "$scratch/hits" ]; then
    report "matches a pattern in $patterns_file" <"$scratch/hits"
    failures=$((failures + $(sort -u "$scratch/hits" | wc -l)))
  fi

  if grep -n -o -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "$texts" |
    grep -v -E ':[^:]*noreply' | cut -d: -f1 >"$scratch/hits" &&
    [ -s "$scratch/hits" ]; then
    report "email address other than a noreply address" <"$scratch/hits"
    failures=$((failures + $(sort -u "$scratch/hits" | wc -l)))
  fi

  if [ -s "$scratch/terms" ]; then
    check "matches a private term" -w -i -F -f "$scratch/terms"
  fi
}

# Workflows must run on GitHub-hosted runners only.
check_workflows() {
  local file line value
  for file in .github/workflows/*.yml .github/workflows/*.yaml; do
    [ -f "$file" ] || continue
    if grep -n 'self-hosted' "$file" >/dev/null; then
      fail "$file: mentions a self-hosted runner"
    fi
    while IFS= read -r line; do
      value=$(printf '%s' "${line#*runs-on:}" | sed -e 's/#.*//' \
        -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e "s/^[\"']//" \
        -e "s/[\"']\$//")
      if ! printf '%s' "$value" |
        grep -q -E '^(ubuntu|windows|macos)-[A-Za-z0-9.]+$'; then
        fail "$file: runs-on is not a GitHub-hosted label: $value"
      fi
    done < <(grep -E '^[[:space:]]*runs-on:' "$file" || true)
  done
}

gitleaks_scan() {
  if ! command -v gitleaks >/dev/null 2>&1; then
    echo "sensitive-content: gitleaks is not installed; skipping it" >&2
    return
  fi
  if ! gitleaks "$@" --redact --no-banner >&2; then
    fail "gitleaks reported a possible secret"
  fi
}

mode=${1:-}
case $mode in
  staged)
    add_diff --cached
    gitleaks_scan git --pre-commit --staged .
    ;;
  message)
    [ $# -eq 2 ] || { echo "usage: $0 message <file>" >&2; exit 2; }
    add_message "commit message" "$2"
    gitleaks_scan stdin <"$2"
    ;;
  range)
    [ $# -ge 3 ] || { echo "usage: $0 range <base> <head> [branch]" >&2; exit 2; }
    base=$2
    head=$3
    if [ -z "$base" ] || [ "$base" = "$zero_sha" ] ||
      ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
      base=$(default_base "$head")
    fi
    # After a force-push the old tip is not an ancestor; scan from where the
    # histories meet.
    base=$(git merge-base "$base" "$head" || upstream_commit)
    add_diff "$base" "$head"
    add_commit_messages "$base..$head"
    if [ -n "${4:-}" ]; then
      add_line "branch name" "$4"
    fi
    gitleaks_scan git --log-opts="$base..$head" .
    ;;
  tree)
    base=$(upstream_commit)
    add_diff "$base" HEAD
    add_commit_messages "$base..HEAD"
    add_line "branch name" "$(git rev-parse --abbrev-ref HEAD)"
    gitleaks_scan git --log-opts="$base..HEAD" .
    ;;
  *)
    sed -n '5,10p' "$0" >&2
    exit 2
    ;;
esac

load_terms
scan_texts
check_workflows

if [ "$failures" -gt 0 ]; then
  echo "sensitive-content: $failures problem(s) found. Remove them before committing or pushing; see \"Public repository\" in AGENTS.md." >&2
  exit 1
fi
echo "sensitive-content: no problems found" >&2
