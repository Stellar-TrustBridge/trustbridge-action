/**
 * Bundle size budget test for dist/ output (ncc-compiled action bundle).
 *
 * Why: GitHub Actions run from dist/index.js. Size regressions slow every
 * assignment job and hint at accidental dependency inclusion (e.g., a
 * dev-only test fixture bundled into production, or a heavyweight library
 * imported when a lighter alternative exists).
 *
 * This test:
 *  - Measures dist/index.js size deterministically using Node fs.statSync.
 *  - Fails when the bundle exceeds a documented maximum bytes budget.
 *  - Reports current size and headroom so PR reviewers see the trend.
 *
 * The budget is intentionally conservative (current baseline + ~20–25%
 * headroom) so minor feature additions don't immediately trigger failures,
 * but large regressions are caught before merge.
 *
 * CI enforcement: this suite is run by the "bundle-size" job in
 * .github/workflows/ci.yml, which fails the build when the budget is
 * exceeded. See CONTRIBUTING.md § "Bundle size budget" for how to
 * investigate size growth.
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Budget configuration
// ---------------------------------------------------------------------------

/**
 * Maximum allowed size for dist/index.js in bytes.
 *
 * CURRENT BASELINE: 1,688,671 bytes (as of 2024-12-29)
 * BUDGET:           2,097,152 bytes (2 MB — 24% headroom)
 *
 * When to increase this budget:
 *  1. A legitimate feature adds a necessary dependency (e.g., a new Stellar
 *     SDK function, a required polyfill, localization strings).
 *  2. The increase is proportional to the value delivered (not just bloat).
 *  3. You've verified no lighter alternative exists.
 *  4. Update this comment block with the new baseline and reason.
 *
 * See CONTRIBUTING.md § "Bundle size budget" for the full checklist.
 */
const MAX_BUNDLE_SIZE_BYTES = 2_097_152; // 2 MB

/**
 * Threshold at which to warn (but not fail) about approaching the budget.
 * Set to 90% of the max budget.
 */
const WARN_THRESHOLD_BYTES = Math.floor(MAX_BUNDLE_SIZE_BYTES * 0.9);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_INDEX_PATH = path.join(REPO_ROOT, 'dist', 'index.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Measure dist/index.js size in bytes using Node's built-in fs.statSync.
 * Deterministic across platforms (no shell wc -c variance).
 */
function measureBundleSize(filePath: string): number {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Bundle file not found: ${filePath}. Did you run 'npm run build'?`);
  }
  const stats = fs.statSync(filePath);
  return stats.size;
}

/**
 * Format bytes as a human-readable string with both raw bytes and MB/KB.
 */
function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(2)} MB (${bytes.toLocaleString()} bytes)`;
  }
  if (bytes >= 1_000) {
    return `${(bytes / 1_000).toFixed(2)} KB (${bytes.toLocaleString()} bytes)`;
  }
  return `${bytes} bytes`;
}

/**
 * Calculate percentage of budget consumed.
 */
function calculateBudgetUsage(size: number, budget: number): number {
  return (size / budget) * 100;
}

/**
 * Build a detailed failure message with actionable next steps.
 */
function buildFailureMessage(size: number, budget: number): string {
  const overage = size - budget;
  const overageFormatted = formatBytes(overage);
  const budgetUsage = calculateBudgetUsage(size, budget).toFixed(1);

  return `
Bundle size exceeds budget!

  Current size:  ${formatBytes(size)}
  Budget:        ${formatBytes(budget)}
  Overage:       ${overageFormatted} (${budgetUsage}% of budget)

This usually means:
  1. A new dependency was added without checking its size impact.
  2. A dev-only fixture or test helper was accidentally imported into src/.
  3. A heavyweight library was used when a lighter alternative exists.

Next steps:
  1. Run 'npm run bundle-size' locally to see current size.
  2. Check recent git diff for new imports in src/*.
  3. Use 'npx ncc build src/index.ts -o dist-test --stats' to analyze which
     modules are contributing the most bytes.
  4. If the increase is intentional and necessary, update MAX_BUNDLE_SIZE_BYTES
     in __tests__/bundle-size.test.ts and document the reason.

See CONTRIBUTING.md § "Bundle size budget" for the full checklist.
`.trim();
}

/**
 * Build a warning message when approaching the budget threshold.
 */
