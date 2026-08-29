// Stryker mutation testing configuration — scoped to src/validation.ts.
//
// Mutation testing is bounded to validation.ts because it is a security
// boundary (SSRF block-list + StrKey address gate). A surviving mutant in
// validation.ts means a test does not catch a weakened security check.
//
// Run locally:  npm run mutation
// CI job:       .github/workflows/ci.yml  mutation-ci  (pull_request only)
//
// Thresholds:
//   high  ≥ 80 %  — informational green label
//   low   ≥ 70 %  — informational yellow label
//   break ≥ 60 %  — CI hard-fail below this score
//
// See CONTRIBUTING.md § "Mutation testing" for guidance.

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'npm',

  // ── Reporters ──────────────────────────────────────────────────────────
  reporters: ['html', 'clear-text', 'progress'],

  // ── Test runner ────────────────────────────────────────────────────────
  testRunner: 'jest',
  jest: {
    projectType: 'custom',
    configFile: 'jest.config.js',
    // Only re-run tests that cover the mutated file — faster feedback.
    enableFindRelatedTests: true,
  },

  // ── Scope — validation.ts only ─────────────────────────────────────────
  // Do NOT expand to all of src/ — mutation testing all files is very slow
  // and is out of scope for this issue.
  mutate: ['src/validation.ts'],

  // ── Timing ─────────────────────────────────────────────────────────────
  // 60 s per-mutant hard timeout; factor 2× for slow CI runners.
  // Prevents a single mutant from hanging the full run.
  timeoutMS: 60000,
  timeoutFactor: 2,

  // ── Concurrency ────────────────────────────────────────────────────────
  // Two parallel workers: safe on a 2-vCPU GitHub-hosted runner.
  concurrency: 2,

  // ── Coverage analysis ──────────────────────────────────────────────────
  // perTest: only re-run tests that cover the mutated line (much faster).
  coverageAnalysis: 'perTest',

  // ── TypeScript ─────────────────────────────────────────────────────────
  // Disable type-checking inside Stryker itself (ts-jest already handles it).
  disableTypeChecks: true,

  // ── Thresholds ─────────────────────────────────────────────────────────
  thresholds: {
    high: 80,   // green badge
    low: 70,    // yellow badge
    break: 60,  // hard-fail CI below this score
  },
};
