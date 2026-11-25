/**
 * Issues #955–#958: required-label gate, per-address check latency histogram,
 * federation memo hash validation, cache single-flight waiter timeout.
 */
import {
  evaluateRequiredLabels,
  parseRequiredLabels,
  PreflightError,
  REASON_CODE_REQUIRED_LABELS_MISSING,
  REQUIRED_LABELS_MAX_COUNT,
} from '../src/preflight';
import { CheckLatencyHistogram, globalMetrics } from '../src/metrics';
import { validateMemo, MEMO_HASH_HEX_LENGTH } from '../src/federation';
import { SimpleCache, SingleFlightTimeoutError, SINGLE_FLIGHT_WAIT_TIMEOUT_CODE } from '../src/cache';
import { isReasonCode } from '../src/reasonCodes';

describe('#955 required_labels gate', () => {
  const payload = (labels: unknown[]) => ({ issue: { number: 1, labels } });

  it('passes when every required label is present (case-insensitive)', () => {
    const d = evaluateRequiredLabels(parseRequiredLabels('Wave, ready'), payload([{ name: 'wave' }, { name: 'READY' }]));
    expect(d.shouldSkip).toBe(false);
    expect(d.missing).toEqual([]);
  });

  it('is disabled for empty input', () => {
    expect(parseRequiredLabels('')).toEqual([]);
    expect(parseRequiredLabels(undefined)).toEqual([]);
    expect(evaluateRequiredLabels([], undefined).shouldSkip).toBe(false);
  });

  it('skips with REQUIRED_LABELS_MISSING when a label is absent', () => {
    const d = evaluateRequiredLabels(['wave', 'payout'], payload([{ name: 'wave' }]));
    expect(d.shouldSkip).toBe(true);
    expect(d.missing).toEqual(['payout']);
    expect(d.reasonCode).toBe(REASON_CODE_REQUIRED_LABELS_MISSING);
    expect(isReasonCode(REASON_CODE_REQUIRED_LABELS_MISSING)).toBe(true);
  });

  it('skips when the event has no issue/PR context', () => {
    expect(evaluateRequiredLabels(['wave'], {}).shouldSkip).toBe(true);
  });

  it('reads pull_request labels and de-duplicates input', () => {
    expect(parseRequiredLabels('a,\nA, b')).toEqual(['a', 'b']);
    expect(
      evaluateRequiredLabels(['a'], { pull_request: { labels: [{ name: 'A' }] } }).shouldSkip,
    ).toBe(false);
  });

  it('rejects oversized label lists and over-long labels with a stable code', () => {
    const many = Array.from({ length: REQUIRED_LABELS_MAX_COUNT + 1 }, (_, i) => `l${i}`).join(',');
    expect(() => parseRequiredLabels(many)).toThrow(PreflightError);
    try {
      parseRequiredLabels('x'.repeat(51));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as PreflightError).reasonCode).toBe('required_labels_invalid');
    }
  });
});

describe('#956 per-address check latency histogram', () => {
  it('buckets observations by outcome without address labels', () => {
    const h = new CheckLatencyHistogram();
    expect(h.record('pass', 40)).toBe(true);
    expect(h.record('pass', 300)).toBe(true);
    expect(h.record('fail', 9000)).toBe(true);
    const snap = h.toSnapshot();
    expect(snap.pass.count).toBe(2);
    expect(snap.pass.buckets['<=50ms']).toBe(1);
    expect(snap.pass.buckets['<=500ms']).toBe(1);
    expect(snap.pass.minMs).toBe(40);
    expect(snap.pass.maxMs).toBe(300);
    expect(snap.fail.buckets['+Inf']).toBe(1);
    expect(Object.keys(snap).sort()).toEqual(['error', 'fail', 'invalid', 'pass']);
    expect(JSON.stringify(snap)).not.toMatch(/G[A-Z2-7]{55}/);
  });

  it('rejects negative, NaN and infinite durations', () => {
    const h = new CheckLatencyHistogram();
    expect(h.record('pass', -1)).toBe(false);
    expect(h.record('pass', NaN)).toBe(false);
    expect(h.record('pass', Infinity)).toBe(false);
    expect(h.rejected).toBe(3);
    expect(h.totalSamples).toBe(0);
  });

  it('rejects unknown outcomes and resets cleanly', () => {
    const h = new CheckLatencyHistogram();
    expect(h.record('bogus' as never, 10)).toBe(false);
    h.record('error', 10);
    h.reset();
    expect(h.totalSamples).toBe(0);
    expect(h.rejected).toBe(0);
  });
});

