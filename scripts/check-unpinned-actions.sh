#!/usr/bin/env bash
# Finds `uses:` lines that reference an action by tag/branch (e.g. @v4,
# @main) instead of a full 40-char commit SHA. Run locally before a PR,
# or wire into CI as a fast pre-check ahead of the full zizmor run.
#
# Usage: ./scripts/check-unpinned-actions.sh [path ...]
# Defaults to scanning .github/workflows and docs/examples.

set -euo pipefail

paths=("$@")
if [ ${#paths[@]} -eq 0 ]; then
  paths=(".github/workflows" "docs/examples")
fi

# Matches: uses: owner/repo@ref   where ref is NOT a 40-char hex SHA.
# Allows local actions (./path) and docker:// refs to pass, since those
# aren't the supply-chain-pinning concern this check is for.
pattern='uses:[[:space:]]*[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(/[A-Za-z0-9_./-]+)?@(?!([0-9a-f]{40})([[:space:]]|$))[^[:space:]]+'

found=0
for p in "${paths[@]}"; do
  [ -e "$p" ] || continue
  while IFS= read -r -d '' file; do
    matches=$(grep -nP "$pattern" "$file" || true)
    if [ -n "$matches" ]; then
      found=1
      echo "== $file =="
      echo "$matches" | sed 's/^/  /'
      echo
    fi
  done < <(find "$p" -type f \( -name '*.yml' -o -name '*.yaml' \) -print0)
done

if [ "$found" -eq 1 ]; then
  echo "Unpinned action references found above." >&2
  echo "Pin each to a full commit SHA, e.g.:" >&2
  echo "  uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2" >&2
  echo >&2
  echo "Tip: https://github.com/<owner>/<repo>/releases/tag/<tag> shows the" >&2
  echo "commit for a given tag, or use a pinning tool like suzuki-shunsuke/pinact" >&2
  echo "or mheap/pin-github-action to automate this across many files." >&2
  exit 1
else
  echo "All action references are pinned to commit SHAs."
fi
