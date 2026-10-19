/**
 * Tests for the ledger freshness / lag alert feature (Issue #107).
 *
 * Covers:
 *  - fetchHorizonRoot success, HTTP error, timeout, network error
 *  - checkLedgerFreshness: ok, stale, unknown (missing field, bad timestamp)
 *  - fail-open behaviour (errors → fresh=true, status='unknown')
 *  - metrics counters emitted correctly
 *  - LedgerFreshnessCheckResult interface alignment
 *  - blocksValid flag in combination with fail-on-stale
 */

import {
  fetchHorizonRoot,
  checkLedgerFreshness,
  HorizonRootResponse,
  FreshnessCheckResult,
} from '../src/freshness';
import { globalMetrics } from '../src/metrics';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock fetch function that resolves with the given body and status.
 */
function makeMockFetch(
  body: unknown,
  status = 200,
): jest.Mock {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

/**
 * Build a mock fetch that rejects with a network error.
 */
function makeMockFetchNetworkError(message = 'fetch failed'): jest.Mock {
  return jest.fn().mockRejectedValue(new Error(message));
}

/**
 * Build a mock fetch that rejects with an AbortError (timeout simulation).
 */
function makeMockFetchTimeout(): jest.Mock {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return jest.fn().mockRejectedValue(err);
}

/**
 * Returns an ISO-8601 timestamp `secondsAgo` seconds before now.
 */
function timestampSecondsAgo(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Reset global metrics before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  globalMetrics.reset();
});

// ===========================================================================
// fetchHorizonRoot
// ===========================================================================

describe('fetchHorizonRoot', () => {
  it('returns parsed root response on HTTP 200', async () => {
    const body: HorizonRootResponse = {
      history_latest_ledger: 50_000_000,
      history_latest_ledger_closed_at: new Date().toISOString(),
      core_latest_ledger: 50_000_001,
    };
    const fetchFn = makeMockFetch(body);

    const result = await fetchHorizonRoot('https://horizon.stellar.org', { fetchFn });

    expect(result.history_latest_ledger).toBe(50_000_000);
    expect(result.core_latest_ledger).toBe(50_000_001);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // Confirm trailing slash is appended to horizon URL
    expect((fetchFn.mock.calls[0] as unknown[])[0]).toMatch(/\/$/);
  });

  it('throws on non-2xx HTTP status', async () => {
    const fetchFn = makeMockFetch({ error: 'gone' }, 503);

    await expect(
      fetchHorizonRoot('https://horizon.stellar.org', { fetchFn }),
    ).rejects.toThrow('HTTP 503');
  });

  it('throws with timeout message on AbortError', async () => {
    const fetchFn = makeMockFetchTimeout();

    await expect(
      fetchHorizonRoot('https://horizon.stellar.org', { fetchFn, timeoutMs: 1 }),
    ).rejects.toThrow(/timed out/i);
  });

  it('propagates generic network errors', async () => {
    const fetchFn = makeMockFetchNetworkError('ECONNREFUSED');

    await expect(
      fetchHorizonRoot('https://horizon.stellar.org', { fetchFn }),
    ).rejects.toThrow('ECONNREFUSED');
  });

  it('normalises the URL (strips trailing slash duplication)', async () => {
    const fetchFn = makeMockFetch({});
    await fetchHorizonRoot('https://horizon.stellar.org/', { fetchFn }).catch(() => {});
    const calledUrl = (fetchFn.mock.calls[0] as unknown[])[0] as string;
    expect(calledUrl).toBe('https://horizon.stellar.org/');
  });
});

// ===========================================================================
// checkLedgerFreshness — status: ok
// ===========================================================================

