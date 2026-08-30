// @ts-nocheck — pre-existing missing-await patterns; tracked in issue #293 for future cleanup
/**
 * @file horizon-mock-smoke.test.ts
 *
 * Smoke tests that run `fetchAccount` and `runAccountChecks` against the
 * local WireMock mock Horizon server.
 *
 * ── How to run ────────────────────────────────────────────────────────────
 *   npm run mock:start                              # start mock container
 *   npm run test:mock                               # run these tests
 *   npm run mock:stop                               # stop container
 *
 * ── Skip behaviour ────────────────────────────────────────────────────────
 * All tests are skipped when HORIZON_MOCK_URL is not set so the standard
 * `npm test` pipeline is never affected. CI runs these tests only in the
 * opt-in `mock-horizon-smoke` job.
 *
 * ── Stub addresses ────────────────────────────────────────────────────────
 * See mock/horizon/mappings/ for the WireMock stub definitions.
 *
 * FUNDED_ADDRESS    — 200, USDC trustline, 10 XLM  (all checks pass)
 * UNFUNDED_ADDRESS  — 404 not found               (unfunded result)
 * LOW_BAL_ADDRESS   — 200, USDC trustline, 0.5 XLM (reserve fails)
 * NO_TL_ADDRESS     — 200, no USDC trustline, 10 XLM (trustline fails)
 */

import { fetchAccount, HorizonError } from '../src/horizon';
import { runAccountChecks, unfundedAccountResult } from '../src/checks';

// ---------------------------------------------------------------------------
// Skip guard — all suites skip when the mock is not running
// ---------------------------------------------------------------------------

const MOCK_URL = process.env['HORIZON_MOCK_URL'];
const RUN = MOCK_URL !== undefined && MOCK_URL.trim() !== '';

const describeIfMock = RUN ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Test addresses — must match mock/horizon/mappings/*.json
// ---------------------------------------------------------------------------

/** Funded account: 10 XLM + USDC trustline — all checks pass */
const FUNDED_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** Unfunded account: Horizon returns 404 */
const UNFUNDED_ADDRESS = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

/** Low balance: 0.5 XLM + USDC trustline — reserve check fails */
const LOW_BAL_ADDRESS = 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

/** No trustline: 10 XLM, no USDC trustline — trustline check fails */
const NO_TL_ADDRESS = 'GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

const checkConfig = {
  assetCode: 'USDC',
  assetIssuer: USDC_ISSUER,
  minXlmReserve: 1.5,
  horizonUrl: MOCK_URL ?? 'http://localhost:8089',
};

const fetchOpts = {
  timeoutMs: 5000,
  maxRetries: 0,   // no retries in smoke tests — fail fast on unexpected responses
  cacheTtlMs: 0,   // always hit the mock; no in-memory caching
};

// ---------------------------------------------------------------------------
// Suite: mock server reachability
// ---------------------------------------------------------------------------

describeIfMock('mock Horizon reachability', () => {
  it('mock server responds to a known funded address (200)', async () => {
    const account = await fetchAccount(MOCK_URL!, FUNDED_ADDRESS, fetchOpts);
    expect(account.account_id).toBe(FUNDED_ADDRESS);
  });
});

// ---------------------------------------------------------------------------
// Suite: funded account — all checks pass
// ---------------------------------------------------------------------------

