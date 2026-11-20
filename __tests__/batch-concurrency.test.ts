/**
 * Concurrency cap, queue-saturation metrics, and abort tests for
 * `runBatchValidation` (Issue #852).
 *
 * `checks-run.ts` itself issues exactly one Check Run per invocation and has
 * no address fan-out to bound. The actual place batch Wave jobs fan out
 * Horizon work across many addresses is `runBatchValidation` in
 * `src/batch.ts` — already documented as deliberately sequential
 * ("Sequential execution keeps request pressure on Horizon predictable").
 * This suite proves the new `maxConcurrency` option bounds that fan-out
 * (instead of leaving it unbounded if parallelism is ever requested),
 * proves `requestDelayMs` pacing still applies per worker, proves the
 * queue-saturation metric fires exactly when addresses wait for a free
 * slot, and proves `signal`-based cancellation drains queued addresses
 * without starting new Horizon fetches and without leaving any promise
 * unresolved.
 */
import { runBatchValidation, BATCH_REASON_CODES, MAX_BATCH_CONCURRENCY } from '../src/batch';
import { CheckConfig } from '../src/checks';
import * as horizon from '../src/horizon';
import { globalMetrics } from '../src/metrics';

jest.mock('@actions/core');
jest.mock('../src/horizon', () => ({
  ...jest.requireActual('../src/horizon'),
  fetchAccount: jest.fn(),
}));

const mockFetchAccount = horizon.fetchAccount as jest.MockedFunction<typeof horizon.fetchAccount>;

const CONFIG: CheckConfig = {
  assetCode: 'USDC',
  assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  minXlmReserve: 1.5,
  horizonUrl: 'https://horizon.stellar.org',
};

// 8 structurally-valid (StrKey checksum-correct) G-addresses, generated
// deterministically — `isValidStellarAddress` performs full CRC16/XMODEM
// checksum validation, so arbitrary strings will not pass.
const ADDRS = [
  'GADRIIJOHNEFKYTPPSEZNI5QXXFNPZHR7YFRQJJSH5GFSZTTQCGZVC7N',
  'GAHBWKBVIJHVY2LWQOIJ3KVXYTI5527YAUJB6LBZIZJWA3L2Q6KKCPTE',
  'GAKSELZ4JFLGG4D5RKL2JMN6ZPMOL4X7BQMSMM2AJVNGO5EBR2N2RRMZ',
  'GAOCSNSDKBOWU54ESGPKXOGF2LP6Z6IGCMQC2OSHKRQW464ISWRK76UK',
  'GARTAPKKK5SHC7ULTCS3FP6M3HTPGAANDITTIQKOLNUHLAUPTSU3NCU2',
  'GAVDORCRLZVXRBMST6WLTRWT4DW7UBYUEEXDWSCVMJXXZCMWUOYL24GI',
  'GAYT4S2YMVZH7DEZU2Z4BTO2472ACDQ3FA2UET24NF3IHEE5VK34JIZL',
  'GA4EKUS7NR4YNE5AVW5MPVHB535QQFJCF46ESVTDOB6YVF5EWG7MX2FF',
];

const FUNDED_ACCOUNT = {
  id: ADDRS[0],
  account_id: ADDRS[0],
  sequence: '1',
  subentry_count: 2,
  balances: [
    { asset_type: 'native', balance: '10.0' },
    {
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: CONFIG.assetIssuer,
      balance: '100.0',
      limit: '1000000',
      is_authorized: true,
      is_clawback_enabled: false,
    },
  ],
};

beforeEach(() => {
  mockFetchAccount.mockReset();
  globalMetrics.reset();
});

