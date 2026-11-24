/**
 * Issue #928: per-address deadline independent of the global timeout.
 */
import { runBatchValidation, BATCH_REASON_CODES } from '../src/batch';
import { runWithAddressDeadline } from '../src/checks-run';
import { CheckConfig } from '../src/checks';
import * as horizon from '../src/horizon';

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
];
const FUNDED = {
  id: ADDRS[1],
  account_id: ADDRS[1],
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

/** A fetch that never resolves on its own but honors its abort signal. */
function hangingFetch(
  _url: string,
  _address: string,
  options?: horizon.FetchAccountOptions,
): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockFetchAccount.mockReset();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('per-address deadline in runBatchValidation (Issue #928)', () => {
  it('times out only the hung address and continues with the next one', async () => {
    mockFetchAccount
      .mockImplementationOnce(hangingFetch as never)
      .mockResolvedValueOnce(FUNDED as never);

    const run = runBatchValidation(ADDRS, CONFIG, CONFIG.horizonUrl, {
      requestDelayMs: 0,
      perAddressTimeoutMs: 1000,
    });
    await jest.advanceTimersByTimeAsync(1000);
    const results = await run;

    expect(results[0].reasonCode).toBe(BATCH_REASON_CODES.addressTimeout);
    expect(results[0].failureReason).toContain('1000 ms');
    expect(results[1].valid).toBe(true);
  });

  it('lets global cancellation take precedence over the per-address deadline', async () => {
    mockFetchAccount.mockImplementation(hangingFetch as never);
    const controller = new AbortController();

    const run = runBatchValidation(ADDRS, CONFIG, CONFIG.horizonUrl, {
      requestDelayMs: 0,
      perAddressTimeoutMs: 5000,
      signal: controller.signal,
    });
    await jest.advanceTimersByTimeAsync(100);
    controller.abort();
    const results = await run;

    expect(results.map((r) => r.reasonCode)).toEqual([
      BATCH_REASON_CODES.cancelled,
      BATCH_REASON_CODES.cancelled,
    ]);
    expect(mockFetchAccount).toHaveBeenCalledTimes(1);
  });

  it('does not time out addresses that finish within the deadline', async () => {
    mockFetchAccount.mockResolvedValue(FUNDED as never);
    const results = await runBatchValidation([ADDRS[1]], CONFIG, CONFIG.horizonUrl, {
      requestDelayMs: 0,
      perAddressTimeoutMs: 1000,
    });
    expect(results[0].valid).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('runWithAddressDeadline', () => {
  it('treats 0 / non-finite deadlines as disabled', async () => {
    await expect(runWithAddressDeadline(async () => 'ok', 0)).resolves.toEqual({
      status: 'completed',
      value: 'ok',
    });
    await expect(runWithAddressDeadline(async () => 'ok', Number.NaN)).resolves.toEqual({
      status: 'completed',
      value: 'ok',
    });
  });

  it('rethrows task errors that are not caused by the deadline or cancellation', async () => {
    await expect(
      runWithAddressDeadline(async () => {
        throw new Error('boom');
      }, 1000),
    ).rejects.toThrow('boom');
  });

  it('returns cancelled immediately when the parent signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const task = jest.fn(async () => 'never');
    await expect(runWithAddressDeadline(task, 1000, controller.signal)).resolves.toEqual({
      status: 'cancelled',
    });
    expect(task).not.toHaveBeenCalled();
  });
});
