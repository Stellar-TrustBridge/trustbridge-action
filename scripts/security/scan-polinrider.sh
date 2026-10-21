#!/usr/bin/env bash
# PolinRider / Contagious Interview indicator scanner (read-only).
# Safe by design: never executes scanned files, never installs deps, never uses secrets.
set -euo pipefail

ROOT="${1:-.}"
MODE="${2:-repo}" # repo | pr-files | self-test
FAIL=0
WARN=0
REPORT=()

note() { REPORT+=("$1"); }
fail() { FAIL=1; note "CONFIRMED: $1"; echo "::error::$1"; }
warn() { WARN=1; note "REVIEW: $1"; echo "::warning::$1"; }

cd "$ROOT"

EXCLUDE_GLOBS=(
  --glob '!node_modules/**'
  --glob '!.next/**'
  --glob '!target/**'
  --glob '!.git/**'
  --glob '!dist/**'
  --glob '!coverage/**'
  --glob '!playwright-report/**'
  --glob '!test-results/**'
  --glob '!security/fixtures/**'
  # Scanner + docs intentionally mention markers — exclude to avoid self-hits
  --glob '!scripts/security/**'
  --glob '!docs/SECURITY_POLINRIDER.md'
  --glob '!.github/workflows/polinrider-security.yml'
)

MARKERS=(
  'rmcej%otb%'
  '_\$_1e42'
  "global\['!'\]"
  'global\["_V"\]'
  'global\.i="A'
  'temp_auto_push\.bat'
  'temp_interactive_push\.bat'
  'fa-solid-400\.woff2'
  'DEV#POPPER'
  'OmniSteal'
)
MARKER_PATTERN=$(IFS='|'; echo "${MARKERS[*]}")

echo "## PolinRider security scan"
echo "Root: $(pwd)  Mode: $MODE"
echo

# ---------- self-test: scan fixtures only ----------
if [[ "$MODE" == "self-test" ]]; then
  FIX=security/fixtures/polinrider
  [[ -d "$FIX" ]] || { echo "Missing fixtures at $FIX"; exit 2; }
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  mkdir -p "$TMP/public/fonts" "$TMP/.vscode"
  cp "$FIX/fa-solid-400.woff2" "$TMP/public/fonts/"
  cp "$FIX/tasks.json" "$TMP/.vscode/tasks.json"
  cp "$FIX/tailwind.config.js" "$TMP/"
  { cat "$FIX/gitignore.snippet"; echo; } > "$TMP/.gitignore"
  echo "Running nested scan against fixture tree..."
  if bash "$(dirname "$0")/scan-polinrider.sh" "$TMP" repo; then
    echo "SELF-TEST FAILED: expected detection in fixtures"
    exit 1
  else
    echo "SELF-TEST PASSED: fixtures correctly detected as malware indicators"
    exit 0
  fi
fi

# 1) Marker grep
if command -v rg >/dev/null 2>&1; then
  HITS=$(rg -n --hidden "${EXCLUDE_GLOBS[@]}" -e "$MARKER_PATTERN" . 2>/dev/null || true)
else
  HITS=$(grep -RInE --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next \
    --exclude-dir=target --exclude-dir=dist --exclude-dir=coverage --exclude-dir=fixtures \
    "$MARKER_PATTERN" . 2>/dev/null || true)
fi
if [[ -n "${HITS}" ]]; then
  fail "PolinRider code markers found in repository content"
  echo "$HITS" | head -50
fi

# 2) VS Code folderOpen auto-run
if [[ -f .vscode/tasks.json ]]; then
  if rg -q 'folderOpen' .vscode/tasks.json 2>/dev/null; then
    if rg -qi 'node.*\.(woff2|woff|ttf|otf|eot|png|jpg|svg)' .vscode/tasks.json; then
      fail ".vscode/tasks.json runs node on a non-JS asset with folderOpen (PolinRider pattern)"
    else
      warn ".vscode/tasks.json uses runOn folderOpen — verify the command is legitimate"
    fi
  fi
fi

# 3) .gitignore fingerprint
if [[ -f .gitignore ]] && rg -q 'temp_auto_push|temp_interactive_push' .gitignore; then
  fail ".gitignore references temp_auto_push / temp_interactive_push (PolinRider fingerprint)"
fi

# 4) Batch helpers
while IFS= read -r -d '' f; do
  base=$(basename "$f")
  case "$base" in
    temp_auto_push.bat|temp_interactive_push.bat)
      fail "Malicious helper batch file present: $f"
      ;;
    *)
      warn "Unexpected Windows batch file in tree: $f — verify legitimacy"
      ;;
  esac
