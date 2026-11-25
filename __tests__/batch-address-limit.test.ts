/**
 * Issue #911 — `batch_max_addresses` hard cap.
 *
 * Overflow must fail before any Horizon call with a message that tells
 * operators how to split the matrix. Covers the boundary (limit, limit + 1),
 * the default and ceiling, malformed limits, and the run()-level wiring.
 */
import * as core from '@actions/core';
import {
  parseBatchAddresses,
  runBatchValidation,
  enforceBatchAddressLimit,
  BatchAddressLimitError,
  BATCH_ADDRESS_LIMIT_REASON_CODE,
  DEFAULT_BATCH_MAX_ADDRESSES,
  BATCH_MAX_ADDRESSES_CEILING,
} from '../src/batch';
import { parseBatchMaxAddressesInput } from '../src/inputs';
import { CheckConfig } from '../src/checks';
import * as horizon from '../src/horizon';
import { run } from '../src/index';

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

/** `n` distinct placeholder addresses (format does not matter for the cap). */
function addresses(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `G${String(i).padStart(55, 'A')}`);
}

describe('parseBatchMaxAddressesInput (Issue #911)', () => {
  it('defaults when empty', () => {
    expect(parseBatchMaxAddressesInput('')).toBe(DEFAULT_BATCH_MAX_ADDRESSES);
    expect(parseBatchMaxAddressesInput(undefined)).toBe(DEFAULT_BATCH_MAX_ADDRESSES);
    expect(DEFAULT_BATCH_MAX_ADDRESSES).toBe(500);
  });

  it('accepts the bounds', () => {
    expect(parseBatchMaxAddressesInput('1')).toBe(1);
    expect(parseBatchMaxAddressesInput(` ${BATCH_MAX_ADDRESSES_CEILING} `)).toBe(BATCH_MAX_ADDRESSES_CEILING);
  });

  it.each(['abc', '1.5', '0', '-3', String(BATCH_MAX_ADDRESSES_CEILING + 1)])(
    'rejects malformed or out-of-range value %p with a stable message',
    (value) => {
      expect(() => parseBatchMaxAddressesInput(value)).toThrow(
        `batch_max_addresses must be a whole number between 1 and ${BATCH_MAX_ADDRESSES_CEILING}. Received: "${value}"`,
      );
    },
  );
});

describe('enforceBatchAddressLimit (Issue #911)', () => {
  it('allows exactly the limit', () => {
    expect(() => enforceBatchAddressLimit(addresses(3), 3)).not.toThrow();
  });

  it('rejects limit + 1 with an actionable split message', () => {
    let caught: unknown;
    try {
      enforceBatchAddressLimit(addresses(7), 3);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BatchAddressLimitError);
    const error = caught as BatchAddressLimitError;
    expect(error.reasonCode).toBe(BATCH_ADDRESS_LIMIT_REASON_CODE);
    expect(error.count).toBe(7);
    expect(error.limit).toBe(3);
    expect(error.suggestedJobs).toBe(3);
    expect(error.message).toBe(
      'stellar_addresses contains 7 unique addresses, which exceeds the batch_max_addresses limit of 3 ' +
        '(BATCH_ADDRESS_LIMIT_EXCEEDED). No Horizon requests were made. Split the addresses across a job ' +
        `matrix with at most 3 addresses per leg (at least 3 legs), or raise batch_max_addresses (maximum ${BATCH_MAX_ADDRESSES_CEILING}). ` +
        'See docs/USAGE.md#batch-address-limit.',
    );
  });

  it('never includes addresses in the error message', () => {
    const list = addresses(4);
    try {
      enforceBatchAddressLimit(list, 2);
      throw new Error('expected overflow');
    } catch (err) {
      for (const address of list) {
        expect((err as Error).message).not.toContain(address);
      }
    }
  });

  it('applies the default limit when none is given', () => {
    expect(() => enforceBatchAddressLimit(addresses(DEFAULT_BATCH_MAX_ADDRESSES))).not.toThrow();
    expect(() => enforceBatchAddressLimit(addresses(DEFAULT_BATCH_MAX_ADDRESSES + 1))).toThrow(BatchAddressLimitError);
  });

  it.each([0, 1.5, BATCH_MAX_ADDRESSES_CEILING + 1, Number.NaN])('rejects an invalid limit %p', (limit) => {
    expect(() => enforceBatchAddressLimit(addresses(1), limit)).toThrow(/batch_max_addresses must be a whole number/);
  });
});

