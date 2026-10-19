/**
 * Tests for src/resilience.ts
 *
 * Wave #26: GitHub Check Run annotations + CircuitBreaker
 * Wave #36: Horizon HTTP mock matrix (HttpMockMatrix)
 */

import * as core from '@actions/core';
import {
  runCliCheck,
  FetchFn,
  calculateBackoffDelay,
  addJitter,
  sleep,
  RateLimiter,
  retryWithBackoff,
  DEFAULT_RETRY_POLICY,
  RetryPolicy,
  CircuitBreaker,
  CircuitOpenError,
  CircuitState,
  emitCheckRunAnnotation,
  annotateRetry,
  annotateRateLimit,
  annotateFallback,
  annotateCircuitOpen,
  HttpMockMatrix,
  HorizonScenario,
} from '../src/resilience';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture core.warning / core.notice / core.error calls for assertion. */
function captureCoreCalls(): {
  notices: string[];
  warnings: string[];
  errors: string[];
  restore: () => void;
} {
  const notices: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const spyNotice = jest.spyOn(core, 'notice').mockImplementation((msg) => {
    notices.push(typeof msg === 'string' ? msg : String(msg));
  });
  const spyWarn = jest.spyOn(core, 'warning').mockImplementation((msg) => {
    warnings.push(typeof msg === 'string' ? msg : String(msg));
  });
  const spyError = jest.spyOn(core, 'error').mockImplementation((msg) => {
    errors.push(typeof msg === 'string' ? msg : String(msg));
  });
  return {
    notices,
    warnings,
    errors,
    restore: () => {
      spyNotice.mockRestore();
      spyWarn.mockRestore();
      spyError.mockRestore();
    },
  };
}

// ---------------------------------------------------------------------------
// calculateBackoffDelay
// ---------------------------------------------------------------------------

