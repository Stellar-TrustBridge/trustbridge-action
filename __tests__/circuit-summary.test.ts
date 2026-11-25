/**
 * #788 — circuit-open metrics surface in the Job Summary without raw bodies.
 */
import { CircuitBreaker } from '../src/resilience';
import { formatCircuitOpenSummary } from '../src/summary';

class HorizonBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HorizonBodyError';
  }
}

async function trip(breaker: CircuitBreaker, err: Error): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await expect(breaker.execute(() => Promise.reject(err))).rejects.toBe(err);
  }
}

describe('CircuitBreaker.getOpenMetrics', () => {
  it('reports open duration and last error class once open', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, onStateChange: () => {} });
    await trip(breaker, new HorizonBodyError('{"secret":"raw horizon body"}'));
    const openedAt = breaker.getStats().openedAt as number;
    expect(breaker.getOpenMetrics(openedAt + 4_000)).toEqual({
      state: 'open',
      openDurationMs: 4_000,
      lastErrorClass: 'HorizonBodyError',
      consecutiveFailures: 2,
    });
  });

  it('reports zero duration and no error class while closed', () => {
    const breaker = new CircuitBreaker({ onStateChange: () => {} });
    expect(breaker.getOpenMetrics()).toEqual({
      state: 'closed',
      openDurationMs: 0,
      lastErrorClass: null,
      consecutiveFailures: 0,
    });
  });

  it('sanitises malformed error names and non-Error throws', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 5, onStateChange: () => {} });
    const bad = new Error('boom');
    bad.name = '<script>alert(1)</script>';
    await expect(breaker.execute(() => Promise.reject(bad))).rejects.toBe(bad);
    expect(breaker.getOpenMetrics().lastErrorClass).toBe('Error');
    await expect(breaker.execute(() => Promise.reject('plain string'))).rejects.toBe('plain string');
    expect(breaker.getOpenMetrics().lastErrorClass).toBe('NonErrorThrown');
  });
});

describe('formatCircuitOpenSummary', () => {
  it('renders duration and error class without the error message', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, onStateChange: () => {} });
    await trip(breaker, new HorizonBodyError('{"secret":"raw horizon body"}'));
    const openedAt = breaker.getStats().openedAt as number;
    const md = formatCircuitOpenSummary(breaker.getOpenMetrics(openedAt + 12_400));
    expect(md).toContain('Horizon circuit breaker open');
    expect(md).toContain('| Open duration | 12s |');
    expect(md).toContain('| Last error class | `HorizonBodyError` |');
    expect(md).toContain('| Consecutive failures | 2 |');
    expect(md).not.toContain('raw horizon body');
  });

  it('returns an empty string when closed, half-open, or missing', () => {
    expect(formatCircuitOpenSummary(null)).toBe('');
    expect(formatCircuitOpenSummary(undefined)).toBe('');
    for (const state of ['closed', 'half-open'] as const) {
      expect(
        formatCircuitOpenSummary({ state, openDurationMs: 0, lastErrorClass: 'X', consecutiveFailures: 0 }),
      ).toBe('');
    }
  });

  it('falls back to "unknown" when no error class was recorded', () => {
    const md = formatCircuitOpenSummary({
      state: 'open',
      openDurationMs: -5,
      lastErrorClass: null,
      consecutiveFailures: 0,
    });
    expect(md).toContain('| Open duration | 0s |');
    expect(md).toContain('`unknown`');
  });
});
