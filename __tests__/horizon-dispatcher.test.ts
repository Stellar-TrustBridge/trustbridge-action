/**
 * @file horizon-dispatcher.test.ts
 *
 * Tests for the HTTP fetch stack used by TrustBridge Horizon requests.
 *
 * Node 20 ships with a built-in `fetch` backed by `undici`. TrustBridge
 * injects a `fetchFn` option so tests can provide deterministic mock
 * implementations without touching real sockets. These tests verify:
 *
 * 1. Timeout (AbortController) fires for hung sockets and produces a
 *    retryable HorizonError with status 408.
 * 2. A slow-responding mock (delayed > timeoutMs) triggers the same path.
 * 3. Repeated timeouts exhaust the retry budget and surface the error.
 * 4. A parent AbortSignal (job cancellation) aborts immediately, non-retryably.
 * 5. HTTP/2-style ECONNRESET is treated as a retryable transport error.
 */

import { fetchAccount, HorizonError, FetchLike } from '../src/horizon';
import type { Response } from 'node-fetch';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const PRIMARY_HORIZON = 'https://horizon.stellar.org';
/** Valid 56-character G-address */
const TEST_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/**
 * Build a minimal options object shared across all dispatcher tests.
 * maxRetries is left to each test to override where relevant.
 */
const baseOptions = {
  cacheTtlMs: 0,           // disable in-memory cache so every call hits the mock
  retryBaseDelayMs: 0,     // no backoff delays in unit tests
  retryMaxDelayMs: 0,
  retryMaxTotalWaitMs: 1_000_000, // generous total cap so backoff maths don't interfere
};

// ---------------------------------------------------------------------------
// Helper — make a minimal successful Horizon account response body
// ---------------------------------------------------------------------------