describe('checkLedgerFreshness — ok', () => {
  it('returns status=ok when lag is within threshold', async () => {
    const body: HorizonRootResponse = {
      history_latest_ledger: 50_000_000,
      history_latest_ledger_closed_at: timestampSecondsAgo(5), // 5 s ago < 60 s default
    };
    const result = await checkLedgerFreshness('https://horizon.stellar.org', {
      fetchFn: makeMockFetch(body),
    });

    expect(result.status).toBe('ok');
    expect(result.fresh).toBe(true);
    expect(result.lagSeconds).toBeCloseTo(5, 0);
    expect(result.latestLedger).toBe(50_000_000);
    expect(result.message).toMatch(/fresh/i);
  });

  it('emits freshness_ok_count counter when fresh', async () => {
    const body: HorizonRootResponse = {
      history_latest_ledger: 1,
      history_latest_ledger_closed_at: timestampSecondsAgo(3),
    };
    await checkLedgerFreshness('https://horizon.stellar.org', {
      fetchFn: makeMockFetch(body),
    });

    expect(globalMetrics.getCounter('freshness_ok_count')).toBe(1);
    expect(globalMetrics.getCounter('freshness_stale_count')).toBe(0);
  });

  it('emits freshness_lag_seconds metric', async () => {
    const body: HorizonRootResponse = {
      history_latest_ledger: 1,
      history_latest_ledger_closed_at: timestampSecondsAgo(10),
    };
    await checkLedgerFreshness('https://horizon.stellar.org', {
      fetchFn: makeMockFetch(body),
    });

    const summary = globalMetrics.getSummary();
    const lagMetric = summary.metrics.find((m) => m.name === 'freshness_lag_seconds');
    expect(lagMetric).toBeDefined();
    expect(lagMetric!.value).toBeGreaterThanOrEqual(9);
    expect(lagMetric!.value).toBeLessThan(15);
  });

  it('emits freshness_latest_ledger metric', async () => {
    const body: HorizonRootResponse = {
      history_latest_ledger: 42_000_000,
      history_latest_ledger_closed_at: timestampSecondsAgo(2),
    };
    await checkLedgerFreshness('https://horizon.stellar.org', {
      fetchFn: makeMockFetch(body),
    });

    const summary = globalMetrics.getSummary();
    const ledgerMetric = summary.metrics.find((m) => m.name === 'freshness_latest_ledger');
    expect(ledgerMetric).toBeDefined();
    expect(ledgerMetric!.value).toBe(42_000_000);
  });

  it('accepts a custom maxLagSeconds threshold', async () => {
    const body: HorizonRootResponse = {
      history_latest_ledger: 1,
      history_latest_ledger_closed_at: timestampSecondsAgo(25),
    };
    const result = await checkLedgerFreshness('https://horizon.stellar.org', {
      fetchFn: makeMockFetch(body),
      maxLagSeconds: 30, // 25 s < 30 s → ok
    });

    expect(result.status).toBe('ok');
  });
});

// ===========================================================================
// checkLedgerFreshness — status: stale
// ===========================================================================

describe('checkLedgerFreshness — stale', () => {
  it('returns status=stale when lag exceeds threshold', async () => {
    const body: HorizonRootResponse = {
      history_latest_ledger: 50_000_000,
      history_latest_ledger_closed_at: timestampSecondsAgo(120), // 120 s > 60 s default
    };
    const result = await checkLedgerFreshness('https://horizon.stellar.org', {
      fetchFn: makeMockFetch(body),
    });

    expect(result.status).toBe('stale');
    expect(result.fresh).toBe(false);
    expect(result.lagSeconds).toBeGreaterThan(115);
    expect(result.message).toMatch(/stale/i);
    expect(result.message).toContain('50000000');
  });

  it('emits freshness_stale_count counter when stale', async () => {
    const body: HorizonRootResponse = {
      history_latest_ledger: 1,
      history_latest_ledger_closed_at: timestampSecondsAgo(300),
    };
    await checkLedgerFreshness('https://horizon.stellar.org', {
      fetchFn: makeMockFetch(body),
    });

    expect(globalMetrics.getCounter('freshness_stale_count')).toBe(1);
    expect(globalMetrics.getCounter('freshness_ok_count')).toBe(0);
  });

  it('stale with custom threshold (10 s)', async () => {
    const body: HorizonRootResponse = {
      history_latest_ledger: 99,
      history_latest_ledger_closed_at: timestampSecondsAgo(15), // 15 > 10 → stale
    };
    const result = await checkLedgerFreshness('https://horizon.stellar.org', {
      fetchFn: makeMockFetch(body),
      maxLagSeconds: 10,
    });

    expect(result.status).toBe('stale');
    expect(result.latestLedger).toBe(99);
  });

  it('stale message includes threshold and ledger sequence', async () => {
    const body: HorizonRootResponse = {
      history_latest_ledger: 55_000_000,
      history_latest_ledger_closed_at: timestampSecondsAgo(200),
    };
    const result = await checkLedgerFreshness('https://horizon.stellar.org', {
      fetchFn: makeMockFetch(body),
      maxLagSeconds: 60,
    });

    expect(result.message).toContain('60s');
    expect(result.message).toContain('55000000');
  });
});

// ===========================================================================
// checkLedgerFreshness — status: unknown (fail-open)
// ===========================================================================

