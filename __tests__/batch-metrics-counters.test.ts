/**
 * Issue #777 — batch pass/fail counters stay consistent with the summary.
 */
import { runBatchValidation, buildBatchSummary } from '../src/batch';
import { CheckConfig } from '../src/checks';
import * as horizon from '../src/horizon';
import { globalMetrics } from '../src/metrics';
import { RateBudgetExhaustedError } from '../src/resilience';

jest.mock('@actions/core');
jest.mock('../src/horizon', () => ({
  ...jest.requireActual('../src/horizon'),
  fetchAccount: jest.fn(),
}));

const mockFetchAccount = horizon.fetchAccount as jest.MockedFunction<typeof horizon.fetchAccount>;

const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const CONFIG: CheckConfig = {
  assetCode: 'USDC',
  assetIssuer: ISSUER,
  minXlmReserve: 1.5,
  horizonUrl: 'https://horizon.stellar.org',
};
const ADDR_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const ADDR_B = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGO6V';

function account(withTrustline: boolean): horizon.HorizonAccount {
  return {
    id: ADDR_A,
    account_id: ADDR_A,
    sequence: '1',
    subentry_count: 2,
    balances: [
      { asset_type: 'native', balance: '10.0' },
      ...(withTrustline
        ? [{ asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: ISSUER, balance: '100.0', limit: '1000000', is_authorized: true, is_clawback_enabled: false }]
        : []),
    ],
  } as unknown as horizon.HorizonAccount;
}

function counters() {
  return {
    passed: globalMetrics.getCounter('batch_address_passed'),
    failed: globalMetrics.getCounter('batch_address_failed'),
  };
}

beforeEach(() => {
  globalMetrics.reset();
  mockFetchAccount.mockReset();
});

describe('batch pass/fail counters (#777)', () => {
  it('counts all-pass batches as passed only', async () => {
    mockFetchAccount.mockResolvedValue(account(true));
    const results = await runBatchValidation([ADDR_A, ADDR_B], CONFIG, CONFIG.horizonUrl, { requestDelayMs: 0 });
    const summary = buildBatchSummary(results);

    expect(counters()).toEqual({ passed: 2, failed: 0 });
    expect(counters()).toEqual({ passed: summary.passed, failed: summary.failed });
  });

  it('counts invalid addresses, check failures and Horizon errors as failed', async () => {
    mockFetchAccount
      .mockResolvedValueOnce(account(false))
      .mockRejectedValueOnce(new horizon.HorizonError('boom', 500));
    const results = await runBatchValidation(['not-an-address', ADDR_A, ADDR_B], CONFIG, CONFIG.horizonUrl, {
      requestDelayMs: 0,
    });
    const summary = buildBatchSummary(results);

    expect(counters()).toEqual({ passed: 0, failed: 3 });
    expect(counters()).toEqual({ passed: summary.passed, failed: summary.failed });
    expect(globalMetrics.getCounter('batch_address_invalid')).toBe(1);
  });

  it('counts rows skipped after rate-budget exhaustion as failed', async () => {
    mockFetchAccount.mockResolvedValueOnce(account(true)).mockRejectedValueOnce(new RateBudgetExhaustedError('spent'));
    const results = await runBatchValidation([ADDR_A, ADDR_B, ADDR_A], CONFIG, CONFIG.horizonUrl, {
      requestDelayMs: 0,
    });

    expect(results).toHaveLength(3);
    expect(counters()).toEqual({ passed: 1, failed: 2 });
    const { passed, failed } = counters();
    expect(passed + failed).toBe(results.length);
  });
});