function makeAccountBody(address: string = TEST_ADDRESS) {
  return {
    id: address,
    account_id: address,
    sequence: '1',
    subentry_count: 0,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [
      { balance: '10.0000000', asset_type: 'native', buying_liabilities: '0', selling_liabilities: '0' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Helper — build a mock fetch that returns a JSON response immediately
// ---------------------------------------------------------------------------

function makeJsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Suite 1: Timeout — hung socket (never resolves)
// ---------------------------------------------------------------------------

describe('Horizon dispatcher: timeout — hung socket', () => {
  it('throws a retryable HorizonError (status 408) when fetch never resolves', async () => {
    /**
     * Mock a fetch that never settles — simulates a hung TCP connection.
     * The per-request AbortController inside fetchAccountOnce should fire
     * after `timeoutMs` and abort the in-flight request.
     */
    const hungFetch: FetchLike = jest.fn((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        // When the AbortController fires, forward it as an AbortError.
        const signal = (init as RequestInit | undefined)?.signal as AbortSignal | undefined;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = Object.assign(new Error('The operation was aborted'), {
              name: 'AbortError',
            });
            reject(err);
          });
        }
        // Otherwise this promise never settles — intentionally.
      });
    });

    await expect(
      fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
        ...baseOptions,
        maxRetries: 0,
        timeoutMs: 50,   // very short timeout
        fetchFn: hungFetch,
      }),
    ).rejects.toMatchObject({
      statusCode: 408,
      retryable: true,
    } satisfies Partial<HorizonError>);

    expect(hungFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Timeout — delayed response that exceeds timeoutMs
// ---------------------------------------------------------------------------

describe('Horizon dispatcher: timeout — delayed response', () => {
  it('rejects with a "timed out" HorizonError when response arrives after timeoutMs', async () => {
    /**
     * Mock a fetch that resolves after 2× the configured timeoutMs.
     * In practice the AbortController fires first and the delayed resolve
     * is irrelevant — the error path is exercised regardless.
     */
    const timeoutMs = 50;

    const delayedFetch: FetchLike = jest.fn((_url, init) => {
      return new Promise<Response>((resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal as AbortSignal | undefined;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = Object.assign(new Error('The operation was aborted'), {
              name: 'AbortError',
            });
            reject(err);
          });
        }
        // Resolve after 2× the timeout — the abort will fire first.
        setTimeout(() => resolve(makeJsonResponse(200, makeAccountBody())), timeoutMs * 2);
      });
    });

    const error = await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
      ...baseOptions,
      maxRetries: 0,
      timeoutMs,
      fetchFn: delayedFetch,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HorizonError);
    const horizonError = error as HorizonError;
    expect(horizonError.message).toMatch(/timed out/i);
    expect(horizonError.statusCode).toBe(408);
    expect(horizonError.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Timeout retried and ultimately fails
// ---------------------------------------------------------------------------

describe('Horizon dispatcher: timeout retried and exhausted', () => {
  it('retries on each timeout and throws after maxRetries are exhausted', async () => {
    /**
     * Mock fetch that always times out. With maxRetries: 2 the action
     * should make 3 attempts total (1 initial + 2 retries) and then throw.
     */
    let callCount = 0;

    const alwaysTimeoutFetch: FetchLike = jest.fn((_url, init) => {
      callCount += 1;
      return new Promise<Response>((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal as AbortSignal | undefined;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = Object.assign(new Error('The operation was aborted'), {
              name: 'AbortError',
            });
            reject(err);
          });
        }
      });
    });

    await expect(
      fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
        ...baseOptions,
        maxRetries: 2,
        timeoutMs: 30,
        fetchFn: alwaysTimeoutFetch,
      }),
    ).rejects.toMatchObject({
      statusCode: 408,
      retryable: true,
    } satisfies Partial<HorizonError>);

    // 1 initial attempt + 2 retries = 3 total calls
    expect(callCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Parent AbortSignal — job cancellation
// ---------------------------------------------------------------------------

describe('Horizon dispatcher: parent AbortSignal (job cancellation)', () => {
  it('throws a non-retryable HorizonError with "job cancelled" when parent signal is already aborted', async () => {
    /**
     * Abort the parent controller *before* calling fetchAccount so the
     * pre-flight check inside fetchAccount detects it immediately without
     * issuing any network call.
     */
    const parentController = new AbortController();
    parentController.abort();

    const fetchFn: FetchLike = jest.fn();

    await expect(
      fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
        ...baseOptions,
        maxRetries: 0,
        timeoutMs: 5000,
        signal: parentController.signal,
        fetchFn,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('job cancelled'),
      statusCode: 0,
      retryable: false,
    });

    // Pre-flight abort detected before any HTTP call is dispatched.
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('aborts an in-flight request when parent signal fires mid-request', async () => {
    /**
     * Start an in-flight hung request, then abort the parent controller
     * shortly after. The per-request controller is chained to the parent
     * so the abort propagates.
     */
    const parentController = new AbortController();

    const hungFetch: FetchLike = jest.fn((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal as AbortSignal | undefined;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = Object.assign(new Error('The operation was aborted'), {
              name: 'AbortError',
            });
            reject(err);
          });
        }
      });
    });

    // Abort the parent after a short delay so the fetch is already in-flight.
    const abortTimer = setTimeout(() => parentController.abort(), 20);

    try {
      await expect(
        fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          ...baseOptions,
          maxRetries: 0,
          timeoutMs: 5000,   // long timeout — parent abort should fire first
          signal: parentController.signal,
          fetchFn: hungFetch,
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('job cancelled'),
        statusCode: 0,
        retryable: false,
      });
    } finally {
      clearTimeout(abortTimer);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 5: ECONNRESET — HTTP/2 keep-alive connection reset
// ---------------------------------------------------------------------------

describe('Horizon dispatcher: ECONNRESET (HTTP/2 keep-alive reset)', () => {
  it('treats ECONNRESET as a retryable transport error and retries', async () => {
    /**
     * Mock a fetch that throws ECONNRESET on the first call (simulating a
     * dropped keep-alive or HTTP/2 RST_STREAM), then succeeds on the second.
     * The action should classify ECONNRESET as retryable (status 0) and
     * transparently retry.
     */
    const account = makeAccountBody();
    let callCount = 0;

    const econnresetFetch: FetchLike = jest.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
        throw err;
      }
      return makeJsonResponse(200, account);
    });

    const result = await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
      ...baseOptions,
      maxRetries: 1,
      timeoutMs: 5000,
      fetchFn: econnresetFetch,
    });

    expect(result.account_id).toBe(TEST_ADDRESS);
    expect(callCount).toBe(2);
  });

  it('throws after all retries are exhausted on persistent ECONNRESET', async () => {
    /**
     * Mock fetch that always throws ECONNRESET. With maxRetries: 2 the
     * action makes 3 attempts and then surfaces the error.
     */
    let callCount = 0;

    const alwaysEconnresetFetch: FetchLike = jest.fn(async () => {
      callCount += 1;
      const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      throw err;
    });

    await expect(
      fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
        ...baseOptions,
        maxRetries: 2,
        timeoutMs: 5000,
        fetchFn: alwaysEconnresetFetch,
      }),
    ).rejects.toMatchObject({
      statusCode: 0,
      retryable: true,
    } satisfies Partial<HorizonError>);

    // 1 initial + 2 retries = 3 total calls
    expect(callCount).toBe(3);
  });
});
