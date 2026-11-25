#!/usr/bin/env bash
# check-unpinned-actions.sh
#
# Scans GitHub Actions workflow files and example docs for `uses:` references
# that are NOT pinned to an immutable full-length SHA (40 hex characters).
#
# Allowed patterns (not flagged):
#   - Local action refs:  uses: ./.github/actions/...
#   - Docker image refs:  uses: docker://...
#   - SHA-pinned refs:    uses: owner/repo@<40-hex-chars>
#                         uses: owner/repo/path@<40-hex-chars>
#
# Flagged patterns (fail the check):
#   - Branch refs:  uses: actions/checkout@main
#   - Tag refs:     uses: actions/checkout@v4
#   - No ref:       uses: actions/checkout
#
# Usage:
#   bash scripts/check-unpinned-actions.sh [dir ...]
#
# Defaults to scanning:
#   .github/workflows/
#   docs/examples/        (if it exists)
#
# Exit codes:
#   0 — All uses: references are pinned to full SHAs or are local/docker
#   1 — One or more unpinned references found

set -euo pipefail

# ---------------------------------------------------------------------------
# Directories to scan (accept overrides from command-line args)
# ---------------------------------------------------------------------------
if [[ $# -gt 0 ]]; then
  SCAN_DIRS=("$@")
else
  SCAN_DIRS=(".github/workflows")
  if [[ -d "docs/examples" ]]; then
    SCAN_DIRS+=("docs/examples")
  fi
fi

# ---------------------------------------------------------------------------
# Regex patterns (ERE)
# ---------------------------------------------------------------------------
# Full SHA: exactly 40 lowercase hex characters at end of @ref
SHA_RE='@[0-9a-f]{40}([[:space:]]|$|#)'
# Local action path
LOCAL_RE='uses:[[:space:]]+\./'
# Docker action
DOCKER_RE='uses:[[:space:]]+docker://'

# ---------------------------------------------------------------------------
# Scan
# ---------------------------------------------------------------------------
violations=0
files_checked=0

echo "🔍  Scanning for unpinned GitHub Actions uses: references"
echo ""

for dir in "${SCAN_DIRS[@]}"; do
  if [[ ! -d "$dir" ]]; then
    echo "  ⚠️  Directory not found, skipping: $dir"
    continue
  fi

  while IFS= read -r -d '' file; do
    files_checked=$((files_checked + 1))
    lineno=0

    while IFS= read -r line; do
      lineno=$((lineno + 1))

      # Only process lines that contain `uses:`
      if ! echo "$line" | grep -qF 'uses:'; then
        continue
      fi

      # Trim leading whitespace for pattern checks
      trimmed=$(echo "$line" | sed 's/^[[:space:]]*//')

      # Skip pure comment lines
      if [[ "$trimmed" == \#* ]]; then
        continue
      fi

      # Skip local refs (./.github/...)
      if echo "$line" | grep -qE "$LOCAL_RE"; then
        continue
      fi

      # Skip docker refs
      if echo "$line" | grep -qE "$DOCKER_RE"; then
        continue
      fi

      # Skip SHA-pinned refs (exactly 40 lowercase hex chars after @)
      if echo "$line" | grep -qE "$SHA_RE"; then
        continue
      fi

      # Any remaining `uses:` line with an actual action reference is unpinned
      if echo "$line" | grep -qE 'uses:[[:space:]]+[^[:space:]]'; then
        echo "  ❌  UNPINNED  ${file}:${lineno}:  ${trimmed}"
        violations=$((violations + 1))
      fi
    done < "$file"

  done < <(find "$dir" -type f \( -name "*.yml" -o -name "*.yaml" \) -print0 2>/dev/null)
done

echo ""
echo "  Files checked: ${files_checked}"

if [[ "$violations" -eq 0 ]]; then
  echo "✅  All actions are pinned to immutable SHAs."
  echo ""
  exit 0
fi

echo "❌  Found ${violations} unpinned action reference(s)."
echo ""
echo "  Fix: pin each flagged action to its full 40-character commit SHA, e.g."
echo "    uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2"
echo ""
exit 1