describe('parseBatchAddresses with maxAddresses (Issue #911)', () => {
  it('counts unique addresses, so duplicates do not trip the cap', () => {
    const [a, b] = addresses(2);
    expect(parseBatchAddresses([a, b, a, b].join('\n'), { maxAddresses: 2 })).toEqual([a, b]);
  });

  it('throws BatchAddressLimitError for a newline list over the cap', () => {
    expect(() => parseBatchAddresses(addresses(3).join('\n'), { maxAddresses: 2 })).toThrow(BatchAddressLimitError);
  });

  it('throws BatchAddressLimitError for a JSON array over the cap', () => {
    expect(() => parseBatchAddresses(JSON.stringify(addresses(3)), { maxAddresses: 2 })).toThrow(
      BatchAddressLimitError,
    );
  });

  it('still reports an empty list with the existing error', () => {
    expect(() => parseBatchAddresses('   ', { maxAddresses: 2 })).toThrow('stellar_addresses input is empty');
  });
});

describe('runBatchValidation with maxAddresses (Issue #911)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects an oversized batch before any Horizon request', async () => {
    await expect(
      runBatchValidation(addresses(3), CONFIG, CONFIG.horizonUrl, { maxAddresses: 2, requestDelayMs: 0 }),
    ).rejects.toBeInstanceOf(BatchAddressLimitError);
    expect(mockFetchAccount).not.toHaveBeenCalled();
  });

  it('validates a batch at exactly the cap', async () => {
    mockFetchAccount.mockRejectedValue(new horizon.HorizonError('Not found', 404));
    const results = await runBatchValidation(addresses(2), CONFIG, CONFIG.horizonUrl, {
      maxAddresses: 2,
      requestDelayMs: 0,
    });
    expect(results).toHaveLength(2);
  });
});

describe('run() batch_max_addresses wiring (Issue #911)', () => {
  const PRIMARY = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

  function mockInputs(overrides: Record<string, string>): void {
    const inputs: Record<string, string> = {
      github_token: 'ghs_test_token',
      stellar_address_input: PRIMARY,
      asset_code: 'USDC',
      asset_issuer: CONFIG.assetIssuer,
      min_xlm_reserve: '1.5',
      horizon_url: 'https://horizon.stellar.org',
      posting_mode: 'off',
      wait_until_funded: 'false',
      use_cache: 'false',
      fail_on_missing: 'false',
      debug_mode: 'false',
      ...overrides,
    };
    (core.getInput as jest.Mock).mockImplementation((name: string) => inputs[name] ?? '');
  }

  beforeEach(() => {
    jest.clearAllMocks();
    for (const fn of ['info', 'debug', 'notice', 'warning', 'error', 'setFailed', 'setOutput', 'setSecret'] as const) {
      (core[fn] as jest.Mock).mockImplementation(() => undefined);
    }
  });

  it('fails before any Horizon call when stellar_addresses exceeds batch_max_addresses', async () => {
    mockInputs({ stellar_addresses: addresses(3).join('\n'), batch_max_addresses: '2' });
    await expect(run()).rejects.toThrow(/BATCH_ADDRESS_LIMIT_EXCEEDED/);
    expect(mockFetchAccount).not.toHaveBeenCalled();
  });

  it('fails before any Horizon call on a malformed batch_max_addresses', async () => {
    mockInputs({ stellar_addresses: addresses(1).join('\n'), batch_max_addresses: 'lots' });
    await expect(run()).rejects.toThrow(/batch_max_addresses must be a whole number/);
    expect(mockFetchAccount).not.toHaveBeenCalled();
  });
});