done < <(find . \( -name node_modules -o -name .git -o -name target -o -name .next -o -name dist -o -path './security/fixtures' \) -prune -o \
  \( -iname '*.bat' -o -iname '*.cmd' \) -print0 2>/dev/null)

# 5) Fake fonts (text/JS)
while IFS= read -r -d '' f; do
  ft=$(file -b "$f" 2>/dev/null || echo unknown)
  case "$ft" in
    *ASCII*|*UTF-8*|*text*|*JavaScript*|*JSON*|*empty*)
      if rg -q "$MARKER_PATTERN" "$f" 2>/dev/null; then
        fail "Font-named file contains PolinRider markers and is text/JS: $f ($ft)"
      else
        fail "Font-named file is text/JS (not a real font): $f ($ft)"
      fi
      ;;
  esac
done < <(find . \( -name node_modules -o -name .git -o -name target -o -name .next -o -path './security/fixtures' \) -prune -o \
  \( -iname '*.woff2' -o -iname '*.woff' -o -iname '*.ttf' -o -iname '*.otf' -o -iname '*.eot' \) -print0 2>/dev/null)

# 6) dist/setup.js
if [[ -f dist/setup.js ]]; then
  fail "Unexpected dist/setup.js present (common malware drop path)"
fi

# 7) Suspicious lifecycle scripts
if [[ -f package.json ]]; then
  if python3 - <<'PY'
import json,re,sys
d=json.load(open("package.json"))
scripts=d.get("scripts") or {}
bad=re.compile(r"(curl\s+.*\|\s*(ba)?sh|wget\s+.*\|\s*(ba)?sh|node\s+-e|eval\(|child_process|invoke-expression)", re.I)
hit=False
for k,v in scripts.items():
    if any(x in k.lower() for x in ("preinstall","postinstall","install","prepare","prepublish")):
        if bad.search(str(v)):
            print(f"{k}={v}")
            hit=True
sys.exit(2 if hit else 0)
PY
  then
    :
  else
    rc=$?
    if [[ $rc -eq 2 ]]; then
      fail "package.json contains suspicious lifecycle script that downloads/executes remote code"
    fi
  fi
fi

# 8) Extreme line lengths in build configs
while IFS= read -r -d '' f; do
  if awk 'length($0)>2000 { found=1 } END { exit found?2:0 }' "$f"; then
    :
  else
    if rg -q "$MARKER_PATTERN|global\[|eval\(" "$f"; then
      fail "Build config has extreme line length with obfuscation markers: $f"
    else
      warn "Build config has extreme line length (>2000 chars): $f — verify no appended payload"
    fi
  fi
done < <(find . \( -name node_modules -o -name .git -o -name target -o -name .next -o -path './security/fixtures' \) -prune -o \
  \( -name '*.config.js' -o -name '*.config.mjs' -o -name '*.config.cjs' -o -name 'postcss.config.*' \
     -o -name 'tailwind.config.*' -o -name 'vite.config.*' -o -name 'babel.config.*' \
     -o -name 'jest.config.*' -o -name 'next.config.*' -o -name 'eslint.config.*' \) -print0 2>/dev/null)

# 9) PR changed-files mode
if [[ "$MODE" == "pr-files" && -n "${POLIN_CHANGED_FILES:-}" ]]; then
  while IFS= read -r f; do
    [[ -z "$f" || ! -f "$f" ]] && continue
    case "$f" in
      .vscode/tasks.json|.gitignore|dist/setup.js|*fa-solid-400.woff2|temp_auto_push.bat|temp_interactive_push.bat)
        warn "PR touches high-risk PolinRider path: $f"
        ;;
    esac
    if rg -q "$MARKER_PATTERN" "$f" 2>/dev/null; then
      fail "PolinRider marker in changed file: $f"
    fi
  done <<< "$POLIN_CHANGED_FILES"
fi

echo
echo "### Summary"
if [[ ${#REPORT[@]} -eq 0 ]]; then
  echo "No findings recorded."
else
  printf '%s\n' "${REPORT[@]}"
fi
echo

if [[ "$FAIL" -ne 0 ]]; then
  echo "🚨 MALWARE DETECTED — Do not merge. Review the security report and remove the malicious code."
  echo "::error::MALWARE DETECTED — Do not merge. Review the security report and remove the malicious code."
  exit 1
fi

if [[ "$WARN" -ne 0 ]]; then
  echo "Scan completed with items needing human review (see warnings). No confirmed PolinRider markers."
  exit 0
fi

echo "Scan clean: no confirmed PolinRider indicators found."
exit 0
