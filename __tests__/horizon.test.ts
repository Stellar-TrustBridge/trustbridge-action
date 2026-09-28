import { HorizonError, HorizonRateLimitError, isCreditBalance,
  isRetryableStatus,
  parseRetryAfterMs,
  fetchNetworkPassphrase, FetchLike,
  parseHorizonBalance, normalizeHorizonUrl, getAssetBalance } from '../src/horizon';
import { fetchAccount, HorizonAccount, waitForFundedAccount, getNativeBalance, hasTrustline, fetchClaimableBalanceCount } from '../src/horizon';
import { HorizonCircuitOpenError, isCircuitOpenError } from '../src/horizon';
import { CircuitBreaker, CircuitOpenError } from '../src/resilience';
import * as loggerModule from '../src/logger';
import { SimpleCache } from '../src/cache';
import type { Request, RequestInit, Response } from 'node-fetch';

const TEST_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const TEST_ADDRESS_2 = `G${'B'.repeat(52)}WHF`;
const FALLBACK_ADDRESS = `G${'C'.repeat(52)}WHF`;
const PRIMARY_HORIZON = 'https://horizon.stellar.org';
const FALLBACK_HORIZON = 'https://horizon-fallback.stellar.org';

function makeAccount(address: string = TEST_ADDRESS): HorizonAccount {
  return {
    id: address,
    account_id: address,
    sequence: '1',
    subentry_count: 2,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [
      {
        balance: '10.0000000',
        asset_type: 'native',
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
      },
      {
        balance: '5.0000000',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: TEST_ADDRESS_2,
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
      },
    ],
  };
}

type DebugCall = { message: string; context: loggerModule.LogContext | undefined };
type TestContext = loggerModule.LogContext & Record<string, unknown>;
type FetchArg = string | Request;

function captureDebugCalls(): { calls: DebugCall[]; restore: () => void } {
  const calls: DebugCall[] = [];
  const spy = jest
    .spyOn(loggerModule.logger, 'debug')
    .mockImplementation((message, context) => {
      const safeMessage = loggerModule.redactString(message);
      const safeContext = loggerModule.redactContext(context);
      calls.push({
        message: safeMessage,
        context: safeContext ? { ...safeContext } : undefined,
      });
    });
  return {
    calls,
    restore: () => spy.mockRestore(),
  };
}

function assertNoRawAddress(text: string | undefined, raw: string): void {
  if (!text) return;
  expect(text).not.toContain(raw);
}

function assertContextHasNoRawAddress(
  context: loggerModule.LogContext | undefined,
  rawAddress: string,
): void {
  if (!context) return;
  for (const [, value] of Object.entries(context)) {
    if (typeof value === 'string') {
      assertNoRawAddress(value, rawAddress);
    } else if (typeof value === 'object' && value !== null) {
      const json = JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
      assertNoRawAddress(json, rawAddress);
    }
  }
}

function assertAllCallsRedacted(
  calls: DebugCall[],
  rawAddresses: string[],
): void {
  for (const call of calls) {
    for (const addr of rawAddresses) {
      assertNoRawAddress(call.message, addr);
      assertContextHasNoRawAddress(call.context, addr);
    }
  }
}

function redactForAddress(raw: string): string {
  return loggerModule.redactStellarAddress(raw);
}

function requireContext(call: DebugCall | undefined): TestContext {
  expect(call).toBeDefined();
  return (call?.context ?? {}) as TestContext;
}

type MockFetch = jest.Mock<Promise<Response>, [FetchArg, RequestInit?]>;

function makeMockFetch(
  impl: (url: FetchArg, init?: RequestInit) => Promise<Response>,
): MockFetch {
  return jest.fn<Promise<Response>, [FetchArg, RequestInit?]>(impl);
}

function makeMockResponse(
  status: number,
  body: unknown,
  opts?: { headers?: Record<string, string> },
): Response {
  const headersMap: Record<string, string> = opts?.headers ?? {};
  const headers = new (class {
    private h: Record<string, string>;
    constructor(h: Record<string, string>) { this.h = h; }
    get(k: string) { return this.h[k.toLowerCase()] ?? null; }
  })(headersMap);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 404 ? 'Not Found' : 'Error',
    headers,
    json: async () => body,
  } as unknown as Response;
}

describe('normalizeHorizonUrl', () => {
  it('trims whitespace and trailing slashes', () => {
    expect(normalizeHorizonUrl(' https://horizon.stellar.org/// ')).toBe(
      'https://horizon.stellar.org',
    );
  });

  it('returns an empty string for blank values', () => {
    expect(normalizeHorizonUrl('   ')).toBe('');
  });
});

describe('parseRetryAfterMs', () => {
  it('parses seconds-based retry headers', () => {
    const response = { headers: { get: () => '2' } } as unknown as import('node-fetch').Response;
    expect(parseRetryAfterMs(response)).toBe(2000);
  });
});

describe('isRetryableStatus', () => {
  it('flags transient Horizon statuses', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
  });
});

