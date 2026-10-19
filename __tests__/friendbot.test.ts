/**
 * Tests for Friendbot integration (Issue #4).
 * Covers: SSRF allowlist, network guards, friendbot calls, error handling.
 */

import {
  callFriendbot,
  isFriendbotAllowed,
  isTestnetHorizon,
  FriendbotResult,
} from '../src/horizon';

describe('isFriendbotAllowed', () => {
  it('allows official Stellar friendbot URL', () => {
    expect(isFriendbotAllowed('https://friendbot.stellar.org')).toBe(true);
  });

  it('allows testnet Horizon friendbot endpoint', () => {
    expect(isFriendbotAllowed('https://horizon-testnet.stellar.org/friendbot')).toBe(true);
  });

  it('allows domain-only variants', () => {
    expect(isFriendbotAllowed('friendbot-testnet.stellar.org')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isFriendbotAllowed('HTTPS://FRIENDBOT.STELLAR.ORG')).toBe(true);
    expect(isFriendbotAllowed('Friendbot.Stellar.Org')).toBe(true);
  });

  it('trims whitespace', () => {
    expect(isFriendbotAllowed('  https://friendbot.stellar.org  ')).toBe(true);
  });

  it('rejects non-allowlisted URLs', () => {
    expect(isFriendbotAllowed('https://evil.example.com')).toBe(false);
    expect(isFriendbotAllowed('https://friendbot.evil.com')).toBe(false);
    expect(isFriendbotAllowed('https://evilfriendbot.stellar.org')).toBe(false);
  });

  it('rejects URLs with path traversal attempts', () => {
    expect(isFriendbotAllowed('https://friendbot.stellar.org/../evil')).toBe(false);
  });

  it('rejects invalid URLs', () => {
    expect(isFriendbotAllowed('not a url')).toBe(false);
    expect(isFriendbotAllowed('javascript:alert(1)')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isFriendbotAllowed('')).toBe(false);
    expect(isFriendbotAllowed('   ')).toBe(false);
  });

  it('rejects localhost and private IPs', () => {
    expect(isFriendbotAllowed('http://localhost:8000')).toBe(false);
    expect(isFriendbotAllowed('http://127.0.0.1:8000')).toBe(false);
    expect(isFriendbotAllowed('http://192.168.1.1')).toBe(false);
  });
});

describe('isTestnetHorizon', () => {
  it('detects testnet URLs', () => {
    expect(isTestnetHorizon('https://horizon-testnet.stellar.org')).toBe(true);
    expect(isTestnetHorizon('https://horizon.testnet.example.com')).toBe(true);
    expect(isTestnetHorizon('https://test-horizon.stellar.org')).toBe(true);
  });

  it('rejects mainnet/public URLs', () => {
    expect(isTestnetHorizon('https://horizon.stellar.org')).toBe(false);
    expect(isTestnetHorizon('https://mainnet-horizon.stellar.org')).toBe(false);
    expect(isTestnetHorizon('https://public.stellar.org')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isTestnetHorizon('HTTPS://HORIZON-TESTNET.STELLAR.ORG')).toBe(true);
    expect(isTestnetHorizon('HTTPS://HORIZON.STELLAR.ORG')).toBe(false);
  });
});

