#!/usr/bin/env node
/**
 * check-error-catalog.js
 *
 * CI drift-detection script for the structured error catalog in
 * docs/ERROR_HANDLING.md.
 *
 * Usage: node scripts/check-error-catalog.js
 *
 * Exits 0 if all expected reason codes are listed inside the
 * <!-- ERROR_CATALOG_BEGIN --> … <!-- ERROR_CATALOG_END --> section.
 * Exits 1 (and prints a diff) if any reason code is missing, so CI fails fast
 * rather than letting the catalog silently drift from the codebase.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Reason codes that must appear in the catalog ────────────────────────────
// Derived from src/checks.ts (validAccountResult, unfundedAccountResult,
// horizonFailureResult, tlsFailureResult) and src/outputs.ts.
const EXPECTED_REASON_CODES = [
  'SUCCESS',
  'ACCOUNT_NOT_FUNDED',
  'TRUSTLINE_MISSING',
  'RESERVE_TOO_LOW',
  'FAILED',
  'HORIZON_ERROR',
  'HORIZON_TIMEOUT',
  'TLS_ERROR',
  'TRUSTLINE_LIMIT_TOO_LOW',
  'RATE_LIMIT_EXHAUSTED',
];

// ── Locate docs/ERROR_HANDLING.md ───────────────────────────────────────────
const repoRoot = path.resolve(__dirname, '..');
const docPath = path.join(repoRoot, 'docs', 'ERROR_HANDLING.md');

if (!fs.existsSync(docPath)) {
  console.error(`[check-error-catalog] ERROR: ${docPath} not found.`);
  process.exit(1);
}

const content = fs.readFileSync(docPath, 'utf8');

// ── Extract the catalog section ─────────────────────────────────────────────
const BEGIN_MARKER = '<!-- ERROR_CATALOG_BEGIN -->';
const END_MARKER = '<!-- ERROR_CATALOG_END -->';

const beginIdx = content.indexOf(BEGIN_MARKER);
const endIdx = content.indexOf(END_MARKER);

if (beginIdx === -1) {
  console.error(
    `[check-error-catalog] ERROR: Marker "${BEGIN_MARKER}" not found in ${docPath}.\n` +
      'Add an <!-- ERROR_CATALOG_BEGIN --> / <!-- ERROR_CATALOG_END --> section to docs/ERROR_HANDLING.md.',
  );
  process.exit(1);
}

if (endIdx === -1 || endIdx < beginIdx) {
  console.error(
    `[check-error-catalog] ERROR: Marker "${END_MARKER}" not found (or appears before BEGIN) in ${docPath}.`,
  );
  process.exit(1);
}

const catalogSection = content.slice(beginIdx + BEGIN_MARKER.length, endIdx);

// ── Check each required reason code is mentioned in the catalog ─────────────
const missing = EXPECTED_REASON_CODES.filter((code) => !catalogSection.includes(code));

if (missing.length === 0) {
  console.log(
    `[check-error-catalog] ✓ All ${EXPECTED_REASON_CODES.length} reason codes are present in the error catalog.`,
  );
  process.exit(0);
} else {
  console.error(
    `[check-error-catalog] ERROR: The following reason codes are missing from the error catalog in docs/ERROR_HANDLING.md:\n` +
      missing.map((c) => `  - ${c}`).join('\n') +
      '\n\n' +
      'Add each missing code to the table between <!-- ERROR_CATALOG_BEGIN --> and <!-- ERROR_CATALOG_END --> ' +
      'and run this script again.',
  );
  process.exit(1);
}
