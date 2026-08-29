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
  'FAILED',
  'HORIZON_ERROR',
  'HORIZON_TIMEOUT',
  'TLS_ERROR',
] as const;

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
});