describe('callFriendbot', () => {
  const testnetHorizonUrl = 'https://horizon-testnet.stellar.org';
  const mainnetHorizonUrl = 'https://horizon.stellar.org';
  const testAddress = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

  it('refuses to call friendbot on mainnet', async () => {
    const result = await callFriendbot(
      testAddress,
      {
        friendbotUrl: 'https://friendbot.stellar.org',
      },
      mainnetHorizonUrl,
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('only available for testnet');
    expect(result.message).toContain('mainnet');
  });

  it('refuses non-allowlisted friendbot URLs', async () => {
    const result = await callFriendbot(
      testAddress,
      {
        friendbotUrl: 'https://evil.example.com/friendbot',
      },
      testnetHorizonUrl,
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('not on the allowlist');
  });

  it('calls allowlisted friendbot on testnet', async () => {
    const mockFetch = async (url: string) => {
      expect(url).toContain('friendbot');
      expect(url).toContain(encodeURIComponent(testAddress));
      
      return {
        ok: true,
        json: async () => ({ hash: 'abc123', id: 'tx-id' }),
      } as Response;
    };

    const result = await callFriendbot(
      testAddress,
      {
        friendbotUrl: 'https://friendbot.stellar.org',
        fetchFn: mockFetch,
      },
      testnetHorizonUrl,
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('funded successfully');
    expect(result.transactionHash).toBe('abc123');
  });

  it('normalizes friendbot URL without https://', async () => {
    const mockFetch = async (url: string) => {
      expect(url).toMatch(/^https:\/\//);
      return {
        ok: true,
        json: async () => ({ hash: 'def456' }),
      } as Response;
    };

    const result = await callFriendbot(
      testAddress,
      {
        friendbotUrl: 'friendbot-testnet.stellar.org',
        fetchFn: mockFetch,
      },
      testnetHorizonUrl,
    );

    expect(result.success).toBe(true);
  });

  it('adds /friendbot path if missing', async () => {
    const mockFetch = async (url: string) => {
      expect(url).toContain('/friendbot');
      return {
        ok: true,
        json: async () => ({ hash: 'ghi789' }),
      } as Response;
    };

    const result = await callFriendbot(
      testAddress,
      {
        friendbotUrl: 'https://horizon-testnet.stellar.org',
        fetchFn: mockFetch,
      },
      testnetHorizonUrl,
    );

    expect(result.success).toBe(true);
  });

  it('handles friendbot HTTP errors', async () => {
    const mockFetch = async () => {
      return {
        ok: false,
        status: 400,
        text: async () => 'Account already exists',
      } as Response;
    };

    const result = await callFriendbot(
      testAddress,
      {
        friendbotUrl: 'https://friendbot.stellar.org',
        fetchFn: mockFetch,
      },
      testnetHorizonUrl,
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('HTTP 400');
    expect(result.message).toContain('Account already exists');
  });

  it('handles friendbot timeout', async () => {
    const mockFetch = async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      throw new Error('AbortError');
    };
    Object.defineProperty(mockFetch, 'name', { value: 'AbortError' });

    const result = await callFriendbot(
      testAddress,
      {
        friendbotUrl: 'https://friendbot.stellar.org',
        timeoutMs: 50,
        fetchFn: mockFetch,
      },
      testnetHorizonUrl,
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('timed out');
  });

  it('handles network errors', async () => {
    const mockFetch = async () => {
      throw new Error('Network error: Connection refused');
    };

    const result = await callFriendbot(
      testAddress,
      {
        friendbotUrl: 'https://friendbot.stellar.org',
        fetchFn: mockFetch,
      },
      testnetHorizonUrl,
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('failed');
    expect(result.message).toContain('Connection refused');
  });

  it('extracts transaction hash from response', async () => {
    const mockFetch = async () => {
      return {
        ok: true,
        json: async () => ({ hash: 'transaction-hash-abc' }),
      } as Response;
    };

    const result = await callFriendbot(
      testAddress,
      {
        friendbotUrl: 'https://friendbot.stellar.org',
        fetchFn: mockFetch,
      },
      testnetHorizonUrl,
    );

    expect(result.success).toBe(true);
    expect(result.transactionHash).toBe('transaction-hash-abc');
  });

  it('falls back to id field if hash missing', async () => {
    const mockFetch = async () => {
      return {
        ok: true,
        json: async () => ({ id: 'tx-id-xyz' }),
      } as Response;
    };

    const result = await callFriendbot(
      testAddress,
      {
        friendbotUrl: 'https://friendbot.stellar.org',
        fetchFn: mockFetch,
      },
      testnetHorizonUrl,
    );

    expect(result.success).toBe(true);
    expect(result.transactionHash).toBe('tx-id-xyz');
  });

  it('URL-encodes the stellar address', async () => {
    const addressWithSpecialChars = 'GABC+123/TEST';
    const mockFetch = async (url: string) => {
      expect(url).toContain(encodeURIComponent(addressWithSpecialChars));
      expect(url).not.toContain('+');
      expect(url).not.toContain('/TEST');
      
      return {
        ok: true,
        json: async () => ({ hash: 'encoded-ok' }),
      } as Response;
    };

    const result = await callFriendbot(
      addressWithSpecialChars,
      {
        friendbotUrl: 'https://friendbot.stellar.org',
        fetchFn: mockFetch,
      },
      testnetHorizonUrl,
    );

    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration scenarios
// ---------------------------------------------------------------------------

describe('Friendbot integration scenarios', () => {
  const testAddress = 'GTESTADDRESS123';
  const testnetHorizon = 'https://horizon-testnet.stellar.org';

  it('happy path: testnet + allowlisted friendbot + successful funding', async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ hash: 'success-hash' }),
    } as Response);

    const result = await callFriendbot(
      testAddress,
      {
        friendbotUrl: 'https://friendbot.stellar.org',
        fetchFn: mockFetch,
      },
      testnetHorizon,
    );

    expect(result.success).toBe(true);
    expect(result.transactionHash).toBe('success-hash');
  });

  it('blocked: mainnet protection prevents funding', async () => {
    const result = await callFriendbot(
      testAddress,
      {
        friendbotUrl: 'https://friendbot.stellar.org',
      },
      'https://horizon.stellar.org', // mainnet
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('mainnet');
  });

  it('blocked: SSRF protection rejects non-allowlisted endpoint', async () => {
    const result = await callFriendbot(
      testAddress,
      {
        friendbotUrl: 'https://malicious-friendbot.evil.com',
      },
      testnetHorizon,
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('allowlist');
  });

  it('graceful failure: friendbot returns error but action continues', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 500,
      text: async () => 'Friendbot temporarily unavailable',
    } as Response);

    const result = await callFriendbot(
      testAddress,
      {
        friendbotUrl: 'https://friendbot.stellar.org',
        fetchFn: mockFetch,
      },
      testnetHorizon,
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('500');
    // Should not throw - returns FriendbotResult
  });
});
