import { AdaptiveConcurrency, ADAPTIVE_RECOVERY_SUCCESSES } from '../src/checks-run';
import { runBatchValidation } from '../src/batch';
import { globalMetrics } from '../src/metrics';
import { FetchLike } from '../src/horizon';
import { Response } from 'node-fetch';

jest.mock('@actions/core');

const ADDRS = [
  'GADRIIJOHNEFKYTPPSEZNI5QXXFNPZHR7YFRQJJSH5GFSZTTQCGZVC7N',
  'GAHBWKBVIJHVY2LWQOIJ3KVXYTI5527YAUJB6LBZIZJWA3L2Q6KKCPTE',
  'GAKSELZ4JFLGG4D5RKL2JMN6ZPMOL4X7BQMSMM2AJVNGO5EBR2N2RRMZ',
  'GAOCSNSDKBOWU54ESGPKXOGF2LP6Z6IGCMQC2OSHKRQW464ISWRK76UK',
  'GARTAPKKK5SHC7ULTCS3FP6M3HTPGAANDITTIQKOLNUHLAUPTSU3NCU2',
  'GAVDORCRLZVXRBMST6WLTRWT4DW7UBYUEEXDWSCVMJXXZCMWUOYL24GI',
];

describe('AdaptiveConcurrency (#946)', () => {
  it('halves once per burst, never below 1', () => {
    const l = new AdaptiveConcurrency(8);
    const e = l.epoch;
    l.onThrottle(e);
    l.onThrottle(e);
    expect(l.limit).toBe(4);
    for (let i = 0; i < 5; i++) l.onThrottle(l.epoch);
    expect(l.limit).toBe(1);
  });

  it('recovers one slot at a time up to max', () => {
    const l = new AdaptiveConcurrency(4);
    l.onThrottle(l.epoch);
    for (let i = 0; i < ADAPTIVE_RECOVERY_SUCCESSES - 1; i++) l.onSuccess(l.epoch);
    expect(l.limit).toBe(2);
    l.onSuccess(l.epoch);
    expect(l.limit).toBe(3);
    for (let i = 0; i < 100; i++) l.onSuccess(l.epoch);
    expect(l.limit).toBe(4);
  });

  it('ignores a low throttle rate and clamps bad bounds', () => {
    const l = new AdaptiveConcurrency(4);
    for (let i = 0; i < 9; i++) l.onSuccess(l.epoch);
    l.onThrottle(l.epoch);
    expect(l.limit).toBe(4);
    expect(new AdaptiveConcurrency(NaN).limit).toBe(1);
  });

  const run = async (status: number, headers: Record<string, string>, signal?: AbortSignal) => {
    let active = 0;
    let calls = 0;
    const peaks: number[] = [];
    const fetchFn: FetchLike = async () => {
      calls++;
      peaks.push(++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return new Response('{}', { status, headers });
    };
    const rows = await runBatchValidation(
      ADDRS,
      { assetCode: 'USDC', assetIssuer: ADDRS[0], minXlmReserve: 1, horizonUrl: 'https://horizon.stellar.org' },
      'https://horizon.stellar.org',
      { requestDelayMs: 0, maxConcurrency: 4, signal, fetchOptions: { fetchFn, maxRetries: 0, useCache: false, negativeCacheTtlMs: 0 } },
    );
    return { rows, calls, peaks };
  };
  const decreased = () => (JSON.parse(globalMetrics.toJSON() as unknown as string) as { counters: Record<string, number> }).counters.batch_concurrency_decreased ?? 0;

  it('lowers concurrency when fake Horizon injects 429s', async () => {
    const before = decreased();
    const { rows, peaks } = await run(429, {});
    expect(rows.every((r) => r.reasonCode)).toBe(true);
    expect(rows).toHaveLength(ADDRS.length);
    expect(Math.max(...peaks.slice(4))).toBeLessThanOrEqual(2);
    expect(decreased()).toBeGreaterThan(before);
  });

  it('counts 503 with Retry-After but not a 404', async () => {
    const before = decreased();
    await run(404, {});
    expect(decreased()).toBe(before);
    await run(503, { 'Retry-After': '1' });
    expect(decreased()).toBeGreaterThan(before);
  });

  it('cancels without Horizon calls', async () => {
    const c = new AbortController();
    c.abort();
    const { rows, calls } = await run(429, {}, c.signal);
    expect(calls).toBe(0);
    expect(rows.every((r) => r.reasonCode === 'CANCELLED')).toBe(true);
  });
});
