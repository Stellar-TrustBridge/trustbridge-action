/**
 * Deterministic ordering guarantee for batch results, summaries and matrix
 * outputs — Issue #964.
 */
import {
  BatchInputError,
  BatchOrderingError,
  buildBatchSummary,
  BatchAddressResult,
  formatBatchSummaryMarkdown,
  MAX_BATCH_ADDRESSES,
  parseBatchAddresses,
  runBatchValidation,
  verifyBatchOrdering,
} from '../src/batch';
import { CheckConfig } from '../src/checks';
import * as horizon from '../src/horizon';
import { globalMetrics } from '../src/metrics';
import { buildMatrixOutputs } from '../src/outputs';

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

const account = (id: string, withTrustline: boolean) => ({
  id,
  account_id: id,
  sequence: '1',
  subentry_count: 2,
  balances: [
    { asset_type: 'native', balance: '10.0' },
    ...(withTrustline
      ? [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: CONFIG.assetIssuer,
            balance: '100.0',
            limit: '1000000',
            is_authorized: true,
            is_clawback_enabled: false,
          },
        ]
      : []),
  ],
});

/** Per-address outcome: 0 passes, 1 lacks the trustline, 2 is unfunded (null). */
const outcomeFor = (address: string) => ADDRS.indexOf(address) % 3;

/** Deterministic PRNG so "random" completion order is reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mock Horizon so responses arrive in an order unrelated to the input order. */
function mockHorizonWithShuffledLatency(seed: number): void {
  const rand = mulberry32(seed);
  mockFetchAccount.mockImplementation(async (_url: string, address: string) => {
    await new Promise((resolve) => setTimeout(resolve, Math.floor(rand() * 15)));
    const outcome = outcomeFor(address);
    if (outcome === 2) return null as never;
    return account(address, outcome === 0) as never;
  });
}

beforeEach(() => {
  mockFetchAccount.mockReset();
  globalMetrics.reset();
});

describe('parseBatchAddresses ordering', () => {
  it('keeps the first occurrence of each address, in input order', () => {
    const raw = [ADDRS[3], ADDRS[1], ADDRS[3], ADDRS[0], ADDRS[1], ADDRS[2]].join('\n');
    expect(parseBatchAddresses(raw)).toEqual([ADDRS[3], ADDRS[1], ADDRS[0], ADDRS[2]]);
  });

  it('yields the same order for the JSON-array and newline forms', () => {
    const list = [ADDRS[5], ADDRS[2], ADDRS[7]];
    expect(parseBatchAddresses(JSON.stringify(list))).toEqual(list);
    expect(parseBatchAddresses(list.join('\n'))).toEqual(list);
    expect(parseBatchAddresses(`\n  ${list.join('\n\n  ')}\n`)).toEqual(list);
  });

  it('is never sorted: reversed input stays reversed', () => {
    expect(parseBatchAddresses([...ADDRS].reverse().join('\n'))).toEqual([...ADDRS].reverse());
  });
});

describe('parseBatchAddresses stable error codes', () => {
  it.each([
    ['', 'BATCH_INPUT_EMPTY'],
    ['   \n ', 'BATCH_INPUT_EMPTY'],
    ['[not json', 'BATCH_INPUT_INVALID_JSON'],
    ['[1, 2]', 'BATCH_INPUT_ITEM_NOT_STRING'],
    ['["", "  "]', 'BATCH_INPUT_NO_ENTRIES'],
  ])('%j -> %s', (raw, code) => {
    try {
      parseBatchAddresses(raw);
      throw new Error('expected failure');
    } catch (err) {
      expect(err).toBeInstanceOf(BatchInputError);
      expect((err as BatchInputError).code).toBe(code);
    }
  });

  it('keeps the pre-existing messages', () => {
    expect(() => parseBatchAddresses('')).toThrow('stellar_addresses input is empty. Provide at least one Stellar address.');
    expect(() => parseBatchAddresses('[1]')).toThrow('stellar_addresses JSON array item at index 0 is not a string.');
  });

  it('rejects an oversized batch with BATCH_INPUT_TOO_LARGE and accepts exactly the maximum', () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => `ADDR${i}`);
    expect(parseBatchAddresses(make(MAX_BATCH_ADDRESSES).join('\n'))).toHaveLength(MAX_BATCH_ADDRESSES);
    try {
      parseBatchAddresses(make(MAX_BATCH_ADDRESSES + 1).join('\n'));
      throw new Error('expected failure');
    } catch (err) {
      expect((err as BatchInputError).code).toBe('BATCH_INPUT_TOO_LARGE');
      expect((err as Error).message).toContain(String(MAX_BATCH_ADDRESSES));
    }
  });

  it('counts unique addresses against the cap, not raw lines', () => {
    const lines = Array.from({ length: MAX_BATCH_ADDRESSES * 2 }, () => ADDRS[0]);
    expect(parseBatchAddresses(lines.join('\n'))).toEqual([ADDRS[0]]);
  });
});

