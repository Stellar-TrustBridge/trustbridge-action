/**
 * Tests for Issue #45 — trustbridge.yml consumer config reader.
 *
 * Covers:
 *   - parseSimpleYaml: flat key/value parsing (strings, booleans, numbers, comments)
 *   - readTrustbridgeConfig: file-not-found, successful read, validation errors,
 *     path traversal guard
 *   - validateTrustbridgeConfig (via validation.ts): SSRF blocking, injection
 *     rejection, secret field redaction, C-address / G-address issuer validation
 *   - sanitizeConfigString: injection pattern detection
 *   - validateSsrfSafeUrl: protocol and private-IP enforcement
 *   - redactSecretFields: secret key masking
 *   - mergeConsumerConfig: precedence rules
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  parseSimpleYaml,
  readTrustbridgeConfig,
  mergeConsumerConfig,
} from '../src/configReader';
import {
  validateSsrfSafeUrl,
  sanitizeConfigString,
  redactSecretFields,
  validateTrustbridgeConfig,
  SECRET_FIELD_NAMES,
} from '../src/validation';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a temp file and return its path + dir. */
function writeTempFileInDir(
  content: string,
  filename = '.trustbridge.yml',
): { filePath: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-test-'));
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content, 'utf8');
  return { filePath, dir };
}

const VALID_G_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const VALID_C_ISSUER = 'C' + 'A'.repeat(55);

// ---------------------------------------------------------------------------
// parseSimpleYaml
// ---------------------------------------------------------------------------
describe('parseSimpleYaml', () => {
  it('parses unquoted string values', () => {
    const result = parseSimpleYaml('horizon_url: https://horizon.stellar.org');
    expect(result.horizon_url).toBe('https://horizon.stellar.org');
  });

  it('parses double-quoted string values', () => {
    const result = parseSimpleYaml('asset_code: "USDC"');
    expect(result.asset_code).toBe('USDC');
  });

  it('parses single-quoted string values', () => {
    const result = parseSimpleYaml("asset_code: 'USDC'");
    expect(result.asset_code).toBe('USDC');
  });

  it('parses boolean true', () => {
    const result = parseSimpleYaml('fail_on_missing: true');
    expect(result.fail_on_missing).toBe(true);
  });

  it('parses boolean false', () => {
    const result = parseSimpleYaml('fail_on_missing: false');
    expect(result.fail_on_missing).toBe(false);
  });

  it('parses boolean case-insensitively', () => {
    expect(parseSimpleYaml('x: True').x).toBe(true);
    expect(parseSimpleYaml('x: FALSE').x).toBe(false);
  });

  it('parses numeric values', () => {
    const result = parseSimpleYaml('horizon_timeout_ms: 15000');
    expect(result.horizon_timeout_ms).toBe(15000);
  });

  it('strips inline comments', () => {
    const result = parseSimpleYaml('asset_code: USDC # default asset');
    expect(result.asset_code).toBe('USDC');
  });

  it('ignores full-line comments', () => {
    const yaml = `# This is a comment\nasset_code: USDC`;
    const result = parseSimpleYaml(yaml);
    expect(result.asset_code).toBe('USDC');
    expect(Object.keys(result)).toEqual(['asset_code']);
  });

  it('ignores blank lines', () => {
    const yaml = `\nasset_code: USDC\n\nfail_on_missing: false\n`;
    const result = parseSimpleYaml(yaml);
    expect(result.asset_code).toBe('USDC');
    expect(result.fail_on_missing).toBe(false);
  });

  it('parses multiple keys', () => {
    const yaml = [
      'horizon_url: https://horizon.stellar.org',
      'asset_code: USDC',
      'fail_on_missing: true',
    ].join('\n');
    const result = parseSimpleYaml(yaml);
    expect(result.horizon_url).toBe('https://horizon.stellar.org');
    expect(result.asset_code).toBe('USDC');
    expect(result.fail_on_missing).toBe(true);
  });

  it('returns null for empty / null values', () => {
    expect(parseSimpleYaml('x: null').x).toBeNull();
    expect(parseSimpleYaml('x: ~').x).toBeNull();
    expect(parseSimpleYaml('x:').x).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateSsrfSafeUrl
// ---------------------------------------------------------------------------
describe('validateSsrfSafeUrl', () => {
  it('accepts a valid public https URL', () => {
    const r = validateSsrfSafeUrl('https://horizon.stellar.org', 'horizon_url');
    expect(r.valid).toBe(true);
  });

  it('accepts http when allowHttp is true', () => {
    const r = validateSsrfSafeUrl('http://horizon-testnet.stellar.org', 'horizon_url', {
      allowHttp: true,
    });
    expect(r.valid).toBe(true);
  });

  it('rejects http when allowHttp is false (default)', () => {
    const r = validateSsrfSafeUrl('http://horizon.stellar.org', 'horizon_url');
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/https/);
  });

  it('rejects loopback 127.x.x.x', () => {
    const r = validateSsrfSafeUrl('https://127.0.0.1/api', 'horizon_url', { allowHttp: true });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/blocked/i);
  });

  it('rejects localhost', () => {
    const r = validateSsrfSafeUrl('http://localhost:8080', 'horizon_url', { allowHttp: true });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/blocked/i);
  });

  it('rejects private class-A (10.x.x.x)', () => {
    const r = validateSsrfSafeUrl('https://10.0.0.1', 'horizon_url', { allowHttp: true });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/blocked/i);
  });

  it('rejects private class-B (172.16-31.x.x)', () => {
    const r = validateSsrfSafeUrl('https://172.16.0.1', 'horizon_url', { allowHttp: true });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/blocked/i);
  });

  it('does not block 172.15.x.x (outside class-B range)', () => {
    const r = validateSsrfSafeUrl('https://172.15.0.1', 'horizon_url', { allowHttp: true });
    expect(r.valid).toBe(true);
  });

  it('rejects private class-C (192.168.x.x)', () => {
    const r = validateSsrfSafeUrl('https://192.168.1.1', 'horizon_url', { allowHttp: true });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/blocked/i);
  });

  it('rejects AWS metadata endpoint (169.254.169.254)', () => {
    const r = validateSsrfSafeUrl('http://169.254.169.254/latest/meta-data/', 'horizon_url', {
      allowHttp: true,
    });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/blocked/i);
  });

  it('rejects file:// URLs', () => {
    const r = validateSsrfSafeUrl('file:///etc/passwd', 'horizon_url', { allowHttp: true });
    expect(r.valid).toBe(false);
  });

  it('rejects malformed URLs', () => {
    const r = validateSsrfSafeUrl('not-a-url', 'horizon_url');
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/not a valid URL/i);
  });

  it('rejects empty string', () => {
    const r = validateSsrfSafeUrl('', 'horizon_url');
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/cannot be empty/i);
  });
});

