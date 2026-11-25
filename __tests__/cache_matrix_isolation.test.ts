import { fetchAccount, HorizonAccount, HorizonError } from '../src/horizon';
import { SimpleCache } from '../src/cache';
import { globalMetrics } from '../src/metrics';
import { redactStellarAddress } from '../src/logger';
import type { Request, RequestInit, Response } from 'node-fetch';

/**
 * Regression coverage for Issue #75 / #310: prove that the in-memory Horizon
 * account cache cannot cross-contaminate results across distinct
 * "matrix dimensions" — different Horizon base URLs (e.g. mainnet vs
 * testnet legs of a matrix build) and different Stellar addresses — even
 * when a single `SimpleCache` instance is shared, and that cache hit/miss
 * metrics are emitted with redacted key dimensions.
 *
 * New coverage added in Issue #310:
 *   - Trailing slash normalization: trailing slash stripped, same key used
 *   - Default port collapsing: :443 on https is dropped so URLs match
 *   - SSRF-blocked URL throws before any cache interaction
 *   - Fallback URL result is stored under the PRIMARY key (not fallback key)
 *   - A later lookup on the primary URL gets a cache hit from the fallback result
 *   - Two different hosts with the same G-address yield distinct entries
 */

const ADDRESS_A = `G${'A'.repeat(55)}`;
const ADDRESS_B = `G${'B'.repeat(55)}`;
const MAINNET_HORIZON = 'https://horizon.stellar.org';
const TESTNET_HORIZON = 'https://horizon-testnet.stellar.org';
// Alternate primary and fallback share the same "network" so cross-network guard
// does not block the fallback path in isolation tests.
const ALT_PRIMARY = 'https://horizon.stellar.org';
const ALT_FALLBACK = 'https://horizon2.stellar.org';

function makeAccount(address: string, marker: string): HorizonAccount {
  return {
    id: address,
    account_id: address,
    sequence: marker,
    subentry_count: 0,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [
      {
        balance: marker,
        asset_type: 'native',
        buying_liabilities: '0',
        selling_liabilities: '0',
      },
    ],
  };
}

type FetchArg = string | Request;
type MockFetch = jest.Mock<Promise<Response>, [FetchArg, RequestInit?]>;

function makeMockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

/**
 * Fetch stub keyed by URL+address so cross-contaminated cache lookups are
 * immediately detectable by comparing the `sequence` field used as a marker.
 */
function makeIsolationAwareFetch(): MockFetch {
  return jest.fn<Promise<Response>, [FetchArg, RequestInit?]>(async (url) => {
    const target = url.toString();
    if (target.includes(TESTNET_HORIZON)) {
      return makeMockResponse(200, makeAccount(ADDRESS_A, 'testnet-A'));
    }
    if (target.includes(ADDRESS_B)) {
      return makeMockResponse(200, makeAccount(ADDRESS_B, 'mainnet-B'));
    }
    return makeMockResponse(200, makeAccount(ADDRESS_A, 'mainnet-A'));
  });
}

