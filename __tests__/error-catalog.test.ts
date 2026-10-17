/**
 * error-catalog.test.ts
 *
 * Drift-detection test for the structured error catalog in docs/ERROR_HANDLING.md.
 *
 * If a reason code is added to src/checks.ts or src/outputs.ts but not to the
 * catalog section, this test fails — keeping the documentation in sync with
 * the codebase on every CI run.
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Reason codes that must be present in the catalog ────────────────────────
// Source of truth: src/checks.ts (validAccountResult, unfundedAccountResult,
// horizonFailureResult, tlsFailureResult) and src/outputs.ts.
const REQUIRED_REASON_CODES: readonly string[] = [
  'SUCCESS',
  'ACCOUNT_NOT_FUNDED',
  'TRUSTLINE_MISSING',
  'RESERVE_TOO_LOW',
  'TRUSTLINE_LIMIT_TOO_LOW',
  'TRUSTLINE_UNAUTHORIZED',
  'CLAWBACK_BLOCKED',
  'FAILED',
  'HORIZON_ERROR',
  'HORIZON_TIMEOUT',
  'TLS_ERROR',
  // Resilience / gating codes emitted from src/checks.ts and src/index.ts.
  // These predate the catalog table, which is how they went undocumented
  // while the runtime had been emitting them all along. (Issue #668)
  'CIRCUIT_OPEN',
  'RATE_BUDGET_EXHAUSTED',
  'MILESTONE_GATE_SKIPPED',
  'MAINTAINER_SKIPPED',
  'CONTRACT_DESTINATION_OK',
  'CONTRACT_NOT_FOUND',
] as const;

/**
 * Reason codes that the runtime is known to emit, derived from the source
 * rather than hand-maintained here. Keeping this derived means a new code
 * added to src/ but forgotten in docs/ERROR_HANDLING.md fails CI without
 * anyone having to update this list.
 *
 * Each entry is a source file plus the literal-bearing patterns that identify
 * a reason_code assignment or comparison in that file.
 */
const RUNTIME_REASON_CODE_SOURCES: ReadonlyArray<{ file: string }> = [
  { file: 'src/checks.ts' },
  { file: 'src/index.ts' },
  { file: 'src/outputs.ts' },
];

/**
 * Extract every UPPER_SNAKE_CASE token that appears in a reason_code
 * position in a source file. Deliberately broad: matching
 * `reasonCode: 'X'`, `setOutput('reason_code', 'X')`, and `reasonCode === 'X'`
 * covers assignment and comparison sites alike. Over-matching is safe here —
 * a code only fails CI if it is missing from the doc, and the catalog is
 * expected to be the superset.
 */
