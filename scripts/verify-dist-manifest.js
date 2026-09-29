#!/usr/bin/env node
/**
 * verify-dist-manifest.js
 *
 * Re-computes the SHA-256 digest of dist/index.js and compares it against the
 * value recorded in dist/dist-manifest.json.  Exits non-zero when:
 *   • dist/dist-manifest.json is missing
 *   • The manifest is malformed / missing the expected entry
 *   • The live digest does not match the recorded digest
 *
 * Usage:
 *   node scripts/verify-dist-manifest.js
 *
 * Called from the release workflow before publishing the GitHub Release so
 * that a stale or tampered bundle cannot be shipped accidentally.
 */

'use strict';

const { createHash } = require('crypto');
const { readFileSync, existsSync } = require('fs');
const { resolve } = require('path');

const REPO_ROOT = resolve(__dirname, '..');
const BUNDLE_PATH = resolve(REPO_ROOT, 'dist', 'index.js');
const MANIFEST_PATH = resolve(REPO_ROOT, 'dist', 'dist-manifest.json');

let ok = true;

function fail(msg) {
  console.error(`[verify-dist-manifest] FAIL: ${msg}`);
  ok = false;
}

// ── 1. Files must exist ───────────────────────────────────────────────────────

if (!existsSync(BUNDLE_PATH)) {
  fail('dist/index.js not found');
}
if (!existsSync(MANIFEST_PATH)) {
  fail('dist/dist-manifest.json not found — run `npm run build` to generate it');
}

if (!ok) {
  process.exit(1);
}

// ── 2. Parse manifest ─────────────────────────────────────────────────────────

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
} catch (err) {
  fail(`dist-manifest.json is not valid JSON: ${err.message}`);
  process.exit(1);
}

const recorded = manifest?.files?.['dist/index.js']?.sha256;
if (typeof recorded !== 'string' || !/^[0-9a-f]{64}$/.test(recorded)) {
  fail('dist-manifest.json is missing or has an invalid files["dist/index.js"].sha256 field');
  process.exit(1);
}

// ── 3. Recompute and compare ──────────────────────────────────────────────────

const bundle = readFileSync(BUNDLE_PATH);
const live = createHash('sha256').update(bundle).digest('hex');

if (live !== recorded) {
  fail(
    `SHA-256 mismatch for dist/index.js\n` +
      `  recorded : ${recorded}\n` +
      `  computed : ${live}\n` +
      `\n` +
      `  The committed bundle does not match the manifest.\n` +
      `  Rebuild with \`npm run build\` and commit both dist/index.js and dist/dist-manifest.json.`,
  );
  process.exit(1);
}

console.log(`[verify-dist-manifest] OK  dist/index.js  sha256:${live}`);
