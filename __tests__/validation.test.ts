/**
 * validation.test.ts
 *
 * Exercises security-sensitive paths in src/validation.ts.
 * Tests are Node-version-agnostic (no native crypto / timer APIs) and must
 * pass identically on Node 20 and Node 22 in the CI matrix.
 *
 * Coverage targets:
 *   - validateContractAddress   (StrKey format)
 *   - validateSsrfSafeUrl       (SSRF prevention, CRITICAL security path)
 *   - sanitizeConfigString      (injection prevention, CRITICAL security path)
 *   - redactSecretFields        (secret leakage prevention)
 *   - validateTrustbridgeConfig (combined round-trip validator)
 *   - validateUrl               (protocol enforcement)
 *   - getSpans / clearSpans     (observability helpers)
 */

import {
  validateContractAddress,
  validateSsrfSafeUrl,
  sanitizeConfigString,
  redactSecretFields,
  validateTrustbridgeConfig,
  validateUrl,
  getSpans,
  clearSpans,
  SECRET_FIELD_NAMES,
} from '../src/validation';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_CONTRACT_ADDRESS = 'C' + 'A'.repeat(55);
const VALID_G_ADDRESS = 'G' + 'A'.repeat(55);

// ---------------------------------------------------------------------------
// validateContractAddress
// ---------------------------------------------------------------------------