describe('calculateBackoffDelay', () => {
  it('applies exponential backoff from initial delay', () => {
    const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, initialDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 30000 };
    expect(calculateBackoffDelay(0, policy)).toBe(1000);
    expect(calculateBackoffDelay(1, policy)).toBe(2000);
    expect(calculateBackoffDelay(2, policy)).toBe(4000);
  });

  it('caps delay at maxDelayMs', () => {
    const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, initialDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 3000 };
    expect(calculateBackoffDelay(5, policy)).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// addJitter
// ---------------------------------------------------------------------------

describe('addJitter', () => {
  let mathRandomSpy: jest.SpyInstance;

  beforeEach(() => {
    mathRandomSpy = jest.spyOn(Math, 'random');
  });

  afterEach(() => {
    mathRandomSpy.mockRestore();
  });

  it('returns a non-negative number close to the input', () => {
    mathRandomSpy.mockRestore(); // use real random
    for (let i = 0; i < 20; i++) {
      const result = addJitter(1000);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(1200);
    }
  });

  it('returns 0 when input is 0', () => {
    expect(addJitter(0)).toBe(0);
  });

  it('respects jitter percent bounds (min)', () => {
    mathRandomSpy.mockReturnValue(0); // lowest possible random -> -jitter
    expect(addJitter(1000, 10)).toBe(900);
  });

  it('respects jitter percent bounds (max)', () => {
    mathRandomSpy.mockReturnValue(0.99999999); // highest possible random -> +jitter
    const maxVal = addJitter(1000, 10);
    expect(maxVal).toBeLessThanOrEqual(1100);
    expect(maxVal).toBeGreaterThan(1099);
  });

  it('respects maxDelayMs cap', () => {
    mathRandomSpy.mockReturnValue(1); // max positive jitter
    // 1000 + 10% = 1100, capped at 1050
    expect(addJitter(1000, 10, 1050)).toBe(1050);
  });

  it('does not exceed maxDelayMs even if jitter is large', () => {
    mathRandomSpy.mockReturnValue(1);
    expect(addJitter(30000, 10, 30000)).toBe(30000);
  });

  it('prevents negative delays', () => {
    mathRandomSpy.mockReturnValue(0); // -jitter
    expect(addJitter(10, 200)).toBe(0); // 10 - 20 = -10 -> 0
  });
});

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------

describe('sleep', () => {
  it('resolves after approximately the given delay', async () => {
    const start = Date.now();
    await sleep(10);
    expect(Date.now() - start).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------

describe('RateLimiter', () => {
  it('allows requests up to capacity', () => {
    const limiter = new RateLimiter(3, 1);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false);
  });

  it('getAvailableTokens reflects consumed tokens', () => {
    const limiter = new RateLimiter(5, 10);
    limiter.tryConsume(2);
    expect(limiter.getAvailableTokens()).toBe(3);
  });

  it('waitTimeMs returns 0 when tokens are available', () => {
    const limiter = new RateLimiter(5, 1);
    expect(limiter.waitTimeMs(1)).toBe(0);
  });

  it('waitTimeMs returns positive value when exhausted', () => {
    const limiter = new RateLimiter(1, 1);
    limiter.tryConsume(1);
    expect(limiter.waitTimeMs(1)).toBeGreaterThan(0);
  });

  it('reset restores full capacity', () => {
    const limiter = new RateLimiter(3, 1);
    limiter.tryConsume(3);
    expect(limiter.getAvailableTokens()).toBe(0);
    limiter.reset();
    expect(limiter.getAvailableTokens()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// retryWithBackoff
// ---------------------------------------------------------------------------

describe('retryWithBackoff', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns the result on first success', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const promise = retryWithBackoff(fn, { ...DEFAULT_RETRY_POLICY, maxRetries: 3 });
    jest.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and eventually succeeds', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValue('success');

    const promise = retryWithBackoff(fn, { ...DEFAULT_RETRY_POLICY, maxRetries: 3, initialDelayMs: 1 });
    jest.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting retries', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('persistent failure'));
    const promise = retryWithBackoff(fn, { ...DEFAULT_RETRY_POLICY, maxRetries: 2, initialDelayMs: 1 });
    jest.runAllTimersAsync();
    await expect(promise).rejects.toThrow('persistent failure');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('respects shouldRetry to stop early', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('non-retryable'));
    const shouldRetry = jest.fn().mockReturnValue(false);
    const promise = retryWithBackoff(fn, { ...DEFAULT_RETRY_POLICY, maxRetries: 3 }, shouldRetry);
    jest.runAllTimersAsync();
    await expect(promise).rejects.toThrow('non-retryable');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledTimes(1);
  });

  it('identifies max-total-wait exhaustion separately from a rate-limit error', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('transient failure'));
    const promise = retryWithBackoff(fn, {
      ...DEFAULT_RETRY_POLICY,
      maxRetries: 2,
      initialDelayMs: 10,
      maxDelayMs: 10,
      maxTotalWaitMs: 5,
    });

    await expect(promise).rejects.toThrow(/Retry wait budget exhausted/);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// CircuitBreaker — Wave #26
// ---------------------------------------------------------------------------

describe('CircuitBreaker', () => {
  describe('initial state', () => {
    it('starts in closed state', () => {
      const cb = new CircuitBreaker({ failureThreshold: 3 });
      expect(cb.getState()).toBe('closed');
    });
  });

  describe('closed → open transition', () => {
    it('opens after reaching the failure threshold', async () => {
      const transitions: Array<{ from: CircuitState; to: CircuitState }> = [];
      const cb = new CircuitBreaker({
        failureThreshold: 3,
        onStateChange: (from, to) => transitions.push({ from, to }),
      });

      for (let i = 0; i < 3; i++) {
        await expect(cb.execute(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
      }

      expect(cb.getState()).toBe('open');
      expect(transitions).toContainEqual({ from: 'closed', to: 'open' });
    });

    it('does not open before reaching the threshold', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 5 });
      for (let i = 0; i < 4; i++) {
        await expect(cb.execute(() => Promise.reject(new Error('err')))).rejects.toThrow();
      }
      expect(cb.getState()).toBe('closed');
    });
  });

  describe('open state — fast-fail', () => {
    it('throws CircuitOpenError immediately without calling fn', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, recoveryTimeoutMs: 60_000 });
      await expect(cb.execute(() => Promise.reject(new Error('trip')))).rejects.toThrow();
      expect(cb.getState()).toBe('open');

      const fn = jest.fn().mockResolvedValue('ok');
      await expect(cb.execute(fn)).rejects.toBeInstanceOf(CircuitOpenError);
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('open → half-open transition', () => {
    it('transitions to half-open after recovery timeout', async () => {
      jest.useFakeTimers();
      const transitions: Array<{ from: CircuitState; to: CircuitState }> = [];
      const cb = new CircuitBreaker({
        failureThreshold: 1,
        recoveryTimeoutMs: 1000,
        onStateChange: (from, to) => transitions.push({ from, to }),
      });

      await expect(cb.execute(() => Promise.reject(new Error('err')))).rejects.toThrow();
      expect(cb.getState()).toBe('open');

      jest.advanceTimersByTime(1001);
      expect(cb.getState()).toBe('half-open');
      expect(transitions.some(t => t.from === 'open' && t.to === 'half-open')).toBe(true);

      jest.useRealTimers();
    });
  });

  describe('half-open → closed transition', () => {
    it('closes after enough successes in half-open', async () => {
      jest.useFakeTimers();
      const transitions: Array<{ from: CircuitState; to: CircuitState }> = [];
      const cb = new CircuitBreaker({
        failureThreshold: 1,
        recoveryTimeoutMs: 1000,
        successThreshold: 2,
        onStateChange: (from, to) => transitions.push({ from, to }),
      });

      await expect(cb.execute(() => Promise.reject(new Error('err')))).rejects.toThrow();
      jest.advanceTimersByTime(1001);
      expect(cb.getState()).toBe('half-open');

      await cb.execute(() => Promise.resolve('ok1'));
      expect(cb.getState()).toBe('half-open');
      await cb.execute(() => Promise.resolve('ok2'));
      expect(cb.getState()).toBe('closed');
      expect(transitions.some(t => t.from === 'half-open' && t.to === 'closed')).toBe(true);

      jest.useRealTimers();
    });

    it('re-opens on failure in half-open', async () => {
      jest.useFakeTimers();
      const transitions: Array<{ from: CircuitState; to: CircuitState }> = [];
      const cb = new CircuitBreaker({
        failureThreshold: 1,
        recoveryTimeoutMs: 500,
        onStateChange: (from, to) => transitions.push({ from, to }),
      });

      await expect(cb.execute(() => Promise.reject(new Error('err')))).rejects.toThrow();
      jest.advanceTimersByTime(501);
      expect(cb.getState()).toBe('half-open');
      await expect(cb.execute(() => Promise.reject(new Error('probe fail')))).rejects.toThrow();
      expect(cb.getState()).toBe('open');
      expect(transitions.some(t => t.from === 'half-open' && t.to === 'open')).toBe(true);

      jest.useRealTimers();
    });
  });

  describe('reset', () => {
    it('returns the breaker to closed state', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1 });
      await expect(cb.execute(() => Promise.reject(new Error('err')))).rejects.toThrow();
      expect(cb.getState()).toBe('open');
      cb.reset();
      expect(cb.getState()).toBe('closed');
    });

    it('does not fire onStateChange when already closed', () => {
      const onChange = jest.fn();
      const cb = new CircuitBreaker({ onStateChange: onChange });
      cb.reset();
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('getStats', () => {
    it('reflects consecutive failure count', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 10 });
      await expect(cb.execute(() => Promise.reject(new Error('e')))).rejects.toThrow();
      await expect(cb.execute(() => Promise.reject(new Error('e')))).rejects.toThrow();
      const stats = cb.getStats();
      expect(stats.consecutiveFailures).toBe(2);
      expect(stats.state).toBe('closed');
    });

    it('records openedAt when circuit opens', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1 });
      await expect(cb.execute(() => Promise.reject(new Error('e')))).rejects.toThrow();
      expect(cb.getStats().openedAt).not.toBeNull();
    });
  });

  describe('default onStateChange emits Check Run annotations', () => {
    it('emits core.warning when circuit opens', async () => {
      const { warnings, restore } = captureCoreCalls();
      const cb = new CircuitBreaker({ failureThreshold: 1 });
      await expect(cb.execute(() => Promise.reject(new Error('boom')))).rejects.toThrow();
      expect(warnings.some(w => w.includes('CircuitBreaker') && w.includes('open'))).toBe(true);
      restore();
    });

    it('emits core.notice when circuit closes', async () => {
      jest.useFakeTimers();
      const { notices, restore } = captureCoreCalls();
      const cb = new CircuitBreaker({ failureThreshold: 1, recoveryTimeoutMs: 100, successThreshold: 1 });
      await expect(cb.execute(() => Promise.reject(new Error('e')))).rejects.toThrow();
      jest.advanceTimersByTime(101);
      await cb.execute(() => Promise.resolve('ok'));
      expect(notices.some(n => n.includes('CircuitBreaker') && n.includes('closed'))).toBe(true);
      restore();
      jest.useRealTimers();
    });
  });
});

// ---------------------------------------------------------------------------
// Check Run annotation helpers — Wave #26
// ---------------------------------------------------------------------------

describe('emitCheckRunAnnotation', () => {
  it('calls core.notice for level=notice', () => {
    const { notices, restore } = captureCoreCalls();
    emitCheckRunAnnotation({ level: 'notice', title: 'T', message: 'M' });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('[TrustBridge Resilience]');
    expect(notices[0]).toContain('T');
    restore();
  });

  it('calls core.warning for level=warning', () => {
    const { warnings, restore } = captureCoreCalls();
    emitCheckRunAnnotation({ level: 'warning', title: 'W', message: 'degraded' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('[TrustBridge Resilience]');
    restore();
  });

  it('calls core.error for level=error', () => {
    const { errors, restore } = captureCoreCalls();
    emitCheckRunAnnotation({ level: 'error', title: 'E', message: 'irrecoverable' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('[TrustBridge Resilience]');
    restore();
  });
});

describe('annotation convenience wrappers', () => {
  it('annotateRetry emits a notice with attempt number and delay', () => {
    const { notices, restore } = captureCoreCalls();
    annotateRetry(1, 2000, 'rate limited');
    expect(notices[0]).toContain('attempt 2');
    expect(notices[0]).toContain('2000ms');
    restore();
  });

  it('annotateRateLimit emits a warning with wait duration', () => {
    const { warnings, restore } = captureCoreCalls();
    annotateRateLimit(5000);
    expect(warnings[0]).toContain('5000ms');
    expect(warnings[0]).toContain('429');
    restore();
  });

  it('annotateFallback emits a warning with fallback URL and reason', () => {
    const { warnings, restore } = captureCoreCalls();
    annotateFallback('https://horizon-alt.stellar.org', '503 from primary');
    expect(warnings[0]).toContain('horizon-alt.stellar.org');
    expect(warnings[0]).toContain('503 from primary');
    restore();
  });

  it('annotateCircuitOpen emits an error with failure count', () => {
    const { errors, restore } = captureCoreCalls();
    annotateCircuitOpen(5);
    expect(errors[0]).toContain('5');
    restore();
  });
});

// ---------------------------------------------------------------------------
// HttpMockMatrix — Wave #36
// ---------------------------------------------------------------------------

describe('HttpMockMatrix', () => {
  const TEST_URL = 'https://horizon.stellar.org/accounts/GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

  describe('success scenario', () => {
    it('returns status 200 with a valid account payload', async () => {
      const fetchFn = HttpMockMatrix.build('success');
      const response = await fetchFn(TEST_URL);
      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body).toHaveProperty('account_id');
      expect(body).toHaveProperty('balances');
    });

    it('returns a custom account payload when provided', async () => {
      const custom = { id: 'GCUSTOM', account_id: 'GCUSTOM', balances: [], sequence: '0', subentry_count: 0, num_sponsoring: 0, num_sponsored: 0 };
      const fetchFn = HttpMockMatrix.build('success', { accountPayload: custom });
      const body = await (await fetchFn(TEST_URL)).json() as Record<string, unknown>;
      expect(body.id).toBe('GCUSTOM');
    });
  });

  describe('not_found scenario', () => {
    it('returns status 404', async () => {
      const fetchFn = HttpMockMatrix.build('not_found');
      const response = await fetchFn(TEST_URL);
      expect(response.status).toBe(404);
      expect(response.ok).toBe(false);
    });
  });

  describe('rate_limit scenario', () => {
    it('returns status 429 with a Retry-After header', async () => {
      const fetchFn = HttpMockMatrix.build('rate_limit', { retryAfterSeconds: '5' });
      const response = await fetchFn(TEST_URL);
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('5');
    });

    it('defaults Retry-After to 0 for instant test retries', async () => {
      const fetchFn = HttpMockMatrix.build('rate_limit');
      const response = await fetchFn(TEST_URL);
      expect(response.headers.get('retry-after')).toBe('0');
    });
  });

  describe('server_error scenario', () => {
    it('returns status 503', async () => {
      const response = await HttpMockMatrix.build('server_error')(TEST_URL);
      expect(response.status).toBe(503);
    });
  });

  describe('bad_gateway scenario', () => {
    it('returns status 502', async () => {
      const response = await HttpMockMatrix.build('bad_gateway')(TEST_URL);
      expect(response.status).toBe(502);
    });
  });

  describe('gateway_timeout scenario', () => {
    it('returns status 504', async () => {
      const response = await HttpMockMatrix.build('gateway_timeout')(TEST_URL);
      expect(response.status).toBe(504);
    });
  });

  describe('timeout scenario', () => {
    it('rejects with AbortError when AbortSignal fires', async () => {
      const controller = new AbortController();
      const fetchFn = HttpMockMatrix.build('timeout');
      const promise = fetchFn(TEST_URL, { signal: controller.signal });
      controller.abort();
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('rejects immediately if signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const fetchFn = HttpMockMatrix.build('timeout');
      await expect(fetchFn(TEST_URL, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    });
  });

  describe('network_error scenario', () => {
    it('rejects with a network error', async () => {
      const fetchFn = HttpMockMatrix.build('network_error');
      await expect(fetchFn(TEST_URL)).rejects.toThrow('fetch failed');
    });
  });

  describe('always_fail scenario', () => {
    it('always returns 503', async () => {
      const fetchFn = HttpMockMatrix.build('always_fail');
      for (let i = 0; i < 3; i++) {
        const response = await fetchFn(TEST_URL);
        expect(response.status).toBe(503);
      }
    });
  });

  describe('flaky_then_success scenario', () => {
    it('fails flakyFailCount times then succeeds', async () => {
      const fetchFn = HttpMockMatrix.build('flaky_then_success', { flakyFailCount: 2, flakyErrorScenario: 'rate_limit' });
      const r1 = await fetchFn(TEST_URL);
      expect(r1.status).toBe(429);
      const r2 = await fetchFn(TEST_URL);
      expect(r2.status).toBe(429);
      const r3 = await fetchFn(TEST_URL);
      expect(r3.status).toBe(200);
    });

    it('uses server_error as flaky error when configured', async () => {
      const fetchFn = HttpMockMatrix.build('flaky_then_success', { flakyFailCount: 1, flakyErrorScenario: 'server_error' });
      const r1 = await fetchFn(TEST_URL);
      expect(r1.status).toBe(503);
      const r2 = await fetchFn(TEST_URL);
      expect(r2.status).toBe(200);
    });
  });

  describe('buildFallbackMatrix', () => {
    it('routes to primary scenario for primary URL', async () => {
      const fetchFn = HttpMockMatrix.buildFallbackMatrix('server_error', 'success', 'https://horizon.stellar.org');
      const primary = await fetchFn('https://horizon.stellar.org/accounts/X');
      expect(primary.status).toBe(503);
    });

    it('routes to fallback scenario for non-primary URL', async () => {
      const fetchFn = HttpMockMatrix.buildFallbackMatrix('server_error', 'success', 'https://horizon.stellar.org');
      const fallback = await fetchFn('https://horizon-alt.stellar.org/accounts/X');
      expect(fallback.status).toBe(200);
    });
  });

  describe('json body shape', () => {
    it.each<HorizonScenario>(['not_found', 'rate_limit', 'server_error', 'bad_gateway', 'gateway_timeout'])(
      '%s scenario returns parseable JSON error body',
      async (scenario) => {
        const fetchFn = HttpMockMatrix.build(scenario);
        const response = await fetchFn(TEST_URL);
        const body = await response.json() as Record<string, unknown>;
        expect(body).toHaveProperty('status');
        expect(body).toHaveProperty('title');
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Integration: HttpMockMatrix driving fetchAccount (Wave #36)
// ---------------------------------------------------------------------------

import { fetchAccount, FetchAccountOptions } from '../src/horizon';

const PRIMARY = 'https://horizon.stellar.org';
const FALLBACK = 'https://horizon-alt.stellar.org';
const TEST_ADDR = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const baseOptions = {
  address: TEST_ADDR,
  horizonUrl: PRIMARY,
  timeoutMs: 5000,
};

describe('HttpMockMatrix integration with fetchAccount', () => {
  it('success scenario returns a valid HorizonAccount', async () => {
    const fetchFn = HttpMockMatrix.build('success') as FetchAccountOptions['fetchFn'];
    const account = await fetchAccount(PRIMARY, TEST_ADDR, { fetchFn, cacheTtlMs: 0, maxRetries: 0 });
    expect(account.account_id).toBeDefined();
    expect(Array.isArray(account.balances)).toBe(true);
  });

  it('not_found scenario causes fetchAccount to throw HorizonError 404', async () => {
    const fetchFn = HttpMockMatrix.build('not_found') as FetchAccountOptions['fetchFn'];
    await expect(fetchAccount(PRIMARY, TEST_ADDR, { fetchFn, cacheTtlMs: 0, maxRetries: 0 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('always_fail scenario exhausts retries and throws', async () => {
    const fetchFn = HttpMockMatrix.build('always_fail') as FetchAccountOptions['fetchFn'];
    await expect(fetchAccount(PRIMARY, TEST_ADDR, { fetchFn, cacheTtlMs: 0, maxRetries: 2 }))
      .rejects.toMatchObject({ statusCode: 503 });
  });

  it('flaky_then_success succeeds after retries', async () => {
    const fetchFn = HttpMockMatrix.build('flaky_then_success', {
      flakyFailCount: 2,
      flakyErrorScenario: 'rate_limit',
    }) as FetchAccountOptions['fetchFn'];
    const account = await fetchAccount(PRIMARY, TEST_ADDR, { fetchFn, cacheTtlMs: 0, maxRetries: 3 });
    expect(account.account_id).toBeDefined();
  });

  it('buildFallbackMatrix: primary outage falls back to success', async () => {
    const fetchFn = HttpMockMatrix.buildFallbackMatrix(
      'server_error',
      'success',
      PRIMARY,
    ) as FetchAccountOptions['fetchFn'];
    const account = await fetchAccount(PRIMARY, TEST_ADDR, {
      fetchFn,
      cacheTtlMs: 0,
      maxRetries: 0,
      horizonUrlFallback: FALLBACK,
    });
    expect(account.account_id).toBeDefined();
  });

  it('network_error scenario causes fetchAccount to throw', async () => {
    const fetchFn = HttpMockMatrix.build('network_error') as FetchAccountOptions['fetchFn'];
    await expect(fetchAccount(PRIMARY, TEST_ADDR, { fetchFn, cacheTtlMs: 0, maxRetries: 0 }))
      .rejects.toThrow();
  });

  it('fails over to secondary Horizon endpoint when primary returns 503', async () => {
    const fetch: FetchFn = async (url) => {
      if (url.includes('horizon.stellar.org')) {
        return { status: 503 };
      }
      return { status: 200 };
    };

    const result = await runCliCheck(
      {
        ...baseOptions,
        horizonUrl: 'https://horizon.stellar.org',
        secondaryHorizonUrl: 'https://horizon-secondary.stellar.org',
        retryPolicy: { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 10, backoffMultiplier: 1, timeoutMs: 5000 },
      },
      fetch,
    );

    expect(result.reachable).toBe(true);
    expect(result.failedOver).toBe(true);
    expect(result.horizonUrlUsed).toBe('https://horizon-secondary.stellar.org');
    expect(result.message).toContain('secondary Horizon');
  });

  it('bypasses failover when primary returns 404', async () => {
    let secondaryCalled = false;
    const fetch: FetchFn = async (url) => {
      if (url.includes('secondary')) {
        secondaryCalled = true;
        return { status: 200 };
      }
      return { status: 404 };
    };

    const result = await runCliCheck(
      {
        ...baseOptions,
        horizonUrl: 'https://horizon.stellar.org',
        secondaryHorizonUrl: 'https://horizon-secondary.stellar.org',
        retryPolicy: { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 10, backoffMultiplier: 1, timeoutMs: 5000 },
      },
      fetch,
    );

    expect(result.reachable).toBe(false);
    expect(result.statusCode).toBe(404);
    expect(secondaryCalled).toBe(false);
  });
});
