#!/usr/bin/env node
/**
 * scripts/check-licenses.js
 *
 * GPL / copyleft license policy gate for TrustBridge Action (GitHub Issue #334).
 *
 * Scans all runtime (production) dependencies for licenses that are incompatible
 * with TrustBridge Action's MIT distribution model:
 *   - GPL-2.0 / GPL-3.0 (and variants)
 *   - AGPL-3.0 (and variants)
 *   - SSPL-1.0
 *   - BUSL-1.1
 *   - UNLICENSED / UNKNOWN
 *
 * Usage:
 *   node scripts/check-licenses.js
 *   npm run license:check
 *
 * Exit codes:
 *   0 — all runtime deps pass the policy gate
 *   1 — one or more runtime deps have a blocked license (CI/release should fail)
 *
 * To add a package exception see the EXCEPTIONS array below and document the
 * rationale in docs/LICENSE_REPORT.md § "Exception registry".
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Blocked license patterns
// ---------------------------------------------------------------------------
// Any license identifier (case-insensitive) that contains one of these
// substrings is considered incompatible and will fail the gate.
const BLOCKED_PATTERNS = [
  /\bGPL\b/i,         // GPL-2.0, GPL-3.0, GPL-2.0-only, GPL-2.0-or-later, etc.
  /\bAGPL\b/i,        // AGPL-3.0, AGPL-3.0-only, AGPL-3.0-or-later
  /\bSSPL\b/i,        // SSPL-1.0
  /\bBUSL\b/i,        // BUSL-1.1
  /\bUNLICENSED\b/i,  // Packages with no declared license
  /\bUNKNOWN\b/i,     // license-checker could not determine the license
];

// ---------------------------------------------------------------------------
// Exception registry
// ---------------------------------------------------------------------------
// Package names (exact match, with version — e.g. "some-package@1.2.3") that
// are explicitly allowed despite having a normally-blocked license.
//
// Before adding an entry here:
//   1. Confirm the package is actually used at runtime (not devDep).
//   2. Verify the legal rationale (dual-license, corporate CLA, etc.).
//   3. Document the exception in docs/LICENSE_REPORT.md § "Exception registry".
//   4. Get explicit maintainer approval in the PR that adds the entry.
//
// Format: 'package-name@version' (the key produced by license-checker).
const EXCEPTIONS = [
  // Example (not active):
  // 'some-gpl-package@1.0.0',  // dual-licensed: also available under MIT via CLA #42
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when a license string contains any blocked pattern
 * and the package is not in the exceptions list.
 *
 * @param {string} pkg   - Package key, e.g. "node-fetch@2.7.0"
 * @param {string} license - SPDX or free-form license string from license-checker
 * @returns {boolean}
 */
function isBlocked(pkg, license) {
  if (EXCEPTIONS.includes(pkg)) return false;
  return BLOCKED_PATTERNS.some((re) => re.test(license));
}

/**
 * Collect the set of production (runtime) package names from package.json.
 * Returns a Set of bare package names (without versions).
 *
 * @returns {Set<string>}
 */
function getRuntimePackageNames() {
  const pkgPath = path.resolve(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  return new Set(Object.keys(pkg.dependencies || {}));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log('\n🔍 TrustBridge license policy gate — scanning runtime dependencies…\n');

// Run license-checker in --production mode to restrict output to runtime deps
// and get machine-readable JSON without writing a file.
let rawOutput;
try {
  rawOutput = execSync(
    'npx license-checker --production --json --excludePrivatePackages',
    {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
} catch (err) {
  // license-checker exits non-zero when it finds a package with no license;
  // it also emits JSON to stdout even on error, so try to parse before giving up.
  if (err.stdout) {
    rawOutput = err.stdout;
  } else {
    console.error('❌  license-checker failed to run:\n', err.message);
    process.exit(1);
  }
}

let licenseMap;
try {
  licenseMap = JSON.parse(rawOutput);
} catch (parseErr) {
  console.error('❌  Could not parse license-checker JSON output:\n', parseErr.message);
  process.exit(1);
}

// Collect violations
const violations = [];
const runtimeNames = getRuntimePackageNames();

for (const [pkg, info] of Object.entries(licenseMap)) {
  const license = (info.licenses || 'UNKNOWN').toString();

  // Only hard-fail on packages that appear in `dependencies` (not devDeps).
  // license-checker --production should already filter devDeps, but we
  // double-check against the package.json dependency list for safety.
  const bareName = pkg.replace(/@[^@]+$/, ''); // strip @version suffix
  const isRuntime = runtimeNames.has(bareName);

  if (isBlocked(pkg, license)) {
    violations.push({ pkg, license, isRuntime });
  }
}

// Split violations into runtime (hard fail) vs non-runtime (warning only)
const runtimeViolations = violations.filter((v) => v.isRuntime);
const transitiveViolations = violations.filter((v) => !v.isRuntime);

// Report transitive / devDep warnings (non-fatal)
if (transitiveViolations.length > 0) {
  console.warn('⚠️  Warning: transitive / dev dependencies with blocked licenses detected:');
  console.warn('   (These do not fail the gate but should be reviewed)\n');
  for (const { pkg, license } of transitiveViolations) {
    console.warn(`   • ${pkg}  →  ${license}`);
  }
  console.warn('');
}

// Report runtime violations (fatal)
if (runtimeViolations.length > 0) {
  console.error('❌  POLICY VIOLATION: runtime dependencies with incompatible licenses:\n');
  for (const { pkg, license } of runtimeViolations) {
    console.error(`   • ${pkg}  →  ${license}`);
  }
  console.error('\nBlocked license categories: GPL, AGPL, SSPL, BUSL, UNLICENSED, UNKNOWN');
  console.error('\nRemediation options:');
  console.error('  1. Replace the dependency with a permissively-licensed alternative.');
  console.error('  2. If the package is dual-licensed or a CLA exists, add an entry to');
  console.error('     the EXCEPTIONS array in scripts/check-licenses.js and document');
  console.error('     the rationale in docs/LICENSE_REPORT.md § "Exception registry".');
  console.error('  3. Contact the package maintainer to request a permissive re-license.');
  console.error('\nSee docs/LICENSE_REPORT.md for the full policy and exceptions process.\n');
  process.exit(1);
}

// All clear
const total = Object.keys(licenseMap).length;
console.log(`✅  License policy gate passed — ${total} packages scanned, 0 runtime violations.\n`);
process.exit(0);