describe('runBatchValidation result order', () => {
  it.each([1, 3, 8])('returns rows in input order at maxConcurrency=%i despite shuffled responses', async (maxConcurrency) => {
    for (const seed of [1, 2, 3, 4, 5]) {
      mockHorizonWithShuffledLatency(seed);
      const results = await runBatchValidation(ADDRS, CONFIG, 'https://horizon.stellar.org', {
        requestDelayMs: 0,
        maxConcurrency,
      });
      expect(results.map((r) => r.address)).toEqual(ADDRS);
      expect(results.map((r) => r.valid)).toEqual(ADDRS.map((a) => outcomeFor(a) === 0));
    }
  });

  it('produces byte-identical rows, summary and markdown across runs with different completion orders', async () => {
    const outputs: string[] = [];
    for (const seed of [11, 22, 33, 44]) {
      mockHorizonWithShuffledLatency(seed);
      const results = await runBatchValidation(ADDRS, CONFIG, 'https://horizon.stellar.org', {
        requestDelayMs: 0,
        maxConcurrency: 8,
      });
      const summary = buildBatchSummary(results);
      outputs.push(JSON.stringify({ results, summary, markdown: formatBatchSummaryMarkdown(summary, 'USDC') }));
    }
    expect(new Set(outputs).size).toBe(1);
  });

  it('keeps one row per address for an aborted run, still in input order', async () => {
    const controller = new AbortController();
    controller.abort();
    const results = await runBatchValidation(ADDRS, CONFIG, 'https://horizon.stellar.org', {
      requestDelayMs: 0,
      signal: controller.signal,
    });
    expect(results.map((r) => r.address)).toEqual(ADDRS);
  });
});

describe('verifyBatchOrdering', () => {
  const row = (address: string): BatchAddressResult => ({
    address,
    valid: true,
    accountFunded: true,
    trustlineExists: true,
    xlmBalance: '10',
    xlmReserveMet: true,
    failureReason: null,
  });

  it('accepts aligned results, including an empty batch', () => {
    expect(() => verifyBatchOrdering(ADDRS, ADDRS.map(row))).not.toThrow();
    expect(() => verifyBatchOrdering([], [])).not.toThrow();
  });

  it('rejects results whose count differs from the input', () => {
    expect(() => verifyBatchOrdering(ADDRS, ADDRS.slice(1).map(row))).toThrow(
      expect.objectContaining({ code: 'BATCH_ORDER_COUNT_MISMATCH' }),
    );
  });

  it('rejects a missing row and reports its index', () => {
    const rows: Array<BatchAddressResult | undefined> = ADDRS.map(row);
    rows[2] = undefined;
    try {
      verifyBatchOrdering(ADDRS, rows);
      throw new Error('expected failure');
    } catch (err) {
      expect(err).toBeInstanceOf(BatchOrderingError);
      expect((err as BatchOrderingError).code).toBe('BATCH_ORDER_ROW_MISSING');
      expect((err as BatchOrderingError).index).toBe(2);
    }
  });

  it('rejects reordered rows and reports the first misplaced index', () => {
    const rows = ADDRS.map(row);
    [rows[1], rows[4]] = [rows[4], rows[1]];
    try {
      verifyBatchOrdering(ADDRS, rows);
      throw new Error('expected failure');
    } catch (err) {
      expect((err as BatchOrderingError).code).toBe('BATCH_ORDER_ADDRESS_MISMATCH');
      expect((err as BatchOrderingError).index).toBe(1);
      expect((err as Error).message).toMatch(/output order must match input order/);
    }
  });
});

