/**
 * #147 — TRUSTBRIDGE_* environment variable support tests
 *
 * Validates that:
 *   - TRUSTBRIDGE_ENV_MAP covers the documented inputs.
 *   - resolveInput returns the with: value when it is non-empty (highest precedence).
 *   - resolveInput falls back to the TRUSTBRIDGE_* env var when with: is empty.
 *   - resolveInput returns '' when neither with: nor env var is set.
 *   - github_token and stellar_address_input are NOT in the env map (security).
 *   - At least three env mappings are tested end-to-end.
 *   - No secret values are read from env (env map excludes token fields).
 */

import { resolveInput, TRUSTBRIDGE_ENV_MAP } from '../src/inputs';

// ---------------------------------------------------------------------------
// TRUSTBRIDGE_ENV_MAP shape
// ---------------------------------------------------------------------------

describe('TRUSTBRIDGE_ENV_MAP', () => {
  it('does not map github_token (secrets must not come from env)', () => {
    const values = Object.values(TRUSTBRIDGE_ENV_MAP);
    expect(values).not.toContain('github_token');
  });

  it('does not map stellar_address_input (required explicit input)', () => {
    const values = Object.values(TRUSTBRIDGE_ENV_MAP);
    expect(values).not.toContain('stellar_address_input');
  });

  it('maps TRUSTBRIDGE_HORIZON_URL to horizon_url', () => {
    expect(TRUSTBRIDGE_ENV_MAP['TRUSTBRIDGE_HORIZON_URL']).toBe('horizon_url');
  });

  it('maps TRUSTBRIDGE_ASSET_CODE to asset_code', () => {
    expect(TRUSTBRIDGE_ENV_MAP['TRUSTBRIDGE_ASSET_CODE']).toBe('asset_code');
  });

  it('maps TRUSTBRIDGE_ASSET_ISSUER to asset_issuer', () => {
    expect(TRUSTBRIDGE_ENV_MAP['TRUSTBRIDGE_ASSET_ISSUER']).toBe('asset_issuer');
  });

  it('maps TRUSTBRIDGE_MIN_XLM_RESERVE to min_xlm_reserve', () => {
    expect(TRUSTBRIDGE_ENV_MAP['TRUSTBRIDGE_MIN_XLM_RESERVE']).toBe('min_xlm_reserve');
  });

  it('maps TRUSTBRIDGE_FAIL_ON_MISSING to fail_on_missing', () => {
    expect(TRUSTBRIDGE_ENV_MAP['TRUSTBRIDGE_FAIL_ON_MISSING']).toBe('fail_on_missing');
  });

  it('maps TRUSTBRIDGE_DEBUG_MODE to debug_mode', () => {
    expect(TRUSTBRIDGE_ENV_MAP['TRUSTBRIDGE_DEBUG_MODE']).toBe('debug_mode');
  });

  it('maps TRUSTBRIDGE_HORIZON_URL_FALLBACK to horizon_url_fallback', () => {
    expect(TRUSTBRIDGE_ENV_MAP['TRUSTBRIDGE_HORIZON_URL_FALLBACK']).toBe('horizon_url_fallback');
  });

  it('maps TRUSTBRIDGE_PREFLIGHT_ONLY to preflight_only', () => {
    expect(TRUSTBRIDGE_ENV_MAP['TRUSTBRIDGE_PREFLIGHT_ONLY']).toBe('preflight_only');
  });
});

// ---------------------------------------------------------------------------
// resolveInput — precedence rules
// ---------------------------------------------------------------------------

describe('resolveInput — with: value wins (highest precedence)', () => {
  it('returns the with: value when it is non-empty', () => {
    const env = { TRUSTBRIDGE_HORIZON_URL: 'https://env-horizon.example.com' };
    expect(resolveInput('horizon_url', 'https://with-horizon.example.com', env)).toBe(
      'https://with-horizon.example.com',
    );
  });

  it('returns the with: value even when it differs from env', () => {
    const env = { TRUSTBRIDGE_ASSET_CODE: 'EURC' };
    expect(resolveInput('asset_code', 'USDC', env)).toBe('USDC');
  });

  it('returns the with: value for min_xlm_reserve', () => {
    const env = { TRUSTBRIDGE_MIN_XLM_RESERVE: '3.0' };
    expect(resolveInput('min_xlm_reserve', '1.5', env)).toBe('1.5');
  });
});

