import {
  isFederationAddress,
  parseFederationAddress,
  validateFederationUsername,
  validateFederationDomain,
  resolveFederationAddress,
  validateMemo,
  MEMO_TEXT_MAX_BYTES,
  FederationResolution,
} from '../src/federation';

describe('isFederationAddress', () => {
  it('accepts valid federation address format', () => {
    expect(isFederationAddress('user*domain.com')).toBe(true);
    expect(isFederationAddress('alice*stellar.org')).toBe(true);
    expect(isFederationAddress('bob123*example.io')).toBe(true);
  });

  it('rejects addresses without *', () => {
    expect(isFederationAddress('userdomain.com')).toBe(false);
    expect(isFederationAddress('user@domain.com')).toBe(false);
  });

  it('rejects addresses with * at the start', () => {
    expect(isFederationAddress('*domain.com')).toBe(false);
  });

  it('rejects addresses with * at the end', () => {
    expect(isFederationAddress('user*')).toBe(false);
  });

  it('rejects addresses with multiple *', () => {
    expect(isFederationAddress('user*domain*com')).toBe(false);
  });

  it('rejects empty or null input', () => {
    expect(isFederationAddress('')).toBe(false);
    expect(isFederationAddress(null as unknown as string)).toBe(false);
    expect(isFederationAddress(undefined as unknown as string)).toBe(false);
  });
});

describe('parseFederationAddress', () => {
  it('parses valid federation address', () => {
    const result = parseFederationAddress('user*domain.com');
    expect(result).toEqual({ username: 'user', domain: 'domain.com' });
  });

  it('parses federation address with whitespace', () => {
    const result = parseFederationAddress('  user  *  domain.com  ');
    expect(result).toEqual({ username: 'user', domain: 'domain.com' });
  });

  it('returns null for invalid format', () => {
    expect(parseFederationAddress('')).toBeNull();
    expect(parseFederationAddress('userdomain.com')).toBeNull();
    expect(parseFederationAddress('*domain.com')).toBeNull();
    expect(parseFederationAddress('user*')).toBeNull();
  });

  it('returns null for null/undefined input', () => {
    expect(parseFederationAddress(null as unknown as string)).toBeNull();
    expect(parseFederationAddress(undefined as unknown as string)).toBeNull();
  });
});

describe('validateFederationUsername', () => {
  it('accepts valid usernames', () => {
    expect(validateFederationUsername('alice')).toEqual({ valid: true, errors: [] });
    expect(validateFederationUsername('bob123')).toEqual({ valid: true, errors: [] });
    expect(validateFederationUsername('user-name')).toEqual({ valid: true, errors: [] });
    expect(validateFederationUsername('user_name')).toEqual({ valid: true, errors: [] });
    expect(validateFederationUsername('user.name')).toEqual({ valid: true, errors: [] });
  });

  it('rejects empty username', () => {
    const result = validateFederationUsername('');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/empty/i);
  });

  it('rejects usernames that are too long', () => {
    const longUsername = 'a'.repeat(33);
    const result = validateFederationUsername(longUsername);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/32 characters/i);
  });

  it('rejects usernames with invalid characters', () => {
    const result = validateFederationUsername('user name');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/alphanumeric/i);
  });

  it('rejects usernames with shell metacharacters', () => {
    const result = validateFederationUsername('user;rm -rf /');
    expect(result.valid).toBe(false);
  });
});

describe('validateFederationDomain', () => {
  it('accepts valid domains', () => {
    expect(validateFederationDomain('domain.com')).toEqual({ valid: true, errors: [] });
    expect(validateFederationDomain('stellar.org')).toEqual({ valid: true, errors: [] });
    expect(validateFederationDomain('example.io')).toEqual({ valid: true, errors: [] });
  });

  it('rejects empty domain', () => {
    const result = validateFederationDomain('');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/empty/i);
  });

  it('rejects localhost', () => {
    const result = validateFederationDomain('localhost');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/blocked address/i);
  });

  it('rejects private IP domains', () => {
    expect(validateFederationDomain('127.0.0.1').valid).toBe(false);
    expect(validateFederationDomain('10.0.0.1').valid).toBe(false);
    expect(validateFederationDomain('192.168.1.1').valid).toBe(false);
    expect(validateFederationDomain('169.254.169.254').valid).toBe(false);
  });

  it('rejects metadata endpoints', () => {
    const result = validateFederationDomain('metadata.google.internal');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/blocked address/i);
  });
});