describe('buildBatchSummary ordering', () => {
  const failing = (address: string, reasonCode: string, reason: string): BatchAddressResult => ({
    address,
    valid: false,
    accountFunded: true,
    trustlineExists: false,
    xlmBalance: '1',
    xlmReserveMet: false,
    failureReason: reason,
    reasonCode,
  });

  it('lists failures in input order', () => {
    const results = [
      failing(ADDRS[0], 'TRUSTLINE_MISSING', 'no trustline'),
      { ...failing(ADDRS[1], 'SUCCESS', ''), valid: true, failureReason: null },
      failing(ADDRS[2], 'RESERVE_TOO_LOW', 'reserve'),
    ];
    expect(buildBatchSummary(results).failures.map((f) => f.address)).toEqual([ADDRS[0], ADDRS[2]]);
  });

  it('sorts fatalReasonCodes regardless of which row failed first', () => {
    const a = buildBatchSummary([failing(ADDRS[0], 'FATAL_CONFIG', 'x'), failing(ADDRS[1], 'FATAL_AUTH', 'y')]);
    const b = buildBatchSummary([failing(ADDRS[1], 'FATAL_AUTH', 'y'), failing(ADDRS[0], 'FATAL_CONFIG', 'x')]);
    expect(a.fatalReasonCodes).toEqual(['FATAL_AUTH', 'FATAL_CONFIG']);
    expect(b.fatalReasonCodes).toEqual(a.fatalReasonCodes);
  });
});

describe('matrix outputs preserve input order', () => {
  const entry = (assigneeLogin: string, valid: boolean) => ({
    assigneeLogin,
    stellarAddress: ADDRS[0],
    validatedAt: '2026-01-01T00:00:00.000Z',
    validationResult: {
      valid,
      accountFunded: true,
      trustlineExists: valid,
      xlmBalance: '10',
      xlmReserveMet: true,
      checks: [],
    } as never,
  });

  it('lists assignees in input order, not JavaScript object-key order', () => {
    // A plain object would hoist integer-like keys ("123", "7") to the front.
    const { matrixReadyMap, assigneeResultsJson } = buildMatrixOutputs([
      entry('zed', true),
      entry('123', false),
      entry('alice', true),
      entry('7', true),
    ]);
    expect(matrixReadyMap).toBe('{"zed":true,"123":false,"alice":true,"7":true}');
    expect(Object.keys(JSON.parse(matrixReadyMap))).toHaveLength(4);
    expect([...assigneeResultsJson.matchAll(/"(zed|123|alice|7)":\{/g)].map((m) => m[1])).toEqual(['zed', '123', 'alice', '7']);
  });

  it('keeps a duplicate assignee at its first position with the last value', () => {
    const { matrixReadyMap } = buildMatrixOutputs([entry('a', true), entry('b', true), entry('a', false)]);
    expect(matrixReadyMap).toBe('{"a":false,"b":true}');
  });

  it('does not lose an assignee named __proto__', () => {
    const { matrixReadyMap } = buildMatrixOutputs([entry('__proto__', true), entry('b', false)]);
    expect(matrixReadyMap).toBe('{"__proto__":true,"b":false}');
  });

  it('is byte-stable across repeated calls and matches plain JSON for ordinary keys', () => {
    const input = [entry('alice', true), entry('bob', false)];
    const first = buildMatrixOutputs(input);
    expect(buildMatrixOutputs(input)).toEqual(first);
    expect(first.matrixReadyMap).toBe(JSON.stringify({ alice: true, bob: false }));
    expect(JSON.parse(first.assigneeResultsJson).alice).toMatchObject({ ready: true, reason_code: 'SUCCESS' });
  });

  it('returns valid empty objects for no assignees', () => {
    const { matrixReadyMap, assigneeResultsJson, includedCount } = buildMatrixOutputs([]);
    expect(matrixReadyMap).toBe('{}');
    expect(assigneeResultsJson).toBe('{}');
    expect(includedCount).toBe(0);
  });
});