describeIfMock('mock Horizon: funded account (all checks pass)', () => {
  it('fetchAccount returns a HorizonAccount with native + USDC balances', async () => {
    const account = await fetchAccount(MOCK_URL!, FUNDED_ADDRESS, fetchOpts);

    expect(account.account_id).toBe(FUNDED_ADDRESS);

    const native = account.balances.find(b => b.asset_type === 'native');
    expect(native).toBeDefined();
    expect(parseFloat(native!.balance)).toBeGreaterThanOrEqual(1.5);

    const usdc = account.balances.find(
      b => b.asset_type !== 'native' &&
           (b as { asset_code?: string }).asset_code === 'USDC',
    );
    expect(usdc).toBeDefined();
  });

  it('runAccountChecks returns valid=true for the funded address', async () => {
    const account = await fetchAccount(MOCK_URL!, FUNDED_ADDRESS, fetchOpts);
    const result = runAccountChecks(account, checkConfig);

    expect(result.valid).toBe(true);
    expect(result.accountFunded).toBe(true);
    expect(result.trustlineExists).toBe(true);
    expect(result.xlmReserveMet).toBe(true);
    expect(result.checks.every(c => c.passed)).toBe(true);
    expect(result.remediation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Suite: unfunded account — 404 from mock
// ---------------------------------------------------------------------------

describeIfMock('mock Horizon: unfunded account (404)', () => {
  it('fetchAccount throws a HorizonError with statusCode 404', async () => {
    await expect(
      fetchAccount(MOCK_URL!, UNFUNDED_ADDRESS, fetchOpts),
    ).rejects.toMatchObject({
      statusCode: 404,
      retryable: false,
    } satisfies Partial<HorizonError>);
  });

  it('unfundedAccountResult produces valid=false with remediation', () => {
    const result = unfundedAccountResult(UNFUNDED_ADDRESS, checkConfig);

    expect(result.valid).toBe(false);
    expect(result.accountFunded).toBe(false);
    expect(result.trustlineExists).toBe(false);
    expect(result.xlmBalance).toBe('0');
    expect(result.remediation).toMatch(/Activate/i);
  });
});

// ---------------------------------------------------------------------------
// Suite: low XLM balance — reserve check fails
// ---------------------------------------------------------------------------

describeIfMock('mock Horizon: low XLM balance (reserve check fails)', () => {
  it('fetchAccount returns the account successfully', async () => {
    const account = await fetchAccount(MOCK_URL!, LOW_BAL_ADDRESS, fetchOpts);
    expect(account.account_id).toBe(LOW_BAL_ADDRESS);
  });

  it('runAccountChecks reports xlmReserveMet=false and valid=false', async () => {
    const account = await fetchAccount(MOCK_URL!, LOW_BAL_ADDRESS, fetchOpts);
    const result = runAccountChecks(account, checkConfig);

    expect(result.valid).toBe(false);
    expect(result.accountFunded).toBe(true);
    expect(result.trustlineExists).toBe(true);
    expect(result.xlmReserveMet).toBe(false);
    expect(result.remediation).toMatch(/Send at least/i);
  });

  it('xlmBalance in result matches mock stub value (0.5)', async () => {
    const account = await fetchAccount(MOCK_URL!, LOW_BAL_ADDRESS, fetchOpts);
    const result = runAccountChecks(account, checkConfig);
    expect(parseFloat(result.xlmBalance)).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Suite: no trustline — trustline check fails
// ---------------------------------------------------------------------------

describeIfMock('mock Horizon: no USDC trustline (trustline check fails)', () => {
  it('fetchAccount returns the account successfully', async () => {
    const account = await fetchAccount(MOCK_URL!, NO_TL_ADDRESS, fetchOpts);
    expect(account.account_id).toBe(NO_TL_ADDRESS);
  });

  it('runAccountChecks reports trustlineExists=false and valid=false', async () => {
    const account = await fetchAccount(MOCK_URL!, NO_TL_ADDRESS, fetchOpts);
    const result = runAccountChecks(account, checkConfig);

    expect(result.valid).toBe(false);
    expect(result.accountFunded).toBe(true);
    expect(result.trustlineExists).toBe(false);
    expect(result.xlmReserveMet).toBe(true);
    expect(result.remediation).toMatch(/trustline/i);
  });
});

// ---------------------------------------------------------------------------
// Informational test — always runs, documents the skip behaviour
// ---------------------------------------------------------------------------

describe('mock smoke test skip guard', () => {
  it('documents that mock tests are skipped when HORIZON_MOCK_URL is not set', () => {
    if (!RUN) {
      // This is the expected state in standard npm test runs.
      expect(MOCK_URL).toBeUndefined();
    } else {
      // When the mock is running, HORIZON_MOCK_URL points at the container.
      expect(MOCK_URL).toMatch(/^https?:\/\//);
    }
  });
});
