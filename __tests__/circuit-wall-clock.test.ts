/**
 * Issue #920 — CircuitBreaker open-state expiry is driven by wall-clock time,
 * not by the number of fast-failed attempts, and a Horizon Retry-After
 * extends the cooldown so half-open probes respect it.
 *
 * Every test injects a fake clock through `CircuitBreakerOptions.now`, so no
 * real time passes and nothing depends on Jest timer mocking.
 */
import {
  CircuitBreaker,
  CircuitOpenError,
  CircuitState,
  DEFAULT_MAX_RETRY_AFTER_MS,
} from '../src/resilience';
import {
  fetchAccount,
  FetchAccountOptions,
  HorizonCircuitOpenError,
  isCircuitOpenError,
} from '../src/horizon';

const PRIMARY = 'https://horizon.stellar.org';
const TEST_ADDR = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** Mutable fake clock; `advance` moves it forward (or back with a negative). */
function fakeClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void; set: (t: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (next: number) => {
      t = next;
    },
  };
}

function breaker(
  clock: { now: () => number },
  extra: Partial<ConstructorParameters<typeof CircuitBreaker>[0]> = {},
): { cb: CircuitBreaker; transitions: Array<{ from: CircuitState; to: CircuitState }> } {
  const transitions: Array<{ from: CircuitState; to: CircuitState }> = [];
  const cb = new CircuitBreaker({
    failureThreshold: 1,
    recoveryTimeoutMs: 10_000,
    successThreshold: 1,
    now: clock.now,
    onStateChange: (from, to) => transitions.push({ from, to }),
    onProbeBudgetExhausted: () => {},
    ...extra,
  });
  return { cb, transitions };
}

async function trip(cb: CircuitBreaker): Promise<void> {
  await expect(cb.execute(() => Promise.reject(new Error('horizon down')))).rejects.toThrow('horizon down');
}