describe('#957 memo_type hash validation', () => {
  const good = 'a'.repeat(MEMO_HASH_HEX_LENGTH);

  it('accepts a 64-char hex hash', () => {
    expect(validateMemo('hash', good)).toMatchObject({ valid: true });
  });

  it.each([
    ['too short', 'a'.repeat(63), /invalid length 63/],
    ['too long', 'a'.repeat(65), /invalid length 65/],
    ['empty-ish odd length', 'abc', /invalid length 3/],
  ])('rejects %s with MEMO_TYPE_MISMATCH', (_n, memo, re) => {
    const r = validateMemo('hash', memo);
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.code).toBe('MEMO_TYPE_MISMATCH');
      expect(r.reason).toMatch(re);
    }
  });

  it('rejects non-hex (base64) encoding without echoing the memo', () => {
    const b64 = Buffer.alloc(32, 7).toString('base64');
    const r = validateMemo('hash', b64);
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.code).toBe('MEMO_TYPE_MISMATCH');
      expect(r.reason).toMatch(/not hex-encoded/);
      expect(r.reason).not.toContain(b64);
    }
  });

  it('still requires a memo value for memo_type hash', () => {
    expect(validateMemo('hash', '')).toMatchObject({ valid: false, code: 'MEMO_REQUIRED' });
  });
});

describe('#958 cache single-flight waiter timeout', () => {
  afterEach(() => jest.useRealTimers());

  it('shares one fetch between leader and waiters', async () => {
    const cache = new SimpleCache();
    let calls = 0;
    let release!: (v: string) => void;
    const fetcher = () => {
      calls += 1;
      return new Promise<string>((r) => (release = r));
    };
    const a = cache.getOrFetch('k', fetcher);
    const b = cache.getOrFetch('k', fetcher);
    release('v');
    await expect(Promise.all([a, b])).resolves.toEqual(['v', 'v']);
    expect(calls).toBe(1);
    expect(cache.getSingleFlightStats()).toMatchObject({ leaders: 1, waiters: 1, waiterTimeouts: 0, inFlight: 0 });
    expect(cache.get('k')).toBe('v');
  });

  it('times out waiters on a hung leader (fake timers)', async () => {
    jest.useFakeTimers();
    const cache = new SimpleCache();
    const before = globalMetrics.getCounter?.('cache_single_flight_waiter_timeouts') ?? 0;
    void cache.getOrFetch('k', () => new Promise<string>(() => undefined)).catch(() => undefined);
    const waiter = cache.getOrFetch('k', async () => 'never', { waiterTimeoutMs: 1000 });
    const assertion = expect(waiter).rejects.toMatchObject({ code: SINGLE_FLIGHT_WAIT_TIMEOUT_CODE });
    jest.advanceTimersByTime(1000);
    await assertion;
    await expect(waiter).rejects.toBeInstanceOf(SingleFlightTimeoutError);
    expect(cache.getSingleFlightStats().waiterTimeouts).toBe(1);
    expect(cache.get('k')).toBeNull();
    if (globalMetrics.getCounter) {
      expect(globalMetrics.getCounter('cache_single_flight_waiter_timeouts')).toBe(before + 1);
    }
  });

  it('propagates leader errors to waiters and clears in-flight state', async () => {
    const cache = new SimpleCache();
    let fail!: (e: Error) => void;
    const leader = cache.getOrFetch('k', () => new Promise<string>((_, rej) => (fail = rej)));
    const waiter = cache.getOrFetch('k', async () => 'x');
    fail(new Error('horizon 503'));
    await expect(leader).rejects.toThrow('horizon 503');
    await expect(waiter).rejects.toThrow('horizon 503');
    expect(cache.getSingleFlightStats().inFlight).toBe(0);
    await expect(cache.getOrFetch('k', async () => 'ok')).resolves.toBe('ok');
  });

  it('rejects invalid waiterTimeoutMs', async () => {
    const cache = new SimpleCache();
    await expect(cache.getOrFetch('k', async () => 1, { waiterTimeoutMs: 0 })).rejects.toThrow(RangeError);
  });
});
