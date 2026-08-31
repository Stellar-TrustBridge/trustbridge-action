import {
  isFederationAddress,
  parseFederationAddress,
  validateFederationUsername,
  validateFederationDomain,
  resolveFederationAddress,
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