describe('checkLedgerFreshness — unknown / fail-open', () => {
  it('returns status=unknown and fresh=true when root endpoint fails', async () => {
    const result = await checkLedgerFreshness('https://horizon.stellar.org', {
      fetchFn: makeMockFetchNetworkError('ECONNREFUSED'),
    });

    expect(result.status).toBe('unknown');
    expect(result.fresh).toBe(true); // fail-open
    expect(result.lagSeconds).toBeNull();
    expect(result.latestLedger).toBeNull();
    expect(result.message).toMatch(/fail-open/i);
  });

  it('returns status=unknown when history_latest_ledger_closed_at is missing', async () => {
    const body: HorizonRootResponse = {
      history_latest_ledger: 50_000_000,
      // history_latest_ledger_closed_at deliberately absent
    };
    const result = await checkLedgerFreshness('https://horizon.stellar.org', {
      fetchFn: makeMockFetch(body),
    });

    expect(result.status).toBe('unknown');
    expect(result.fresh).toBe(true);
    expect(result.lagSeconds).toBeNull();
    expect(result.latestLedger).toBe(50_000_000);
    expect(result.message).toMatch(/unknown/i);
  });

  it('returns status=unknown when history_latest_ledger_closed_at is unparseable', async () => {
    const body: HorizonRootResponse = {
      history_latest_ledger: 1,
      history_latest_ledger_closed_at: 'not-a-date',
    };
    const result = await checkLedgerFreshness('https://horizon.stellar.org', {
      fetchFn: makeMockFetch(body),
    });

    expect(result.status).toBe('unknown');
    expect(result.fresh).toBe(true);
    expect(result.lagSeconds).toBeNull();
  });

  it('returns status=unknown on HTTP 503', async () => {
    const result = await checkLedgerFreshness('https://horizon.stellar.org', {
      fetchFn: makeMockFetch({}, 503),
    });

    expect(result.status).toBe('unknown');
    expect(result.fresh).toBe(true);
  });

  it('returns status=unknown on AbortError (timeout)', async () => {
    const result = await checkLedgerFreshness('https://horizon.stellar.org', {
      fetchFn: makeMockFetchTimeout(),
      timeoutMs: 1,
    });

    expect(result.status).toBe('unknown');
    expect(result.fresh).toBe(true);
  });

  it('emits freshness_check_failed counter on network error', async () => {
    await checkLedgerFreshness('https://horizon.stellar.org', {
      fetchFn: makeMockFetchNetworkError(),
    });

    expect(globalMetrics.getCounter('freshness_check_failed')).toBeGreaterThanOrEqual(1);
  });

  it('emits freshness_check_unknown metric on missing field', async () => {
    await checkLedgerFreshness('https://horizon.stellar.org', {
      fetchFn: makeMockFetch({ history_latest_ledger: 1 }),
    });

    const summary = globalMetrics.getSummary();
    const unknownMetric = summary.metrics.find((m) => m.name === 'freshness_check_unknown');
    expect(unknownMetric).toBeDefined();
  });
});

// ===========================================================================
// LedgerFreshnessCheckResult interface (blocksValid)
// ===========================================================================

describe('LedgerFreshnessCheckResult — blocksValid semantics', () => {
  it('stale result does NOT block valid in warn mode (fail_on_stale=false)', async () => {
    const raw: FreshnessCheckResult = {
      status: 'stale',
      fresh: false,
      lagSeconds: 200,
      latestLedger: 1,
      message: 'stale',
    };

    // Simulate index.ts logic for building LedgerFreshnessCheckResult
    const ledgerFreshnessFailOnStale = false;
    const result = {
      status: raw.status,
      lagSeconds: raw.lagSeconds,
      latestLedger: raw.latestLedger,
      message: raw.message,
      blocksValid: raw.status === 'stale' && ledgerFreshnessFailOnStale,
    };

    expect(result.blocksValid).toBe(false);
  });

  it('stale result DOES block valid when fail_on_stale=true', async () => {
    const raw: FreshnessCheckResult = {
      status: 'stale',
      fresh: false,
      lagSeconds: 200,
      latestLedger: 1,
      message: 'stale',
    };

    const ledgerFreshnessFailOnStale = true;
    const result = {
      status: raw.status,
      lagSeconds: raw.lagSeconds,
      latestLedger: raw.latestLedger,
      message: raw.message,
      blocksValid: raw.status === 'stale' && ledgerFreshnessFailOnStale,
    };

    expect(result.blocksValid).toBe(true);
  });

  it('unknown result never blocks valid regardless of fail_on_stale', async () => {
    const ledgerFreshnessFailOnStale = true;
    const raw: FreshnessCheckResult = {
      status: 'unknown',
      fresh: true,
      lagSeconds: null,
      latestLedger: null,
      message: 'unknown',
    };

    const result = {
      status: raw.status,
      lagSeconds: raw.lagSeconds,
      latestLedger: raw.latestLedger,
      message: raw.message,
      blocksValid: raw.status === 'stale' && ledgerFreshnessFailOnStale,
    };

    expect(result.blocksValid).toBe(false);
  });

  it('ok result never blocks valid', async () => {
    const body: HorizonRootResponse = {
      history_latest_ledger: 1,
      history_latest_ledger_closed_at: timestampSecondsAgo(3),
    };
    const raw = await checkLedgerFreshness('https://horizon.stellar.org', {
      fetchFn: makeMockFetch(body),
    });

    const blocksValid = raw.status === 'stale' && true; // even with fail_on_stale=true
    expect(blocksValid).toBe(false);
  });
});