describe('matrix cache isolation (Issue #75 / #310)', () => {
  beforeEach(() => {
    globalMetrics.reset();
  });

  // ------------------------------------------------------------------ //
  //  Existing tests (Issue #75)                                         //
  // ------------------------------------------------------------------ //

  it('does not share cache entries across different horizon_url matrix legs for the same address', async () => {
    const cache = new SimpleCache();
    const mock = makeIsolationAwareFetch();

    const mainnetResult = await fetchAccount(MAINNET_HORIZON, ADDRESS_A, {
      cacheTtlMs: 60_000,
      cache,
      fetchFn: mock,
    });
    const testnetResult = await fetchAccount(TESTNET_HORIZON, ADDRESS_A, {
      cacheTtlMs: 60_000,
      cache,
      fetchFn: mock,
    });

    expect(mainnetResult.sequence).toBe('mainnet-A');
    expect(testnetResult.sequence).toBe('testnet-A');
    expect(mock).toHaveBeenCalledTimes(2);
    expect(cache.getStats().size).toBe(2);
  });

  it('does not share cache entries across different addresses on the same horizon_url', async () => {
    const cache = new SimpleCache();
    const mock = makeIsolationAwareFetch();

    const resultA = await fetchAccount(MAINNET_HORIZON, ADDRESS_A, {
      cacheTtlMs: 60_000,
      cache,
      fetchFn: mock,
    });
    const resultB = await fetchAccount(MAINNET_HORIZON, ADDRESS_B, {
      cacheTtlMs: 60_000,
      cache,
      fetchFn: mock,
    });

    expect(resultA.sequence).toBe('mainnet-A');
    expect(resultB.sequence).toBe('mainnet-B');
    expect(mock).toHaveBeenCalledTimes(2);
    expect(cache.getStats().size).toBe(2);
  });

  it('serves a cache hit for a repeated (horizon_url, address) key without a second network call', async () => {
    const cache = new SimpleCache();
    const mock = makeIsolationAwareFetch();

    const first = await fetchAccount(MAINNET_HORIZON, ADDRESS_A, {
      cacheTtlMs: 60_000,
      cache,
      fetchFn: mock,
    });
    const second = await fetchAccount(MAINNET_HORIZON, ADDRESS_A, {
      cacheTtlMs: 60_000,
      cache,
      fetchFn: mock,
    });

    expect(first.sequence).toBe('mainnet-A');
    expect(second.sequence).toBe('mainnet-A');
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('emits distinguishable hit/miss metrics per matrix leg without leaking raw addresses', async () => {
    const cache = new SimpleCache();
    const mock = makeIsolationAwareFetch();

    // Miss (mainnet, A) -> populate
    await fetchAccount(MAINNET_HORIZON, ADDRESS_A, { cacheTtlMs: 60_000, cache, fetchFn: mock });
    // Hit (mainnet, A)
    await fetchAccount(MAINNET_HORIZON, ADDRESS_A, { cacheTtlMs: 60_000, cache, fetchFn: mock });
    // Miss (testnet, A) — different matrix leg, must not reuse the mainnet hit
    await fetchAccount(TESTNET_HORIZON, ADDRESS_A, { cacheTtlMs: 60_000, cache, fetchFn: mock });

    expect(globalMetrics.getCounter('horizon_cache_hit')).toBe(1);
    expect(globalMetrics.getCounter('horizon_cache_miss')).toBe(2);

    const summary = globalMetrics.getSummary();
    const hitPoint = summary.metrics.find((m) => m.name === 'horizon_cache_hit');
    const missPoints = summary.metrics.filter((m) => m.name === 'horizon_cache_miss');

    expect(hitPoint?.tags?.stellarAddress).toBe(redactStellarAddress(ADDRESS_A));
    expect(hitPoint?.tags?.stellarAddress).not.toBe(ADDRESS_A);
    expect(hitPoint?.tags?.horizonUrl).not.toContain(ADDRESS_A);

    // Two distinct horizon_url dimensions among the miss metrics.
    const missHorizonUrls = new Set(missPoints.map((m) => m.tags?.horizonUrl));
    expect(missHorizonUrls.size).toBe(2);

    // Never leak the full 56-char address anywhere in the metrics export.
    expect(globalMetrics.toJSON()).not.toContain(ADDRESS_A);
  });

  it('does not cache disabled (ttl=0) lookups, so every matrix leg call reaches the network', async () => {
    const mock = makeIsolationAwareFetch();

    await fetchAccount(MAINNET_HORIZON, ADDRESS_A, { cacheTtlMs: 0, fetchFn: mock });
    await fetchAccount(MAINNET_HORIZON, ADDRESS_A, { cacheTtlMs: 0, fetchFn: mock });

    expect(mock).toHaveBeenCalledTimes(2);
    expect(globalMetrics.getCounter('horizon_cache_hit')).toBe(0);
    expect(globalMetrics.getCounter('horizon_cache_miss')).toBe(0);
  });

  // ------------------------------------------------------------------ //
  //  New tests (Issue #310)                                             //
  // ------------------------------------------------------------------ //

  describe('trailing slash normalization', () => {
    it('treats "https://horizon.stellar.org" and "https://horizon.stellar.org/" as the same cache key', async () => {
      const cache = new SimpleCache();
      const mock = makeIsolationAwareFetch();

      // Populate via the URL without trailing slash.
      const first = await fetchAccount('https://horizon.stellar.org', ADDRESS_A, {
        cacheTtlMs: 60_000,
        cache,
        fetchFn: mock,
      });

      // A lookup with a trailing slash should hit the same entry and NOT call the network again.
      const second = await fetchAccount('https://horizon.stellar.org/', ADDRESS_A, {
        cacheTtlMs: 60_000,
        cache,
        fetchFn: mock,
      });

      expect(first.sequence).toBe('mainnet-A');
      expect(second.sequence).toBe('mainnet-A');
      // Only one network call because both URLs normalize to the same key.
      expect(mock).toHaveBeenCalledTimes(1);
      // Only one cache entry.
      expect(cache.getStats().size).toBe(1);
    });

    it('multiple trailing slashes still normalize to the same key', async () => {
      const cache = new SimpleCache();
      const mock = makeIsolationAwareFetch();

      await fetchAccount('https://horizon.stellar.org', ADDRESS_A, {
        cacheTtlMs: 60_000,
        cache,
        fetchFn: mock,
      });

      const withSlashes = await fetchAccount('https://horizon.stellar.org///', ADDRESS_A, {
        cacheTtlMs: 60_000,
        cache,
        fetchFn: mock,
      });

      expect(withSlashes.sequence).toBe('mainnet-A');
      expect(mock).toHaveBeenCalledTimes(1);
      expect(cache.getStats().size).toBe(1);
    });
  });

  describe('default port normalization', () => {
    it('treats "https://horizon.stellar.org:443" as the same key as "https://horizon.stellar.org"', async () => {
      const cache = new SimpleCache();
      const mock = makeIsolationAwareFetch();

      // Populate without explicit port.
      await fetchAccount('https://horizon.stellar.org', ADDRESS_A, {
        cacheTtlMs: 60_000,
        cache,
        fetchFn: mock,
      });

      // Lookup with explicit default port — URL.origin drops :443 so same key.
      const withPort = await fetchAccount('https://horizon.stellar.org:443', ADDRESS_A, {
        cacheTtlMs: 60_000,
        cache,
        fetchFn: mock,
      });

      expect(withPort.sequence).toBe('mainnet-A');
      expect(mock).toHaveBeenCalledTimes(1);
      expect(cache.getStats().size).toBe(1);
    });

    it('preserves a non-default port as a distinct cache key', async () => {
      // Port 8080 is non-default so it must not match the canonical https URL.
      const cache = new SimpleCache();

      // Manufacture a fetch that distinguishes by URL target.
      const mock = jest.fn<Promise<Response>, [FetchArg, RequestInit?]>(async (url) => {
        const target = url.toString();
        if (target.includes(':8080')) {
          return makeMockResponse(200, makeAccount(ADDRESS_A, 'port-8080'));
        }
        return makeMockResponse(200, makeAccount(ADDRESS_A, 'default-port'));
      });

      const standard = await fetchAccount('https://horizon.stellar.org', ADDRESS_A, {
        cacheTtlMs: 60_000,
        cache,
        fetchFn: mock,
      });
      const nonDefault = await fetchAccount('https://horizon.stellar.org:8080', ADDRESS_A, {
        cacheTtlMs: 60_000,
        cache,
        fetchFn: mock,
      });

      expect(standard.sequence).toBe('default-port');
      expect(nonDefault.sequence).toBe('port-8080');
      // Different ports → different keys → two network calls and two cache entries.
      expect(mock).toHaveBeenCalledTimes(2);
      expect(cache.getStats().size).toBe(2);
    });
  });

  describe('SSRF-blocked URLs do not interact with the cache', () => {
    it('throws immediately for a loopback URL without touching the cache', async () => {
      const cache = new SimpleCache();
      const mock = jest.fn<Promise<Response>, [FetchArg, RequestInit?]>();

      await expect(
        fetchAccount('http://127.0.0.1:8080', ADDRESS_A, {
          cacheTtlMs: 60_000,
          cache,
          fetchFn: mock,
        }),
      ).rejects.toThrow();

      // No network call should have been attempted.
      expect(mock).not.toHaveBeenCalled();
      // Cache must remain empty — the SSRF block fires at normalizeHorizonUrl
      // before any cache read or write.
      expect(cache.getStats().size).toBe(0);
    });

    it('throws immediately for a private-range URL without touching the cache', async () => {
      const cache = new SimpleCache();
      const mock = jest.fn<Promise<Response>, [FetchArg, RequestInit?]>();

      await expect(
        fetchAccount('http://192.168.1.1', ADDRESS_A, {
          cacheTtlMs: 60_000,
          cache,
          fetchFn: mock,
        }),
      ).rejects.toThrow();

      expect(mock).not.toHaveBeenCalled();
      expect(cache.getStats().size).toBe(0);
    });

    it('throws immediately for a localhost URL without touching the cache', async () => {
      const cache = new SimpleCache();
      const mock = jest.fn<Promise<Response>, [FetchArg, RequestInit?]>();

      await expect(
        fetchAccount('http://localhost:9000', ADDRESS_A, {
          cacheTtlMs: 60_000,
          cache,
          fetchFn: mock,
        }),
      ).rejects.toThrow();

      expect(mock).not.toHaveBeenCalled();
      expect(cache.getStats().size).toBe(0);
    });

    it('a valid lookup after a blocked attempt stores only the valid entry', async () => {
      const cache = new SimpleCache();
      const mock = makeIsolationAwareFetch();

      // Blocked attempt — should throw.
      await expect(
        fetchAccount('http://127.0.0.1:8080', ADDRESS_A, {
          cacheTtlMs: 60_000,
          cache,
          fetchFn: mock,
        }),
      ).rejects.toThrow();

      // Valid lookup — should succeed and populate the cache.
      const result = await fetchAccount(MAINNET_HORIZON, ADDRESS_A, {
        cacheTtlMs: 60_000,
        cache,
        fetchFn: mock,
      });

      expect(result.sequence).toBe('mainnet-A');
      expect(cache.getStats().size).toBe(1);
    });
  });

  describe('fallback URL isolation', () => {
    it('fallback result is stored under the PRIMARY URL key, not the fallback key', async () => {
      // primary → server_error (retryable) — exhausts retries and triggers fallback
      // fallback → success
      const PRIMARY = 'https://horizon.stellar.org';
      const FALLBACK = 'https://horizon2.stellar.org';

      let primaryCallCount = 0;
      const mock = jest.fn<Promise<Response>, [FetchArg, RequestInit?]>(async (url) => {
        const target = url.toString();
        if (target.includes('horizon2.stellar.org')) {
          return makeMockResponse(200, makeAccount(ADDRESS_A, 'from-fallback'));
        }
        primaryCallCount++;
        return makeMockResponse(503, { extras: { reason: 'Service Unavailable' } });
      });

      const cache = new SimpleCache();

      const result = await fetchAccount(PRIMARY, ADDRESS_A, {
        cacheTtlMs: 60_000,
        cache,
        fetchFn: mock,
        horizonUrlFallback: FALLBACK,
        maxRetries: 0,         // no retries on primary; go straight to fallback
        retryMaxTotalWaitMs: 0,
      });

      expect(result.sequence).toBe('from-fallback');

      // The cache must have exactly one entry, keyed on the PRIMARY URL.
      expect(cache.getStats().size).toBe(1);
      const [entryKey] = cache.getStats().entries;
      expect(entryKey).toContain('horizon.stellar.org');
      // Must NOT be keyed under the fallback URL.
      expect(entryKey).not.toContain('horizon2.stellar.org');
    });

    it('a subsequent lookup on the PRIMARY URL gets a cache hit from the fallback result', async () => {
      const PRIMARY = 'https://horizon.stellar.org';
      const FALLBACK = 'https://horizon2.stellar.org';

      const mock = jest.fn<Promise<Response>, [FetchArg, RequestInit?]>(async (url) => {
        const target = url.toString();
        if (target.includes('horizon2.stellar.org')) {
          return makeMockResponse(200, makeAccount(ADDRESS_A, 'from-fallback'));
        }
        return makeMockResponse(503, { extras: { reason: 'Service Unavailable' } });
      });

      const cache = new SimpleCache();

      // First call: primary fails → fallback fills cache.
      await fetchAccount(PRIMARY, ADDRESS_A, {
        cacheTtlMs: 60_000,
        cache,
        fetchFn: mock,
        horizonUrlFallback: FALLBACK,
        maxRetries: 0,
        retryMaxTotalWaitMs: 0,
      });

      const callCountAfterFirst = mock.mock.calls.length;

      // Second call: primary URL again — should be a cache hit (no new network call).
      const second = await fetchAccount(PRIMARY, ADDRESS_A, {
        cacheTtlMs: 60_000,
        cache,
        fetchFn: mock,
      });

      expect(second.sequence).toBe('from-fallback');
      // No additional network calls after the first round.
      expect(mock.mock.calls.length).toBe(callCountAfterFirst);
    });

    it('fallback success for address-A does not pollute address-B cache entry', async () => {
      const PRIMARY = 'https://horizon.stellar.org';
      const FALLBACK = 'https://horizon2.stellar.org';

      const mock = jest.fn<Promise<Response>, [FetchArg, RequestInit?]>(async (url) => {
        const target = url.toString();
        if (target.includes('horizon2.stellar.org') && target.includes(ADDRESS_A)) {
          return makeMockResponse(200, makeAccount(ADDRESS_A, 'fallback-A'));
        }
        if (target.includes(ADDRESS_B)) {
          return makeMockResponse(200, makeAccount(ADDRESS_B, 'primary-B'));
        }
        // ADDRESS_A on primary → 503
        return makeMockResponse(503, { extras: { reason: 'Service Unavailable' } });
      });

      const cache = new SimpleCache();

      const resultA = await fetchAccount(PRIMARY, ADDRESS_A, {
        cacheTtlMs: 60_000,
        cache,
        fetchFn: mock,
        horizonUrlFallback: FALLBACK,
        maxRetries: 0,
        retryMaxTotalWaitMs: 0,
      });
      const resultB = await fetchAccount(PRIMARY, ADDRESS_B, {
        cacheTtlMs: 60_000,
        cache,
        fetchFn: mock,
      });

      expect(resultA.sequence).toBe('fallback-A');
      expect(resultB.sequence).toBe('primary-B');

      // Two distinct cache entries: one per address.
      expect(cache.getStats().size).toBe(2);
    });

    it('fallback URL with trailing slash normalizes to the same fallback endpoint', async () => {
      const PRIMARY = 'https://horizon.stellar.org';
      const FALLBACK_WITH_SLASH = 'https://horizon2.stellar.org/';

      const mock = jest.fn<Promise<Response>, [FetchArg, RequestInit?]>(async (url) => {
        const target = url.toString();
        if (target.includes('horizon2.stellar.org')) {
          return makeMockResponse(200, makeAccount(ADDRESS_A, 'fallback-trailing'));
        }
        return makeMockResponse(503, { extras: { reason: 'Service Unavailable' } });
      });

      const cache = new SimpleCache();

      const result = await fetchAccount(PRIMARY, ADDRESS_A, {
        cacheTtlMs: 60_000,
        cache,
        fetchFn: mock,
        horizonUrlFallback: FALLBACK_WITH_SLASH,
        maxRetries: 0,
        retryMaxTotalWaitMs: 0,
      });

      expect(result.sequence).toBe('fallback-trailing');
      // Result is still under the primary key.
      const [entryKey] = cache.getStats().entries;
      expect(entryKey).toContain('horizon.stellar.org');
    });

    it('two different primary URLs each get their own fallback-populated entries', async () => {
      // Simulate two concurrent matrix legs using the same cache instance:
      //   leg-1: primary-A fails → fallback-A fills cache under primary-A key
      //   leg-2: primary-B fails → fallback-B fills cache under primary-B key
      const PRIMARY_A = 'https://horizon.stellar.org';
      const FALLBACK_A = 'https://horizon2.stellar.org';
      const PRIMARY_B = 'https://horizon-testnet.stellar.org';
      const FALLBACK_B = 'https://horizon2-testnet.stellar.org';

      const mock = jest.fn<Promise<Response>, [FetchArg, RequestInit?]>(async (url) => {
        const target = url.toString();
        if (target.includes('horizon2-testnet.stellar.org')) {
          return makeMockResponse(200, makeAccount(ADDRESS_A, 'fallback-testnet-A'));
        }
        if (target.includes('horizon2.stellar.org')) {
          return makeMockResponse(200, makeAccount(ADDRESS_A, 'fallback-mainnet-A'));
        }
        // Both primaries fail.
        return makeMockResponse(503, { extras: { reason: 'Service Unavailable' } });
      });

      const cache = new SimpleCache();

      const legMainnet = await fetchAccount(PRIMARY_A, ADDRESS_A, {
        cacheTtlMs: 60_000,
        cache,
        fetchFn: mock,
        horizonUrlFallback: FALLBACK_A,
        maxRetries: 0,
        retryMaxTotalWaitMs: 0,
        allowCrossNetworkFallback: true, // both fallbacks used for the test
      });

      const legTestnet = await fetchAccount(PRIMARY_B, ADDRESS_A, {
        cacheTtlMs: 60_000,
        cache,
        fetchFn: mock,
        horizonUrlFallback: FALLBACK_B,
        maxRetries: 0,
        retryMaxTotalWaitMs: 0,
        allowCrossNetworkFallback: true,
      });

      expect(legMainnet.sequence).toBe('fallback-mainnet-A');
      expect(legTestnet.sequence).toBe('fallback-testnet-A');

      // Two entries — one per primary key.
      expect(cache.getStats().size).toBe(2);

      // Each entry is under its own primary host; no bleed.
      const keys = cache.getStats().entries;
      const mainnetKey = keys.find((k) => k.includes('horizon.stellar.org') && !k.includes('testnet'));
      const testnetKey = keys.find((k) => k.includes('horizon-testnet.stellar.org'));
      expect(mainnetKey).toBeDefined();
      expect(testnetKey).toBeDefined();
    });
  });

  describe('two hosts, same G-address, different bodies — no bleed (end-to-end)', () => {
    /**
     * This is the primary scenario described in Issue #310:
     * a matrix build with `horizon_url: mainnet` and `horizon_url: testnet`
     * both check the same Stellar address. Confirms that a cached mainnet
     * response is never served to the testnet leg and vice-versa.
     */
    it('concurrent simulated matrix legs never bleed across hosts', async () => {
      const cache = new SimpleCache();

      const mainnetAccount = makeAccount(ADDRESS_A, 'mainnet-body');
      const testnetAccount = makeAccount(ADDRESS_A, 'testnet-body');

      const mock = jest.fn<Promise<Response>, [FetchArg, RequestInit?]>(async (url) => {
        const target = url.toString();
        if (target.includes(TESTNET_HORIZON)) {
          return makeMockResponse(200, testnetAccount);
        }
        return makeMockResponse(200, mainnetAccount);
      });

      // Simulate leg-1: mainnet matrix entry
      const r1 = await fetchAccount(MAINNET_HORIZON, ADDRESS_A, {
        cacheTtlMs: 60_000,
        cache,
        fetchFn: mock,
      });
      // Simulate leg-2: testnet matrix entry
      const r2 = await fetchAccount(TESTNET_HORIZON, ADDRESS_A, {
        cacheTtlMs: 60_000,
        cache,
        fetchFn: mock,
      });

      expect(r1.sequence).toBe('mainnet-body');
      expect(r2.sequence).toBe('testnet-body');

      // Both legs required a network call.
      expect(mock).toHaveBeenCalledTimes(2);

      // A third call to mainnet must return the cached mainnet body without hitting testnet data.
      const r3 = await fetchAccount(MAINNET_HORIZON, ADDRESS_A, {
        cacheTtlMs: 60_000,
        cache,
        fetchFn: mock,
      });
      expect(r3.sequence).toBe('mainnet-body');
      // No additional network call.
      expect(mock).toHaveBeenCalledTimes(2);
    });

    it('cache is isolated even when address is identical across all matrix legs', async () => {
      const hosts = [
        'https://horizon.stellar.org',
        'https://horizon-testnet.stellar.org',
        'https://horizon-futurenet.stellar.org',
      ];

      const cache = new SimpleCache();

      const mock = jest.fn<Promise<Response>, [FetchArg, RequestInit?]>(async (url) => {
        const target = url.toString();
        const host = hosts.find((h) => target.includes(new URL(h).hostname));
        const marker = host ? new URL(host).hostname : 'unknown';
        return makeMockResponse(200, makeAccount(ADDRESS_A, marker));
      });

      const results = await Promise.all(
        hosts.map((h) =>
          fetchAccount(h, ADDRESS_A, {
            cacheTtlMs: 60_000,
            cache,
            fetchFn: mock,
          }),
        ),
      );

      // Each result carries the marker from its own Horizon host.
      expect(results[0].sequence).toBe('horizon.stellar.org');
      expect(results[1].sequence).toBe('horizon-testnet.stellar.org');
      expect(results[2].sequence).toBe('horizon-futurenet.stellar.org');

      // Three network calls, three distinct cache entries.
      expect(mock).toHaveBeenCalledTimes(3);
      expect(cache.getStats().size).toBe(3);
    });
  });
});