describe('validateContractAddress', () => {
  it('accepts a well-formed 56-character contract address', () => {
    expect(validateContractAddress(VALID_CONTRACT_ADDRESS)).toEqual({
      valid: true,
      errors: [],
      warnings: [],
    });
  });

  it('rejects an empty address', () => {
    const result = validateContractAddress('');
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(['Contract address cannot be empty']);
  });

  it('rejects addresses not starting with C', () => {
    const result = validateContractAddress('G' + 'A'.repeat(55));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /must start with "C"/.test(e))).toBe(true);
  });

  it('rejects addresses with the wrong length', () => {
    const result = validateContractAddress('CSHORT');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /56 characters/.test(e))).toBe(true);
  });

  it('rejects addresses with invalid base32 characters', () => {
    const result = validateContractAddress('C' + '0'.repeat(55));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /StrKey format/.test(e))).toBe(true);
  });

  it('trims surrounding whitespace before validating', () => {
    expect(validateContractAddress(`  ${VALID_CONTRACT_ADDRESS}  `).valid).toBe(true);
  });

  it('accepts a valid Soroban C-address in the broader Stellar address validator', () => {
    expect(() => {
      // The reusable address validator accepts both G- and C-addresses at the StrKey level.
      const result = validateContractAddress(VALID_CONTRACT_ADDRESS);
      expect(result.valid).toBe(true);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateSsrfSafeUrl  — CRITICAL security path
// ---------------------------------------------------------------------------

describe('validateSsrfSafeUrl', () => {
  it('accepts a valid public https URL', () => {
    const result = validateSsrfSafeUrl('https://horizon.stellar.org', 'horizon_url');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects http when allowHttp is not set', () => {
    const result = validateSsrfSafeUrl('http://horizon.stellar.org', 'horizon_url');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /https/.test(e))).toBe(true);
  });

  it('accepts http when allowHttp is explicitly true', () => {
    const result = validateSsrfSafeUrl('http://horizon.stellar.org', 'horizon_url', {
      allowHttp: true,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects loopback address 127.0.0.1 (SSRF)', () => {
    const result = validateSsrfSafeUrl(
      'https://127.0.0.1/api',
      'horizon_url',
      { allowHttp: true },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /blocked/.test(e))).toBe(true);
  });

  it('rejects localhost (SSRF)', () => {
    const result = validateSsrfSafeUrl('http://localhost:8080', 'horizon_url', {
      allowHttp: true,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /blocked/.test(e))).toBe(true);
  });

  it('rejects private class-A IP 10.x.x.x (SSRF)', () => {
    const result = validateSsrfSafeUrl(
      'https://10.0.0.1/horizon',
      'horizon_url',
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /blocked/.test(e))).toBe(true);
  });

  it('rejects private class-B IP 172.16.x.x (SSRF)', () => {
    const result = validateSsrfSafeUrl('https://172.16.0.1/', 'horizon_url');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /blocked/.test(e))).toBe(true);
  });

  it('rejects private class-C IP 192.168.x.x (SSRF)', () => {
    const result = validateSsrfSafeUrl('https://192.168.1.1/', 'horizon_url');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /blocked/.test(e))).toBe(true);
  });

  it('rejects AWS metadata endpoint 169.254.169.254 (SSRF)', () => {
    const result = validateSsrfSafeUrl(
      'http://169.254.169.254/latest/meta-data/',
      'horizon_url',
      { allowHttp: true },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /blocked/.test(e))).toBe(true);
  });

  it('rejects GCP metadata endpoint (SSRF)', () => {
    const result = validateSsrfSafeUrl(
      'http://metadata.google.internal/computeMetadata/',
      'horizon_url',
      { allowHttp: true },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /blocked/.test(e))).toBe(true);
  });

  it('rejects file:// protocol (SSRF)', () => {
    const result = validateSsrfSafeUrl('file:///etc/passwd', 'horizon_url');
    expect(result.valid).toBe(false);
  });

  it('rejects an empty value', () => {
    const result = validateSsrfSafeUrl('', 'horizon_url');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /cannot be empty/.test(e))).toBe(true);
  });

  it('rejects a non-URL string', () => {
    const result = validateSsrfSafeUrl('not-a-url', 'horizon_url');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /not a valid URL/.test(e))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sanitizeConfigString  — CRITICAL security path
// ---------------------------------------------------------------------------

describe('sanitizeConfigString', () => {
  it('accepts a clean alphanumeric string', () => {
    expect(sanitizeConfigString('USDC', 'asset_code').valid).toBe(true);
  });

  it('accepts a clean decimal string', () => {
    expect(sanitizeConfigString('1.5', 'min_xlm_reserve').valid).toBe(true);
  });

  it('rejects a string containing a semicolon', () => {
    const result = sanitizeConfigString('USDC;drop table', 'asset_code');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /injection/.test(e))).toBe(true);
  });

  it('rejects a string containing an ampersand', () => {
    const result = sanitizeConfigString('USDC&evil', 'asset_code');
    expect(result.valid).toBe(false);
  });

  it('rejects a string containing a pipe character', () => {
    const result = sanitizeConfigString('USDC|cmd', 'asset_code');
    expect(result.valid).toBe(false);
  });

  it('rejects a string containing a backtick', () => {
    const result = sanitizeConfigString('`whoami`', 'asset_code');
    expect(result.valid).toBe(false);
  });

  it('rejects a string containing a dollar-sign', () => {
    const result = sanitizeConfigString('${HOME}', 'asset_code');
    expect(result.valid).toBe(false);
  });

  it('rejects a string containing a newline (header injection)', () => {
    const result = sanitizeConfigString('USDC\nevil', 'asset_code');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /injection/.test(e))).toBe(true);
  });

  it('rejects a string containing a carriage return', () => {
    const result = sanitizeConfigString('USDC\revil', 'asset_code');
    expect(result.valid).toBe(false);
  });

  it('rejects a string containing a null byte', () => {
    const result = sanitizeConfigString('USDC\x00evil', 'asset_code');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /null byte/.test(e))).toBe(true);
  });

  it('rejects a non-string value', () => {
    // @ts-expect-error — deliberately testing runtime type guard
    const result = sanitizeConfigString(42, 'asset_code');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /must be a string/.test(e))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// redactSecretFields  — secret leakage prevention
// ---------------------------------------------------------------------------

describe('redactSecretFields', () => {
  it('redacts every field in SECRET_FIELD_NAMES', () => {
    const input: Record<string, unknown> = {};
    for (const field of SECRET_FIELD_NAMES) {
      input[field] = 'super-secret-value';
    }
    const output = redactSecretFields(input);
    for (const field of SECRET_FIELD_NAMES) {
      expect(output[field]).toBe('***');
    }
  });

  it('preserves non-secret fields unchanged', () => {
    const input = { asset_code: 'USDC', min_xlm_reserve: '1.5' };
    const output = redactSecretFields(input);
    expect(output['asset_code']).toBe('USDC');
    expect(output['min_xlm_reserve']).toBe('1.5');
  });

  it('does not mutate the original object', () => {
    const input = { github_token: 'ghp_abc123' };
    redactSecretFields(input);
    expect(input['github_token']).toBe('ghp_abc123');
  });

  it('handles an empty object', () => {
    expect(redactSecretFields({})).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// validateTrustbridgeConfig  — combined round-trip
// ---------------------------------------------------------------------------

describe('validateTrustbridgeConfig', () => {
  it('accepts a well-formed config with a public Horizon URL', () => {
    const result = validateTrustbridgeConfig({
      horizon_url: 'https://horizon.stellar.org',
      asset_code: 'USDC',
      asset_issuer: VALID_G_ADDRESS,
      min_xlm_reserve: '1.5',
      fail_on_missing: true,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects a private-IP horizon_url (SSRF)', () => {
    const result = validateTrustbridgeConfig({
      horizon_url: 'http://192.168.1.1/',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /blocked/.test(e))).toBe(true);
  });

  it('rejects an asset_code containing shell metacharacters (injection)', () => {
    const result = validateTrustbridgeConfig({ asset_code: 'USD;C' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /injection/.test(e))).toBe(true);
  });

  it('rejects a malformed G-address issuer', () => {
    const result = validateTrustbridgeConfig({ asset_issuer: 'GBADADDR' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /G-address/.test(e))).toBe(true);
  });

  it('rejects an asset_issuer not starting with G or C', () => {
    const result = validateTrustbridgeConfig({ asset_issuer: 'XBADPREFIX' + 'A'.repeat(45) });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /must start with/.test(e))).toBe(true);
  });

  it('rejects fail_on_missing when given a non-boolean', () => {
    const result = validateTrustbridgeConfig({ fail_on_missing: 'yes' as unknown as boolean });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /boolean/.test(e))).toBe(true);
  });

  it('ignores unknown keys silently (forward-compat)', () => {
    const result = validateTrustbridgeConfig({
      horizon_url: 'https://horizon.stellar.org',
      unknown_future_key: 'whatever',
    });
    expect(result.valid).toBe(true);
  });

  it('accepts a valid C-address issuer (Soroban contract)', () => {
    const result = validateTrustbridgeConfig({
      horizon_url: 'https://horizon.stellar.org',
      asset_issuer: VALID_CONTRACT_ADDRESS,
    });
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateUrl  — protocol enforcement
// ---------------------------------------------------------------------------

describe('validateUrl', () => {
  it('accepts https by default', () => {
    expect(validateUrl('https://example.com', 'test_url').valid).toBe(true);
  });

  it('accepts http by default', () => {
    expect(validateUrl('http://example.com', 'test_url').valid).toBe(true);
  });

  it('rejects ftp when not in allowed protocols', () => {
    const result = validateUrl('ftp://example.com', 'test_url', {
      protocols: ['http', 'https'],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /protocols/.test(e))).toBe(true);
  });

  it('rejects an empty string', () => {
    const result = validateUrl('', 'test_url');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /cannot be empty/.test(e))).toBe(true);
  });

  it('rejects a malformed URL string', () => {
    const result = validateUrl('not-a-url', 'test_url');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /not a valid URL/.test(e))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getSpans / clearSpans  — observability helpers
// ---------------------------------------------------------------------------

describe('span observability', () => {
  beforeEach(() => clearSpans());
  afterEach(() => clearSpans());

  it('records a span for each validateContractAddress call', () => {
    validateContractAddress(VALID_CONTRACT_ADDRESS);
    const spans = getSpans();
    expect(spans.length).toBeGreaterThanOrEqual(1);
    expect(spans[spans.length - 1].name).toBe('validateContractAddress');
  });

  it('records status "ok" for a valid address', () => {
    validateContractAddress(VALID_CONTRACT_ADDRESS);
    const span = getSpans().pop();
    expect(span?.status).toBe('ok');
  });

  it('records status "error" for an invalid address', () => {
    validateContractAddress('INVALID');
    const span = getSpans().pop();
    expect(span?.status).toBe('error');
  });

  it('clearSpans empties the span store', () => {
    validateContractAddress(VALID_CONTRACT_ADDRESS);
    clearSpans();
    expect(getSpans()).toHaveLength(0);
  });

  it('getSpans returns a copy, not the internal reference', () => {
    validateContractAddress(VALID_CONTRACT_ADDRESS);
    const snapshot = getSpans();
    clearSpans();
    // snapshot is unaffected by the clear
    expect(snapshot.length).toBeGreaterThanOrEqual(1);
    expect(getSpans()).toHaveLength(0);
  });
});

