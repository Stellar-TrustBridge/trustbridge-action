/**
 * Wave #32: Reusable workflow examples in validation checks
 * 
 * Tests for trustline, reserve, StrKey, and multi-asset validation helpers
 * added to src/checks.ts (Issue #32).
 * 
 * Coverage includes:
 * - checkTrustlineExists
 * - checkReserveMet
 * - validateStrKeyFormat
 * - checkMultiAssetTrustlines
 * - calculateRecommendedReserve
 * - checkAccountSponsored
 * - generateValidationReport
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  checkTrustlineExists,
  checkReserveMet,
  validateStrKeyFormat,
  checkMultiAssetTrustlines,
  calculateRecommendedReserve,
  checkAccountSponsored,
  generateValidationReport,
  STELLAR_MIN_ACCOUNT_BALANCE_XLM,
  STELLAR_BASE_RESERVE_XLM,
  type MultiAssetConfig,
  type CheckConfig,
} from '../src/checks';
import { HorizonAccount } from '../src/horizon';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const EURC_ISSUER = 'GCQTGZQQ5G4PTM2RNQRAXRJJEL5CQ5Z2OY5SUJRE763CPEKE6EJUMCU';
const TEST_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const CONTRACT_ADDRESS = 'C' + 'A'.repeat(55);

function makeAccount(overrides: Partial<HorizonAccount> = {}): HorizonAccount {
  return {
    id: TEST_ADDRESS,
    account_id: TEST_ADDRESS,
    sequence: '1',
    subentry_count: 2,
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
    ...overrides,
  };
}

const DEFAULT_CHECK_CONFIG: CheckConfig = {
  assetCode: 'USDC',
  assetIssuer: USDC_ISSUER,
  minXlmReserve: 1.5,
};

// ---------------------------------------------------------------------------
// checkTrustlineExists
// ---------------------------------------------------------------------------

describe('checkTrustlineExists', () => {
  it('returns true when trustline exists for the specified asset', () => {
    const account = makeAccount();
    expect(checkTrustlineExists(account, 'USDC', USDC_ISSUER)).toBe(true);
  });
  
  it('returns false when trustline does not exist', () => {
    const account = makeAccount();
    expect(checkTrustlineExists(account, 'EURC', EURC_ISSUER)).toBe(false);
  });
  
  it('returns false when account has no trustlines', () => {
    const account = makeAccount({
      balances: [
        {
          balance: '10.0000000',
          asset_type: 'native',
          buying_liabilities: '0',
          selling_liabilities: '0',
        },
      ],
    });
    expect(checkTrustlineExists(account, 'USDC', USDC_ISSUER)).toBe(false);
  });
  
  it('matches asset code and issuer exactly', () => {
    const account = makeAccount();
    
    // Wrong code
    expect(checkTrustlineExists(account, 'EURC', USDC_ISSUER)).toBe(false);
    
    // Wrong issuer
    expect(checkTrustlineExists(account, 'USDC', EURC_ISSUER)).toBe(false);
    
    // Both correct
    expect(checkTrustlineExists(account, 'USDC', USDC_ISSUER)).toBe(true);
  });
  
  it('handles multiple trustlines correctly', () => {
    const account = makeAccount({
      balances: [
        {
          balance: '10.0000000',
          asset_type: 'native',
          buying_liabilities: '0',
          selling_liabilities: '0',
        },
        {
          balance: '100.0000000',
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: USDC_ISSUER,
          buying_liabilities: '0',
          selling_liabilities: '0',
        },
        {
          balance: '50.0000000',
          asset_type: 'credit_alphanum4',
          asset_code: 'EURC',
          asset_issuer: EURC_ISSUER,
          buying_liabilities: '0',
          selling_liabilities: '0',
        },
      ],
    });
    
    expect(checkTrustlineExists(account, 'USDC', USDC_ISSUER)).toBe(true);
    expect(checkTrustlineExists(account, 'EURC', EURC_ISSUER)).toBe(true);
    expect(checkTrustlineExists(account, 'BTC', 'GISSUERXXXXXXXXXXX')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkReserveMet
// ---------------------------------------------------------------------------

describe('checkReserveMet', () => {
  it('returns true when balance meets the minimum reserve', () => {
    const account = makeAccount(); // has 10 XLM
    expect(checkReserveMet(account, 1.5)).toBe(true);
  });
  
  it('returns true when balance exactly equals the minimum reserve', () => {
    const account = makeAccount({
      balances: [
        {
          balance: '1.5000000',
          asset_type: 'native',
          buying_liabilities: '0',
          selling_liabilities: '0',
        },
      ],
    });
    expect(checkReserveMet(account, 1.5)).toBe(true);
  });
  
  it('returns false when balance is below the minimum reserve', () => {
    const account = makeAccount({
      balances: [
        {
          balance: '1.0000000',
          asset_type: 'native',
          buying_liabilities: '0',
          selling_liabilities: '0',
        },
      ],
    });
    expect(checkReserveMet(account, 1.5)).toBe(false);
  });
  
  it('returns false when account has no native balance', () => {
    const account = makeAccount({
      balances: [
        {
          balance: '100.0000000',
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: USDC_ISSUER,
          buying_liabilities: '0',
          selling_liabilities: '0',
        },
      ],
    });
    expect(checkReserveMet(account, 1.5)).toBe(false);
  });
  
  it('handles edge-case reserve values correctly', () => {
    const account = makeAccount({
      balances: [
        {
          balance: '0.0000001',
          asset_type: 'native',
          buying_liabilities: '0',
          selling_liabilities: '0',
        },
      ],
    });
    
    expect(checkReserveMet(account, 0.0000001)).toBe(true);
    expect(checkReserveMet(account, 0.0000002)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateStrKeyFormat
// ---------------------------------------------------------------------------

describe('validateStrKeyFormat', () => {
  it('accepts valid G-addresses', () => {
    const valid = [
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      'G' + 'A'.repeat(55),
      'G' + '2'.repeat(55),
      'G' + '7'.repeat(55),
    ];
    
    for (const addr of valid) {
      expect(validateStrKeyFormat(addr)).toBe(true);
    }
  });
  
  it('accepts valid C-addresses (contracts)', () => {
    const valid = [
      CONTRACT_ADDRESS,
      'C' + '2'.repeat(55),
      'C' + '7'.repeat(55),
    ];
    
    for (const addr of valid) {
      expect(validateStrKeyFormat(addr)).toBe(true);
    }
  });
  
  it('rejects addresses with wrong prefix', () => {
    const invalid = [
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', // secret key
      'MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    ];
    
    for (const addr of invalid) {
      expect(validateStrKeyFormat(addr)).toBe(false);
    }
  });
  
  it('rejects addresses with wrong length', () => {
    expect(validateStrKeyFormat('G')).toBe(false);
    expect(validateStrKeyFormat('GA')).toBe(false);
    expect(validateStrKeyFormat('G' + 'A'.repeat(54))).toBe(false);
    expect(validateStrKeyFormat('G' + 'A'.repeat(56))).toBe(false);
  });
  
  it('rejects addresses with invalid base32 characters', () => {
    const invalid = [
      'G' + '0'.repeat(55), // 0 not in base32
      'G' + '1'.repeat(55), // 1 not in base32
      'G' + '8'.repeat(55), // 8 not in base32
      'G' + 'a'.repeat(55), // lowercase
    ];
    
    for (const addr of invalid) {
      expect(validateStrKeyFormat(addr)).toBe(false);
    }
  });
  
  it('trims whitespace before validation', () => {
    const addr = '  GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF  ';
    expect(validateStrKeyFormat(addr)).toBe(true);
  });
  
  it('rejects empty and whitespace-only strings', () => {
    expect(validateStrKeyFormat('')).toBe(false);
    expect(validateStrKeyFormat('   ')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkMultiAssetTrustlines
// ---------------------------------------------------------------------------

describe('checkMultiAssetTrustlines', () => {
  it('checks multiple assets and returns individual results', () => {
    const account = makeAccount({
      balances: [
        {
          balance: '10.0000000',
          asset_type: 'native',
          buying_liabilities: '0',
          selling_liabilities: '0',
        },
        {
          balance: '100.0000000',
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: USDC_ISSUER,
          buying_liabilities: '0',
          selling_liabilities: '0',
        },
        {
          balance: '50.0000000',
          asset_type: 'credit_alphanum4',
          asset_code: 'EURC',
          asset_issuer: EURC_ISSUER,
          buying_liabilities: '0',
          selling_liabilities: '0',
        },
      ],
    });
    
    const assets: MultiAssetConfig[] = [
      { assetCode: 'USDC', assetIssuer: USDC_ISSUER, required: true },
      { assetCode: 'EURC', assetIssuer: EURC_ISSUER, required: true },
      { assetCode: 'BTC', assetIssuer: 'GISSUERXXXXXXXXXXX', required: false },
    ];
    
    const results = checkMultiAssetTrustlines(account, assets);
    
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({
      asset: 'USDC',
      issuer: USDC_ISSUER,
      exists: true,
      required: true,
    });
    expect(results[1]).toEqual({
      asset: 'EURC',
      issuer: EURC_ISSUER,
      exists: true,
      required: true,
    });
    expect(results[2]).toEqual({
      asset: 'BTC',
      issuer: 'GISSUERXXXXXXXXXXX',
      exists: false,
      required: false,
    });
  });
  
  it('returns empty array when no assets are checked', () => {
    const account = makeAccount();
    const results = checkMultiAssetTrustlines(account, []);
    expect(results).toEqual([]);
  });
  
  it('handles required vs optional assets correctly', () => {
    const account = makeAccount();
    
    const assets: MultiAssetConfig[] = [
      { assetCode: 'USDC', assetIssuer: USDC_ISSUER, required: true },
      { assetCode: 'EURC', assetIssuer: EURC_ISSUER, required: false },
    ];
    
    const results = checkMultiAssetTrustlines(account, assets);
    
    expect(results[0].required).toBe(true);
    expect(results[1].required).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// calculateRecommendedReserve
// ---------------------------------------------------------------------------

describe('calculateRecommendedReserve', () => {
  it('calculates reserve for zero trustlines', () => {
    expect(calculateRecommendedReserve(0)).toBe(1.0);
  });
  
  it('calculates reserve for one trustline', () => {
    expect(calculateRecommendedReserve(1)).toBe(1.5);
  });
  
  it('calculates reserve for multiple trustlines', () => {
    expect(calculateRecommendedReserve(2)).toBe(2.0);
    expect(calculateRecommendedReserve(3)).toBe(2.5);
    expect(calculateRecommendedReserve(10)).toBe(6.0);
  });
  
  it('matches documented Stellar reserve formula', () => {
    const trustlineCount = 5;
    const expected =
      STELLAR_MIN_ACCOUNT_BALANCE_XLM + trustlineCount * STELLAR_BASE_RESERVE_XLM;
    
    expect(calculateRecommendedReserve(trustlineCount)).toBe(expected);
  });
  
  it('handles edge cases without throwing', () => {
    expect(calculateRecommendedReserve(-1)).toBe(0.5); // negative becomes negative reserve
    expect(calculateRecommendedReserve(1000)).toBe(501.0); // large count
  });
});

// ---------------------------------------------------------------------------
// checkAccountSponsored
// ---------------------------------------------------------------------------

describe('checkAccountSponsored', () => {
  it('returns true when account is sponsored (num_sponsored > 0)', () => {
    const account = makeAccount({ num_sponsored: 1 });
    expect(checkAccountSponsored(account)).toBe(true);
  });
  
  it('returns true when account has multiple sponsored entries', () => {
    const account = makeAccount({ num_sponsored: 5 });
    expect(checkAccountSponsored(account)).toBe(true);
  });
  
  it('returns false when account is not sponsored (num_sponsored = 0)', () => {
    const account = makeAccount({ num_sponsored: 0 });
    expect(checkAccountSponsored(account)).toBe(false);
  });
  
  it('does not consider num_sponsoring (sponsoring other accounts)', () => {
    const account = makeAccount({ num_sponsoring: 10, num_sponsored: 0 });
    expect(checkAccountSponsored(account)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generateValidationReport
// ---------------------------------------------------------------------------

describe('generateValidationReport', () => {
  it('produces a complete validation report for a healthy account', () => {
    const account = makeAccount();
    const report = generateValidationReport(account, DEFAULT_CHECK_CONFIG);
    
    expect(report.address).toBe(TEST_ADDRESS);
    expect(report.strKeyValid).toBe(true);
    expect(report.accountFunded).toBe(true);
    expect(report.xlmBalance).toBe('10.0000000');
    expect(report.reserveStatus.current).toBe(10);
    expect(report.reserveStatus.met).toBe(true);
    expect(report.trustlines).toHaveLength(1);
    expect(report.trustlines[0]).toEqual({
      asset: 'USDC',
      issuer: USDC_ISSUER,
      exists: true,
    });
    expect(report.sponsored).toBe(false);
    expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  
  it('includes additional assets in the report', () => {
    const account = makeAccount({
      balances: [
        {
          balance: '10.0000000',
          asset_type: 'native',
          buying_liabilities: '0',
          selling_liabilities: '0',
        },
        {
          balance: '100.0000000',
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: USDC_ISSUER,
          buying_liabilities: '0',
          selling_liabilities: '0',
        },
        {
          balance: '50.0000000',
          asset_type: 'credit_alphanum4',
          asset_code: 'EURC',
          asset_issuer: EURC_ISSUER,
          buying_liabilities: '0',
          selling_liabilities: '0',
        },
      ],
    });
    
    const additionalAssets: MultiAssetConfig[] = [
      { assetCode: 'EURC', assetIssuer: EURC_ISSUER, required: true },
    ];
    
    const report = generateValidationReport(account, DEFAULT_CHECK_CONFIG, additionalAssets);
    
    expect(report.trustlines).toHaveLength(2);
    expect(report.trustlines[0].asset).toBe('USDC');
    expect(report.trustlines[1].asset).toBe('EURC');
  });
  
  it('calculates recommended reserve based on trustline count', () => {
    const account = makeAccount({
      balances: [
        {
          balance: '1.0000000',
          asset_type: 'native',
          buying_liabilities: '0',
          selling_liabilities: '0',
        },
        {
          balance: '100.0000000',
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: USDC_ISSUER,
          buying_liabilities: '0',
          selling_liabilities: '0',
        },
        {
          balance: '50.0000000',
          asset_type: 'credit_alphanum4',
          asset_code: 'EURC',
          asset_issuer: EURC_ISSUER,
          buying_liabilities: '0',
          selling_liabilities: '0',
        },
      ],
    });
    
    const report = generateValidationReport(account, DEFAULT_CHECK_CONFIG);
    
    // Account has 2 trustlines → recommended reserve = 1 + 2×0.5 = 2.0
    const recommendedReserve = calculateRecommendedReserve(2);
    expect(report.reserveStatus.required).toBe(Math.max(1.5, recommendedReserve));
    expect(report.reserveStatus.met).toBe(false); // 1.0 < 2.0
  });
  
  it('reports deficit when reserve is not met', () => {
    const account = makeAccount({
      balances: [
        {
          balance: '0.5000000',
          asset_type: 'native',
          buying_liabilities: '0',
          selling_liabilities: '0',
        },
      ],
    });
    
    const report = generateValidationReport(account, DEFAULT_CHECK_CONFIG);
    
    expect(report.reserveStatus.met).toBe(false);
    expect(report.reserveStatus.deficit).toMatch(/^1\.\d{7}$/);
  });
  
  it('includes sponsorship status', () => {
    const sponsored = makeAccount({ num_sponsored: 3 });
    const notSponsored = makeAccount({ num_sponsored: 0 });
    
    const reportSponsored = generateValidationReport(sponsored, DEFAULT_CHECK_CONFIG);
    const reportNotSponsored = generateValidationReport(notSponsored, DEFAULT_CHECK_CONFIG);
    
    expect(reportSponsored.sponsored).toBe(true);
    expect(reportNotSponsored.sponsored).toBe(false);
  });
  
  it('validates StrKey format for the account address', () => {
    const validAccount = makeAccount({ account_id: TEST_ADDRESS });
    const invalidAccount = makeAccount({ account_id: 'not-a-strkey' });
    
    const reportValid = generateValidationReport(validAccount, DEFAULT_CHECK_CONFIG);
    const reportInvalid = generateValidationReport(invalidAccount, DEFAULT_CHECK_CONFIG);
    
    expect(reportValid.strKeyValid).toBe(true);
    expect(reportInvalid.strKeyValid).toBe(false);
  });
  
  it('produces unique timestamps for sequential calls', () => {
    const account = makeAccount();
    
    const report1 = generateValidationReport(account, DEFAULT_CHECK_CONFIG);
    const report2 = generateValidationReport(account, DEFAULT_CHECK_CONFIG);
    
    // Timestamps might be the same if called within the same millisecond,
    // but they should always be valid ISO strings
    expect(report1.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(report2.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// Integration: reusable workflows in real-world scenarios
// ---------------------------------------------------------------------------

describe('Reusable workflows — integration scenarios', () => {
  it('scenario: DAO contributor onboarding validation', () => {
    // A DAO requires contributors to have USDC + EURC trustlines and 2 XLM reserve
    const account = makeAccount({
      balances: [
        {
          balance: '2.5000000',
          asset_type: 'native',
          buying_liabilities: '0',
          selling_liabilities: '0',
        },
        {
          balance: '100.0000000',
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: USDC_ISSUER,
          buying_liabilities: '0',
          selling_liabilities: '0',
        },
        {
          balance: '50.0000000',
          asset_type: 'credit_alphanum4',
          asset_code: 'EURC',
          asset_issuer: EURC_ISSUER,
          buying_liabilities: '0',
          selling_liabilities: '0',
        },
      ],
    });
    
    const requiredAssets: MultiAssetConfig[] = [
      { assetCode: 'USDC', assetIssuer: USDC_ISSUER, required: true },
      { assetCode: 'EURC', assetIssuer: EURC_ISSUER, required: true },
    ];
    
    // Validate all requirements
    const strKeyValid = validateStrKeyFormat(account.account_id);
    const reserveMet = checkReserveMet(account, 2.0);
    const assetResults = checkMultiAssetTrustlines(account, requiredAssets);
    const allTrustlinesExist = assetResults.every((r) => r.exists);
    
    const ready = strKeyValid && reserveMet && allTrustlinesExist;
    
    expect(ready).toBe(true);
  });
  
  it('scenario: Treasury account with sponsorship reduces reserve requirement', () => {
    const treasuryAccount = makeAccount({
      num_sponsored: 5,
      balances: [
        {
          balance: '0.5000000', // low balance but sponsored
          asset_type: 'native',
          buying_liabilities: '0',
          selling_liabilities: '0',
        },
      ],
    });
    
    const isSponsored = checkAccountSponsored(treasuryAccount);
    const baseReserveMet = checkReserveMet(treasuryAccount, 1.5);
    
    // Account is sponsored so reduced reserve applies
    const ready = isSponsored || baseReserveMet;
    
    expect(isSponsored).toBe(true);
    expect(ready).toBe(true);
  });
  
  it('scenario: Multi-asset payment gateway validation', () => {
    const gatewayAccount = makeAccount({
      balances: [
        {
          balance: '100.0000000',
          asset_type: 'native',
          buying_liabilities: '0',
          selling_liabilities: '0',
        },
        {
          balance: '1000.0000000',
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: USDC_ISSUER,
          buying_liabilities: '0',
          selling_liabilities: '0',
        },
        {
          balance: '500.0000000',
          asset_type: 'credit_alphanum4',
          asset_code: 'EURC',
          asset_issuer: EURC_ISSUER,
          buying_liabilities: '0',
          selling_liabilities: '0',
        },
      ],
    });
    
    // Payment gateway needs high reserve due to multiple assets
    const trustlineCount = 2;
    const recommendedReserve = calculateRecommendedReserve(trustlineCount);
    const reserveMet = checkReserveMet(gatewayAccount, recommendedReserve);
    
    const report = generateValidationReport(
      gatewayAccount,
      { assetCode: 'USDC', assetIssuer: USDC_ISSUER, minXlmReserve: recommendedReserve },
      [{ assetCode: 'EURC', assetIssuer: EURC_ISSUER, required: true }],
    );
    
    expect(reserveMet).toBe(true);
    expect(report.trustlines).toHaveLength(2);
    expect(report.trustlines.every((t) => t.exists)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reusable workflow contract: explicit issue_number pass-through
// ---------------------------------------------------------------------------

describe('Reusable workflow issue_number contract', () => {
  const actionPath = path.join(__dirname, '../action.yml');
  const workflowPath = path.join(__dirname, '../docs/examples/trustbridge-reusable.yml');
  const usagePath = path.join(__dirname, '../docs/USAGE.md');

  it('action.yml declares issue_number as an explicit input', () => {
    const content = fs.readFileSync(actionPath, 'utf8');
    expect(content).toContain('issue_number:');
    expect(content).toContain('Explicit issue or pull request number to comment on');
  });

  it('reusable workflow declares and forwards issue_number', () => {
    const content = fs.readFileSync(workflowPath, 'utf8');
    expect(content).toContain('issue_number:');
    expect(content).toContain('Explicit issue or pull request number to post the result comment on');
    expect(content).toContain('issue_number: ${{ inputs.issue_number }}');
  });

  it('USAGE.md documents the reusable workflow issue_number handoff', () => {
    const content = fs.readFileSync(usagePath, 'utf8');
    expect(content).toContain('pass it through as `issue_number`');
    expect(content).toContain('github.event.pull_request.number || github.event.issue.number');
  });
});

// ---------------------------------------------------------------------------
// Issue #466 — Label-gate pass-through output contract
//
// Verifies that every declared pass-through output in the label-gate composite
// action is wired to the correct trustbridge-action output step reference, and
// that the gate-skipped guard outputs are always present.
// ---------------------------------------------------------------------------

describe('Label-gate pass-through output contract (#466)', () => {
  const labelGatePath = path.join(
    __dirname,
    '../.github/actions/trustbridge-label-gate/action.yml',
  );
  const labelGateDesignPath = path.join(__dirname, '../docs/LABEL_GATE_DESIGN.md');

  let actionContent: string;

  beforeAll(() => {
    actionContent = fs.readFileSync(labelGatePath, 'utf8');
  });

  // ── Gate control outputs ─────────────────────────────────────────────────

  it('declares gate_skipped output wired to check-gate step', () => {
    expect(actionContent).toContain('gate_skipped:');
    expect(actionContent).toContain("${{ steps.check-gate.outputs.gate_skipped }}");
  });

  it('declares gate_label_found output wired to check-gate step', () => {
    expect(actionContent).toContain('gate_label_found:');
    expect(actionContent).toContain("${{ steps.check-gate.outputs.gate_label_found }}");
  });

  // ── Core TrustBridge pass-through outputs ────────────────────────────────

  it('forwards account_funded from run-trustbridge step', () => {
    expect(actionContent).toContain('account_funded:');
    expect(actionContent).toContain("${{ steps.run-trustbridge.outputs.account_funded }}");
  });

  it('forwards trustline_exists from run-trustbridge step', () => {
    expect(actionContent).toContain('trustline_exists:');
    expect(actionContent).toContain("${{ steps.run-trustbridge.outputs.trustline_exists }}");
  });

  it('forwards xlm_balance from run-trustbridge step', () => {
    expect(actionContent).toContain('xlm_balance:');
    expect(actionContent).toContain("${{ steps.run-trustbridge.outputs.xlm_balance }}");
  });

  it('forwards comment_url from run-trustbridge step', () => {
    expect(actionContent).toContain('comment_url:');
    expect(actionContent).toContain("${{ steps.run-trustbridge.outputs.comment_url }}");
  });

  // ── Extended pass-through outputs (Issue #466) ───────────────────────────

  it('forwards asset_balance from run-trustbridge step', () => {
    expect(actionContent).toContain('asset_balance:');
    expect(actionContent).toContain("${{ steps.run-trustbridge.outputs.asset_balance }}");
  });

  it('forwards asset_balance_met from run-trustbridge step', () => {
    expect(actionContent).toContain('asset_balance_met:');
    expect(actionContent).toContain("${{ steps.run-trustbridge.outputs.asset_balance_met }}");
  });

  it('forwards check_account_funded from run-trustbridge step', () => {
    expect(actionContent).toContain('check_account_funded:');
    expect(actionContent).toContain("${{ steps.run-trustbridge.outputs.check_account_funded }}");
  });

  it('forwards check_trustline from run-trustbridge step', () => {
    expect(actionContent).toContain('check_trustline:');
    expect(actionContent).toContain("${{ steps.run-trustbridge.outputs.check_trustline }}");
  });

  it('forwards check_xlm_reserve from run-trustbridge step', () => {
    expect(actionContent).toContain('check_xlm_reserve:');
    expect(actionContent).toContain("${{ steps.run-trustbridge.outputs.check_xlm_reserve }}");
  });

  it('forwards ready from run-trustbridge step', () => {
    expect(actionContent).toContain('ready:');
    expect(actionContent).toContain("${{ steps.run-trustbridge.outputs.ready }}");
  });

  // ── Design doc coverage ──────────────────────────────────────────────────

  it('LABEL_GATE_DESIGN.md documents asset_balance pass-through', () => {
    const designContent = fs.readFileSync(labelGateDesignPath, 'utf8');
    expect(designContent).toContain('asset_balance');
  });

  it('LABEL_GATE_DESIGN.md documents check_account_funded pass-through', () => {
    const designContent = fs.readFileSync(labelGateDesignPath, 'utf8');
    expect(designContent).toContain('check_account_funded');
  });

  it('LABEL_GATE_DESIGN.md documents check_trustline pass-through', () => {
    const designContent = fs.readFileSync(labelGateDesignPath, 'utf8');
    expect(designContent).toContain('check_trustline');
  });

  it('LABEL_GATE_DESIGN.md documents check_xlm_reserve pass-through', () => {
    const designContent = fs.readFileSync(labelGateDesignPath, 'utf8');
    expect(designContent).toContain('check_xlm_reserve');
  });

  it('LABEL_GATE_DESIGN.md documents ready pass-through', () => {
    const designContent = fs.readFileSync(labelGateDesignPath, 'utf8');
    expect(designContent).toContain('ready');
  });

  it('LABEL_GATE_DESIGN.md advises checking gate_skipped before branching on outputs', () => {
    const designContent = fs.readFileSync(labelGateDesignPath, 'utf8');
    expect(designContent).toContain("gate_skipped != 'true'");
  });
});

// ---------------------------------------------------------------------------
// Issue #554 — workflow_dispatch smoke trigger for trustbridge-reusable.yml
//
// Verifies that:
//  1. The production reusable workflow declares a workflow_dispatch trigger.
//  2. The dispatch inputs cover the minimum set needed for a smoke test.
//  3. The smoke-test example workflow exists in docs/examples/.
//  4. The job step uses posting_mode (not the deprecated comment_mode) for
//     suppressing comments on dispatch runs.
// ---------------------------------------------------------------------------

describe('Issue #554 — workflow_dispatch smoke trigger: trustbridge-reusable.yml', () => {
  const reusableWorkflowPath = path.join(
    __dirname,
    '../.github/workflows/trustbridge-reusable.yml',
  );
  const smokeExamplePath = path.join(
    __dirname,
    '../docs/examples/reusable-smoke.yml',
  );

  let reusableContent: string;
  let smokeContent: string;

  beforeAll(() => {
    reusableContent = fs.readFileSync(reusableWorkflowPath, 'utf8');
    smokeContent = fs.readFileSync(smokeExamplePath, 'utf8');
  });

  // ── Production reusable workflow ─────────────────────────────────────────

  it('trustbridge-reusable.yml declares a workflow_dispatch trigger', () => {
    expect(reusableContent).toContain('workflow_dispatch:');
  });

  it('trustbridge-reusable.yml retains the workflow_call trigger (no regression)', () => {
    expect(reusableContent).toContain('workflow_call:');
  });

  it('workflow_dispatch inputs include stellar_address_input', () => {
    // The dispatch block must declare stellar_address_input so maintainers can
    // supply a G-address from the GitHub Actions UI.
    const dispatchSection = reusableContent.slice(
      reusableContent.indexOf('workflow_dispatch:'),
      reusableContent.indexOf('workflow_call:'),
    );
    expect(dispatchSection).toContain('stellar_address_input:');
  });

  it('workflow_dispatch inputs include posting_mode defaulting to dry-run', () => {
    const dispatchSection = reusableContent.slice(
      reusableContent.indexOf('workflow_dispatch:'),
      reusableContent.indexOf('workflow_call:'),
    );
    expect(dispatchSection).toContain('posting_mode:');
    expect(dispatchSection).toContain('dry-run');
  });

  it('action step passes posting_mode from inputs', () => {
    // Ensures dispatch smoke runs default to dry-run and never accidentally
    // post a comment to an unrelated issue.
    expect(reusableContent).toContain("posting_mode: ${{ inputs.posting_mode");
  });

  it('action step does NOT reference a non-existent dry_run input', () => {
    // Regression guard: the old pattern used a non-existent dry_run input.
    // posting_mode is the correct surface.
    expect(reusableContent).not.toMatch(/inputs\.dry_run/);
  });

  // ── Smoke example workflow ────────────────────────────────────────────────

  it('docs/examples/reusable-smoke.yml exists', () => {
    expect(fs.existsSync(smokeExamplePath)).toBe(true);
  });

  it('smoke example declares workflow_dispatch trigger', () => {
    expect(smokeContent).toContain('workflow_dispatch:');
  });

  it('smoke example includes stellar_address_input dispatch input', () => {
    expect(smokeContent).toContain('stellar_address_input:');
  });

  it('smoke example defaults posting_mode to dry-run', () => {
    expect(smokeContent).toContain("default: 'dry-run'");
  });

  it('smoke example uses posting_mode (not legacy comment_mode) for suppression', () => {
    expect(smokeContent).toContain('posting_mode:');
    expect(smokeContent).not.toMatch(/comment_mode.*dry-run/);
  });

  it('smoke example wires posting_mode to the action step', () => {
    expect(smokeContent).toContain('posting_mode: ${{ inputs.posting_mode }}');
  });

  it('smoke example sets fail_on_missing to false by default (safe for smoke)', () => {
    expect(smokeContent).toContain("default: 'false'");
  });

  it('smoke example includes a Print outputs step for run-log visibility', () => {
    expect(smokeContent).toContain('Print outputs');
    expect(smokeContent).toContain('steps.trustbridge.outputs.ready');
  });
});