describe('isCreditBalance', () => {
  it('detects credit balances', () => {
    expect(isCreditBalance({ balance: '1', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', buying_liabilities: '0', selling_liabilities: '0' })).toBe(true);
    expect(isCreditBalance({ balance: '1', asset_type: 'native', buying_liabilities: '0', selling_liabilities: '0' })).toBe(false);
  });

  it('returns false for liquidity_pool_shares', () => {
    expect(isCreditBalance({
      balance: '1',
      asset_type: 'liquidity_pool_shares',
      liquidity_pool_id: 'abc123',
      buying_liabilities: '0',
      selling_liabilities: '0',
      limit: '1000',
      is_authorized: true,
      is_authorized_to_maintain_liabilities: true,
    })).toBe(false);
  });

  it('returns false for claimable_balance_id', () => {
    expect(isCreditBalance({
      asset_type: 'claimable_balance_id',
      balance: '1',
      claimable_balance_id: 'xyz',
    })).toBe(false);
  });
});

describe('parseHorizonBalance', () => {
  it('returns valid numbers or 0', () => {
    expect(parseHorizonBalance('1.5000000')).toBe(1.5);
    expect(parseHorizonBalance('bad')).toBe(0);
  });
});

describe('getNativeBalance & hasTrustline', () => {
  it('extracts native XLM balance correctly', () => {
    const account = makeAccount();
    expect(getNativeBalance(account)).toBe('10.0000000');
  });

  it('returns 0 when native balance is missing', () => {
    const account = makeAccount();
    account.balances = [];
    expect(getNativeBalance(account)).toBe('0');
  });

  it('checks if trustline exists for code and issuer', () => {
    const account = makeAccount();
    expect(hasTrustline(account, 'USDC', TEST_ADDRESS_2)).toBe(true);
    expect(hasTrustline(account, 'EURT', TEST_ADDRESS_2)).toBe(false);
  });

  it('does not false-positive on liquidity_pool_shares entries', () => {
    const account = makeAccount();
    account.balances = [
      { balance: '10.0000000', asset_type: 'native', buying_liabilities: '0', selling_liabilities: '0' },
      {
        balance: '1.0000000',
        asset_type: 'liquidity_pool_shares',
        liquidity_pool_id: 'pool123',
        buying_liabilities: '0',
        selling_liabilities: '0',
        limit: '1000',
        is_authorized: true,
        is_authorized_to_maintain_liabilities: true,
      },
    ];
    expect(hasTrustline(account, 'USDC', TEST_ADDRESS_2)).toBe(false);
  });

  it('finds trustline in account with 100+ mixed balance entries', () => {
    const account = makeAccount();
    const manyBalances: HorizonAccount['balances'] = [
      { balance: '10.0000000', asset_type: 'native', buying_liabilities: '0', selling_liabilities: '0' },
    ];
    // 98 LP share entries
    for (let i = 0; i < 98; i++) {
      manyBalances.push({
        balance: '1.0000000',
        asset_type: 'liquidity_pool_shares',
        liquidity_pool_id: `pool${i}`,
        buying_liabilities: '0',
        selling_liabilities: '0',
        limit: '1000',
        is_authorized: true,
        is_authorized_to_maintain_liabilities: true,
      });
    }
    // target trustline at the end
    manyBalances.push({
      balance: '5.0000000',
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: TEST_ADDRESS_2,
      buying_liabilities: '0',
      selling_liabilities: '0',
    });
    account.balances = manyBalances;
    expect(hasTrustline(account, 'USDC', TEST_ADDRESS_2)).toBe(true);
  });
});

describe('getAssetBalance', () => {
  it('extracts asset balance for matching code and issuer', () => {
    const account = makeAccount();
    expect(getAssetBalance(account, 'USDC', TEST_ADDRESS_2)).toBe('5.0000000');
  });

  it('returns 0 when asset trustline does not exist', () => {
    const account = makeAccount();
    expect(getAssetBalance(account, 'EURT', TEST_ADDRESS_2)).toBe('0');
    expect(getAssetBalance(account, 'USDC', FALLBACK_ADDRESS)).toBe('0');
  });

  it('returns 0 when balances array is empty', () => {
    const account = makeAccount();
    account.balances = [];
    expect(getAssetBalance(account, 'USDC', TEST_ADDRESS_2)).toBe('0');
  });

  it('matches asset code and issuer exactly', () => {
    const account = makeAccount();
    account.balances.push({
      balance: '25.0000000',
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: FALLBACK_ADDRESS,
      buying_liabilities: '0.0000000',
      selling_liabilities: '0.0000000',
    });
    expect(getAssetBalance(account, 'USDC', TEST_ADDRESS_2)).toBe('5.0000000');
    expect(getAssetBalance(account, 'USDC', FALLBACK_ADDRESS)).toBe('25.0000000');
  });

  it('handles 12-character asset codes (credit_alphanum12)', () => {
    const account = makeAccount();
    account.balances.push({
      balance: '99.0000000',
      asset_type: 'credit_alphanum12',
      asset_code: 'LONGASSET12',
      asset_issuer: TEST_ADDRESS_2,
      buying_liabilities: '0.0000000',
      selling_liabilities: '0.0000000',
    });
    expect(getAssetBalance(account, 'LONGASSET12', TEST_ADDRESS_2)).toBe('99.0000000');
  });
});

describe('fetchAccount: basic', () => {
  it('fails fast when horizon_url is blank', async () => {
    await expect(fetchAccount('   ', TEST_ADDRESS)).rejects.toMatchObject({
      message: 'horizon_url is required.',
      statusCode: 0,
      retryable: false,
    } satisfies Partial<HorizonError>);
  });
});

describe('waitForFundedAccount', () => {
  it('returns the account once a poll succeeds', async () => {
    const account = makeAccount();
    const fetchAccountFn = jest
      .fn()
      .mockRejectedValueOnce(new HorizonError('not found', 404, false))
      .mockRejectedValueOnce(new HorizonError('not found', 404, false))
      .mockResolvedValueOnce(account);

    const onPoll = jest.fn();

    const result = await waitForFundedAccount(
      PRIMARY_HORIZON,
      TEST_ADDRESS,
      { timeoutMs: 5000, pollIntervalMs: 5, onPoll },
      fetchAccountFn,
    );

    expect(result).toBe(account);
    expect(fetchAccountFn).toHaveBeenCalledTimes(3);
    expect(onPoll).toHaveBeenCalledTimes(2);
  });

  it('throws a 404 HorizonError once the timeout budget is exhausted', async () => {
    const fetchAccountFn = jest.fn().mockRejectedValue(new HorizonError('not found', 404, false));

    await expect(
      waitForFundedAccount(
        PRIMARY_HORIZON,
        TEST_ADDRESS,
        { timeoutMs: 20, pollIntervalMs: 5 },
        fetchAccountFn,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rethrows non-404 errors immediately without polling further', async () => {
    const outage = new HorizonError('Horizon request failed (503): maintenance', 503, true);
    const fetchAccountFn = jest.fn().mockRejectedValue(outage);

    await expect(
      waitForFundedAccount(
        PRIMARY_HORIZON,
        TEST_ADDRESS,
        { timeoutMs: 5000, pollIntervalMs: 5 },
        fetchAccountFn,
      ),
    ).rejects.toBe(outage);
    expect(fetchAccountFn).toHaveBeenCalledTimes(1);
  });
});

describe('Horizon debug log redaction', () => {
  const RAW_ADDRESSES = [TEST_ADDRESS, TEST_ADDRESS_2, FALLBACK_ADDRESS];

  describe('fetch path: success debug logs redact addresses and URLs', () => {
    it('redacts stellar addresses and horizon URLs from every debug line on success', async () => {
      const { calls, restore } = captureDebugCalls();
      const account = makeAccount(TEST_ADDRESS);
      const mock = makeMockFetch(async () => makeMockResponse(200, account));
      loggerModule.logger.setDebugMode(true);
      const expectedRedacted = redactForAddress(TEST_ADDRESS);

      try {
        const result = await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 0,
          cacheTtlMs: 0,
          fetchFn: mock,
        });
        expect(result.account_id).toBe(TEST_ADDRESS);
        expect(mock).toHaveBeenCalledTimes(1);
        expect(calls.length).toBeGreaterThan(0);
        const fetchStart = calls.find((c) => c.message === 'Horizon fetch start');
        expect(fetchStart).toBeDefined();
        expect(fetchStart!.context?.url).toContain(expectedRedacted);
        const success = calls.find((c) => c.message === 'Horizon fetch success');
        const successCtx = requireContext(success);
        expect(successCtx.balancesCount).toBe(2);
        expect(successCtx.creditTrustlineCount).toBe(1);
        expect(successCtx.subentryCount).toBe(2);
        expect(successCtx.balances).toBeUndefined();
        expect(successCtx.sequence).toBeUndefined();
        expect(successCtx.account_id).toBeUndefined();
        assertAllCallsRedacted(calls, RAW_ADDRESSES);
      } finally {
        jest.restoreAllMocks();
        restore();
      }
    });

    it('redacts addresses in error debug lines (400 non-retryable parses body)', async () => {
      const { calls, restore } = captureDebugCalls();
      const errBody = { type: 'https://stellar.org/horizon-errors/bad_request', title: 'Bad Request', status: 400, detail: `The resource at /accounts/${TEST_ADDRESS} was malformed` };
      const mock = makeMockFetch(async () => makeMockResponse(400, errBody));
      loggerModule.logger.setDebugMode(true);
      const expectedRedacted = redactForAddress(TEST_ADDRESS);

      try {
        await expect(fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 0,
          cacheTtlMs: 0,
          fetchFn: mock,
        })).rejects.toMatchObject({ statusCode: 400 });
        expect(mock).toHaveBeenCalledTimes(1);
        expect(calls.length).toBeGreaterThan(0);
        const parsed = calls.find((c) => c.message === 'Horizon error response parsed');
        const parsedCtx = requireContext(parsed);
        expect(parsedCtx.errorDetail).toContain(expectedRedacted);
        assertAllCallsRedacted(calls, RAW_ADDRESSES);
      } finally {
        jest.restoreAllMocks();
        restore();
      }
    });

    it('emits 404-specific debug line and does not try fallback for 404', async () => {
      const { calls, restore } = captureDebugCalls();
      const errBody = { type: 'https://stellar.org/horizon-errors/not_found', title: 'Not Found', status: 404, detail: `Not found` };
      const mock = makeMockFetch(async () => makeMockResponse(404, errBody));
      loggerModule.logger.setDebugMode(true);

      try {
        await expect(fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 0,
          cacheTtlMs: 0,
          horizonUrlFallback: FALLBACK_HORIZON,
          fetchFn: mock,
        })).rejects.toMatchObject({ statusCode: 404 });
        expect(mock).toHaveBeenCalledTimes(1);
        const notFound = calls.find((c) => c.message === 'Horizon account not found (404)');
        expect(notFound).toBeDefined();
        const fallbackSwitch = calls.find((c) =>
          c.message === 'Horizon RPC fallback: primary exhausted, switching to fallback URL',
        );
        expect(fallbackSwitch).toBeUndefined();
        assertAllCallsRedacted(calls, RAW_ADDRESSES);
      } finally {
        jest.restoreAllMocks();
        restore();
      }
    });
  });

  describe('retry path: transient HTTP 429 + retry debug logs redacted', () => {
    it('redacts addresses and retry details on transient HTTP retries', async () => {
      const { calls, restore } = captureDebugCalls();
      const account = makeAccount(TEST_ADDRESS);
      const errBody = { type: 'rate_limit', title: 'Too Many Requests', status: 429, detail: `Account ${TEST_ADDRESS} exceeded rate limit` };
      let callCount = 0;
      const mock = makeMockFetch(async () => {
        callCount += 1;
        if (callCount < 2) {
          return makeMockResponse(429, errBody, { headers: { 'retry-after': '0' } });
        }
        return makeMockResponse(200, account);
      });
      const origSetTimeout = global.setTimeout;
      global.setTimeout = ((callback: Parameters<typeof setTimeout>[0]) =>
        origSetTimeout(callback, 0)) as typeof setTimeout;
      loggerModule.logger.setDebugMode(true);
      const expectedRedacted = redactForAddress(TEST_ADDRESS);

      try {
        const result = await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 2,
          cacheTtlMs: 0,
          fetchFn: mock,
        });
        expect(result.account_id).toBe(TEST_ADDRESS);
        expect(mock).toHaveBeenCalledTimes(2);
        const retrySched = calls.find((c) => c.message === 'Horizon retry scheduled');
        const retryCtx = requireContext(retrySched);
        expect(retryCtx.nextAttempt).toBe(1);
        expect(retryCtx.retryAfterFromHeader).toBe(true);
        const parsedErr = calls.find((c) => c.message === 'Horizon error response parsed');
        const parsedErrCtx = requireContext(parsedErr);
        expect(parsedErrCtx.errorDetail).not.toContain(TEST_ADDRESS);
        expect(parsedErrCtx.errorDetail).toContain(expectedRedacted);
        assertAllCallsRedacted(calls, RAW_ADDRESSES);
      } finally {
        global.setTimeout = origSetTimeout;
        jest.restoreAllMocks();
        restore();
      }
    });

    it('caps Retry-After at retryMaxDelayMs and still retries on 429', async () => {
      const errBody = { type: 'rate_limit', title: 'Too Many Requests', status: 429, detail: `Rate limited` };
      let callCount = 0;
      const mock = makeMockFetch(async () => {
        callCount += 1;
        if (callCount === 1) {
          return makeMockResponse(429, errBody, { headers: { 'retry-after': '120' } });
        }
        return makeMockResponse(200, { id: TEST_ADDRESS, balances: [{ asset_type: 'native', balance: '100' }] });
      });

      const origSetTimeout = global.setTimeout;
      global.setTimeout = ((callback: Parameters<typeof setTimeout>[0]) =>
        origSetTimeout(callback, 0)) as typeof setTimeout;

      try {
        const result = await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 2,
          cacheTtlMs: 0,
          retryMaxDelayMs: 60000,
          fetchFn: mock,
        });

        expect(result).toBeDefined();
        expect(callCount).toBe(2);
      } finally {
        global.setTimeout = origSetTimeout;
      }
    });

    it('reports wait-budget context if total wait exceeds max total wait', async () => {
      const errBody = { type: 'rate_limit', title: 'Too Many Requests', status: 429, detail: `Rate limited` };
      let callCount = 0;
      const mock = makeMockFetch(async () => {
        callCount += 1;
        // Two consecutive 429s, each asking to wait 40 seconds (40000ms).
        return makeMockResponse(429, errBody, { headers: { 'retry-after': '40' } });
      });
      const origSetTimeout = global.setTimeout;
      global.setTimeout = ((callback: Parameters<typeof setTimeout>[0]) =>
        origSetTimeout(callback, 0)) as typeof setTimeout;

      try {
        await expect(fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 2,
          cacheTtlMs: 0,
          retryMaxDelayMs: 60000, // per-retry cap is generous enough
          retryMaxTotalWaitMs: 70000, // but total wait cap will be exceeded on 2nd retry (40k + 40k = 80k > 70k)
          fetchFn: mock,
        })).rejects.toThrow(/retry wait budget exhausted/i);
        // It should have made 2 calls (first attempt + 1 retry, before failing before 2nd retry)
        expect(mock).toHaveBeenCalledTimes(2);
      } finally {
        global.setTimeout = origSetTimeout;
      }
    });
  });

  describe('cache path: cache lookup, hit, miss, and populate debug logs redacted', () => {
    it('redacts cache keys and embedded addresses on cache hit and populate', async () => {
      const { calls, restore } = captureDebugCalls();
      const cache = new SimpleCache();
      const account = makeAccount(TEST_ADDRESS);
      const mock = makeMockFetch(async () => makeMockResponse(200, account));
      loggerModule.logger.setDebugMode(true);
      const expectedRedacted = redactForAddress(TEST_ADDRESS);

      try {
        const first = await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 0,
          cacheTtlMs: 60_000,
          cache,
          fetchFn: mock,
        });
        expect(first.account_id).toBe(TEST_ADDRESS);
        expect(mock).toHaveBeenCalledTimes(1);
        const lookup = calls.find((c) => c.message === 'Horizon cache lookup start');
        const lookupCtx = requireContext(lookup);
        expect(lookupCtx.cacheKey).toContain('horizon:account:');
        expect(lookupCtx.cacheKey).not.toContain(TEST_ADDRESS);
        expect(lookupCtx.cacheKey).toContain(expectedRedacted);
        const miss = calls.find((c) => c.message === 'Horizon cache miss');
        expect(miss).toBeDefined();
        const populate = calls.find((c) => c.message === 'Horizon cache populate after primary success');
        const populateCtx = requireContext(populate);
        expect(populateCtx.source).toBe('primary');
        expect(populateCtx.cacheSizeAfter).toBe(1);
        assertAllCallsRedacted(calls, RAW_ADDRESSES);

        calls.length = 0;
        mock.mockClear();
        const second = await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 0,
          cacheTtlMs: 60_000,
          cache,
          fetchFn: mock,
        });
        expect(second.account_id).toBe(TEST_ADDRESS);
        expect(mock).not.toHaveBeenCalled();
        const hit = calls.find((c) => c.message === 'Horizon cache hit');
        const hitCtx = requireContext(hit);
        expect(hitCtx.balancesCount).toBe(2);
        expect(hitCtx.cacheKey).not.toContain(TEST_ADDRESS);
        const fetchCalls = calls.filter((c) => c.message === 'Horizon fetch start');
        expect(fetchCalls.length).toBe(0);
        assertAllCallsRedacted(calls, RAW_ADDRESSES);
      } finally {
        jest.restoreAllMocks();
        restore();
      }
    });

    it('emits a cache-disabled debug line when ttl is 0', async () => {
      const { calls, restore } = captureDebugCalls();
      const account = makeAccount(TEST_ADDRESS);
      const mock = makeMockFetch(async () => makeMockResponse(200, account));
      loggerModule.logger.setDebugMode(true);

      try {
        await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 0,
          cacheTtlMs: 0,
          fetchFn: mock,
        });
        expect(mock).toHaveBeenCalledTimes(1);
        const disabled = calls.find((c) => c.message === 'Horizon cache disabled (ttl=0)');
        const disabledCtx = requireContext(disabled);
        expect(disabledCtx.cacheTtlMs).toBe(0);
        assertAllCallsRedacted(calls, RAW_ADDRESSES);
      } finally {
        jest.restoreAllMocks();
        restore();
      }
    });
  });

  describe('RPC fallback path: fallback switch, success, and exhaustion debug logs redacted', () => {
    it('redacts primary/fallback URLs and error messages when fallback succeeds', async () => {
      const { calls, restore } = captureDebugCalls();
      const account = makeAccount(FALLBACK_ADDRESS);
      const primaryErrBody = { type: 'server_error', title: 'Service Unavailable', status: 503, detail: `Upstream error while querying account ${TEST_ADDRESS_2}` };
      const mock = makeMockFetch(async (url) => {
        if (typeof url === 'string' && url.startsWith(PRIMARY_HORIZON)) {
          return makeMockResponse(503, primaryErrBody);
        }
        return makeMockResponse(200, account);
      });
      loggerModule.logger.setDebugMode(true);
      const expectedTestAddr = redactForAddress(TEST_ADDRESS);
      const expectedAddr2 = redactForAddress(TEST_ADDRESS_2);

      try {
        const result = await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 0,
          cacheTtlMs: 0,
          horizonUrlFallback: FALLBACK_HORIZON,
          fetchFn: mock,
        });
        expect(result.account_id).toBe(FALLBACK_ADDRESS);
        expect(mock).toHaveBeenCalledTimes(2);

        const switchLog = calls.find((c) =>
          c.message === 'Horizon RPC fallback: primary exhausted, switching to fallback URL',
        );
        const switchCtx = requireContext(switchLog);
        expect(switchCtx.horizonUrlFallback).toContain(FALLBACK_HORIZON.replace(/\/+$/, ''));
        expect(switchCtx.primaryStatusCode).toBe(503);
        expect(switchCtx.primaryErrorMessage).not.toContain(TEST_ADDRESS_2);
        expect(switchCtx.primaryErrorMessage).toContain(expectedAddr2);

        const fallbackSuccess = calls.find(
          (c) => c.message === 'Horizon RPC fallback succeeded',
        );
        const fallbackSuccessCtx = requireContext(fallbackSuccess);
        expect(fallbackSuccessCtx.fallbackAttempts).toBeDefined();
        expect(fallbackSuccessCtx.fallbackLatencyMs).toBeDefined();

        const fallbackFetches = calls.filter(
          (c) => c.message === 'Horizon fetch start' && requireContext(c).endpointKind === 'fallback',
        );
        expect(fallbackFetches.length).toBe(1);
        expect(requireContext(fallbackFetches[0]).url).toContain(expectedTestAddr);

        assertAllCallsRedacted(calls, RAW_ADDRESSES);
      } finally {
        jest.restoreAllMocks();
        restore();
      }
    });

    it('redacts both primary and fallback errors when fallback is exhausted', async () => {
      const { calls, restore } = captureDebugCalls();
      const primaryErrBody = { type: 'server_error', title: 'Bad Gateway', status: 502, detail: `Connecting to account ${TEST_ADDRESS} failed` };
      const fallbackErrBody = { type: 'server_error', title: 'Service Unavailable', status: 503, detail: `Fallback also down for ${TEST_ADDRESS_2}` };
      const mock = makeMockFetch(async (url) => {
        if (typeof url === 'string' && url.startsWith(PRIMARY_HORIZON)) {
          return makeMockResponse(502, primaryErrBody);
        }
        return makeMockResponse(503, fallbackErrBody);
      });
      loggerModule.logger.setDebugMode(true);
      const expectedTestAddr = redactForAddress(TEST_ADDRESS);
      const expectedAddr2 = redactForAddress(TEST_ADDRESS_2);

      try {
        await expect(fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 0,
          cacheTtlMs: 0,
          horizonUrlFallback: FALLBACK_HORIZON,
          fetchFn: mock,
        })).rejects.toMatchObject({ statusCode: 503 });
        expect(mock).toHaveBeenCalledTimes(2);

        const exhausted = calls.find(
          (c) => c.message === 'Horizon RPC fallback exhausted',
        );
        const exhaustedCtx = requireContext(exhausted);
        expect(exhaustedCtx.primaryStatusCode).toBe(502);
        expect(exhaustedCtx.fallbackStatusCode).toBe(503);
        expect(exhaustedCtx.primaryErrorMessage).not.toContain(TEST_ADDRESS);
        expect(exhaustedCtx.fallbackErrorMessage).not.toContain(TEST_ADDRESS_2);
        expect(exhaustedCtx.primaryErrorMessage).toContain(expectedTestAddr);
        expect(exhaustedCtx.fallbackErrorMessage).toContain(expectedAddr2);

        assertAllCallsRedacted(calls, RAW_ADDRESSES);
      } finally {
        jest.restoreAllMocks();
        restore();
      }
    });

    it('bypasses failover when primary returns 404 (account missing is not retryable)', async () => {
      const mock = makeMockFetch(async (url) => {
        if (typeof url === 'string' && url.startsWith(PRIMARY_HORIZON)) {
          return makeMockResponse(404, { title: 'Resource Missing' });
        }
        return makeMockResponse(200, makeAccount(TEST_ADDRESS));
      });

      await expect(
        fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 0,
          horizonUrlFallback: FALLBACK_HORIZON,
          fetchFn: mock,
        }),
      ).rejects.toThrow(/not found on Horizon/);

      expect(mock).toHaveBeenCalledTimes(1);
    });

    it('prevents failover across different networks when allowCrossNetworkFailover is false', async () => {
      const mock = makeMockFetch(async (url) => {
        if (typeof url === 'string' && url.startsWith(PRIMARY_HORIZON)) {
          return makeMockResponse(500, { title: 'Internal Error' });
        }
        return makeMockResponse(200, makeAccount(TEST_ADDRESS));
      });

      const testnetSecondary = 'https://horizon-testnet.stellar.org';

      await expect(
        fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 0,
          secondaryHorizonUrl: testnetSecondary,
          allowCrossNetworkFailover: false,
          fetchFn: mock,
        }),
      ).rejects.toThrow(/Horizon request failed/);

      expect(mock).toHaveBeenCalledTimes(1);
    });

    it('attaches _servedByUrl to the returned account object on primary and secondary success', async () => {
      const mock = makeMockFetch(async (url) => {
        if (typeof url === 'string' && url.startsWith(PRIMARY_HORIZON)) {
          return makeMockResponse(500, { title: 'Internal Error' });
        }
        return makeMockResponse(200, makeAccount(TEST_ADDRESS));
      });

      const secondaryHorizon = 'https://horizon-secondary.stellar.org';
      const account = await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
        maxRetries: 0,
        secondaryHorizonUrl: secondaryHorizon,
        fetchFn: mock,
      });

      expect(account._servedByUrl).toBe(secondaryHorizon);
    });
  });

  describe('RPC fallback network binding rule', () => {
    const TESTNET_FALLBACK_HORIZON = 'https://horizon-testnet.stellar.org';

    it('skips a cross-network fallback by default and rethrows the primary error', async () => {
      const { calls, restore } = captureDebugCalls();
      const primaryErrBody = { type: 'server_error', title: 'Bad Gateway', status: 502, detail: 'primary down' };
      const mock = makeMockFetch(async (url) => {
        if (typeof url === 'string' && url.startsWith(PRIMARY_HORIZON)) {
          return makeMockResponse(502, primaryErrBody);
        }
        // The fallback must never be called for a cross-network mismatch.
        return makeMockResponse(200, makeAccount(FALLBACK_ADDRESS));
      });
      loggerModule.logger.setDebugMode(true);

      try {
        await expect(fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 0,
          cacheTtlMs: 0,
          horizonUrlFallback: TESTNET_FALLBACK_HORIZON,
          fetchFn: mock,
        })).rejects.toMatchObject({ statusCode: 502 });

        // Only the primary request was made — the mismatched-network
        // fallback was never attempted.
        expect(mock).toHaveBeenCalledTimes(1);

        const skipped = calls.find(
          (c) => c.message === 'Horizon RPC fallback skipped: primary and fallback resolve to different networks',
        );
        const skippedCtx = requireContext(skipped);
        expect(skippedCtx.primaryNetwork).toBe('public');
        expect(skippedCtx.fallbackNetwork).toBe('testnet');

        const switched = calls.find(
          (c) => c.message === 'Horizon RPC fallback: primary exhausted, switching to fallback URL',
        );
        expect(switched).toBeUndefined();
      } finally {
        jest.restoreAllMocks();
        restore();
      }
    });

    it('uses a cross-network fallback when allowCrossNetworkFallback is explicitly set', async () => {
      const account = makeAccount(FALLBACK_ADDRESS);
      const primaryErrBody = { type: 'server_error', title: 'Bad Gateway', status: 502, detail: 'primary down' };
      const mock = makeMockFetch(async (url) => {
        if (typeof url === 'string' && url.startsWith(PRIMARY_HORIZON)) {
          return makeMockResponse(502, primaryErrBody);
        }
        return makeMockResponse(200, account);
      });

      const result = await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
        maxRetries: 0,
        cacheTtlMs: 0,
        horizonUrlFallback: TESTNET_FALLBACK_HORIZON,
        allowCrossNetworkFallback: true,
        fetchFn: mock,
      });

      expect(result.account_id).toBe(FALLBACK_ADDRESS);
      expect(mock).toHaveBeenCalledTimes(2);
      jest.restoreAllMocks();
    });

    it('still uses the fallback when both URLs resolve to the same network', async () => {
      const account = makeAccount(FALLBACK_ADDRESS);
      const primaryErrBody = { type: 'server_error', title: 'Bad Gateway', status: 502, detail: 'primary down' };
      const mock = makeMockFetch(async (url) => {
        if (typeof url === 'string' && url.startsWith(PRIMARY_HORIZON)) {
          return makeMockResponse(502, primaryErrBody);
        }
        return makeMockResponse(200, account);
      });

      const result = await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
        maxRetries: 0,
        cacheTtlMs: 0,
        horizonUrlFallback: FALLBACK_HORIZON,
        fetchFn: mock,
      });

      expect(result.account_id).toBe(FALLBACK_ADDRESS);
      expect(mock).toHaveBeenCalledTimes(2);
      jest.restoreAllMocks();
    });
  });

  describe('never caches a 404 as a successful/funded result', () => {
    it('does not populate the cache on a 404 and refetches on the next call', async () => {
      const cache = new SimpleCache();
      const account = makeAccount(TEST_ADDRESS);
      const notFoundBody = { type: 'not_found', title: 'Not Found', status: 404, detail: 'Account not found' };
      let callCount = 0;
      const mock = makeMockFetch(async () => {
        callCount += 1;
        if (callCount === 1) {
          return makeMockResponse(404, notFoundBody);
        }
        return makeMockResponse(200, account);
      });

      await expect(fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
        maxRetries: 0,
        cacheTtlMs: 60_000,
        cache,
        fetchFn: mock,
      })).rejects.toMatchObject({ statusCode: 404 });

      expect(cache.getStats().size).toBe(0);

      const result = await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
        maxRetries: 0,
        cacheTtlMs: 60_000,
        cache,
        fetchFn: mock,
      });

      expect(result.account_id).toBe(TEST_ADDRESS);
      expect(callCount).toBe(2);
      jest.restoreAllMocks();
    });
  });

  describe('safeAccountSummary: never emits sensitive account fields into debug context', () => {
    it('strips balance, sequence, sponsor counts and raw id from success context', async () => {
      const { calls, restore } = captureDebugCalls();
      const account = makeAccount(TEST_ADDRESS);
      const mock = makeMockFetch(async () => makeMockResponse(200, account));
      loggerModule.logger.setDebugMode(true);

      try {
        await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 0,
          cacheTtlMs: 0,
          fetchFn: mock,
        });
        expect(mock).toHaveBeenCalledTimes(1);
        const success = calls.find((c) => c.message === 'Horizon fetch success');
        const ctx = requireContext(success);
        expect(ctx.sequence).toBeUndefined();
        expect(ctx.balances).toBeUndefined();
        expect(ctx.id).toBeUndefined();
        expect(ctx.account_id).toBeUndefined();
        expect(ctx.num_sponsoring).toBeUndefined();
        expect(ctx.num_sponsored).toBeUndefined();
        expect(ctx.balancesCount).toBe(2);
        expect(ctx.creditTrustlineCount).toBe(1);
        expect(ctx.hasNativeBalance).toBe(true);
        expect(ctx.subentryCount).toBe(2);
      } finally {
        jest.restoreAllMocks();
        restore();
      }
    });

    it('excludes liquidity_pool_shares from creditTrustlineCount', async () => {
      const { calls, restore } = captureDebugCalls();
      const account = makeAccount(TEST_ADDRESS);
      account.balances = [
        { balance: '10.0000000', asset_type: 'native', buying_liabilities: '0', selling_liabilities: '0' },
        {
          balance: '1.0000000',
          asset_type: 'liquidity_pool_shares',
          liquidity_pool_id: 'pool1',
          buying_liabilities: '0',
          selling_liabilities: '0',
          limit: '1000',
          is_authorized: true,
          is_authorized_to_maintain_liabilities: true,
        },
        {
          balance: '5.0000000',
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: TEST_ADDRESS_2,
          buying_liabilities: '0',
          selling_liabilities: '0',
        },
      ];
      const mock = makeMockFetch(async () => makeMockResponse(200, account));
      loggerModule.logger.setDebugMode(true);

      try {
        await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 0,
          cacheTtlMs: 0,
          fetchFn: mock,
        });
        const success = calls.find((c) => c.message === 'Horizon fetch success');
        const ctx = requireContext(success);
        expect(ctx.balancesCount).toBe(3);
        // LP share must NOT be counted as a credit trustline
        expect(ctx.creditTrustlineCount).toBe(1);
      } finally {
        jest.restoreAllMocks();
        restore();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// AbortSignal / job-cancellation tests (Issue #82)
// ---------------------------------------------------------------------------

describe('AbortSignal cancellation', () => {
  describe('fetchAccount: pre-flight abort', () => {
    it('rejects immediately (non-retryable) when signal is already aborted before fetch starts', async () => {
      const controller = new AbortController();
      controller.abort();
      const mock = makeMockFetch(async () => makeMockResponse(200, makeAccount()));

      await expect(
        fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 2,
          cacheTtlMs: 0,
          signal: controller.signal,
          fetchFn: mock,
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('aborted'),
        retryable: false,
      });

      // The fetch function should NOT have been called at all.
      expect(mock).not.toHaveBeenCalled();
    });
  });

  describe('fetchAccount: mid-request abort stops retries', () => {
    it('does not retry after the parent signal fires during a request', async () => {
      const controller = new AbortController();

      // Simulate: first call triggers the job abort, second call should never run.
      let callCount = 0;
      const mock = makeMockFetch(async () => {
        callCount += 1;
        controller.abort(); // cancel the job during the first request
        // Throw an AbortError as fetch would when the signal fires.
        const err = new Error('The user aborted a request.');
        err.name = 'AbortError';
        throw err;
      });

      await expect(
        fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 3,
          cacheTtlMs: 0,
          signal: controller.signal,
          fetchFn: mock,
        }),
      ).rejects.toMatchObject({
        retryable: false,
        message: expect.stringContaining('aborted'),
      });

      // Should have been called exactly once — no retries after cancellation.
      expect(callCount).toBe(1);
    });
  });

  describe('waitForFundedAccount: abort stops polling', () => {
    it('exits without retrying when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const fetchAccountFn = jest.fn().mockRejectedValue(new HorizonError('not found', 404, false));

      await expect(
        waitForFundedAccount(
          PRIMARY_HORIZON,
          TEST_ADDRESS,
          { timeoutMs: 5000, pollIntervalMs: 5, signal: controller.signal },
          fetchAccountFn,
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining('aborted'),
        retryable: false,
      });

      // fetch should not have been called — aborted before first attempt.
      expect(fetchAccountFn).not.toHaveBeenCalled();
    });

    it('stops polling mid-loop when signal fires between polls', async () => {
      const controller = new AbortController();
      let calls = 0;

      const fetchAccountFn = jest.fn().mockImplementation(async () => {
        calls += 1;
        // Abort after the first 404 to simulate job cancellation between polls.
        if (calls === 1) {
          controller.abort();
        }
        throw new HorizonError('not found', 404, false);
      });

      await expect(
        waitForFundedAccount(
          PRIMARY_HORIZON,
          TEST_ADDRESS,
          { timeoutMs: 30000, pollIntervalMs: 1, signal: controller.signal },
          fetchAccountFn,
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining('aborted'),
        retryable: false,
      });

      // Only one fetch should have been attempted before the abort was processed.
      expect(calls).toBe(1);
    });

    it('does not produce a misleading "account not funded" error on abort', async () => {
      const controller = new AbortController();
      controller.abort();

      const fetchAccountFn = jest.fn().mockRejectedValue(new HorizonError('not found', 404, false));

      const error = await waitForFundedAccount(
        PRIMARY_HORIZON,
        TEST_ADDRESS,
        { timeoutMs: 5000, pollIntervalMs: 5, signal: controller.signal },
        fetchAccountFn,
      ).catch((e) => e as HorizonError);

      // Must NOT look like a genuine "account not funded" (404) error.
      expect(error).toBeInstanceOf(HorizonError);
      expect((error as HorizonError).statusCode).toBe(0);
      expect((error as HorizonError).message).not.toContain('not funded');
      expect((error as HorizonError).message).not.toContain('wait_until_funded');
    });
  });

  describe('RateBudgetTracker integration', () => {
    it('throws RateBudgetExhaustedError when horizonMaxRequests is exceeded', async () => {
      const { RateBudgetExhaustedError } = require('../src/resilience');
      const account = makeAccount(TEST_ADDRESS);
      const mock = makeMockFetch(async () => makeMockResponse(200, account));
      
      const rateBudgetTracker = new (require('../src/resilience').RateBudgetTracker)(2);

      await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
        fetchFn: mock,
        rateBudgetTracker,
        cacheTtlMs: 0,
      });

      await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
        fetchFn: mock,
        rateBudgetTracker,
        cacheTtlMs: 0,
      });

      expect(rateBudgetTracker.requestsMade).toBe(2);

      await expect(
        fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          fetchFn: mock,
          rateBudgetTracker,
          cacheTtlMs: 0,
        }),
      ).rejects.toThrow(RateBudgetExhaustedError);
    });

    it('caps Retry-After at retryMaxDelayMs and retries', async () => {
      let callCount = 0;
      const mock = makeMockFetch(async () => {
        callCount += 1;
        if (callCount === 1) {
          return makeMockResponse(429, {}, { headers: { 'retry-after': '100' } });
        }
        return makeMockResponse(200, { id: TEST_ADDRESS, balances: [{ asset_type: 'native', balance: '100' }] });
      });

      const result = await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
        fetchFn: mock,
        maxRetries: 1,
        retryMaxDelayMs: 2000,
        cacheTtlMs: 0,
      });

      expect(result).toBeDefined();
      expect(callCount).toBe(2);
    });
  });
});

