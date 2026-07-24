import {
  isValidStellarAddress,
  normalizeStellarAddress,
  parseMinXlmReserve,
  runAccountChecks,
  unfundedAccountResult,
  validateStellarAddress,
  getFailedCheckLabels,
  formatXlmDeficit,
  estimateTrustlineSetupCost,
  buildReserveRequirement,
  horizonFailureResult,
  STELLAR_BASE_RESERVE_XLM,
  STELLAR_MIN_ACCOUNT_BALANCE_XLM,
} from '../src/checks';
import { HorizonAccount } from '../src/horizon';

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const TEST_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

const defaultConfig = {
  assetCode: 'USDC',
  assetIssuer: USDC_ISSUER,
  minXlmReserve: 1.5,
};

function makeAccount(overrides: Partial<HorizonAccount> = {}): HorizonAccount {
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
    ...overrides,
  };
}

describe('isValidStellarAddress', () => {
  it('accepts a valid 56-character G-address', () => {
    expect(isValidStellarAddress(TEST_ADDRESS)).toBe(true);
  });

  it('rejects addresses not starting with G', () => {
    expect(isValidStellarAddress('B' + TEST_ADDRESS.slice(1))).toBe(false);
  });

  it('rejects addresses with wrong length', () => {
    expect(isValidStellarAddress('GABC')).toBe(false);
  });

  it('rejects invalid base32 characters', () => {
    expect(isValidStellarAddress('G' + '0'.repeat(55))).toBe(false);
  });
});

describe('normalizeStellarAddress', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeStellarAddress(`  ${TEST_ADDRESS}  `)).toBe(TEST_ADDRESS);
  });
});

describe('validateStellarAddress', () => {
  it('throws when address is empty', () => {
    expect(() => validateStellarAddress('')).toThrow(/required/i);
  });

  it('throws for invalid format', () => {
    expect(() => validateStellarAddress('not-a-stellar-address')).toThrow(/Invalid Stellar address/i);
  });
});

describe('parseMinXlmReserve', () => {
  it('parses valid numeric strings', () => {
    expect(parseMinXlmReserve('1.5')).toBe(1.5);
  });

  it('trims valid numeric strings', () => {
    expect(parseMinXlmReserve(' 2.25 ')).toBe(2.25);
  });

  it('throws for non-numeric values', () => {
    expect(() => parseMinXlmReserve('abc')).toThrow(/min_xlm_reserve/i);
  });

  it('throws for blank values', () => {
    expect(() => parseMinXlmReserve('   ')).toThrow(/min_xlm_reserve/i);
  });

  it('throws for non-finite values', () => {
    expect(() => parseMinXlmReserve('Infinity')).toThrow(/min_xlm_reserve/i);
  });

  it('throws for negative values', () => {
    expect(() => parseMinXlmReserve('-1')).toThrow(/min_xlm_reserve/i);
  });
});

describe('estimateTrustlineSetupCost', () => {
  it('adds account and trustline reserves', () => {
    expect(estimateTrustlineSetupCost()).toBe(1.5);
  });
});

describe('formatXlmDeficit', () => {
  it('formats missing reserve without going negative', () => {
    expect(formatXlmDeficit(1.5, 1)).toBe('0.5000000');
    expect(formatXlmDeficit(1.5, 2)).toBe('0.0000000');
  });
});

