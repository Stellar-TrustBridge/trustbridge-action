import { SimpleCache, GitHubActionsCacheBackend } from '../src/cache';
import * as actionsCache from '@actions/cache';
import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';

jest.mock('@actions/cache', () => ({
  isFeatureAvailable: jest.fn(),
  saveCache: jest.fn(),
  restoreCache: jest.fn(),
}));

jest.mock('@actions/core');

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
    const warnSpy = core.warning as jest.MockedFunction<typeof core.warning>;
    new SimpleCache({ selectedBackend: 'dynamodb' });
    const [message] = warnSpy.mock.calls[0];
    expect(String(message)).toContain('"memory"');
    expect(String(message)).toContain('"github-actions"');
  });

  it('does NOT emit a warning for the supported "memory" backend', () => {
    const warnSpy = core.warning as jest.MockedFunction<typeof core.warning>;
    new SimpleCache({ selectedBackend: 'memory' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT emit a warning for the supported "github-actions" backend', () => {
    const warnSpy = core.warning as jest.MockedFunction<typeof core.warning>;
    new SimpleCache({ selectedBackend: 'github-actions' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT emit a warning when selectedBackend is not provided', () => {
    const warnSpy = core.warning as jest.MockedFunction<typeof core.warning>;
    new SimpleCache({});
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT emit a warning when selectedBackend is an empty string', () => {
    const warnSpy = core.warning as jest.MockedFunction<typeof core.warning>;
    new SimpleCache({ selectedBackend: '' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('cache still operates normally (in-memory fallback) after an unsupported backend warning', () => {
    const cache = new SimpleCache({ selectedBackend: 'redis' });
    cache.set('k', 'v', 60_000);
    expect(cache.get('k')).toBe('v');
  });
});