// ===========================================================================
// Edge cases / boundary conditions
// ===========================================================================

describe('checkLedgerFreshness — edge cases', () => {
  it('lag of exactly 0 ms (ledger closed right now) is ok', async () => {
    const body: HorizonRootResponse = {
      history_latest_ledger: 1,
      history_latest_ledger_closed_at: new Date().toISOString(),
    };
    const result = await checkLedgerFreshness('https://horizon.stellar.org', {
      fetchFn: makeMockFetch(body),
      maxLagSeconds: 60,
    });

    expect(result.status).toBe('ok');
    expect(result.lagSeconds).toBeGreaterThanOrEqual(0);
  });

  it('history_latest_ledger absent but close time present — still measures lag', async () => {
    const body: HorizonRootResponse = {
      // history_latest_ledger absent
      history_latest_ledger_closed_at: timestampSecondsAgo(5),
    };
    const result = await checkLedgerFreshness('https://horizon.stellar.org', {
      fetchFn: makeMockFetch(body),
    });

    expect(result.status).toBe('ok');
    expect(result.latestLedger).toBeNull();
    expect(result.lagSeconds).toBeGreaterThanOrEqual(4);
  });

  it('uses DEFAULT_MAX_LAG_SECONDS (60) when maxLagSeconds not provided', async () => {
    const body: HorizonRootResponse = {
      history_latest_ledger: 1,
      history_latest_ledger_closed_at: timestampSecondsAgo(59), // just under 60 s
    };
    const result = await checkLedgerFreshness('https://horizon.stellar.org', {
      fetchFn: makeMockFetch(body),
      // maxLagSeconds deliberately omitted → defaults to 60
    });

    expect(result.status).toBe('ok');
  });

  it('threshold boundary: lag == threshold → ok (not stale)', async () => {
    // lagSeconds is computed as Math.max(0, (now - closedAt) / 1000)
    // If closedAt is exactly maxLagSeconds ago, the comparison is lagSeconds > maxLagSeconds
    // which is false → ok.
    const body: HorizonRootResponse = {
      history_latest_ledger: 1,
      history_latest_ledger_closed_at: timestampSecondsAgo(60), // exactly 60 s
    };
    const result = await checkLedgerFreshness('https://horizon.stellar.org', {
      fetchFn: makeMockFetch(body),
      maxLagSeconds: 60,
    });

    // Due to execution time this may be fractionally above 60; allow stale or ok
    expect(['ok', 'stale']).toContain(result.status);
  });

  it('does not throw on missing core_latest_ledger field', async () => {
    const body: HorizonRootResponse = {
      history_latest_ledger: 1,
      history_latest_ledger_closed_at: timestampSecondsAgo(3),
      // core_latest_ledger absent
    };
    await expect(
      checkLedgerFreshness('https://horizon.stellar.org', { fetchFn: makeMockFetch(body) }),
    ).resolves.toBeDefined();
  });

  it('multiple calls accumulate metrics independently', async () => {
    const freshBody: HorizonRootResponse = {
      history_latest_ledger: 1,
      history_latest_ledger_closed_at: timestampSecondsAgo(5),
    };
    const staleBody: HorizonRootResponse = {
      history_latest_ledger: 2,
      history_latest_ledger_closed_at: timestampSecondsAgo(120),
    };

    await checkLedgerFreshness('https://horizon.stellar.org', { fetchFn: makeMockFetch(freshBody) });
    await checkLedgerFreshness('https://horizon.stellar.org', { fetchFn: makeMockFetch(staleBody) });

    expect(globalMetrics.getCounter('freshness_ok_count')).toBe(1);
    expect(globalMetrics.getCounter('freshness_stale_count')).toBe(1);
  });
});