function extractReasonCodesFromSource(source: string): Set<string> {
  const codes = new Set<string>();
  const patterns = [
    /reasonCode:\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
    /reason_code['"]?\s*,\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
    /reasonCode\s*===\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
    /return\s+['"]([A-Z][A-Z0-9_]{3,})['"]/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      codes.add(match[1]!);
    }
  }
  return codes;
}

const DOC_PATH = path.resolve(__dirname, '..', 'docs', 'ERROR_HANDLING.md');
const BEGIN_MARKER = '<!-- ERROR_CATALOG_BEGIN -->';
const END_MARKER = '<!-- ERROR_CATALOG_END -->';

// ── Helpers ──────────────────────────────────────────────────────────────────

function readCatalogSection(): string {
  expect(fs.existsSync(DOC_PATH)).toBe(true);
  const content = fs.readFileSync(DOC_PATH, 'utf8');

  const beginIdx = content.indexOf(BEGIN_MARKER);
  const endIdx = content.indexOf(END_MARKER);

  expect(beginIdx).toBeGreaterThan(-1);
  expect(endIdx).toBeGreaterThan(beginIdx);

  return content.slice(beginIdx + BEGIN_MARKER.length, endIdx);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('docs/ERROR_HANDLING.md — structured error catalog', () => {
  let catalogSection: string;

  beforeAll(() => {
    catalogSection = readCatalogSection();
  });

  it('contains the ERROR_CATALOG_BEGIN and ERROR_CATALOG_END delimiters', () => {
    const content = fs.readFileSync(DOC_PATH, 'utf8');
    expect(content).toContain(BEGIN_MARKER);
    expect(content).toContain(END_MARKER);
  });

  it('catalog section is non-empty', () => {
    expect(catalogSection.trim().length).toBeGreaterThan(0);
  });

  it('catalog section contains a Markdown table with the reason_code column', () => {
    expect(catalogSection).toContain('`reason_code`');
  });

  it.each(REQUIRED_REASON_CODES)(
    'catalog section lists reason code: %s',
    (code) => {
      expect(catalogSection).toContain(code);
    },
  );

  it('no required reason code is missing from the catalog (aggregate check)', () => {
    const missing = REQUIRED_REASON_CODES.filter((code) => !catalogSection.includes(code));
    if (missing.length > 0) {
      throw new Error(
        `The following reason codes are missing from the error catalog in docs/ERROR_HANDLING.md:\n` +
          missing.map((c) => `  - ${c}`).join('\n') +
          '\n\nAdd each missing code to the table between <!-- ERROR_CATALOG_BEGIN --> and <!-- ERROR_CATALOG_END -->.',
      );
    }
  });

  // Issue #668 — the original failure mode was a hand-maintained list that
  // silently fell behind the source. Deriving the expected set from src/ means
  // drift fails CI on its own.
  it('every reason_code emitted at runtime is documented in the catalog', () => {
    const repoRoot = path.resolve(__dirname, '..');
    const undocumented: string[] = [];

    for (const { file } of RUNTIME_REASON_CODE_SOURCES) {
      const sourcePath = path.join(repoRoot, file);
      expect(fs.existsSync(sourcePath)).toBe(true);
      const codes = extractReasonCodesFromSource(fs.readFileSync(sourcePath, 'utf8'));
      for (const code of codes) {
        if (!catalogSection.includes(code)) {
          undocumented.push(`${code} (from ${file})`);
        }
      }
    }

    if (undocumented.length > 0) {
      throw new Error(
        'The following reason codes are emitted at runtime but are missing from ' +
          'the catalog section of docs/ERROR_HANDLING.md:\n' +
          undocumented.map((c) => `  - ${c}`).join('\n') +
          '\n\nAdd each one to the table between <!-- ERROR_CATALOG_BEGIN --> and ' +
          '<!-- ERROR_CATALOG_END -->, including retryability and remediation guidance.',
      );
    }
  });

  it('the extraction helper finds codes across assignment and comparison sites', () => {
    const sample = `
      reasonCode: 'ACCOUNT_NOT_FUNDED',
      core.setOutput('reason_code', 'MILESTONE_GATE_SKIPPED');
      if (result.reasonCode === 'CIRCUIT_OPEN') { /* ... */ }
      const code = 'TRUSTLINE_UNAUTHORIZED';
    `;
    const codes = extractReasonCodesFromSource(sample);
    expect(codes.has('ACCOUNT_NOT_FUNDED')).toBe(true);
    expect(codes.has('MILESTONE_GATE_SKIPPED')).toBe(true);
    expect(codes.has('CIRCUIT_OPEN')).toBe(true);
  });

  it('the extraction helper ignores lowercase identifiers and non-code strings', () => {
    const codes = extractReasonCodesFromSource(
      `const label = 'clawback safety'; reasonCode: 'CLAWBACK_BLOCKED';`,
    );
    expect(codes.has('CLAWBACK_BLOCKED')).toBe(true);
    // Multi-word prose must never be mistaken for a reason code.
    expect([...codes].every((c) => /^[A-Z][A-Z0-9_]*$/.test(c))).toBe(true);
  });
});
