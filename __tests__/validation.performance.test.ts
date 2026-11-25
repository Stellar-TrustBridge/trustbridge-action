/**
 * Validation performance budget (Issue #138).
 *
 * Measures end-to-end handler time for a full validation run with mocked
 * Horizon. Fails CI when the p95 duration exceeds the documented budget.
 *
 * Budget baseline: see CONTRIBUTING.md → Security → Validation performance budget.
 * Update VALIDATION_PERFORMANCE_BUDGET_P95_MS intentionally when the baseline
 * changes (and document why in the PR).
 */

import * as core from '@actions/core';
import * as horizon from '../src/horizon';
import type { HorizonAccount } from '../src/horizon';
import { run } from '../src/index';

jest.mock('@actions/core');

jest.mock('../src/comment', () => {
  const actual = jest.requireActual('../src/comment') as typeof import('../src/comment');
  return {
    ...actual,
    postIssueComment: jest.fn(async () => undefined),
  };
});

/**
 * p95 wall-clock budget for one mocked validation run (milliseconds).
 * Generous headroom for standard GitHub-hosted runners to avoid flakes.
 */
export const VALIDATION_PERFORMANCE_BUDGET_P95_MS = 2000;

/** Samples used to compute p95 (after warmup). */
const SAMPLE_COUNT = 25;
const WARMUP_COUNT = 3;

const TEST_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const HORIZON_URL = 'https://horizon.stellar.org';

function makeAccount(): HorizonAccount {
  return {
    id: TEST_ADDRESS,
    account_id: TEST_ADDRESS,
    sequence: '1',
    subentry_count: 1,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [
      {
        balance: '10.0000000',
        asset_type: 'native',
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
      },
      {
        balance: '100.0000000',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: USDC_ISSUER,
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
      },
    ],
  };
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) {
    return 0;
  }
  const rank = Math.ceil((p / 100) * sortedAsc.length) - 1;
  const index = Math.min(sortedAsc.length - 1, Math.max(0, rank));
  return sortedAsc[index];
}

function budgetFailureMessage(p95Ms: number, budgetMs: number): string {
  return [
    `Validation performance budget exceeded: p95=${p95Ms.toFixed(1)}ms > ${budgetMs}ms.`,
    'Likely causes: extra Horizon retries, additional fetches, or logging/metrics bloat',
    'on the validation path. Investigate recent changes to src/index.ts, src/horizon.ts,',
    'and related helpers. If the regression is intentional, update',
    'VALIDATION_PERFORMANCE_BUDGET_P95_MS and document the new baseline in CONTRIBUTING.md',
    '(Security → Validation performance budget).',
  ].join(' ');
}

describe('validation performance budget', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();

    const inputs: Record<string, string> = {
      github_token: 'ghs_test_token',
      stellar_address_input: TEST_ADDRESS,
      horizon_url: HORIZON_URL,
      asset_code: 'USDC',
      asset_issuer: USDC_ISSUER,
      min_xlm_reserve: '1.5',
      fail_on_missing: 'true',
      debug_mode: 'false',
      sticky_comment: 'false',
      wait_until_funded: 'false',
      use_cache: 'false',
      log_inputs: 'false',
      sep0007_deep_links: 'false',
    };

    (core.getInput as jest.Mock).mockImplementation((name: string) => inputs[name] ?? '');
    (core.info as jest.Mock).mockImplementation(() => undefined);
    (core.debug as jest.Mock).mockImplementation(() => undefined);
    (core.warning as jest.Mock).mockImplementation(() => undefined);
    (core.error as jest.Mock).mockImplementation(() => undefined);
    (core.setFailed as jest.Mock).mockImplementation(() => undefined);
    (core.setOutput as jest.Mock).mockImplementation(() => undefined);

    fetchSpy = jest.spyOn(horizon, 'fetchAccount').mockResolvedValue(makeAccount());
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it(`keeps mocked end-to-end validation p95 under ${VALIDATION_PERFORMANCE_BUDGET_P95_MS}ms`, async () => {
    for (let i = 0; i < WARMUP_COUNT; i += 1) {
      await run();
    }
    fetchSpy.mockClear();

    const durationsMs: number[] = [];
    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      const start = process.hrtime.bigint();
      await run();
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      durationsMs.push(elapsedMs);
    }

    // Deterministic: mocked Horizon, exactly one fetch per run.
    expect(fetchSpy).toHaveBeenCalledTimes(SAMPLE_COUNT);
    expect(fetchSpy.mock.calls.every((call) => call[0] === HORIZON_URL)).toBe(true);

    const sorted = [...durationsMs].sort((a, b) => a - b);
    const p95 = percentile(sorted, 95);

    if (p95 > VALIDATION_PERFORMANCE_BUDGET_P95_MS) {
      throw new Error(budgetFailureMessage(p95, VALIDATION_PERFORMANCE_BUDGET_P95_MS));
    }

    expect(p95).toBeLessThanOrEqual(VALIDATION_PERFORMANCE_BUDGET_P95_MS);
  });
});
