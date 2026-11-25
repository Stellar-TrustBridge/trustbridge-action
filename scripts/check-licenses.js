#!/usr/bin/env node
/**
 * check-licenses.js
 *
 * Scans production dependencies (npm list --prod --all --json) for licenses
 * that violate trustbridge-action's license policy.
 *
 * Denied licenses (copyleft / incompatible with MIT distribution):
 *   GPL-2.0, GPL-3.0, AGPL-3.0, LGPL-2.0, LGPL-2.1, LGPL-3.0, CPAL-1.0,
 *   OSL-3.0, EUPL-1.1, EUPL-1.2, SSPL-1.0
 *
 * Run:
 *   npm ci
 *   npm run license:check
 *
 * Exits 0 when all production deps are on the allow-list.
 * Exits 1 and prints offenders when a violation is found.
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Licenses that must never appear in production dependencies. */
const DENIED_LICENSES = new Set([
  'GPL-2.0',
  'GPL-2.0-only',
  'GPL-2.0-or-later',
  'GPL-3.0',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'AGPL-3.0',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'LGPL-2.0',
  'LGPL-2.0-only',
  'LGPL-2.0-or-later',
  'LGPL-2.1',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'CPAL-1.0',
  'OSL-3.0',
  'EUPL-1.1',
  'EUPL-1.2',
  'SSPL-1.0',
]);

/**
 * Packages explicitly allowlisted despite an unusual or missing license.
 * Format: "package-name@version" or just "package-name" to match all versions.
 * Document *why* each entry is here.
 */
const ALLOWLISTED_PACKAGES = new Set([
  // Add package@version entries here if a specific dep needs an exception.
  // e.g. 'some-dep@1.0.0'  // reason: internal fork, BSD compatible
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read package.json `license` field from a resolved package path.
 * Returns the SPDX string or 'UNKNOWN' when not determinable.
 */
function readLicenseFromPackage(pkgName, pkgVersion) {
  try {
    // Walk node_modules to find the package.json
    const candidates = [
      path.join(process.cwd(), 'node_modules', pkgName, 'package.json'),
    ];
    // scoped packages
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        const lic = pkg.license || pkg.licenses;
        if (Array.isArray(lic)) {
          return lic.map((l) => (typeof l === 'string' ? l : l.type)).join(' OR ');
        }
        if (typeof lic === 'object' && lic !== null) {
          return lic.type || 'UNKNOWN';
        }
        return typeof lic === 'string' ? lic : 'UNKNOWN';
      }
    }
    return 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

/**
 * Recursively collect all packages from the npm list JSON tree.
 * Returns an array of { name, version, license }.
 */
function collectPackages(depsObj, seen = new Set()) {
  const results = [];
  if (!depsObj || typeof depsObj !== 'object') return results;

  for (const [name, info] of Object.entries(depsObj)) {
    const version = info.version || 'unknown';
    const key = `${name}@${version}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const license = readLicenseFromPackage(name, version);
    results.push({ name, version, license });

    // Recurse into nested deps
    if (info.dependencies) {
      results.push(...collectPackages(info.dependencies, seen));
    }
  }
  return results;
}

/**
 * Normalise an SPDX expression: trim, strip parentheses/spaces for
 * simple single-license strings. For compound expressions (AND/OR) we
 * check each individual token.
 */
function extractLicenseTokens(licenseStr) {
  if (!licenseStr || licenseStr === 'UNKNOWN') return ['UNKNOWN'];
  // Split on AND / OR / WITH and parentheses
  return licenseStr
    .split(/\s+(?:AND|OR|WITH)\s+|[()]/gi)
    .map((t) => t.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log('🔍  trustbridge-action license check\n');

  // Build the production dependency tree
  let listOutput;
  try {
    listOutput = execSync('npm list --prod --all --json', {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
  } catch (err) {
    // npm list exits non-zero when there are peer dep warnings; capture stdout anyway
    listOutput = err.stdout ? err.stdout.toString() : '';
    if (!listOutput) {
      console.error('❌  Failed to run npm list:', err.message);
      process.exit(1);
    }
  }

  let tree;
  try {
    tree = JSON.parse(listOutput);
  } catch {
    console.error('❌  Could not parse npm list output.');
    process.exit(1);
  }

  const packages = collectPackages(tree.dependencies || {});

  const violations = [];
  const unknowns = [];

  for (const pkg of packages) {
    const key = `${pkg.name}@${pkg.version}`;
    const keyNoVersion = pkg.name;

    if (ALLOWLISTED_PACKAGES.has(key) || ALLOWLISTED_PACKAGES.has(keyNoVersion)) {
      console.log(`  ⚠️  ALLOWLISTED  ${key}  (${pkg.license})`);
      continue;
    }

    if (pkg.license === 'UNKNOWN') {
      unknowns.push(pkg);
      continue;
    }

    const tokens = extractLicenseTokens(pkg.license);
    const denied = tokens.filter((t) => DENIED_LICENSES.has(t));
    if (denied.length > 0) {
      violations.push({ ...pkg, denied });
    }
  }

  // Summary
  console.log(`  Scanned ${packages.length} production package(s).\n`);

  if (unknowns.length > 0) {
    console.warn('⚠️   Packages with unknown license metadata (review manually):');
    for (const p of unknowns) {
      console.warn(`    ${p.name}@${p.version}`);
    }
    console.warn('');
  }

  if (violations.length === 0) {
    console.log('✅  No denied licenses found. License policy satisfied.\n');
    process.exit(0);
  }

  console.error('❌  License policy violation(s) detected:\n');
  for (const v of violations) {
    console.error(`    ${v.name}@${v.version}  →  ${v.license}  [denied: ${v.denied.join(', ')}]`);
  }
  console.error(`\n  Total violations: ${violations.length}`);
  console.error(
    '\n  Resolution: replace or remove the offending package, or add a justified\n' +
      '  ALLOWLISTED_PACKAGES entry in scripts/check-licenses.js if the SPDX\n' +
      '  identifier is incorrect and the actual license is compatible.\n'
  );
  process.exit(1);
}

main();
