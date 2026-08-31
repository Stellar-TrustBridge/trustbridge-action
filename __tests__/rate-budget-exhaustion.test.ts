/**
 * Rate-budget exhaustion tests (#309)
 *
 * Verifies that:
 * 1. horizon_max_requests=1 fails closed immediately (RATE_BUDGET_EXHAUSTED),
 *    not with an unfunded/404 comment.
 * 2. wait_until_funded polling stops immediately on budget exhaustion —
 *    it does NOT continue polling past the budget.
 * 3. The reason_code is RATE_BUDGET_EXHAUSTED, never ACCOUNT_NOT_FUNDED.
 * 4. Cache hits do NOT count against the budget.
 * 5. budget=0 means unlimited (no exhaustion thrown).
 *
 * Key behaviour to guard:
 *   - RateBudgetExhaustedError propagates immediately through waitForFundedAccount
 *     (because the inner error is not a HorizonError with statusCode 404)
 *   - fetchAccount surfaces RateBudgetExhaustedError, not HorizonError
 *   - The rateBudgetExhaustedResult reasonCode is 'RATE_BUDGET_EXHAUSTED',
 *     distinct from 'ACCOUNT_NOT_FUNDED' and 'HORIZON_ERROR'
 */

import {
  fetchAccount,
  waitForFundedAccount,
  HorizonAccount,
  HorizonError,
  FetchLike,
} from '../src/horizon';
import { RateBudgetTracker, RateBudgetExhaustedError } from '../src/resilience';
import { rateBudgetExhaustedResult } from '../src/checks';

const PRIMARY_HORIZON = 'https://horizon.stellar.org';
const TEST_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

// Minimal funded account payload
function makeAccount(address: string = TEST_ADDRESS): HorizonAccount {
  return {
    id: address,
    account_id: address,
    sequence: '1',
    subentry_count: 1,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [
      {
        balance: '10.0000000',
        asset_type: 'native',
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
      },
    ],
  };
}

type MockResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(k: string): string | null };
  json(): Promise<unknown>;
};

function makeSuccessResponse(body: unknown = makeAccount()): MockResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (_k: string) => null },
    json: async () => body,
  };
}

function make404Response(): MockResponse {
  return {
    ok: false,
    status: 404,
    statusText: 'Not Found',
    headers: { get: (_k: string) => null },
    json: async () => ({
      type: 'https://stellar.org/horizon-errors/not_found',
      title: 'Resource Missing',
      status: 404,
      detail: 'The resource at the requested endpoint does not exist.',
    }),
  };
}

/** Build a FetchLike mock that always returns the given response */
function alwaysReturn(response: MockResponse): FetchLike {
  return jest.fn().mockResolvedValue(response) as unknown as FetchLike;
}

/** Build a FetchLike mock that returns 404 N times, then succeeds */
function failThenSucceed(failCount: number): { fn: FetchLike; callCount: () => number } {
  let calls = 0;
  const fn = jest.fn(async () => {
    calls++;
    return calls <= failCount ? make404Response() : makeSuccessResponse();
  }) as unknown as FetchLike;
  return { fn, callCount: () => calls };
}

// ---------------------------------------------------------------------------
// 1. RateBudgetTracker unit tests
// ---------------------------------------------------------------------------

describe('RateBudgetTracker', () => {
  it('budget=0 is unlimited — never throws', () => {
    const tracker = new RateBudgetTracker(0);
    // budget=0 means unlimited — should never throw regardless of call count
    for (let i = 0; i < 100; i++) {
      expect(() => tracker.recordRequest()).not.toThrow();
    }
    // requestsMade is 0 in unlimited mode (no tracking needed by design)
    expect(tracker.requestsMade).toBe(0);
  });

  it('budget=1 allows exactly one request then throws', () => {
    const tracker = new RateBudgetTracker(1);
    expect(() => tracker.recordRequest()).not.toThrow(); // request 1 OK
    expect(() => tracker.recordRequest()).toThrow(RateBudgetExhaustedError); // request 2 exceeds
  });

  it('budget=5 allows five requests then throws on sixth', () => {
    const tracker = new RateBudgetTracker(5);
    for (let i = 0; i < 5; i++) {
      expect(() => tracker.recordRequest()).not.toThrow();
    }
    expect(() => tracker.recordRequest()).toThrow(RateBudgetExhaustedError);
    expect(tracker.requestsMade).toBe(6);
  });

  it('thrown error has name RateBudgetExhaustedError and retryable=false', () => {
    const tracker = new RateBudgetTracker(1);
    tracker.recordRequest();
    let thrown: unknown;
    try {
      tracker.recordRequest();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RateBudgetExhaustedError);
    expect((thrown as RateBudgetExhaustedError).name).toBe('RateBudgetExhaustedError');
    expect((thrown as RateBudgetExhaustedError).retryable).toBe(false);
  });

  it('error message includes max request count', () => {
    const tracker = new RateBudgetTracker(3);
    for (let i = 0; i < 3; i++) tracker.recordRequest();
    expect(() => tracker.recordRequest()).toThrow(/3/);
  });
});