describe('fetchClaimableBalanceCount', () => {
  it('returns 0 on validation error', async () => {
    const result = await fetchClaimableBalanceCount('http://169.254.169.254', 'G123', jest.fn() as any);
    expect(result).toBe(0);
  });

  it('returns 0 on fetch error', async () => {
    const fetchFn = jest.fn().mockRejectedValue(new Error('Network error'));
    const result = await fetchClaimableBalanceCount('https://horizon.stellar.org', 'G123', fetchFn as any);
    expect(result).toBe(0);
  });

  it('returns 0 on non-ok response', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: false });
    const result = await fetchClaimableBalanceCount('https://horizon.stellar.org', 'G123', fetchFn as any);
    expect(result).toBe(0);
  });

  it('returns count when _embedded.records is populated', async () => {
    const fetchFn = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ _embedded: { records: [1, 2, 3] } }),
    });
    const result = await fetchClaimableBalanceCount('https://horizon.stellar.org', 'G123', fetchFn as any);
    expect(result).toBe(3);
  });

  it('returns count when records is populated directly', async () => {
    const fetchFn = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ records: [1] }),
    });
    const result = await fetchClaimableBalanceCount('https://horizon.stellar.org', 'G123', fetchFn as any);
    expect(result).toBe(1);
  });

  it('returns 0 when records is empty', async () => {
    const fetchFn = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ records: [] }),
    });
    const result = await fetchClaimableBalanceCount('https://horizon.stellar.org', 'G123', fetchFn as any);
    expect(result).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Issue #434 — circuit-open propagation