describe('CircuitBreaker wall-clock open-state expiry (Issue #920)', () => {
  it('happy path: goes half-open exactly when the recovery timeout elapses on the injected clock', async () => {
    const clock = fakeClock();
    const { cb, transitions } = breaker(clock);
    await trip(cb);
    expect(cb.getState()).toBe('open');
    expect(cb.getRemainingCooldownMs()).toBe(10_000);

    clock.advance(9_999);
    expect(cb.getState()).toBe('open');
    expect(cb.getRemainingCooldownMs()).toBe(1);

    clock.advance(1);
    expect(cb.getState()).toBe('half-open');
    expect(cb.getRemainingCooldownMs()).toBe(0);

    await expect(cb.execute(() => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(cb.getState()).toBe('closed');
    expect(transitions).toEqual([
      { from: 'closed', to: 'open' },
      { from: 'open', to: 'half-open' },
      { from: 'half-open', to: 'closed' },
    ]);
  });

  it('does not expire the open state after many fast-failed attempts when no time has passed', async () => {
    const clock = fakeClock();
    const { cb } = breaker(clock);
    await trip(cb);

    const fn = jest.fn().mockResolvedValue('ok');
    for (let i = 0; i < 500; i++) {
      await expect(cb.execute(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    }
    expect(fn).not.toHaveBeenCalled();
    expect(cb.getState()).toBe('open');
  });

  it('CircuitOpenError carries the remaining cooldown', async () => {
    const clock = fakeClock();
    const { cb } = breaker(clock);
    await trip(cb);
    clock.advance(2_500);

    const err = await cb.execute(() => Promise.resolve('x')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CircuitOpenError);
    expect((err as CircuitOpenError).remainingCooldownMs).toBe(7_500);
    expect((err as CircuitOpenError).message).toContain('7500ms cooldown remaining');
  });

  it('a failed half-open probe restarts the full cooldown from the failure time', async () => {
    const clock = fakeClock();
    const { cb } = breaker(clock);
    await trip(cb);
    clock.advance(10_000);
    expect(cb.getState()).toBe('half-open');

    await trip(cb);
    expect(cb.getState()).toBe('open');
    expect(cb.getRemainingCooldownMs()).toBe(10_000);
    clock.advance(9_000);
    expect(cb.getState()).toBe('open');
    clock.advance(1_000);
    expect(cb.getState()).toBe('half-open');
  });

  it('restarts the cooldown instead of expiring early when the clock moves backwards', async () => {
    const clock = fakeClock();
    const { cb } = breaker(clock);
    await trip(cb);
    clock.advance(-60_000);
    expect(cb.getState()).toBe('open');
    expect(cb.getRemainingCooldownMs()).toBe(10_000);
    clock.advance(10_000);
    expect(cb.getState()).toBe('half-open');
  });

  it('getOpenMetrics uses the injected clock by default', async () => {
    const clock = fakeClock();
    const { cb } = breaker(clock);
    await trip(cb);
    clock.advance(4_000);
    expect(cb.getOpenMetrics().openDurationMs).toBe(4_000);
  });

  describe('option validation', () => {
    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects recoveryTimeoutMs=%p', (value) => {
      expect(() => new CircuitBreaker({ recoveryTimeoutMs: value })).toThrow(RangeError);
      expect(() => new CircuitBreaker({ recoveryTimeoutMs: value })).toThrow(
        /recoveryTimeoutMs must be a finite number of milliseconds >= 0/,
      );
    });

    it('rejects a negative maxRetryAfterMs', () => {
      expect(() => new CircuitBreaker({ maxRetryAfterMs: -5 })).toThrow(/maxRetryAfterMs/);
    });

    it('rejects a non-function clock', () => {
      expect(() => new CircuitBreaker({ now: 123 as unknown as () => number })).toThrow(TypeError);
    });

    it('accepts recoveryTimeoutMs=0 (immediately half-open)', async () => {
      const clock = fakeClock();
      const { cb } = breaker(clock, { recoveryTimeoutMs: 0 });
      await trip(cb);
      expect(cb.getState()).toBe('half-open');
    });
  });
});

describe('CircuitBreaker Retry-After interaction (Issue #920)', () => {
  it('keeps the circuit open past the recovery timeout until Retry-After passes', async () => {
    const clock = fakeClock();
    const { cb } = breaker(clock);
    await trip(cb);
    expect(cb.noteRetryAfter(25_000)).toBe(true);

    clock.advance(10_000);
    expect(cb.getState()).toBe('open');
    expect(cb.getRemainingCooldownMs()).toBe(15_000);

    clock.advance(15_000);
    expect(cb.getState()).toBe('half-open');
  });

  it('a Retry-After shorter than the recovery timeout does not shorten it', async () => {
    const clock = fakeClock();
    const { cb } = breaker(clock);
    await trip(cb);
    cb.noteRetryAfter(1_000);
    clock.advance(1_000);
    expect(cb.getState()).toBe('open');
    expect(cb.getRemainingCooldownMs()).toBe(9_000);
  });

  it('half-open probes are fast-failed while a later Retry-After is still pending', async () => {
    const clock = fakeClock();
    const { cb } = breaker(clock);
    await trip(cb);
    clock.advance(10_000);
    expect(cb.getState()).toBe('half-open');

    cb.noteRetryAfter(3_000);
    const probe = jest.fn().mockResolvedValue('ok');
    const err = await cb.execute(probe).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CircuitOpenError);
    expect((err as CircuitOpenError).remainingCooldownMs).toBe(3_000);
    expect(probe).not.toHaveBeenCalled();
    // A deferred probe does not consume the half-open probe budget.
    expect(cb.getStats().halfOpenProbeBudgetExhaustedCount).toBe(0);
    expect(cb.getStats().halfOpenProbesInFlight).toBe(0);

    clock.advance(3_000);
    await expect(cb.execute(probe)).resolves.toBe('ok');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(cb.getState()).toBe('closed');
  });

  it('clamps oversized Retry-After values to maxRetryAfterMs', async () => {
    const clock = fakeClock();
    const { cb } = breaker(clock, { maxRetryAfterMs: 20_000 });
    await trip(cb);
    cb.noteRetryAfter(86_400_000);
    expect(cb.getRemainingCooldownMs()).toBe(20_000);
    clock.advance(20_000);
    expect(cb.getState()).toBe('half-open');
  });

  it('defaults the Retry-After clamp to five minutes', async () => {
    expect(DEFAULT_MAX_RETRY_AFTER_MS).toBe(300_000);
    const clock = fakeClock();
    const { cb } = breaker(clock);
    await trip(cb);
    cb.noteRetryAfter(Number.MAX_SAFE_INTEGER);
    expect(cb.getRemainingCooldownMs()).toBe(300_000);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('ignores malformed Retry-After %p', async (value) => {
    const clock = fakeClock();
    const { cb } = breaker(clock);
    await trip(cb);
    expect(cb.noteRetryAfter(value)).toBe(false);
    expect(cb.getRemainingCooldownMs()).toBe(10_000);
  });

  it('never shortens an existing, longer Retry-After deadline', () => {
    const clock = fakeClock();
    const { cb } = breaker(clock);
    expect(cb.noteRetryAfter(30_000)).toBe(true);
    expect(cb.noteRetryAfter(5_000)).toBe(false);
    expect(cb.noteRetryAfter(40_000)).toBe(true);
  });

  it('does not block calls while closed, and reset() clears a pending deadline', async () => {
    const clock = fakeClock();
    const { cb } = breaker(clock);
    cb.noteRetryAfter(60_000);
    expect(cb.getRemainingCooldownMs()).toBe(0);
    await expect(cb.execute(() => Promise.resolve('ok'))).resolves.toBe('ok');

    await trip(cb);
    expect(cb.getRemainingCooldownMs()).toBe(60_000);
    cb.reset();
    await trip(cb);
    expect(cb.getRemainingCooldownMs()).toBe(10_000);
  });
});

describe('fetchAccount feeds Horizon Retry-After into the breaker (Issue #920)', () => {
  function response(status: number, headers: Record<string, string> = {}) {
    return {
      status,
      ok: status >= 200 && status < 300,
      statusText: status === 429 ? 'Too Many Requests' : 'Service Unavailable',
      headers: new Headers(headers),
      json: async () => ({}),
      text: async () => '{}',
    } as unknown as Awaited<ReturnType<NonNullable<FetchAccountOptions['fetchFn']>>>;
  }

  it('records Retry-After on a 429 and surfaces the cooldown on the next blocked call', async () => {
    const clock = fakeClock();
    const { cb } = breaker(clock, { failureThreshold: 1, recoveryTimeoutMs: 1_000 });
    const fetchFn = jest.fn(async () => response(429, { 'retry-after': '120' })) as unknown as FetchAccountOptions['fetchFn'];

    await expect(
      fetchAccount(PRIMARY, TEST_ADDR, { fetchFn, cacheTtlMs: 0, maxRetries: 0, circuitBreaker: cb }),
    ).rejects.toMatchObject({ statusCode: 429 });

    // Trip the breaker with a transport failure; Horizon's 120 s deadline
    // now outlasts the 1 s recovery timeout.
    await trip(cb);
    clock.advance(1_000);
    expect(cb.getState()).toBe('open');

    const blocked = await fetchAccount(PRIMARY, TEST_ADDR, {
      fetchFn,
      cacheTtlMs: 0,
      maxRetries: 0,
      circuitBreaker: cb,
    }).catch((e: unknown) => e);
    expect(isCircuitOpenError(blocked)).toBe(true);
    expect(blocked).toBeInstanceOf(HorizonCircuitOpenError);
    expect((blocked as HorizonCircuitOpenError).remainingCooldownMs).toBe(119_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('ignores a malformed Retry-After header', async () => {
    const clock = fakeClock();
    const { cb } = breaker(clock, { failureThreshold: 1, recoveryTimeoutMs: 1_000 });
    const fetchFn = jest.fn(async () => response(503, { 'retry-after': 'soon-ish' })) as unknown as FetchAccountOptions['fetchFn'];

    await expect(
      fetchAccount(PRIMARY, TEST_ADDR, { fetchFn, cacheTtlMs: 0, maxRetries: 0, circuitBreaker: cb }),
    ).rejects.toMatchObject({ statusCode: 503 });
    await trip(cb);
    expect(cb.getRemainingCooldownMs()).toBe(1_000);
  });
});