// ---------------------------------------------------------------------------
// 2. fetchAccount — budget exhaustion with shared RateBudgetTracker
// ---------------------------------------------------------------------------

describe('fetchAccount rate-budget exhaustion', () => {
  it('budget=1 rejects on second call with RateBudgetExhaustedError, not HorizonError', async () => {
    const fetchFn = alwaysReturn(makeSuccessResponse());
    const tracker = new RateBudgetTracker(1);

    await expect(
      fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
        fetchFn,
        rateBudgetTracker: tracker,
        cacheTtlMs: 0,
      }),
    ).resolves.toBeDefined();

    await expect(
      fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
        fetchFn,
        rateBudgetTracker: tracker,
        cacheTtlMs: 0,
      }),
    ).rejects.toBeInstanceOf(RateBudgetExhaustedError);
  });

  it('budget=2 allows 2 calls then fails on third', async () => {
    const fetchFn = alwaysReturn(makeSuccessResponse());
    const tracker = new RateBudgetTracker(2);

    await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, { fetchFn, rateBudgetTracker: tracker, cacheTtlMs: 0 });
    await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, { fetchFn, rateBudgetTracker: tracker, cacheTtlMs: 0 });

    await expect(
      fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, { fetchFn, rateBudgetTracker: tracker, cacheTtlMs: 0 }),
    ).rejects.toBeInstanceOf(RateBudgetExhaustedError);
  });

  it('budget=0 (unlimited) — many calls all succeed', async () => {
    const fetchFn = alwaysReturn(makeSuccessResponse());
    const tracker = new RateBudgetTracker(0);

    for (let i = 0; i < 10; i++) {
      await expect(
        fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, { fetchFn, rateBudgetTracker: tracker, cacheTtlMs: 0 }),
      ).resolves.toBeDefined();
    }
  });

  it('cache hit does NOT count against the budget', async () => {
    const fetchFn = jest.fn().mockResolvedValue(makeSuccessResponse()) as unknown as FetchLike;
    const tracker = new RateBudgetTracker(1);

    // First call: cache miss → real request (counts as 1)
    await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
      fetchFn,
      rateBudgetTracker: tracker,
      cacheTtlMs: 60_000,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Second call: cache hit → no real request, no recordRequest call
    await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
      fetchFn,
      rateBudgetTracker: tracker,
      cacheTtlMs: 60_000,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1); // still 1 — cache hit
    expect(tracker.requestsMade).toBe(1); // budget only consumed 1
  });

  it('error thrown is NOT a HorizonError', async () => {
    const fetchFn = alwaysReturn(makeSuccessResponse());
    const tracker = new RateBudgetTracker(1);

    await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, { fetchFn, rateBudgetTracker: tracker, cacheTtlMs: 0 });

    let thrown: unknown;
    try {
      await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, { fetchFn, rateBudgetTracker: tracker, cacheTtlMs: 0 });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(RateBudgetExhaustedError);
    expect(thrown).not.toBeInstanceOf(HorizonError);
  });
});

// ---------------------------------------------------------------------------
// 3. waitForFundedAccount — budget exhaustion stops polling immediately
// ---------------------------------------------------------------------------

