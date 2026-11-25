#!/usr/bin/env node
/**
 * generate-dist-manifest.js
 *
 * Computes the SHA-256 digest of dist/index.js and writes the result to
 * dist/dist-manifest.json alongside the bundle.  Run automatically as part
 * of `npm run build` (appended in package.json) and during the release CI
 * job so the manifest always travels with the bundle it describes.
 *
 * Output format:
 *   {
 *     "version": 1,
 *     "generated_at": "<ISO-8601 UTC timestamp>",
 *     "files": {
 *       "dist/index.js": {
 *         "sha256": "<64-char lowercase hex digest>"
 *       }
 *     }
 *   }
 *
 * Usage:
 *   node scripts/generate-dist-manifest.js
 */

'use strict';

const { createHash } = require('crypto');
const { readFileSync, writeFileSync } = require('fs');
const { resolve, relative } = require('path');

const REPO_ROOT = resolve(__dirname, '..');
const BUNDLE_PATH = resolve(REPO_ROOT, 'dist', 'index.js');
const MANIFEST_PATH = resolve(REPO_ROOT, 'dist', 'dist-manifest.json');

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

const bundle = readFileSync(BUNDLE_PATH);
const digest = sha256Hex(bundle);

const manifest = {
  version: 1,
  generated_at: new Date().toISOString(),
  files: {
    'dist/index.js': {
      sha256: digest,
    },
  },
};

writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

const relBundle = relative(REPO_ROOT, BUNDLE_PATH).replace(/\\/g, '/');
const relManifest = relative(REPO_ROOT, MANIFEST_PATH).replace(/\\/g, '/');
console.log(`[generate-dist-manifest] ${relBundle} → sha256:${digest}`);
console.log(`[generate-dist-manifest] Wrote ${relManifest}`);