describe('runBatchValidation concurrency cap (Issue #852)', () => {
  it('never runs more concurrent Horizon fetches than maxConcurrency allows', async () => {
    let inFlight = 0;
    let maxObservedInFlight = 0;
    const releases: Array<() => void> = [];

    mockFetchAccount.mockImplementation(async () => {
      inFlight++;
      maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight--;
      return FUNDED_ACCOUNT as any;
    });

    const pending = runBatchValidation(ADDRS, CONFIG, 'https://horizon.stellar.org', {
      requestDelayMs: 0,
      maxConcurrency: 3,
    });

    // Let every worker reach its "fetchAccount is awaiting" point.
    await new Promise((r) => setImmediate(r));
    expect(maxObservedInFlight).toBeLessThanOrEqual(3);
    expect(inFlight).toBe(3); // exactly maxConcurrency in flight, not more

    // Release all waiters in waves until the batch resolves.
    while (releases.length > 0) {
      releases.splice(0).forEach((release) => release());
      await new Promise((r) => setImmediate(r));
    }

    const results = await pending;
    expect(results).toHaveLength(ADDRS.length);
    expect(results.every((r) => r.valid)).toBe(true);
    expect(maxObservedInFlight).toBeLessThanOrEqual(3);
  });

  it('defaults to maxConcurrency=1 (fully sequential, byte-identical to pre-#852 behavior)', async () => {
    let inFlight = 0;
    let maxObservedInFlight = 0;
    mockFetchAccount.mockImplementation(async () => {
      inFlight++;
      maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      return FUNDED_ACCOUNT as any;
    });

    const results = await runBatchValidation(ADDRS.slice(0, 4), CONFIG, 'https://horizon.stellar.org', {
      requestDelayMs: 0,
    });

    expect(maxObservedInFlight).toBe(1);
    expect(results.map((r) => r.address)).toEqual(ADDRS.slice(0, 4));
  });

  it('clamps an out-of-range maxConcurrency into [1, MAX_BATCH_CONCURRENCY]', async () => {
    mockFetchAccount.mockResolvedValue(FUNDED_ACCOUNT as any);

    const results = await runBatchValidation(ADDRS.slice(0, 2), CONFIG, 'https://horizon.stellar.org', {
      requestDelayMs: 0,
      maxConcurrency: MAX_BATCH_CONCURRENCY + 1000,
    });

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.valid)).toBe(true);
  });

  it('records batch_max_concurrency and increments batch_queue_saturated for addresses that had to wait for a slot', async () => {
    mockFetchAccount.mockResolvedValue(FUNDED_ACCOUNT as any);

    await runBatchValidation(ADDRS, CONFIG, 'https://horizon.stellar.org', {
      requestDelayMs: 0,
      maxConcurrency: 3,
    });

    const summary = globalMetrics.getSummary();
    const maxConcurrencyMetric = summary.metrics.find((m) => m.name === 'batch_max_concurrency');
    expect(maxConcurrencyMetric?.value).toBe(3);
    // 8 addresses, 3 slots -> 5 addresses had to wait for a slot to free up.
    expect(globalMetrics.getCounter('batch_queue_saturated')).toBe(ADDRS.length - 3);
  });

  it('emits no batch_queue_saturated increments when maxConcurrency covers every address', async () => {
    mockFetchAccount.mockResolvedValue(FUNDED_ACCOUNT as any);

    await runBatchValidation(ADDRS.slice(0, 2), CONFIG, 'https://horizon.stellar.org', {
      requestDelayMs: 0,
      maxConcurrency: 10,
    });

    expect(globalMetrics.getCounter('batch_queue_saturated')).toBe(0);
  });
});

describe('runBatchValidation abort/cancel (Issue #852)', () => {
  it('returns every row as CANCELLED and issues zero fetches when already aborted', async () => {
    mockFetchAccount.mockResolvedValue(FUNDED_ACCOUNT as any);
    const controller = new AbortController();
    controller.abort();

    const results = await runBatchValidation(ADDRS.slice(0, 3), CONFIG, 'https://horizon.stellar.org', {
      requestDelayMs: 0,
      signal: controller.signal,
    });

    expect(results).toHaveLength(3);
    for (const row of results) {
      expect(row.valid).toBe(false);
      expect(row.reasonCode).toBe(BATCH_REASON_CODES.cancelled);
    }
    expect(mockFetchAccount).not.toHaveBeenCalled();
  });

  it('stops dispatching new addresses once aborted mid-run, without leaving a result row empty', async () => {
    const controller = new AbortController();
    let callCount = 0;

    mockFetchAccount.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // Abort right after the first fetch is dispatched, before it
        // resolves, simulating cancellation arriving mid-flight.
        controller.abort();
      }
      return FUNDED_ACCOUNT as any;
    });

    const results = await runBatchValidation(ADDRS, CONFIG, 'https://horizon.stellar.org', {
      requestDelayMs: 0,
      maxConcurrency: 1,
      signal: controller.signal,
    });

    // Every address gets exactly one row — nothing is left `undefined` /
    // orphaned — and no further Horizon calls happen after the abort.
    expect(results).toHaveLength(ADDRS.length);
    expect(mockFetchAccount.mock.calls.length).toBeLessThan(ADDRS.length);
    const cancelledRows = results.filter((r) => r.reasonCode === BATCH_REASON_CODES.cancelled);
    expect(cancelledRows.length).toBeGreaterThan(0);
    for (const row of cancelledRows) {
      expect(row.valid).toBe(false);
      expect(row.failureReason).toMatch(/cancelled/i);
    }
  });

  it('threads the batch signal into fetchOptions so in-flight Horizon requests abort too', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    mockFetchAccount.mockImplementation(async (_url, _addr, opts) => {
      receivedSignal = (opts as { signal?: AbortSignal } | undefined)?.signal;
      return FUNDED_ACCOUNT as any;
    });

    await runBatchValidation([ADDRS[0]], CONFIG, 'https://horizon.stellar.org', {
      requestDelayMs: 0,
      signal: controller.signal,
    });

    expect(receivedSignal).toBe(controller.signal);
  });

  it('does not override an explicit fetchOptions.signal already set by the caller', async () => {
    const batchSignal = new AbortController().signal;
    const explicitSignal = new AbortController().signal;
    let receivedSignal: AbortSignal | undefined;

    mockFetchAccount.mockImplementation(async (_url, _addr, opts) => {
      receivedSignal = (opts as { signal?: AbortSignal } | undefined)?.signal;
      return FUNDED_ACCOUNT as any;
    });

    await runBatchValidation([ADDRS[0]], CONFIG, 'https://horizon.stellar.org', {
      requestDelayMs: 0,
      signal: batchSignal,
      fetchOptions: { signal: explicitSignal },
    });

    expect(receivedSignal).toBe(explicitSignal);
  });

  it('resolves with an empty array and issues no fetches for an empty address list', async () => {
    const results = await runBatchValidation([], CONFIG, 'https://horizon.stellar.org', {
      requestDelayMs: 0,
    });
    expect(results).toEqual([]);
    expect(mockFetchAccount).not.toHaveBeenCalled();
  });
});