describe('runAccountChecks', () => {
  it('passes when account is funded, has trustline, and meets reserve', () => {
    const result = runAccountChecks(makeAccount(), defaultConfig);

    expect(result.valid).toBe(true);
    expect(result.accountFunded).toBe(true);
    expect(result.trustlineExists).toBe(true);
    expect(result.xlmReserveMet).toBe(true);
    expect(result.xlmBalance).toBe('10.0000000');
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it('fails when USDC trustline is missing', () => {
    const account = makeAccount({
      balances: [
        {
          balance: '10.0000000',
          asset_type: 'native',
          buying_liabilities: '0.0000000',
          selling_liabilities: '0.0000000',
        },
      ],
    });

    const result = runAccountChecks(account, defaultConfig);

    expect(result.valid).toBe(false);
    expect(result.trustlineExists).toBe(false);
    expect(result.checks[1].passed).toBe(false);
    expect(result.checks[1].detail).toMatch(/zero trustlines/i);
    expect(result.remediation).toMatch(/Stellar Laboratory/i);
  });

  it('fails when account has trustlines but not for the target asset', () => {
    const account = makeAccount({
      balances: [
        {
          balance: '10.0000000',
          asset_type: 'native',
          buying_liabilities: '0.0000000',
          selling_liabilities: '0.0000000',
        },
        {
          balance: '5.0000000',
          asset_type: 'credit_alphanum4',
          asset_code: 'EURT',
          asset_issuer: 'GCQTGZQQ5G4PTM2RNQRAXRJJEL5CQ5Z2OY5SUJRE763CPEKE6EJUMCU',
          buying_liabilities: '0.0000000',
          selling_liabilities: '0.0000000',
        },
      ],
    });

    const result = runAccountChecks(account, defaultConfig);

    expect(result.trustlineExists).toBe(false);
    expect(result.checks[1].detail).toMatch(/not for \*\*USDC\*\*/i);
  });

  it('fails when XLM balance is below minimum reserve', () => {
    const account = makeAccount({
      balances: [
        {
          balance: '1.0000000',
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
    });

    const result = runAccountChecks(account, defaultConfig);

    expect(result.valid).toBe(false);
    expect(result.xlmReserveMet).toBe(false);
    expect(result.checks[2].passed).toBe(false);
    expect(result.remediation).toMatch(/Send at least/i);
  });

  it('matches asset by code and issuer exactly', () => {
    const account = makeAccount({
      balances: [
        {
          balance: '10.0000000',
          asset_type: 'native',
          buying_liabilities: '0.0000000',
          selling_liabilities: '0.0000000',
        },
        {
          balance: '1.0000000',
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: 'GDIFFERENTISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          buying_liabilities: '0.0000000',
          selling_liabilities: '0.0000000',
        },
      ],
    });

    const result = runAccountChecks(account, defaultConfig);
    expect(result.trustlineExists).toBe(false);
  });
});

describe('getFailedCheckLabels', () => {
  it('returns labels for failed checks only', () => {
    const result = runAccountChecks(makeAccount({ balances: [] }), defaultConfig);
    expect(getFailedCheckLabels(result)).toEqual(['USDC trustline', 'XLM reserve']);
  });
});

describe('unfundedAccountResult', () => {
  it('returns all checks failed with remediation guidance', () => {
    const result = unfundedAccountResult(TEST_ADDRESS, defaultConfig);

    expect(result.valid).toBe(false);
    expect(result.accountFunded).toBe(false);
    expect(result.trustlineExists).toBe(false);
    expect(result.xlmBalance).toBe('0');
    expect(result.remediation).toMatch(/Activate/);
    expect(result.remediation).toMatch(/Stellar Laboratory/);
    expect(result.remediation).toMatch(
      String(STELLAR_MIN_ACCOUNT_BALANCE_XLM + STELLAR_BASE_RESERVE_XLM),
    );
  });
});

describe('Stellar reserve constants', () => {
  it('exports documented reserve values', () => {
    expect(STELLAR_BASE_RESERVE_XLM).toBe(0.5);
    expect(STELLAR_MIN_ACCOUNT_BALANCE_XLM).toBe(1);
  });
});

describe('buildReserveRequirement', () => {
  it('summarizes reserve state', () => {
    expect(buildReserveRequirement(1.5, 1)).toEqual({
      required: 1.5,
      actual: 1,
      missing: '0.5000000',
      met: false,
    });
  });
});

describe('markdown escape hardening', () => {
  it('escapes untrusted Horizon error text before it becomes a check detail', () => {
    const maliciousMessage =
      'Horizon down [click here](https://evil.example) *urgent* `rm -rf /` __alert__';

    const result = horizonFailureResult(maliciousMessage, defaultConfig);

    const detail = result.checks[0].detail;
    expect(detail).not.toContain('[click here](https://evil.example)');
    expect(detail).not.toContain('*urgent*');
    expect(detail).not.toContain('`rm -rf /`');
    expect(detail).toContain('\\[click here\\]');
    expect(detail).toContain('\\*urgent\\*');
  });

  it('escapes a backtick in the issuer so it cannot close the inline-code span early', () => {
    const account = makeAccount();
    // A raw backtick here would close the surrounding `code span`, letting
    // the rest of the value render as live Markdown (e.g. a clickable link).
    const maliciousIssuer = 'GENUINE` [click me](https://evil.example) `INJECTED';

    const result = runAccountChecks(account, {
      ...defaultConfig,
      assetIssuer: maliciousIssuer,
    });

    const detail = result.checks[1].detail;
    expect(detail).toContain('\\`');
    expect(detail).not.toContain('GENUINE` [click me]');
  });

  it('escapes backticks in the stellar address for unfunded results', () => {
    const result = unfundedAccountResult('G`INJECTED`ADDRESS', defaultConfig);

    expect(result.checks[0].detail).toContain('\\`INJECTED\\`');
    expect(result.checks[0].detail).not.toMatch(/[^\\]`INJECTED[^\\]`/);
  });
});
