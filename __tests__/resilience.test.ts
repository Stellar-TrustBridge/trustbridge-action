import { MetricsCollector } from '../src/metrics';
import {
  addJitter,
  calculateBackoffDelay,
  CircuitOpenDurationTracker,
  RateLimiter,
  retryWithBackoff,
  sleep,
} from '../src/resilience';

describe('resilience helpers', () => {
  it('calculates capped exponential backoff and applies jitter', () => {
    const policy = { maxRetries: 3, initialDelayMs: 100, maxDelayMs: 250, backoffMultiplier: 2, timeoutMs: 1000 };
    expect(calculateBackoffDelay(1, policy)).toBe(200);
    expect(calculateBackoffDelay(3, policy)).toBe(250);
    jest.spyOn(Math, 'random').mockReturnValue(1);
    expect(addJitter(100, 10)).toBe(110);
    jest.restoreAllMocks();
  });

  it('waits for a timer and refills/reset rate limiter tokens', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const limiter = new RateLimiter(2, 1);
    expect(limiter.tryConsume(2)).toBe(true);
    expect(limiter.tryConsume()).toBe(false);
    expect(limiter.waitTimeMs()).toBe(1000);
    const pause = sleep(100);
    await jest.advanceTimersByTimeAsync(1000);
    await pause;
    expect(limiter.tryConsume()).toBe(true);
    limiter.reset();
    expect(limiter.getAvailableTokens()).toBe(2);
    jest.useRealTimers();
  });

  it('retries a rejected operation and stops when the predicate rejects it', async () => {
    const policy = { maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 2, timeoutMs: 1000 };
    const operation = jest.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue('ok');
    await expect(retryWithBackoff(operation, policy)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
    const permanent = new Error('permanent');
    await expect(retryWithBackoff(() => Promise.reject(permanent), policy, () => false))
      .rejects.toBe(permanent);
  });
});

describe('CircuitOpenDurationTracker', () => {
  it('records an open duration once using the injected clock', () => {
    const metrics = new MetricsCollector();
    let now = 100;
    const tracker = new CircuitOpenDurationTracker('horizon', metrics, () => now);
    tracker.open();
    now = 250;
    tracker.open();
    expect(tracker.close()).toBe(150);
    expect(metrics.getSummary().metrics[0]).toMatchObject({
      name: 'circuit_open_duration', value: 150, unit: 'ms', tags: { circuit: 'horizon' },
    });
    expect(tracker.close()).toBeNull();
  });

  it('does not emit a metric when closed without opening', () => {
    const metrics = new MetricsCollector();
    const tracker = new CircuitOpenDurationTracker('rpc', metrics, () => 10);
    expect(tracker.close()).toBeNull();
    expect(metrics.getSummary().totalMetrics).toBe(0);
  });

  it('rejects an empty circuit name', () => {
    expect(() => new CircuitOpenDurationTracker('  ')).toThrow('Circuit name must not be empty.');
  });

  it('clamps a backwards fake clock to a zero duration', () => {
    const metrics = new MetricsCollector();
    let now = 10;
    const tracker = new CircuitOpenDurationTracker('horizon', metrics, () => now);
    tracker.open();
    now = 5;
    expect(tracker.close()).toBe(0);
  });
});
