import { SimpleCache, GitHubActionsCacheBackend } from '../src/cache';
import * as actionsCache from '@actions/cache';
import * as core from '@actions/core';
import * as fs from 'fs';

jest.mock('@actions/cache', () => ({
  isFeatureAvailable: jest.fn(),
  saveCache: jest.fn(),
  restoreCache: jest.fn(),
}));

jest.mock('@actions/core');
jest.mock('@actions/cache');

describe('SimpleCache', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns null on a miss', () => {
    const cache = new SimpleCache();
    expect(cache.get('missing-key')).toBeNull();
  });

  it('returns the stored value on a hit', () => {
    const cache = new SimpleCache();
    cache.set('key', { foo: 'bar' });
    expect(cache.get('key')).toEqual({ foo: 'bar' });
  });

  it('serves a value that has not yet expired', () => {
    const cache = new SimpleCache();
    cache.set('key', 'value', 1000);
    jest.advanceTimersByTime(999);
    expect(cache.get('key')).toBe('value');
  });

  it('expires a value once its TTL has elapsed and evicts it from the store', () => {
    const cache = new SimpleCache();
    cache.set('key', 'value', 1000);
    jest.advanceTimersByTime(1001);

    expect(cache.get('key')).toBeNull();
    expect(cache.getStats().entries).not.toContain('key');
  });

  it('refetches (does not resurrect) an expired entry after a fresh set', () => {
    const cache = new SimpleCache();
    cache.set('key', 'stale', 1000);
    jest.advanceTimersByTime(1001);
    expect(cache.get('key')).toBeNull();

    cache.set('key', 'fresh', 1000);
    expect(cache.get('key')).toBe('fresh');
  });

  it('defaults to a 60 second TTL when none is provided', () => {
    const cache = new SimpleCache();
    cache.set('key', 'value');
    jest.advanceTimersByTime(59_999);
    expect(cache.get('key')).toBe('value');
    jest.advanceTimersByTime(2);
    expect(cache.get('key')).toBeNull();
  });

  it('clear() removes all entries regardless of TTL', () => {
    const cache = new SimpleCache();
    cache.set('a', 1, 60_000);
    cache.set('b', 2, 60_000);
    cache.clear();
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBeNull();
    expect(cache.getStats()).toEqual({ size: 0, entries: [] });
  });

  it('getStats() reports size and keys', () => {
    const cache = new SimpleCache();
    cache.set('a', 1, 60_000);
    cache.set('b', 2, 60_000);
    const stats = cache.getStats();
    expect(stats.size).toBe(2);
    expect(stats.entries.sort()).toEqual(['a', 'b']);
  });

  it('keeps independent TTLs per key', () => {
    const cache = new SimpleCache();
    cache.set('short', 'expires-soon', 100);
    cache.set('long', 'expires-later', 10_000);

    jest.advanceTimersByTime(101);

    expect(cache.get('short')).toBeNull();
    expect(cache.get('long')).toBe('expires-later');
  });

  it('reports backendEnabled in stats when useActionsCacheBackend is true', () => {
    const cache = new SimpleCache({ useActionsCacheBackend: true });
    expect(cache.getStats().backendEnabled).toBe(true);
  });

  // Issue #709: stellar.toml entries must be evictable when the hash pin no
  // longer matches, so a poisoned/stale body is never served again.
  it('delete() evicts a single key and leaves others intact', () => {
    const cache = new SimpleCache();
    cache.set('toml:anchor.example', { content: 'stale' }, 60_000);
    cache.set('toml:other.example', { content: 'fresh' }, 60_000);

    expect(cache.delete('toml:anchor.example')).toBe(true);
    expect(cache.get('toml:anchor.example')).toBeNull();
    expect(cache.get('toml:other.example')).toEqual({ content: 'fresh' });
  });

  it('delete() returns false for a missing key', () => {
    const cache = new SimpleCache();
    expect(cache.delete('toml:missing.example')).toBe(false);
  });

  it('serves a stellar.toml-style entry for exactly its TTL window', () => {
    const cache = new SimpleCache();
    cache.set('toml:anchor.example', { content: 'body' }, 3_600_000);
    jest.advanceTimersByTime(3_599_999);
    expect(cache.get('toml:anchor.example')).toEqual({ content: 'body' });
    jest.advanceTimersByTime(2);
    expect(cache.get('toml:anchor.example')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Issue #759 — Freshness TTL tests for cached Horizon account payloads
// ---------------------------------------------------------------------------

describe('SimpleCache — Horizon account freshness TTL (Issue #759)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const horizonKey = 'horizon:account:GABC123';
  const fundedPayload = { account_id: 'GABC123', balances: [{ asset_type: 'native', balance: '100.0000000' }] };

  it('happy path: serves a fresh cached Horizon account payload within TTL', () => {
    const cache = new SimpleCache();
    cache.set(horizonKey, fundedPayload, 30_000);

    jest.advanceTimersByTime(29_999);

    expect(cache.get(horizonKey)).toEqual(fundedPayload);
  });

  it('failure path: treats an expired Horizon payload as stale (miss)', () => {
    const cache = new SimpleCache();
    cache.set(horizonKey, fundedPayload, 30_000);

    jest.advanceTimersByTime(30_001);

    expect(cache.get(horizonKey)).toBeNull();
    expect(cache.getStats().entries).not.toContain(horizonKey);
  });

  it('clock skew: a backward clock jump does not prematurely expire a fresh payload', () => {
    const cache = new SimpleCache();
    cache.set(horizonKey, fundedPayload, 30_000);

    // Simulate the wall clock moving backward relative to the cached timestamp.
    jest.setSystemTime(Date.now() - 10_000);

    expect(cache.get(horizonKey)).toEqual(fundedPayload);
  });

  it('clock skew: a forward clock jump past the TTL expires the payload', () => {
    const cache = new SimpleCache();
    cache.set(horizonKey, fundedPayload, 30_000);

    jest.setSystemTime(Date.now() + 60_000);

    expect(cache.get(horizonKey)).toBeNull();
  });

  it('stale-while-revalidate: batch recheck refetches expired payloads instead of marking funded wallets unready', async () => {
    const cache = new SimpleCache();
    const accounts = ['GABC123', 'GDEF456', 'GHIJ789'];

    for (const account of accounts) {
      cache.set(`horizon:account:${account}`, { account_id: account, funded: true }, 5_000);
    }

    jest.advanceTimersByTime(5_001);

    // All entries are stale; a batch recheck must observe misses and refetch.
    const stale = accounts.map((account) => cache.get(`horizon:account:${account}`));
    expect(stale).toEqual([null, null, null]);

    // Revalidate by refetching and re-setting fresh payloads.
    for (const account of accounts) {
      cache.set(`horizon:account:${account}`, { account_id: account, funded: true }, 5_000);
    }

    const revalidated = accounts.map((account) => cache.get(`horizon:account:${account}`));
    expect(revalidated).toEqual(accounts.map((account) => ({ account_id: account, funded: true })));
  });
});

describe('GitHubActionsCacheBackend (Issue #461)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('saves and retrieves from cache without actions backend when feature unavailable', async () => {
    (actionsCache.isFeatureAvailable as jest.Mock).mockReturnValue(false);
    const backend = new GitHubActionsCacheBackend('test-prefix');

    await backend.saveCache('account-1', JSON.stringify({ funded: true }), 10_000);
    const val = await backend.getCache('account-1');

    expect(val).toBe(JSON.stringify({ funded: true }));
    expect(actionsCache.saveCache).not.toHaveBeenCalled();

    await backend.dispose();
  });

  it('calls actionsCache.saveCache when feature is available', async () => {
    (actionsCache.isFeatureAvailable as jest.Mock).mockReturnValue(true);
    (actionsCache.saveCache as jest.Mock).mockResolvedValue(1);

    const backend = new GitHubActionsCacheBackend('tb');
    await backend.saveCache('horizon:acc:123', JSON.stringify({ active: true }), 60_000);

    expect(actionsCache.saveCache).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining('.json')]),
      expect.stringMatching(/^tb-check-/),
    );

    await backend.dispose();
  });

  it('restores from actionsCache when local memory is empty', async () => {
    (actionsCache.isFeatureAvailable as jest.Mock).mockReturnValue(true);
    (actionsCache.restoreCache as jest.Mock).mockImplementation(async (paths: string[]) => {
      // Simulate actionsCache downloading the file
      const filePath = paths[0];
      fs.writeFileSync(
        filePath,
        JSON.stringify({ key: 'rem-key', data: '{"restored":true}', expiresAt: Date.now() + 60_000 }),
      );
      return 'tb-check-hit';
    });

    const backend = new GitHubActionsCacheBackend('tb');
    const val = await backend.getCache('rem-key');

    expect(val).toBe('{"restored":true}');
    expect(actionsCache.restoreCache).toHaveBeenCalled();

    await backend.dispose();
  });

  it('returns null when entry has expired according to TTL', async () => {
    (actionsCache.isFeatureAvailable as jest.Mock).mockReturnValue(false);
    const backend = new GitHubActionsCacheBackend('tb');

    // Save with negative TTL (already expired)
    await backend.saveCache('expired-key', 'data', -1000);
    const val = await backend.getCache('expired-key');

    expect(val).toBeNull();

    await backend.dispose();
  });

  it('handles actionsCache.saveCache error gracefully (soft-fail)', async () => {
    (actionsCache.isFeatureAvailable as jest.Mock).mockReturnValue(true);
    (actionsCache.saveCache as jest.Mock).mockRejectedValue(new Error('ReserveCacheError: Cache entry already exists'));

    const backend = new GitHubActionsCacheBackend('tb');
    // Should not throw
    await expect(backend.saveCache('key', 'data', 5000)).resolves.not.toThrow();

    await backend.dispose();
  });

  it('restoreCache returns boolean indicating hit or miss', async () => {
    (actionsCache.isFeatureAvailable as jest.Mock).mockReturnValue(false);
    const backend = new GitHubActionsCacheBackend('tb');

    expect(await backend.restoreCache('missing')).toBe(false);

    await backend.saveCache('found', 'val', 5000);
    expect(await backend.restoreCache('found')).toBe(true);

    await backend.dispose();
  });

  it('SimpleCache restores via restoreAsync using backend', async () => {
    (actionsCache.isFeatureAvailable as jest.Mock).mockReturnValue(false);
    const backend = new GitHubActionsCacheBackend('tb');
    await backend.saveCache('account-key', JSON.stringify({ sequence: '123' }), 5000);

    const cache = new SimpleCache({ backend });
    const restored = await cache.restoreAsync<{ sequence: string }>('account-key');

    expect(restored).toEqual({ sequence: '123' });
    // Should also be in synchronous cache now
    expect(cache.get('account-key')).toEqual({ sequence: '123' });

    await cache.clear();
  });
});

// ---------------------------------------------------------------------------
// Issue #462 — Warn when cache backend selection is ignored
// ---------------------------------------------------------------------------

describe('SimpleCache — unsupported backend warning (Issue #462)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('emits a core.warning when an unsupported selectedBackend is provided', () => {
    const warnSpy = core.warning as jest.MockedFunction<typeof core.warning>;
    new SimpleCache({ selectedBackend: 'redis' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message] = warnSpy.mock.calls[0];
    expect(String(message)).toContain('unsupported backend "redis"');
    expect(String(message)).toContain('Falling back to in-memory cache');
  });

  it('warning message lists the supported backend names', () => {
    const warnSpy = core.warning as jest.Mock;
    new SimpleCache({ selectedBackend: 'redis' });
    const [message] = warnSpy.mock.calls[0];
    expect(String(message)).toContain('memory');
    expect(String(message)).toContain('actions');
  });

  it('does not warn for supported backends', () => {
    const warnSpy = core.warning as jest.Mock;
    new SimpleCache({ selectedBackend: 'memory' });
    new SimpleCache({ selectedBackend: 'actions' });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