describe('waitForFundedAccount rate-budget exhaustion (fail closed)', () => {
  it('budget=1 stops polling on second attempt — throws RateBudgetExhaustedError not timeout-404', async () => {
    let realCallCount = 0;
    const fetchFn = jest.fn(async () => {
      realCallCount++;
      return make404Response();
    }) as unknown as FetchLike;

    const tracker = new RateBudgetTracker(1);

    await expect(
      waitForFundedAccount(
        PRIMARY_HORIZON,
        TEST_ADDRESS,
        {
          timeoutMs: 60_000,
          pollIntervalMs: 10,
        },
        (hUrl, sAddr, opts) =>
          fetchAccount(hUrl, sAddr, {
            fetchFn,
            rateBudgetTracker: tracker,
            cacheTtlMs: 0,
            ...opts,
          }),
      ),
    ).rejects.toBeInstanceOf(RateBudgetExhaustedError);

    // Only 1 real HTTP call was made — the second attempt threw before fetch was called
    expect(realCallCount).toBe(1);
  });

  it('budget=2 stops polling after second 404, throws RateBudgetExhaustedError', async () => {
    let realCallCount = 0;
    const fetchFn = jest.fn(async () => {
      realCallCount++;
      return make404Response();
    }) as unknown as FetchLike;

    const tracker = new RateBudgetTracker(2);

    await expect(
      waitForFundedAccount(
        PRIMARY_HORIZON,
        TEST_ADDRESS,
        {
          timeoutMs: 30_000,
          pollIntervalMs: 10,
        },
        (hUrl, sAddr, opts) =>
          fetchAccount(hUrl, sAddr, {
            fetchFn,
            rateBudgetTracker: tracker,
            cacheTtlMs: 0,
            ...opts,
          }),
      ),
    ).rejects.toBeInstanceOf(RateBudgetExhaustedError);

    expect(realCallCount).toBe(2);
  });

  it('budget exhaustion does NOT produce an ACCOUNT_NOT_FUNDED error (statusCode=404)', async () => {
    const fetchFn = alwaysReturn(make404Response());
    const tracker = new RateBudgetTracker(1);

    let caughtError: unknown;
    try {
      await waitForFundedAccount(
        PRIMARY_HORIZON,
        TEST_ADDRESS,
        { timeoutMs: 10_000, pollIntervalMs: 10 },
        (hUrl, sAddr, opts) =>
          fetchAccount(hUrl, sAddr, {
            fetchFn,
            rateBudgetTracker: tracker,
            cacheTtlMs: 0,
            ...opts,
          }),
      );
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeInstanceOf(RateBudgetExhaustedError);
    expect((caughtError as RateBudgetExhaustedError).name).toBe('RateBudgetExhaustedError');
    // Must not look like a 404 / unfunded error
    expect((caughtError as { statusCode?: number }).statusCode).not.toBe(404);
  });

  it('budget=0 (unlimited) with polling completes when account eventually funds', async () => {
    const { fn: fetchFn } = failThenSucceed(3); // 404 x3, then 200
    const tracker = new RateBudgetTracker(0); // unlimited

    const result = await waitForFundedAccount(
      PRIMARY_HORIZON,
      TEST_ADDRESS,
      {
        timeoutMs: 10_000,
        pollIntervalMs: 10,
      },
      (hUrl, sAddr, opts) =>
        fetchAccount(hUrl, sAddr, {
          fetchFn,
          rateBudgetTracker: tracker,
          cacheTtlMs: 0,
          ...opts,
        }),
    );

    expect(result).toBeDefined();
    expect(result.account_id).toBe(TEST_ADDRESS);
  });
});

// ---------------------------------------------------------------------------
// 4. rateBudgetExhaustedResult — shape and reason_code assertions
// ---------------------------------------------------------------------------

describe('rateBudgetExhaustedResult', () => {
  const baseConfig = {
    assetCode: 'USDC',
    assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    minXlmReserve: 1.5,
    horizonUrl: PRIMARY_HORIZON,
  };

  it('returns valid=false', () => {
    const result = rateBudgetExhaustedResult('Rate budget exhausted.', baseConfig);
    expect(result.valid).toBe(false);
  });

  it('reasonCode is RATE_BUDGET_EXHAUSTED', () => {
    const result = rateBudgetExhaustedResult('Rate budget exhausted.', baseConfig);
    expect(result.reasonCode).toBe('RATE_BUDGET_EXHAUSTED');
  });

  it('reasonCode is NOT ACCOUNT_NOT_FUNDED, HORIZON_ERROR, PAYMENT_NO_TRUST, or HORIZON_TIMEOUT', () => {
    const result = rateBudgetExhaustedResult('Rate budget exhausted.', baseConfig);
    expect(result.reasonCode).not.toBe('ACCOUNT_NOT_FUNDED');
    expect(result.reasonCode).not.toBe('HORIZON_ERROR');
    expect(result.reasonCode).not.toBe('HORIZON_TIMEOUT');
    expect(result.reasonCode).not.toBe('TLS_ERROR');
    expect(result.reasonCode).not.toBe('PAYMENT_NO_TRUST');
  });

  it('accountFunded is false (fail closed — unknown state)', () => {
    const result = rateBudgetExhaustedResult('Rate budget exhausted.', baseConfig);
    expect(result.accountFunded).toBe(false);
  });

  it('trustlineExists is false (fail closed)', () => {
    const result = rateBudgetExhaustedResult('Rate budget exhausted.', baseConfig);
    expect(result.trustlineExists).toBe(false);
  });

  it('xlmBalance is "unknown" not "0" (not the same as an unfunded account)', () => {
    const result = rateBudgetExhaustedResult('Rate budget exhausted.', baseConfig);
    expect(result.xlmBalance).toBe('unknown');
    expect(result.xlmBalance).not.toBe('0');
  });

  it('assetBalance is "unknown" not "0"', () => {
    const result = rateBudgetExhaustedResult('Rate budget exhausted.', baseConfig);
    expect(result.assetBalance).toBe('unknown');
    expect(result.assetBalance).not.toBe('0');
  });

  it('checks list has "Horizon availability" with rate-budget detail', () => {
    const result = rateBudgetExhaustedResult('exceeded 5 maximum Horizon requests per run.', baseConfig);
    const availabilityCheck = result.checks.find((c) => c.label === 'Horizon availability');
    expect(availabilityCheck).toBeDefined();
    expect(availabilityCheck?.passed).toBe(false);
    expect(availabilityCheck?.detail).toContain('Rate budget exhausted');
  });

  it('remediation message references horizon_max_requests', () => {
    const result = rateBudgetExhaustedResult('Rate budget exhausted.', baseConfig);
    expect(result.remediation).toContain('horizon_max_requests');
  });

  it('remediation does NOT suggest account activation (not a 404 result)', () => {
    const result = rateBudgetExhaustedResult('Rate budget exhausted.', baseConfig);
    expect(result.remediation).not.toMatch(/send.*xlm/i);
    expect(result.remediation).not.toMatch(/activate/i);
  });

  it('sponsorshipInfo defaults to zero (Horizon was never queried successfully)', () => {
    const result = rateBudgetExhaustedResult('Rate budget exhausted.', baseConfig);
    expect(result.sponsorshipInfo).toEqual({ numSponsoring: 0, numSponsored: 0 });
  });

  it('all checks are failed (not partially passed)', () => {
    const result = rateBudgetExhaustedResult('Rate budget exhausted.', baseConfig);
    const failedChecks = result.checks.filter((c) => !c.passed);
    expect(failedChecks.length).toBe(result.checks.length);
  });
});

// ---------------------------------------------------------------------------
// 5. Integration: budget exhaustion does not bleed into 404/unfunded path
// ---------------------------------------------------------------------------

describe('rate-budget exhaustion vs unfunded — distinguishability', () => {
  it('404 from Horizon is NOT a RateBudgetExhaustedError', async () => {
    const fetchFn = alwaysReturn(make404Response());
    const tracker = new RateBudgetTracker(0); // unlimited — no budget exhaustion

    let fetchError: unknown;
    try {
      await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
        fetchFn,
        rateBudgetTracker: tracker,
        cacheTtlMs: 0,
      });
    } catch (e) {
      fetchError = e;
    }

    expect(fetchError).toBeDefined();
    expect(fetchError).not.toBeInstanceOf(RateBudgetExhaustedError);
    expect(fetchError).toBeInstanceOf(HorizonError);
    expect((fetchError as HorizonError).statusCode).toBe(404);
  });

  it('budget error has statusCode 0, not 404', () => {
    const tracker = new RateBudgetTracker(1);
    tracker.recordRequest(); // exhaust
    let thrown: unknown;
    try {
      tracker.recordRequest();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RateBudgetExhaustedError);
    expect((thrown as RateBudgetExhaustedError).statusCode).toBe(0);
    expect((thrown as RateBudgetExhaustedError).statusCode).not.toBe(404);
  });

  it('RATE_BUDGET_EXHAUSTED result has different shape from unfundedAccountResult', async () => {
    const { unfundedAccountResult } = await import('../src/checks');
    const budgetResult = rateBudgetExhaustedResult('Rate budget exhausted.', {
      assetCode: 'USDC',
      assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      minXlmReserve: 1.5,
      horizonUrl: PRIMARY_HORIZON,
    });
    const unfundedResult = unfundedAccountResult(TEST_ADDRESS, {
      assetCode: 'USDC',
      assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      minXlmReserve: 1.5,
      horizonUrl: PRIMARY_HORIZON,
    });

    // Key difference: reasonCode
    expect(budgetResult.reasonCode).toBe('RATE_BUDGET_EXHAUSTED');
    expect(unfundedResult.reasonCode).toBe('ACCOUNT_NOT_FUNDED');

    // xlmBalance: budget result = 'unknown', unfunded result = '0'
    expect(budgetResult.xlmBalance).toBe('unknown');
    expect(unfundedResult.xlmBalance).toBe('0');
  });
});