function buildWarningMessage(size: number, budget: number, threshold: number): string {
  const headroom = budget - size;
  const usage = calculateBudgetUsage(size, budget).toFixed(1);
  const thresholdPercent = calculateBudgetUsage(threshold, budget).toFixed(0);

  return `
⚠️  Bundle size is approaching the budget threshold (${thresholdPercent}%)

  Current size:  ${formatBytes(size)}
  Budget:        ${formatBytes(budget)}
  Headroom:      ${formatBytes(headroom)} (${(100 - parseFloat(usage)).toFixed(1)}% remaining)

Consider reviewing recent dependency additions before the next feature lands.
`.trim();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bundle size budget', () => {

  let bundleSize: number;

  beforeAll(() => {
    bundleSize = measureBundleSize(DIST_INDEX_PATH);
  });

  it('dist/index.js exists and is measurable', () => {
    expect(fs.existsSync(DIST_INDEX_PATH)).toBe(true);
    expect(bundleSize).toBeGreaterThan(0);
  });

  it(`dist/index.js does not exceed ${formatBytes(MAX_BUNDLE_SIZE_BYTES)} budget`, () => {
    // Always log the current size for PR reviewers
    console.log(`\n📦 Bundle size: ${formatBytes(bundleSize)}`);
    console.log(`   Budget:      ${formatBytes(MAX_BUNDLE_SIZE_BYTES)}`);
    console.log(`   Usage:       ${calculateBudgetUsage(bundleSize, MAX_BUNDLE_SIZE_BYTES).toFixed(1)}%`);

    if (bundleSize > MAX_BUNDLE_SIZE_BYTES) {
      throw new Error(buildFailureMessage(bundleSize, MAX_BUNDLE_SIZE_BYTES));
    }

    // Warn (but don't fail) when approaching the threshold
    if (bundleSize > WARN_THRESHOLD_BYTES) {
      console.warn(buildWarningMessage(bundleSize, MAX_BUNDLE_SIZE_BYTES, WARN_THRESHOLD_BYTES));
    }

    expect(bundleSize).toBeLessThanOrEqual(MAX_BUNDLE_SIZE_BYTES);
  });

  it('bundle size is reasonable for a GitHub Action (< 5 MB sanity check)', () => {
    const SANITY_LIMIT = 5_000_000; // 5 MB — far beyond what any action should need
    expect(bundleSize).toBeLessThan(SANITY_LIMIT);
  });

  // Informational test — always passes, reports baseline for tracking
  it('reports current bundle size baseline for tracking', () => {
    console.log(`\n📊 Bundle size metrics:`);
    console.log(`   Raw bytes:    ${bundleSize.toLocaleString()}`);
    console.log(`   Formatted:    ${formatBytes(bundleSize)}`);
    console.log(`   Budget used:  ${calculateBudgetUsage(bundleSize, MAX_BUNDLE_SIZE_BYTES).toFixed(2)}%`);
    console.log(`   Headroom:     ${formatBytes(MAX_BUNDLE_SIZE_BYTES - bundleSize)}`);

    // Always pass — this is just for visibility
    expect(true).toBe(true);
  });

});

// ---------------------------------------------------------------------------
// Edge cases and error handling
// ---------------------------------------------------------------------------

describe('bundle size measurement — edge cases', () => {

  it('throws a clear error if dist/index.js is missing', () => {
    const fakePath = path.join(REPO_ROOT, 'dist', 'nonexistent.js');
    expect(() => measureBundleSize(fakePath)).toThrow(/Bundle file not found/);
    expect(() => measureBundleSize(fakePath)).toThrow(/npm run build/);
  });

  it('formatBytes handles various magnitudes correctly', () => {
    expect(formatBytes(500)).toBe('500 bytes');
    expect(formatBytes(5_000)).toContain('KB');
    expect(formatBytes(5_000_000)).toContain('MB');
  });

  it('calculateBudgetUsage returns correct percentages', () => {
    expect(calculateBudgetUsage(1_000_000, 2_000_000)).toBe(50);
    expect(calculateBudgetUsage(2_000_000, 2_000_000)).toBe(100);
    expect(calculateBudgetUsage(2_500_000, 2_000_000)).toBe(125);
  });

  it('buildFailureMessage includes overage and next steps', () => {
    const message = buildFailureMessage(2_500_000, 2_000_000);
    expect(message).toContain('exceeds budget');
    expect(message).toContain('Overage');
    expect(message).toContain('CONTRIBUTING.md');
  });

  it('buildWarningMessage includes headroom information', () => {
    const message = buildWarningMessage(1_900_000, 2_000_000, 1_800_000);
    expect(message).toContain('approaching the budget threshold');
    expect(message).toContain('Headroom');
  });

});