// ---------------------------------------------------------------------------

describe('circuit-open propagation (Issue #434)', () => {
  it('throws HorizonCircuitOpenError when the breaker blocks the request', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, recoveryTimeoutMs: 60_000 });
    // Trip the breaker with one failure. The tripping call rethrows the
    // original error; the *next* call is the fast-fail.
    await expect(
      breaker.execute(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // The next call is fast-failed without touching the network.
    const fetchFn = jest.fn();
    await expect(
      fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
        fetchFn: fetchFn as unknown as FetchLike,
        cacheTtlMs: 0,
        circuitBreaker: breaker,
      }),
    ).rejects.toThrow(HorizonCircuitOpenError);

    expect(fetchFn).not.toHaveBeenCalled();
  });


  it('keeps HorizonCircuitOpenError a HorizonError so existing handlers still work', () => {
    const err = new HorizonCircuitOpenError('blocked');
    expect(err).toBeInstanceOf(HorizonError);
    expect(err.statusCode).toBe(0);
    expect(err.retryable).toBe(false);
  });

  it('detects circuit-open errors across both representations', () => {
    expect(isCircuitOpenError(new HorizonCircuitOpenError('x'))).toBe(true);
    expect(isCircuitOpenError(new CircuitOpenError('x'))).toBe(true);
    expect(isCircuitOpenError(new HorizonError('x', 500))).toBe(false);
    expect(isCircuitOpenError(new Error('x'))).toBe(false);
    expect(isCircuitOpenError(undefined)).toBe(false);
  });
});
