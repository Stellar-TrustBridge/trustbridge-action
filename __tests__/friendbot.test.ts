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
import * as fs from 'fs';
import * as path from 'path';
import { toActionOutputs } from '../src/outputs';
import type { ValidationResult } from '../src/checks';

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

// ---------------------------------------------------------------------------
// Issue #699 — friendbot input combinations, network guards and outputs
// ---------------------------------------------------------------------------

describe('Friendbot preset URLs and network guards (Issue #699)', () => {
  const testAddress = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  const okResponse = (hash: string) =>
    ({ ok: true, json: async () => ({ hash }) }) as Response;

  it.each([
    ['https://friendbot.stellar.org'],
    ['https://friendbot-testnet.stellar.org'],
    ['https://horizon-testnet.stellar.org/friendbot'],
    ['https://friendbot-futurenet.stellar.org'],
    ['https://horizon-futurenet.stellar.org/friendbot'],
  ])('allowlists the official preset Friendbot URL %s', (url) => {
    expect(isFriendbotAllowed(url)).toBe(true);
  });

  it('rejects non-https custom friendbot_url values', () => {
    expect(isFriendbotAllowed('http://friendbot.stellar.org')).toBe(false);
  });

  it('rejects friendbot_url on an allowlisted host with an unexpected path', () => {
    expect(isFriendbotAllowed('https://friendbot.stellar.org/admin')).toBe(false);
  });

  it.each([
    ['https://horizon.stellar.org'],
    ['https://horizon.stellar.org/'],
    ['https://mainnet.example.com'],
  ])('refuses pubnet Horizon %s without issuing a Friendbot request', async (horizonUrl) => {
    const fetchFn = jest.fn(async () => okResponse('should-not-happen'));
    const result = await callFriendbot(
      testAddress,
      { friendbotUrl: 'https://friendbot.stellar.org', fetchFn },
      horizonUrl,
    );
    expect(result.success).toBe(false);
    expect(result.transactionHash).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses a non-allowlisted custom friendbot_url without issuing a request', async () => {
    const fetchFn = jest.fn(async () => okResponse('should-not-happen'));
    const result = await callFriendbot(
      testAddress,
      { friendbotUrl: 'https://friendbot.example.com', fetchFn },
      'https://horizon-testnet.stellar.org',
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain('not on the allowlist');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('funds a futurenet account through the futurenet Friendbot host', async () => {
    const fetchFn = jest.fn(async (_url: string) => okResponse('futurenet-hash'));
    const result = await callFriendbot(
      testAddress,
      { friendbotUrl: 'https://friendbot-futurenet.stellar.org', fetchFn },
      'https://horizon-futurenet.stellar.org',
    );
    expect(result.success).toBe(true);
    expect(result.transactionHash).toBe('futurenet-hash');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const calledUrl = new URL(fetchFn.mock.calls[0][0]);
    expect(calledUrl.hostname).toBe('friendbot-futurenet.stellar.org');
    expect(calledUrl.pathname).toBe('/friendbot');
    expect(calledUrl.searchParams.get('addr')).toBe(testAddress);
  });

  it('uses a custom allowlisted friendbot_url exactly once per call', async () => {
    const fetchFn = jest.fn(async (_url: string) => okResponse('custom-hash'));
    await callFriendbot(
      testAddress,
      { friendbotUrl: 'https://horizon-testnet.stellar.org/friendbot', fetchFn },
      'https://horizon-testnet.stellar.org',
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe(
      `https://horizon-testnet.stellar.org/friendbot?addr=${encodeURIComponent(testAddress)}`,
    );
  });

  it('aborts the request when friendbot_timeout_ms elapses', async () => {
    const fetchFn = jest.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const result = await callFriendbot(
      testAddress,
      { friendbotUrl: 'https://friendbot.stellar.org', timeoutMs: 20, fetchFn },
      'https://horizon-testnet.stellar.org',
    );
    expect(result.success).toBe(false);
    expect(result.message).toBe('Friendbot request timed out after 20ms');
    expect(result.transactionHash).toBeUndefined();
  });

  it('reports HTTP 5xx failures without a transaction hash', async () => {
    const fetchFn = jest.fn(async () =>
      ({ ok: false, status: 503, text: async () => 'Service Unavailable' }) as Response,
    );
    const result = await callFriendbot(
      testAddress,
      { friendbotUrl: 'https://friendbot.stellar.org', fetchFn },
      'https://horizon-testnet.stellar.org',
    );
    expect(result.success).toBe(false);
    expect(result.message).toBe('Friendbot returned HTTP 503: Service Unavailable');
    expect(result.transactionHash).toBeUndefined();
  });
});

describe('Friendbot action outputs (Issue #699)', () => {
  const baseResult = {
    valid: false,
    checks: [],
    trustlineExists: false,
    xlmBalance: '0',
    accountFunded: false,
    reasonCode: 'ACCOUNT_NOT_FUNDED',
  } as unknown as ValidationResult;

  async function outputsFor(result: FriendbotResult | null) {
    return toActionOutputs(baseResult, undefined, undefined, {
      friendbotCalled: result !== null,
      friendbotSuccess: result?.success ?? false,
      friendbotTransactionHash: result?.transactionHash ?? '',
    });
  }

  it('sets friendbot_called, friendbot_success and friendbot_transaction_hash on success', async () => {
    const fbResult = await callFriendbot(
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      {
        friendbotUrl: 'https://friendbot.stellar.org',
        fetchFn: async () => ({ ok: true, json: async () => ({ hash: 'funded-hash' }) }) as Response,
      },
      'https://horizon-testnet.stellar.org',
    );
    const outputs = await outputsFor(fbResult);
    expect(outputs.friendbot_called).toBe('true');
    expect(outputs.friendbot_success).toBe('true');
    expect(outputs.friendbot_transaction_hash).toBe('funded-hash');
  });

  it('sets friendbot_called=true but friendbot_success=false when funding fails', async () => {
    const fbResult = await callFriendbot(
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      {
        friendbotUrl: 'https://friendbot.stellar.org',
        fetchFn: async () => ({ ok: false, status: 400, text: async () => 'bad request' }) as Response,
      },
      'https://horizon-testnet.stellar.org',
    );
    const outputs = await outputsFor(fbResult);
    expect(outputs.friendbot_called).toBe('true');
    expect(outputs.friendbot_success).toBe('false');
    expect(outputs.friendbot_transaction_hash).toBe('');
  });

  it('leaves all friendbot outputs at their defaults when Friendbot is not called', async () => {
    const outputs = await outputsFor(null);
    expect(outputs.friendbot_called).toBe('false');
    expect(outputs.friendbot_success).toBe('false');
    expect(outputs.friendbot_transaction_hash).toBe('');
  });
});

describe('Friendbot wiring in index.ts and docs (Issue #699)', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8');

  it('guards the Friendbot call behind the pubnet check and a single-call flag', () => {
    const guardIdx = indexSource.indexOf('useFriendbot && !isTestnetHorizon(horizonUrl)');
    const onceIdx = indexSource.indexOf('useFriendbot && !friendbotCalled');
    const callIdx = indexSource.indexOf('await callFriendbot(');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(onceIdx).toBeGreaterThan(guardIdx);
    expect(callIdx).toBeGreaterThan(onceIdx);
    expect(indexSource.match(/await callFriendbot\(/g)).toHaveLength(1);
  });

  it('reads the friendbot inputs with the action.yml defaults', () => {
    expect(indexSource).toContain("core.getInput('use_friendbot'), false");
    expect(indexSource).toContain("core.getInput('friendbot_url') || 'https://friendbot.stellar.org'");
    expect(indexSource).toMatch(/core\.getInput\('friendbot_timeout_ms'\), 15000, \{\s*min: 1000,\s*max: 60000,/);
  });

  it('example workflow forwards the friendbot inputs to trustbridge-reusable.yml', () => {
    const example = fs.readFileSync(
      path.join(__dirname, '../docs/examples/friendbot-testnet-onboarding.yml'),
      'utf8',
    );
    const reusable = fs.readFileSync(
      path.join(__dirname, '../docs/examples/trustbridge-reusable.yml'),
      'utf8',
    );
    expect(example).toContain('trustbridge-reusable.yml@');
    for (const input of ['use_friendbot', 'friendbot_url', 'friendbot_timeout_ms']) {
      expect(example).toContain(`${input}:`);
      expect(reusable).toContain(`${input}:`);
      expect(reusable).toContain(`${input}: \${{ inputs.${input} }}`);
    }
    for (const output of ['friendbot_called', 'friendbot_success', 'friendbot_transaction_hash']) {
      expect(reusable).toContain(`${output}: \${{ steps.trustbridge.outputs.${output} }}`);
    }
  });

  it('USAGE.md documents the friendbot inputs and links troubleshooting', () => {
    const usage = fs.readFileSync(path.join(__dirname, '../docs/USAGE.md'), 'utf8');
    for (const input of ['use_friendbot', 'friendbot_url', 'friendbot_timeout_ms']) {
      expect(usage).toContain(`\`${input}\``);
    }
    expect(usage).toContain('TROUBLESHOOTING.md#friendbot-funding-failed');
    expect(usage).toContain('friendbot-futurenet.stellar.org');
  });
});