// ---------------------------------------------------------------------------
// sanitizeConfigString
// ---------------------------------------------------------------------------
describe('sanitizeConfigString', () => {
  it('accepts clean alphanumeric strings', () => {
    expect(sanitizeConfigString('USDC', 'asset_code').valid).toBe(true);
  });

  it('accepts strings with hyphens and dots', () => {
    expect(sanitizeConfigString('horizon-testnet.stellar.org', 'field').valid).toBe(true);
  });

  it('rejects strings containing semicolons', () => {
    const r = sanitizeConfigString('USDC; rm -rf /', 'asset_code');
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/injection/i);
  });

  it('rejects strings containing pipe characters', () => {
    const r = sanitizeConfigString('USDC | cat /etc/passwd', 'asset_code');
    expect(r.valid).toBe(false);
  });

  it('rejects strings containing backticks', () => {
    const r = sanitizeConfigString('`id`', 'asset_code');
    expect(r.valid).toBe(false);
  });

  it('rejects strings containing dollar signs', () => {
    const r = sanitizeConfigString('$HOME', 'asset_code');
    expect(r.valid).toBe(false);
  });

  it('rejects strings containing newlines', () => {
    const r = sanitizeConfigString('USDC\nmalicious', 'asset_code');
    expect(r.valid).toBe(false);
  });

  it('rejects strings containing carriage returns', () => {
    const r = sanitizeConfigString('USDC\rmalicious', 'asset_code');
    expect(r.valid).toBe(false);
  });

  it('rejects strings containing null bytes', () => {
    const r = sanitizeConfigString('USDC\x00', 'asset_code');
    expect(r.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// redactSecretFields
// ---------------------------------------------------------------------------
describe('redactSecretFields', () => {
  it('replaces known secret field values with ***', () => {
    const raw = { github_token: 'ghp_realtoken', asset_code: 'USDC' };
    const safe = redactSecretFields(raw);
    expect(safe.github_token).toBe('***');
    expect(safe.asset_code).toBe('USDC');
  });

  it('redacts all fields in SECRET_FIELD_NAMES', () => {
    const raw: Record<string, unknown> = {};
    for (const key of SECRET_FIELD_NAMES) {
      raw[key] = 'secret-value';
    }
    const safe = redactSecretFields(raw);
    for (const key of SECRET_FIELD_NAMES) {
      expect(safe[key]).toBe('***');
    }
  });

  it('does not mutate the original object', () => {
    const raw = { github_token: 'real', asset_code: 'USDC' };
    redactSecretFields(raw);
    expect(raw.github_token).toBe('real');
  });

  it('passes through unknown fields unchanged', () => {
    const raw = { custom_field: 'value' };
    expect(redactSecretFields(raw).custom_field).toBe('value');
  });
});

// ---------------------------------------------------------------------------
// validateTrustbridgeConfig
// ---------------------------------------------------------------------------
describe('validateTrustbridgeConfig', () => {
  it('accepts a valid complete config', () => {
    const raw = {
      horizon_url: 'https://horizon.stellar.org',
      asset_code: 'USDC',
      asset_issuer: VALID_G_ISSUER,
      min_xlm_reserve: '1.5',
      fail_on_missing: true,
    };
    expect(validateTrustbridgeConfig(raw).valid).toBe(true);
  });

  it('accepts a valid config with C-address issuer', () => {
    const raw = { asset_issuer: VALID_C_ISSUER };
    expect(validateTrustbridgeConfig(raw).valid).toBe(true);
  });

  it('rejects a config with an SSRF-blocked horizon_url', () => {
    const r = validateTrustbridgeConfig({ horizon_url: 'http://localhost:8080' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /blocked/i.test(e))).toBe(true);
  });

  it('rejects a config with a private-IP horizon_url_fallback', () => {
    const r = validateTrustbridgeConfig({ horizon_url_fallback: 'https://10.0.0.1' });
    expect(r.valid).toBe(false);
  });

  it('rejects a config with an injected asset_code', () => {
    const r = validateTrustbridgeConfig({ asset_code: 'USDC; rm -rf /' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /injection/i.test(e))).toBe(true);
  });

  it('rejects a config with a malformed G-address issuer', () => {
    const r = validateTrustbridgeConfig({ asset_issuer: 'GBADADDRESS' });
    expect(r.valid).toBe(false);
  });

  it('rejects a config with an invalid C-address issuer', () => {
    const r = validateTrustbridgeConfig({ asset_issuer: 'CSHORT' });
    expect(r.valid).toBe(false);
  });

  it('rejects a config with a non-boolean fail_on_missing', () => {
    const r = validateTrustbridgeConfig({ fail_on_missing: 'yes' as unknown as boolean });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /fail_on_missing.*boolean/.test(e))).toBe(true);
  });

  it('accepts an empty config object (all fields optional)', () => {
    expect(validateTrustbridgeConfig({}).valid).toBe(true);
  });

  it('accumulates multiple errors in one result', () => {
    const r = validateTrustbridgeConfig({
      horizon_url: 'http://localhost',
      asset_code: 'USDC; drop table',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// readTrustbridgeConfig — file system integration
// ---------------------------------------------------------------------------
describe('readTrustbridgeConfig', () => {
  it('returns found=false and valid=true when the file does not exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-test-'));
    const result = readTrustbridgeConfig('.trustbridge.yml', dir);
    expect(result.found).toBe(false);
    expect(result.validation.valid).toBe(true);
    expect(result.config).toBeNull();
  });

  it('reads and parses a valid config file successfully', () => {
    const yaml = [
      `horizon_url: https://horizon.stellar.org`,
      `asset_code: USDC`,
      `asset_issuer: ${VALID_G_ISSUER}`,
      `fail_on_missing: true`,
    ].join('\n');
    const { filePath, dir } = writeTempFileInDir(yaml);
    const result = readTrustbridgeConfig(path.basename(filePath), dir);

    expect(result.found).toBe(true);
    expect(result.validation.valid).toBe(true);
    expect(result.config).not.toBeNull();
    expect(result.config?.horizon_url).toBe('https://horizon.stellar.org');
    expect(result.config?.asset_code).toBe('USDC');
    expect(result.config?.fail_on_missing).toBe(true);
  });

  it('returns found=true and valid=false for an SSRF-blocked horizon_url', () => {
    const yaml = 'horizon_url: http://127.0.0.1:8080';
    const { filePath, dir } = writeTempFileInDir(yaml);
    const result = readTrustbridgeConfig(path.basename(filePath), dir);

    expect(result.found).toBe(true);
    expect(result.validation.valid).toBe(false);
    expect(result.validation.errors.some((e) => /blocked/i.test(e))).toBe(true);
    expect(result.config).toBeNull();
  });

  it('returns found=true and valid=false for an injection attempt in asset_code', () => {
    const yaml = 'asset_code: USDC;cat /etc/passwd';
    const { filePath, dir } = writeTempFileInDir(yaml);
    const result = readTrustbridgeConfig(path.basename(filePath), dir);

    expect(result.found).toBe(true);
    expect(result.validation.valid).toBe(false);
    expect(result.validation.errors.some((e) => /injection/i.test(e))).toBe(true);
  });

  it('provides a redactedSnapshot that masks secret fields', () => {
    const yaml = `github_token: ghp_real_token\nasset_code: USDC`;
    const { filePath, dir } = writeTempFileInDir(yaml);
    const result = readTrustbridgeConfig(path.basename(filePath), dir);

    // Even when validation succeeds for asset_code, snapshot masks the token
    expect(result.redactedSnapshot?.github_token).toBe('***');
    expect(result.redactedSnapshot?.asset_code).toBe('USDC');
  });

  it('blocks path traversal outside workspace root', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-test-'));
    const result = readTrustbridgeConfig('../../etc/passwd', dir);

    expect(result.found).toBe(false);
    expect(result.validation.valid).toBe(false);
    expect(result.validation.errors[0]).toMatch(/outside the workspace root/i);
  });

  it('defaults to .trustbridge.yml in workspace root when path is empty', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-test-'));
    // No file written — should come back as not found
    const result = readTrustbridgeConfig('', dir);
    expect(result.found).toBe(false);
    expect(result.resolvedPath).toContain('.trustbridge.yml');
  });

  it('accepts an absolute path that is inside the workspace root', () => {
    const yaml = 'asset_code: USDC';
    const { filePath, dir } = writeTempFileInDir(yaml);
    const result = readTrustbridgeConfig(filePath, dir);
    expect(result.found).toBe(true);
    expect(result.validation.valid).toBe(true);
  });

  it('surfaces all validation errors when multiple fields are invalid', () => {
    const yaml = [
      'horizon_url: http://localhost',
      'asset_code: USDC; bad',
    ].join('\n');
    const { filePath, dir } = writeTempFileInDir(yaml);
    const result = readTrustbridgeConfig(path.basename(filePath), dir);

    expect(result.validation.valid).toBe(false);
    expect(result.validation.errors.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// mergeConsumerConfig
// ---------------------------------------------------------------------------
describe('mergeConsumerConfig', () => {
  const baseInputs = {
    horizonUrl: 'https://horizon.stellar.org',
    assetCode: 'USDC',
    assetIssuer: VALID_G_ISSUER,
    minXlmReserveRaw: '1.5',
    failOnMissing: true,
  };

  it('returns unchanged inputs when consumerConfig is null', () => {
    const result = mergeConsumerConfig(baseInputs, null, new Set());
    expect(result).toEqual(baseInputs);
  });

  it('applies consumer config values for fields not explicitly set', () => {
    const consumerConfig = { horizon_url: 'https://horizon-testnet.stellar.org' };
    const result = mergeConsumerConfig(baseInputs, consumerConfig, new Set());
    expect(result.horizonUrl).toBe('https://horizon-testnet.stellar.org');
  });

  it('does not override fields that are in the explicitInputs set', () => {
    const consumerConfig = { horizon_url: 'https://horizon-testnet.stellar.org' };
    const result = mergeConsumerConfig(baseInputs, consumerConfig, new Set(['horizonUrl']));
    // explicit input wins
    expect(result.horizonUrl).toBe('https://horizon.stellar.org');
  });

  it('applies fail_on_missing boolean from consumer config', () => {
    const consumerConfig = { fail_on_missing: false };
    const result = mergeConsumerConfig(baseInputs, consumerConfig, new Set());
    expect(result.failOnMissing).toBe(false);
  });

  it('does not override failOnMissing when explicitly set', () => {
    const consumerConfig = { fail_on_missing: false };
    const result = mergeConsumerConfig(baseInputs, consumerConfig, new Set(['failOnMissing']));
    expect(result.failOnMissing).toBe(true);
  });

  it('does not mutate the original inputs object', () => {
    const consumerConfig = { horizon_url: 'https://different.example.com' };
    const original = { ...baseInputs };
    mergeConsumerConfig(baseInputs, consumerConfig, new Set());
    expect(baseInputs.horizonUrl).toBe(original.horizonUrl);
  });
});