describe('resolveFederationAddress', () => {
  it('returns null for invalid federation address format', async () => {
    const result = await resolveFederationAddress('not-a-federation');
    expect(result).toBeNull();
  });

  it('returns null for invalid username', async () => {
    const result = await resolveFederationAddress('user name*domain.com');
    expect(result).toBeNull();
  });

  it('returns null for invalid domain', async () => {
    const result = await resolveFederationAddress('user*localhost');
    expect(result).toBeNull();
  });

  it('returns null when stellar.toml fetch fails', async () => {
    // Mock fetchSSRFSafe to return failure
    jest.mock('../src/ssrf', () => ({
      fetchSSRFSafe: jest.fn().mockResolvedValue({
        ok: false,
        error: 'Connection refused',
      }),
    }));

    const result = await resolveFederationAddress('user*nonexistent.domain');
    expect(result).toBeNull();
  });

  it('returns null when TOML has no federation server', async () => {
    const mockToml = `
# No federation server here
[FEDERATION_SERVER]
forward_url = ""
`;
    jest.mock('../src/ssrf', () => ({
      fetchSSRFSafe: jest.fn().mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(mockToml),
      }),
    }));

    const result = await resolveFederationAddress('user*domain.com');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Memo validation — validateMemo()
// ---------------------------------------------------------------------------

describe('validateMemo', () => {
  // -------------------------------------------------------------------------
  // Happy path: no memo
  // -------------------------------------------------------------------------
  it('returns valid when memo_type and memo are both absent', () => {
    const result = validateMemo(undefined, undefined);
    expect(result.valid).toBe(true);
  });

  it('ignores a memo value when memo_type is absent (non-standard server)', () => {
    // Some servers return memo without memo_type; we don't reject this.
    const result = validateMemo(undefined, 'some-value');
    expect(result.valid).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Happy path: text memo
  // -------------------------------------------------------------------------
  it('accepts a valid text memo', () => {
    const result = validateMemo('text', 'payment-ref-42');
    expect(result).toMatchObject({ valid: true, memoType: 'text', memo: 'payment-ref-42' });
  });

  it('accepts a text memo at exactly 28 bytes', () => {
    const exactly28 = 'a'.repeat(MEMO_TEXT_MAX_BYTES);
    const result = validateMemo('text', exactly28);
    expect(result.valid).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Happy path: id memo
  // -------------------------------------------------------------------------
  it('accepts a valid id memo (zero)', () => {
    const result = validateMemo('id', '0');
    expect(result).toMatchObject({ valid: true, memoType: 'id', memo: '0' });
  });

  it('accepts a valid id memo (large unsigned 64-bit)', () => {
    const result = validateMemo('id', '18446744073709551615');
    expect(result.valid).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Happy path: hash memo
  // -------------------------------------------------------------------------
  it('accepts a valid hash memo (64 hex chars, lowercase)', () => {
    const hash = 'a'.repeat(32) + 'f'.repeat(32);
    const result = validateMemo('hash', hash);
    expect(result).toMatchObject({ valid: true, memoType: 'hash', memo: hash });
  });

  it('accepts a valid hash memo with uppercase hex chars', () => {
    const result = validateMemo('hash', 'A'.repeat(64));
    expect(result.valid).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Failure: MEMO_REQUIRED — memo_type present, memo absent/empty
  // -------------------------------------------------------------------------
  it('returns MEMO_REQUIRED when memo_type is set but memo is absent', () => {
    const result = validateMemo('text', undefined);
    expect(result).toMatchObject({
      valid: false,
      code: 'MEMO_REQUIRED',
      reason: expect.stringContaining('"text"'),
    });
  });

  it('returns MEMO_REQUIRED when memo_type is set but memo is null', () => {
    const result = validateMemo('id', null);
    expect(result).toMatchObject({ valid: false, code: 'MEMO_REQUIRED' });
  });

  it('returns MEMO_REQUIRED when memo_type is set but memo is empty string', () => {
    const result = validateMemo('hash', '');
    expect(result).toMatchObject({ valid: false, code: 'MEMO_REQUIRED' });
  });

  it('returns MEMO_REQUIRED when memo_type is set but memo is whitespace only', () => {
    const result = validateMemo('text', '   ');
    expect(result).toMatchObject({ valid: false, code: 'MEMO_REQUIRED' });
  });

  // -------------------------------------------------------------------------
  // Failure: MEMO_TYPE_MISMATCH — unrecognized memo_type
  // -------------------------------------------------------------------------
  it('returns MEMO_TYPE_MISMATCH for an unrecognized memo_type', () => {
    const result = validateMemo('return', 'some-memo');
    expect(result).toMatchObject({
      valid: false,
      code: 'MEMO_TYPE_MISMATCH',
      reason: expect.stringContaining('"return"'),
    });
  });

  it('returns MEMO_TYPE_MISMATCH for memo_type "none" (not a Stellar type)', () => {
    const result = validateMemo('none', 'memo');
    expect(result).toMatchObject({ valid: false, code: 'MEMO_TYPE_MISMATCH' });
  });

  it('returns MEMO_TYPE_MISMATCH for a numeric memo_type', () => {
    const result = validateMemo(42, 'memo');
    expect(result).toMatchObject({ valid: false, code: 'MEMO_TYPE_MISMATCH' });
  });

  // -------------------------------------------------------------------------
  // Failure: MEMO_TYPE_MISMATCH — id memo with non-numeric value
  // -------------------------------------------------------------------------
  it('returns MEMO_TYPE_MISMATCH for id memo with non-numeric value', () => {
    const result = validateMemo('id', 'not-a-number');
    expect(result).toMatchObject({
      valid: false,
      code: 'MEMO_TYPE_MISMATCH',
      reason: expect.stringContaining('"id"'),
    });
  });

  it('returns MEMO_TYPE_MISMATCH for id memo with float string', () => {
    const result = validateMemo('id', '123.456');
    expect(result).toMatchObject({ valid: false, code: 'MEMO_TYPE_MISMATCH' });
  });

  it('returns MEMO_TYPE_MISMATCH for id memo with negative string', () => {
    const result = validateMemo('id', '-1');
    expect(result).toMatchObject({ valid: false, code: 'MEMO_TYPE_MISMATCH' });
  });

  it('returns MEMO_TYPE_MISMATCH for id memo exceeding uint64 max', () => {
    const result = validateMemo('id', '99999999999999999999');
    expect(result).toMatchObject({ valid: false, code: 'MEMO_TYPE_MISMATCH' });
  });

  // -------------------------------------------------------------------------
  // Failure: MEMO_TYPE_MISMATCH — hash memo with wrong format
  // -------------------------------------------------------------------------
  it('returns MEMO_TYPE_MISMATCH for hash memo with less than 64 chars', () => {
    const result = validateMemo('hash', 'abc123');
    expect(result).toMatchObject({
      valid: false,
      code: 'MEMO_TYPE_MISMATCH',
      reason: expect.stringContaining('"hash"'),
    });
  });

  it('returns MEMO_TYPE_MISMATCH for hash memo with non-hex characters', () => {
    const result = validateMemo('hash', 'g'.repeat(64));
    expect(result).toMatchObject({ valid: false, code: 'MEMO_TYPE_MISMATCH' });
  });

  it('returns MEMO_TYPE_MISMATCH for hash memo with more than 64 chars', () => {
    const result = validateMemo('hash', 'a'.repeat(65));
    expect(result).toMatchObject({ valid: false, code: 'MEMO_TYPE_MISMATCH' });
  });

  // -------------------------------------------------------------------------
  // Failure: MEMO_TYPE_MISMATCH — text memo over 28 bytes
  // -------------------------------------------------------------------------
  it('returns MEMO_TYPE_MISMATCH for text memo exceeding 28 bytes', () => {
    const tooLong = 'a'.repeat(MEMO_TEXT_MAX_BYTES + 1);
    const result = validateMemo('text', tooLong);
    expect(result).toMatchObject({
      valid: false,
      code: 'MEMO_TYPE_MISMATCH',
      reason: expect.stringContaining('28-byte'),
    });
  });

  it('returns MEMO_TYPE_MISMATCH for text memo over 28 bytes due to multi-byte UTF-8', () => {
    // Each '€' is 3 bytes in UTF-8; 10 of them = 30 bytes → over the 28-byte limit.
    const result = validateMemo('text', '€'.repeat(10));
    expect(result).toMatchObject({ valid: false, code: 'MEMO_TYPE_MISMATCH' });
  });
});

// ---------------------------------------------------------------------------
// FederationResolution.memoRequired field — end-to-end path
// (see __tests__/federation-memo-resolution.test.ts for mocked fetch tests)
// ---------------------------------------------------------------------------