describe('resolveInput — env var fallback when with: is empty', () => {
  it('returns TRUSTBRIDGE_HORIZON_URL when with: is empty', () => {
    const env = { TRUSTBRIDGE_HORIZON_URL: 'https://horizon-testnet.stellar.org' };
    expect(resolveInput('horizon_url', '', env)).toBe('https://horizon-testnet.stellar.org');
  });

  it('returns TRUSTBRIDGE_ASSET_CODE when with: is empty', () => {
    const env = { TRUSTBRIDGE_ASSET_CODE: 'EURC' };
    expect(resolveInput('asset_code', '', env)).toBe('EURC');
  });

  it('returns TRUSTBRIDGE_ASSET_ISSUER when with: is empty', () => {
    const env = { TRUSTBRIDGE_ASSET_ISSUER: 'GCIRCLEISSUERADDRESS1234567890ABCDEFGHIJKLMNOPQRSTUVWX' };
    const result = resolveInput('asset_issuer', '', env);
    expect(result).toBe('GCIRCLEISSUERADDRESS1234567890ABCDEFGHIJKLMNOPQRSTUVWX');
  });

  it('returns TRUSTBRIDGE_MIN_XLM_RESERVE when with: is empty', () => {
    const env = { TRUSTBRIDGE_MIN_XLM_RESERVE: '2.5' };
    expect(resolveInput('min_xlm_reserve', '', env)).toBe('2.5');
  });

  it('returns TRUSTBRIDGE_FAIL_ON_MISSING when with: is empty', () => {
    const env = { TRUSTBRIDGE_FAIL_ON_MISSING: 'false' };
    expect(resolveInput('fail_on_missing', '', env)).toBe('false');
  });

  it('returns TRUSTBRIDGE_DEBUG_MODE when with: is empty', () => {
    const env = { TRUSTBRIDGE_DEBUG_MODE: 'true' };
    expect(resolveInput('debug_mode', '', env)).toBe('true');
  });

  it('returns TRUSTBRIDGE_HORIZON_URL_FALLBACK when with: is empty', () => {
    const env = { TRUSTBRIDGE_HORIZON_URL_FALLBACK: 'https://fallback.horizon.example.com' };
    expect(resolveInput('horizon_url_fallback', '', env)).toBe('https://fallback.horizon.example.com');
  });

  it('returns TRUSTBRIDGE_PREFLIGHT_ONLY when with: is empty', () => {
    const env = { TRUSTBRIDGE_PREFLIGHT_ONLY: 'true' };
    expect(resolveInput('preflight_only', '', env)).toBe('true');
  });
});

describe('resolveInput — returns empty string when neither source is set', () => {
  it('returns empty string for horizon_url when both with: and env are absent', () => {
    expect(resolveInput('horizon_url', '', {})).toBe('');
  });

  it('returns empty string for unknown input names', () => {
    expect(resolveInput('unknown_input', '', { TRUSTBRIDGE_UNKNOWN_INPUT: 'value' })).toBe('');
  });

  it('ignores env var with empty string value', () => {
    const env = { TRUSTBRIDGE_ASSET_CODE: '' };
    expect(resolveInput('asset_code', '', env)).toBe('');
  });
});

describe('resolveInput — no secrets logged from env', () => {
  it('does not pick up TRUSTBRIDGE_GITHUB_TOKEN (not in map)', () => {
    // Even if someone sets this env var, it should not be returned
    const env = { TRUSTBRIDGE_GITHUB_TOKEN: 'super-secret-token' };
    const result = resolveInput('github_token', '', env);
    // github_token is not in TRUSTBRIDGE_ENV_MAP, so env is not consulted
    expect(result).toBe('');
  });

  it('does not pick up TRUSTBRIDGE_STELLAR_ADDRESS_INPUT (not in map)', () => {
    const env = { TRUSTBRIDGE_STELLAR_ADDRESS_INPUT: 'G' + 'A'.repeat(55) };
    const result = resolveInput('stellar_address_input', '', env);
    expect(result).toBe('');
  });
});
