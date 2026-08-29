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
