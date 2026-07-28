/**
 * Tests for OpenTelemetry-style spans in src/validation.ts (Issue #35).
 * Covers: span recording, span attributes, status, clearSpans/getSpans,
 * and all four validator wrappers.
 */

import {
  clearSpans,
  combineResults,
  getSpans,
  validateAssetCode,
  validateContractAddress,
  validateNumericInput,
  validateUrl,
} from '../src/validation';

const VALID_CONTRACT = 'C' + 'A'.repeat(55);

beforeEach(() => {
  clearSpans();
});

// ---------------------------------------------------------------------------
// Span store helpers
// ---------------------------------------------------------------------------

describe('getSpans / clearSpans', () => {
  it('starts empty after clearSpans()', () => {
    validateContractAddress(VALID_CONTRACT);
    clearSpans();
    expect(getSpans()).toHaveLength(0);
  });

  it('returns a copy — mutations do not affect the store', () => {
    validateContractAddress(VALID_CONTRACT);
    const spans = getSpans();
    spans.pop();
    expect(getSpans()).toHaveLength(1);
  });

  it('accumulates spans across multiple calls', () => {
    validateContractAddress(VALID_CONTRACT);
    validateAssetCode('USDC');
    validateNumericInput('42', 'timeout');
    expect(getSpans()).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// validateContractAddress spans
// ---------------------------------------------------------------------------

describe('validateContractAddress span', () => {
  it('records an "ok" span for a valid address', () => {
    const result = validateContractAddress(VALID_CONTRACT);
    expect(result.valid).toBe(true);

    const spans = getSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('validateContractAddress');
    expect(spans[0].status).toBe('ok');
    expect(spans[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(spans[0].startTimeMs).toBeGreaterThan(0);
    expect(spans[0].error).toBeUndefined();
  });

  it('records an "error" span for an invalid address', () => {
    const result = validateContractAddress('GNOTACONTRACT');
    expect(result.valid).toBe(false);

    const spans = getSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status).toBe('error');
    expect(spans[0].error).toBeDefined();
  });

  it('span attributes include inputLength and startsWithC (no raw address)', () => {
    validateContractAddress(VALID_CONTRACT);
    const span = getSpans()[0];
    expect(span.attributes).toMatchObject({
      inputLength: 56,
      startsWithC: true,
    });
    // Raw address must NOT appear in attributes
    expect(JSON.stringify(span.attributes)).not.toContain(VALID_CONTRACT);
  });

  it('span errorCount matches errors array length', () => {
    validateContractAddress('CSHORT');
    const span = getSpans()[0];
    expect(span.attributes.errorCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// validateAssetCode spans
// ---------------------------------------------------------------------------

describe('validateAssetCode span', () => {
  it('records an "ok" span for a valid asset code', () => {
    validateAssetCode('USDC');
    const spans = getSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status).toBe('ok');
    expect(spans[0].attributes.inputLength).toBe(4);
  });

  it('records an "error" span for an empty code', () => {
    validateAssetCode('');
    const span = getSpans()[0];
    expect(span.status).toBe('error');
    expect(span.error).toContain('empty');
  });

  it('records an "error" span for a too-long code', () => {
    validateAssetCode('TOOLONGASSETCODE');
    const span = getSpans()[0];
    expect(span.status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// validateNumericInput spans
// ---------------------------------------------------------------------------

describe('validateNumericInput span', () => {
  it('records an "ok" span for a valid number', () => {
    validateNumericInput('42', 'timeout', { min: 0, max: 100 });
    const span = getSpans()[0];
    expect(span.name).toBe('validateNumericInput');
    expect(span.status).toBe('ok');
    expect(span.attributes.fieldName).toBe('timeout');
    expect(span.attributes.hasMin).toBe(true);
    expect(span.attributes.hasMax).toBe(true);
  });

  it('records an "error" span for a non-numeric string', () => {
    validateNumericInput('abc', 'field');
    const span = getSpans()[0];
    expect(span.status).toBe('error');
  });

  it('records an "error" span when below min', () => {
    validateNumericInput('-5', 'field', { min: 0 });
    const span = getSpans()[0];
    expect(span.status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// validateUrl spans
// ---------------------------------------------------------------------------

describe('validateUrl span', () => {
  it('records an "ok" span for a valid https URL', () => {
    validateUrl('https://horizon.stellar.org', 'horizon_url');
    const span = getSpans()[0];
    expect(span.name).toBe('validateUrl');
    expect(span.status).toBe('ok');
    expect(span.attributes.fieldName).toBe('horizon_url');
    // URL value must NOT appear in attributes
    expect(JSON.stringify(span.attributes)).not.toContain('horizon.stellar.org');
  });

  it('records an "error" span for an invalid URL', () => {
    validateUrl('not-a-url', 'horizon_url');
    const span = getSpans()[0];
    expect(span.status).toBe('error');
  });

  it('records an "error" span for a disallowed protocol', () => {
    validateUrl('ftp://example.com', 'url', { protocols: ['https'] });
    const span = getSpans()[0];
    expect(span.status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// combineResults (no span of its own)
// ---------------------------------------------------------------------------

describe('combineResults', () => {
  it('merges errors and warnings from multiple results', () => {
    const r1 = validateContractAddress('CSHORT');
    const r2 = validateAssetCode('');
    clearSpans(); // not testing span here
    const combined = combineResults(r1, r2);
    expect(combined.valid).toBe(false);
    expect(combined.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('is valid when all results are valid', () => {
    const r1 = validateAssetCode('USDC');
    const r2 = validateNumericInput('100', 'x');
    const combined = combineResults(r1, r2);
    expect(combined.valid).toBe(true);
    expect(combined.errors).toHaveLength(0);
  });
});
