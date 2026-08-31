// @ts-nocheck — pre-existing missing-await patterns; tracked in issue #293 for future cleanup
import {
  isValidStellarAddress,
  isValidMuxedAddress,
  decodeMuxedAddress,
  convertMuxedToGAddress,
  normalizeStellarAddress,
  parseMinAssetBalance,
  parseMinXlmReserve,
  runAccountChecks,
  runMultiAssetChecks,
  unfundedAccountResult,
  validateStellarAddress,
  getFailedCheckLabels,
  formatXlmDeficit,
  formatAssetDeficit,
  estimateTrustlineSetupCost,
  buildReserveRequirement,
  computeProtocolMinReserve,
  buildValidationGate,
  horizonFailureResult,
  tlsFailureResult,
  buildAssetBalanceRequirement,
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
  it('accepts a valid 56-character G-address', async () => {
    expect(isValidStellarAddress(TEST_ADDRESS)).toBe(true);
  });

  it('rejects addresses not starting with G', async () => {
    expect(isValidStellarAddress('B' + TEST_ADDRESS.slice(1))).toBe(false);
  });

  it('rejects addresses with wrong length', async () => {
    expect(isValidStellarAddress('GABC')).toBe(false);
  });

  it('rejects invalid base32 characters', async () => {
    expect(isValidStellarAddress('G' + '0'.repeat(55))).toBe(false);
  });
});

describe('normalizeStellarAddress', () => {
  it('trims surrounding whitespace', async () => {
    expect(normalizeStellarAddress(`  ${TEST_ADDRESS}  `)).toBe(TEST_ADDRESS);
  });
});

describe('validateStellarAddress', () => {
  it('throws when address is empty', async () => {
    expect(() => validateStellarAddress('')).toThrow(/required/i);
  });

  it('throws for invalid format', async () => {
    expect(() => validateStellarAddress('not-a-stellar-address')).toThrow(/Invalid Stellar address/i);
  });
});

describe('parseMinXlmReserve', () => {
  it('parses valid numeric strings', async () => {
    expect(parseMinXlmReserve('1.5')).toBe('1.5');
  });

  it('trims valid numeric strings', async () => {
    expect(parseMinXlmReserve(' 2.25 ')).toBe('2.25');
  });

  it('throws for non-numeric values', async () => {
    expect(() => parseMinXlmReserve('abc')).toThrow(/min_xlm_reserve/i);
  });

  it('throws for blank values', async () => {
    expect(() => parseMinXlmReserve('   ')).toThrow(/min_xlm_reserve/i);
  });

  it('throws for non-finite values', async () => {
    expect(() => parseMinXlmReserve('Infinity')).toThrow(/min_xlm_reserve/i);
  });

  it('throws for negative values', async () => {
    expect(() => parseMinXlmReserve('-1')).toThrow(/min_xlm_reserve/i);
  });
});

describe('parseMinAssetBalance', () => {
  it('returns undefined for empty string', async () => {
    expect(parseMinAssetBalance('')).toBeUndefined();
  });

  it('returns undefined for whitespace-only string', async () => {
    expect(parseMinAssetBalance('   ')).toBeUndefined();
  });

  it('parses valid numeric strings', async () => {
    expect(parseMinAssetBalance('100')).toBe('100');
    expect(parseMinAssetBalance('50.5')).toBe('50.5');
  });

  it('trims valid numeric strings', async () => {
    expect(parseMinAssetBalance(' 25.25 ')).toBe('25.25');
  });

  it('throws for non-numeric values', async () => {
    expect(() => parseMinAssetBalance('abc')).toThrow(/min_asset_balance/i);
  });

  it('throws for non-finite values', async () => {
    expect(() => parseMinAssetBalance('Infinity')).toThrow(/min_asset_balance/i);
  });

  it('throws for negative values', async () => {
    expect(() => parseMinAssetBalance('-10')).toThrow(/min_asset_balance/i);
  });
});

describe('estimateTrustlineSetupCost', () => {
  it('adds account and trustline reserves', async () => {
    expect(estimateTrustlineSetupCost()).toBe(1.5);
  });
});

describe('formatXlmDeficit', () => {
  it('formats missing reserve without going negative', async () => {
    expect(formatXlmDeficit(1.5, 1.0)).toBe('0.5000000');
    expect(formatXlmDeficit(1.5, 2.0)).toBe('0.0000000');
  });
});

describe('formatAssetDeficit', () => {
  it('formats missing asset balance without going negative', async () => {
    expect(formatAssetDeficit(100, 50)).toBe('50.0000000');
    expect(formatAssetDeficit(100, 150)).toBe('0.0000000');
    expect(formatAssetDeficit(0, 0)).toBe('0.0000000');
  });
});

describe('runAccountChecks', () => {
  it('passes when account is funded, has trustline, and meets reserve', async () => {
    const result = await runAccountChecks(makeAccount(), defaultConfig);

    expect(result.valid).toBe(true);
    expect(result.accountFunded).toBe(true);
    expect(result.trustlineExists).toBe(true);
    expect(result.xlmReserveMet).toBe(true);
    expect(result.xlmBalance).toBe('10.0000000');
    expect(result.assetBalance).toBe('100.0000000');
    expect(result.assetBalanceMet).toBe(true);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(result.checks.length).toBe(3);
  });

  it('passes with minAssetBalance when balance meets or exceeds the floor', async () => {
    const configWithFloor = { ...defaultConfig, minAssetBalance: 50 };
    const result = await runAccountChecks(makeAccount(), configWithFloor);

    expect(result.valid).toBe(true);
    expect(result.assetBalanceMet).toBe(true);
    expect(result.checks.length).toBe(4);
    expect(result.checks[3].label).toBe('USDC minimum balance');
    expect(result.checks[3].passed).toBe(true);
    expect(result.checks[3].detail).toMatch(/meets the minimum of \*\*50 USDC\*\*/);
  });

  it('passes with minAssetBalance exactly equal to the floor', async () => {
    const account = makeAccount({
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
    });
    const configWithFloor = { ...defaultConfig, minAssetBalance: 100 };
    const result = await runAccountChecks(account, configWithFloor);

    expect(result.valid).toBe(true);
    expect(result.assetBalanceMet).toBe(true);
    expect(result.checks[3].passed).toBe(true);
  });

  it('fails when minAssetBalance is set and balance is below the floor', async () => {
    const configWithFloor = { ...defaultConfig, minAssetBalance: 200 };
    const result = await runAccountChecks(makeAccount(), configWithFloor);

    expect(result.valid).toBe(false);
    expect(result.assetBalanceMet).toBe(false);
    expect(result.checks.length).toBe(4);
    expect(result.checks[3].label).toBe('USDC minimum balance');
    expect(result.checks[3].passed).toBe(false);
    expect(result.checks[3].detail).toMatch(/Deficit:/);
    expect(result.checks[3].detail).toMatch(/\*\*100\.0000000 USDC\*\*/);
    expect(result.remediation).toMatch(/Acquire at least/);
    expect(result.remediation).toMatch(/100\.0000000 USDC/);
  });

  it('does not block on minAssetBalance when trustline is missing (balance check is informational)', async () => {
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
    const configWithFloor = { ...defaultConfig, minAssetBalance: 100 };
    const result = await runAccountChecks(account, configWithFloor);

    expect(result.valid).toBe(false);
    expect(result.trustlineExists).toBe(false);
    expect(result.assetBalance).toBe('0');
    expect(result.assetBalanceMet).toBe(false);
    expect(result.checks[3].passed).toBe(true);
    expect(result.checks[3].detail).toMatch(/Cannot verify/);
    expect(result.checks[3].detail).toMatch(/trustline is not configured yet/);
  });

  it('fails when USDC trustline is missing', async () => {
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

    const result = await runAccountChecks(account, defaultConfig);

    expect(result.valid).toBe(false);
    expect(result.trustlineExists).toBe(false);
    expect(result.checks[1].passed).toBe(false);
    expect(result.checks[1].detail).toMatch(/zero trustlines/i);
    expect(result.remediation).toMatch(/Stellar Laboratory/i);
  });

  it('fails when account has trustlines but not for the target asset', async () => {
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

    const result = await runAccountChecks(account, defaultConfig);

    expect(result.trustlineExists).toBe(false);
    expect(result.checks[1].detail).toMatch(/not for \*\*USDC\*\*/i);
  });

  it('fails when XLM balance is below minimum reserve', async () => {
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

    const result = await runAccountChecks(account, defaultConfig);

    expect(result.valid).toBe(false);
    expect(result.xlmReserveMet).toBe(false);
    expect(result.checks[2].passed).toBe(false);
    expect(result.remediation).toMatch(/Send at least/i);
  });

  it('does not false-positive hasAnyTrustlines when only LP shares are present', async () => {
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
          asset_type: 'liquidity_pool_shares',
          liquidity_pool_id: 'pool1',
          buying_liabilities: '0',
          selling_liabilities: '0',
          limit: '1000',
          is_authorized: true,
          is_authorized_to_maintain_liabilities: true,
        } as unknown as import('../src/horizon').HorizonBalance,
      ],
    });

    const result = await runAccountChecks(account, defaultConfig);
    expect(result.trustlineExists).toBe(false);
    // Should say "zero trustlines" not "has trustlines but not for USDC"
    expect(result.checks[1].detail).toMatch(/zero trustlines/i);
  });

  it('finds trustline in account with 100+ mixed balance entries without false negative', async () => {
    const manyBalances: import('../src/horizon').HorizonBalance[] = [
      { balance: '10.0000000', asset_type: 'native', buying_liabilities: '0', selling_liabilities: '0' },
    ];
    for (let i = 0; i < 98; i++) {
      manyBalances.push({
        balance: '1.0000000',
        asset_type: 'liquidity_pool_shares',
        liquidity_pool_id: `pool${i}`,
        buying_liabilities: '0',
        selling_liabilities: '0',
        limit: '1000',
        is_authorized: true,
        is_authorized_to_maintain_liabilities: true,
      } as unknown as import('../src/horizon').HorizonBalance);
    }
    manyBalances.push({
      balance: '100.0000000',
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: USDC_ISSUER,
      buying_liabilities: '0.0000000',
      selling_liabilities: '0.0000000',
    });

    const account = makeAccount({ balances: manyBalances });
    const result = await runAccountChecks(account, defaultConfig);
    expect(result.trustlineExists).toBe(true);
    expect(result.valid).toBe(true);
  });

  it('matches asset by code and issuer exactly', async () => {
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

    const result = await runAccountChecks(account, defaultConfig);
    expect(result.trustlineExists).toBe(false);
    expect(result.assetBalance).toBe('0');
  });

  it('does not add asset balance check when minAssetBalance is 0', async () => {
    const configZero = { ...defaultConfig, minAssetBalance: 0 };
    const result = await runAccountChecks(makeAccount(), configZero);

    expect(result.checks.length).toBe(3);
    expect(result.assetBalanceMet).toBe(true);
  });

  it('does not add asset balance check when minAssetBalance is undefined', async () => {
    const configUndefined = { ...defaultConfig, minAssetBalance: undefined };
    const result = await runAccountChecks(makeAccount(), configUndefined);

    expect(result.checks.length).toBe(3);
    expect(result.assetBalanceMet).toBe(true);
  });

  it('sponsor-aware: extra subentries raise the requirement above the flat floor and can fail a balance the flat check would have passed', async () => {
    // protocol minimum = (2 base + 5 subentries) * 0.5 = 3.5 XLM, which exceeds
    // the configured 1.5 XLM floor. A 2.0 XLM balance would pass the old flat
    // 1.5 XLM check but correctly fails the sponsor-aware protocol minimum.
    const account = makeAccount({
      subentry_count: 5,
      num_sponsoring: 0,
      num_sponsored: 0,
      balances: [
        {
          balance: '2.0000000',
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
    const result = await runAccountChecks(account, defaultConfig);

    expect(result.reserveRequirement?.protocolMinimum).toBe(3.5);
    expect(result.reserveRequirement?.required).toBe(3.5);
    expect(result.xlmReserveMet).toBe(false);
  });

  it('sponsor-aware: fully sponsored trustlines lower the protocol minimum below the flat floor', async () => {
    // protocol minimum = (2 base + 3 subentries + 0 sponsoring - 3 sponsored) * 0.5 = 1.0 XLM,
    // which is below the configured 1.5 XLM floor — the floor still applies.
    const account = makeAccount({ subentry_count: 3, num_sponsoring: 0, num_sponsored: 3 });
    const result = await runAccountChecks(account, defaultConfig);

    expect(result.reserveRequirement?.protocolMinimum).toBe(1);
    expect(result.reserveRequirement?.required).toBe(1.5); // floor override
  });

  it('sponsor-aware: check detail explains the computed requirement vs the floor', async () => {
    const account = makeAccount({ subentry_count: 2, num_sponsoring: 1, num_sponsored: 0 });
    const result = await runAccountChecks(account, defaultConfig);

    const reserveDetail = result.checks[2].detail;
    expect(reserveDetail).toMatch(/protocol minimum/i);
    expect(reserveDetail).toContain('1 sponsoring');
    expect(reserveDetail).toMatch(/floor \*\*1\.5 XLM\*\*/);
  });

  it('sponsor-aware: omitted sponsor fields on an account default to 0', async () => {
    const account = makeAccount({ subentry_count: 1 });
    delete (account as { num_sponsoring?: number }).num_sponsoring;
    delete (account as { num_sponsored?: number }).num_sponsored;

    const result = await runAccountChecks(account, defaultConfig);
    expect(result.reserveRequirement?.protocolMinimum).toBe(1.5);
  });
});

describe('getFailedCheckLabels', () => {
  it('returns labels for failed checks only', async () => {
    const result = await runAccountChecks(makeAccount({ balances: [] }), defaultConfig);
    expect(getFailedCheckLabels(result)).toEqual(['USDC trustline', 'XLM reserve']);
  });

  it('includes asset balance minimum in failed labels when applicable', async () => {
    const configWithFloor = { ...defaultConfig, minAssetBalance: 500 };
    const result = await runAccountChecks(makeAccount(), configWithFloor);
    expect(getFailedCheckLabels(result)).toEqual(['USDC minimum balance']);
  });
});

describe('unfundedAccountResult', () => {
  it('returns all checks failed with remediation guidance', async () => {
    const result = unfundedAccountResult(TEST_ADDRESS, defaultConfig);

    expect(result.valid).toBe(false);
    expect(result.accountFunded).toBe(false);
    expect(result.trustlineExists).toBe(false);
    expect(result.xlmBalance).toBe('0');
    expect(result.assetBalance).toBe('0');
    expect(result.assetBalanceMet).toBe(false);
    expect(result.remediation).toMatch(/Activate/);
    expect(result.remediation).toMatch(/Stellar Laboratory/);
    expect(result.remediation).toMatch(
      String(STELLAR_MIN_ACCOUNT_BALANCE_XLM + STELLAR_BASE_RESERVE_XLM),
    );
    expect(result.checks.length).toBe(3);
  });

  it('includes asset balance check when minAssetBalance is configured', async () => {
    const configWithFloor = { ...defaultConfig, minAssetBalance: 100 };
    const result = unfundedAccountResult(TEST_ADDRESS, configWithFloor);

    expect(result.checks.length).toBe(4);
    expect(result.checks[3].label).toBe('USDC minimum balance');
    expect(result.checks[3].passed).toBe(false);
    expect(result.checks[3].detail).toMatch(/Fund the account and establish a trustline first/);
    expect(result.assetBalance).toBe('0');
    expect(result.assetBalanceMet).toBe(false);
  });
});

describe('Stellar reserve constants', () => {
  it('exports documented reserve values', async () => {
    expect(STELLAR_BASE_RESERVE_XLM).toBe(0.5);
    expect(STELLAR_MIN_ACCOUNT_BALANCE_XLM).toBe(1);
  });
});

describe('computeProtocolMinReserve', () => {
  it('computes 2 base reserves plus one per subentry (unsponsored account)', async () => {
    expect(computeProtocolMinReserve({ subentry_count: 1 })).toBe(1.5);
    expect(computeProtocolMinReserve({ subentry_count: 3 })).toBe(2.5);
  });

  it('defaults missing sponsor fields to 0 (older Horizon snapshots)', async () => {
    expect(computeProtocolMinReserve({ subentry_count: 2 })).toBe(2);
  });

  it('adds reserve for subentries this account sponsors for others', async () => {
    expect(
      computeProtocolMinReserve({ subentry_count: 1, num_sponsoring: 2, num_sponsored: 0 }),
    ).toBe(2.5);
  });

  it('subtracts reserve for subentries sponsored on this account by someone else', async () => {
    expect(
      computeProtocolMinReserve({ subentry_count: 3, num_sponsoring: 0, num_sponsored: 3 }),
    ).toBe(1);
  });

  it('never goes negative even if sponsorship counts outweigh base + subentries', async () => {
    expect(
      computeProtocolMinReserve({ subentry_count: 0, num_sponsoring: 0, num_sponsored: 10 }),
    ).toBe(0);
  });
});

describe('buildReserveRequirement', () => {
  it('summarizes reserve state using the protocol minimum when no floor override applies', async () => {
    expect(buildReserveRequirement(1.5, 1, { subentry_count: 1 })).toEqual({
      required: 1.5,
      actual: 1,
      missing: '0.5000000',
      met: false,
      protocolMinimum: 1.5,
      configuredFloor: 1.5,
      subentryCount: 1,
      numSponsoring: 0,
      numSponsored: 0,
    });
  });

  it('uses the configured floor when it exceeds the protocol minimum', async () => {
    const result = buildReserveRequirement(5, 3, { subentry_count: 1 });
    expect(result.protocolMinimum).toBe(1.5);
    expect(result.configuredFloor).toBe(5);
    expect(result.required).toBe(5);
    expect(result.met).toBe(false);
  });

  it('uses the protocol minimum when it exceeds the configured floor (sponsored trustlines)', async () => {
    const result = buildReserveRequirement(1.5, 3, {
      subentry_count: 4,
      num_sponsoring: 0,
      num_sponsored: 0,
    });
    // 2 base + 4 subentries = 6 reserve units * 0.5 XLM
    expect(result.protocolMinimum).toBe(3);
    expect(result.required).toBe(3);
    expect(result.met).toBe(true);
  });

  it('defaults to no account context (protocol minimum 0) when omitted', async () => {
    expect(buildReserveRequirement(1.5, 1)).toEqual({
      required: 1.5,
      actual: 1,
      missing: '0.5000000',
      met: false,
      protocolMinimum: 0,
      configuredFloor: 1.5,
      subentryCount: 0,
      numSponsoring: 0,
      numSponsored: 0,
    });
  });
});

describe('buildAssetBalanceRequirement', () => {
  it('calculates deficit and met status correctly', async () => {
    expect(buildAssetBalanceRequirement(1000000000n, 500000000n)).toEqual({
      required: 1000000000n,
      actual: 500000000n,
      missing: '50.0000000',
      met: false,
    });
  });

  it('shows zero missing when met', async () => {
    expect(buildAssetBalanceRequirement(1000000000n, 2000000000n)).toEqual({
      required: 1000000000n,
      actual: 2000000000n,
      missing: '0.0000000',
      met: true,
    });
  });

  it('shows zero missing when exactly equal', async () => {
    expect(buildAssetBalanceRequirement(1000000000n, 1000000000n)).toEqual({
      required: 1000000000n,
      actual: 1000000000n,
      missing: '0.0000000',
      met: true,
    });
  });
});

describe('buildValidationGate', () => {
  it('reports a ready gate when every check passes', async () => {
    const result = await runAccountChecks(makeAccount(), defaultConfig);

    expect(buildValidationGate(result)).toEqual({
      ready: true,
      totalChecks: 3,
      passedChecks: 3,
      failedChecks: 0,
      failedLabels: [],
    });
  });

  it('reports blocked labels for failed checks', async () => {
    const result = await runAccountChecks(makeAccount({ balances: [] }), defaultConfig);

    expect(buildValidationGate(result)).toEqual({
      ready: false,
      totalChecks: 3,
      passedChecks: 1,
      failedChecks: 2,
      failedLabels: ['USDC trustline', 'XLM reserve'],
    });
  });

  it('reports 4 total checks and asset balance failure when minAssetBalance is set and fails', async () => {
    const configWithFloor = { ...defaultConfig, minAssetBalance: 500 };
    const result = await runAccountChecks(makeAccount(), configWithFloor);

    expect(buildValidationGate(result)).toEqual({
      ready: false,
      totalChecks: 4,
      passedChecks: 3,
      failedChecks: 1,
      failedLabels: ['USDC minimum balance'],
    });
  });

  it('reports 4 total checks all passing when minAssetBalance is set and met', async () => {
    const configWithFloor = { ...defaultConfig, minAssetBalance: 50 };
    const result = await runAccountChecks(makeAccount(), configWithFloor);

    expect(buildValidationGate(result)).toEqual({
      ready: true,
      totalChecks: 4,
      passedChecks: 4,
      failedChecks: 0,
      failedLabels: [],
    });
  });
});

describe('runMultiAssetChecks', () => {
  const EURC_ISSUER = 'GCQTGZQQ5G4PTM2RNQRAXRJJEL5CQ5Z2OY5SUJRE763CPEKE6EJUMCU';

  it('returns true for all assets when all trustlines exist', async () => {
    const account = makeAccount({
      balances: [
        { balance: '10.0000000', asset_type: 'native', buying_liabilities: '0', selling_liabilities: '0' },
        { balance: '100.0000000', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER, buying_liabilities: '0', selling_liabilities: '0' },
        { balance: '50.0000000', asset_type: 'credit_alphanum4', asset_code: 'EURC', asset_issuer: EURC_ISSUER, buying_liabilities: '0', selling_liabilities: '0' },
      ],
    });
    const { results, allTrustlinesExist } = runMultiAssetChecks(account, [
      { assetCode: 'USDC', assetIssuer: USDC_ISSUER },
      { assetCode: 'EURC', assetIssuer: EURC_ISSUER },
    ]);
    expect(allTrustlinesExist).toBe(true);
    expect(results).toEqual([
      { assetCode: 'USDC', assetIssuer: USDC_ISSUER, trustlineExists: true },
      { assetCode: 'EURC', assetIssuer: EURC_ISSUER, trustlineExists: true },
    ]);
  });

  it('returns false aggregate when any trustline is missing', async () => {
    const account = makeAccount(); // only has USDC
    const { results, allTrustlinesExist } = runMultiAssetChecks(account, [
      { assetCode: 'USDC', assetIssuer: USDC_ISSUER },
      { assetCode: 'EURC', assetIssuer: EURC_ISSUER },
    ]);
    expect(allTrustlinesExist).toBe(false);
    expect(results[0].trustlineExists).toBe(true);
    expect(results[1].trustlineExists).toBe(false);
  });

  it('returns empty results and true aggregate for empty asset list', async () => {
    const { results, allTrustlinesExist } = runMultiAssetChecks(makeAccount(), []);
    expect(results).toEqual([]);
    expect(allTrustlinesExist).toBe(true);
  });

  it('handles a single asset correctly', async () => {
    const { results, allTrustlinesExist } = runMultiAssetChecks(makeAccount(), [
      { assetCode: 'USDC', assetIssuer: USDC_ISSUER },
    ]);
    expect(allTrustlinesExist).toBe(true);
    expect(results[0].trustlineExists).toBe(true);
  });
});

describe('markdown escape hardening', () => {
  it('escapes untrusted Horizon error text before it becomes a check detail', async () => {
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

  it('escapes a backtick in the issuer so it cannot close the inline-code span early', async () => {
    const account = makeAccount();
    // A raw backtick here would close the surrounding `code span`, letting
    // the rest of the value render as live Markdown (e.g. a clickable link).
    const maliciousIssuer = 'GENUINE` [click me](https://evil.example) `INJECTED';

    const result = await runAccountChecks(account, {
      ...defaultConfig,
      assetIssuer: maliciousIssuer,
    });

    const detail = result.checks[1].detail;
    expect(detail).toContain('\\`');
    expect(detail).not.toContain('GENUINE` [click me]');
  });

  it('escapes backticks in the stellar address for unfunded results', async () => {
    const result = unfundedAccountResult('G`INJECTED`ADDRESS', defaultConfig);

    expect(result.checks[0].detail).toContain('\\`INJECTED\\`');
    expect(result.checks[0].detail).not.toMatch(/[^\\]`INJECTED[^\\]`/);
  });
});

describe('trustline limit validation (Issue #140)', () => {
  it('does not add trustline limit check when minTrustlineLimit is undefined', async () => {
    const account = makeAccount({
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
          limit: '1000.0000000',
          buying_liabilities: '0.0000000',
          selling_liabilities: '0.0000000',
        },
      ],
    });

    const result = await runAccountChecks(account, defaultConfig);

    // Only 3 checks: account funded, trustline exists, XLM reserve
    expect(result.checks.length).toBe(3);
    expect(result.checks.some((c) => c.label === 'Trustline limit')).toBe(false);
    expect(result.valid).toBe(true);
  });

  it('passes when trustline limit meets minimum requirement', async () => {
    const account = makeAccount({
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
          limit: '1000.0000000',
          buying_liabilities: '0.0000000',
          selling_liabilities: '0.0000000',
        },
      ],
    });

    const result = await runAccountChecks(account, {
      ...defaultConfig,
      minTrustlineLimit: 500,
    });

    expect(result.valid).toBe(true);
    expect(result.trustlineLimit).toBe('1000.0000000');
    expect(result.checks[3].label).toBe('Trustline limit');
    expect(result.checks[3].passed).toBe(true);
    expect(result.checks[3].detail).toContain('1000.0000000');
    expect(result.checks[3].detail).toContain('500');
  });

  it('fails when trustline limit is below minimum requirement', async () => {
    const account = makeAccount({
      balances: [
        {
          balance: '10.0000000',
          asset_type: 'native',
          buying_liabilities: '0.0000000',
          selling_liabilities: '0.0000000',
        },
        {
          balance: '50.0000000',
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: USDC_ISSUER,
          limit: '100.0000000',
          buying_liabilities: '0.0000000',
          selling_liabilities: '0.0000000',
        },
      ],
    });

    const result = await runAccountChecks(account, {
      ...defaultConfig,
      minTrustlineLimit: 500,
    });

    expect(result.valid).toBe(false);
    expect(result.checks[3].label).toBe('Trustline limit');
    expect(result.checks[3].passed).toBe(false);
    expect(result.checks[3].detail).toContain('100.0000000');
    expect(result.checks[3].detail).toContain('500');
    expect(result.remediation).toContain('Increase the USDC trustline limit');
    expect(result.remediation).toContain('at least **500');
    expect(result.remediation).toContain('Current limit is **`100.0000000` USDC**');
  });

  it('fails the trustline limit check when trustline does not exist', async () => {
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

    const result = await runAccountChecks(account, {
      ...defaultConfig,
      minTrustlineLimit: 500,
    });

    expect(result.valid).toBe(false);
    expect(result.trustlineExists).toBe(false);
    expect(result.checks[3].label).toBe('Trustline limit');
    expect(result.checks[3].passed).toBe(false);
    expect(result.checks[3].detail).toContain('Cannot verify trustline limit');
    expect(result.checks[3].detail).toContain('USDC');
  });

  it('handles trustline with zero limit', async () => {
    const account = makeAccount({
      balances: [
        {
          balance: '10.0000000',
          asset_type: 'native',
          buying_liabilities: '0.0000000',
          selling_liabilities: '0.0000000',
        },
        {
          balance: '0.0000000',
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: USDC_ISSUER,
          limit: '0.0000000',
          buying_liabilities: '0.0000000',
          selling_liabilities: '0.0000000',
        },
      ],
    });

    const result = await runAccountChecks(account, {
      ...defaultConfig,
      minTrustlineLimit: 1,
    });

    expect(result.valid).toBe(false);
    expect(result.checks[3].passed).toBe(false);
    expect(result.checks[3].detail).toContain('0.0000000');
  });

  it('passes when trustline limit exactly equals minimum requirement', async () => {
    const account = makeAccount({
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
          limit: '250.5000000',
          buying_liabilities: '0.0000000',
          selling_liabilities: '0.0000000',
        },
      ],
    });

    const result = await runAccountChecks(account, {
      ...defaultConfig,
      minTrustlineLimit: 250.5,
    });

    expect(result.valid).toBe(true);
    expect(result.checks[3].passed).toBe(true);
  });

  it('includes all remediation steps when multiple checks fail', async () => {
    const account = makeAccount({
      balances: [
        {
          balance: '0.5000000',
          asset_type: 'native',
          buying_liabilities: '0.0000000',
          selling_liabilities: '0.0000000',
        },
        {
          balance: '50.0000000',
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: USDC_ISSUER,
          limit: '100.0000000',
          buying_liabilities: '0.0000000',
          selling_liabilities: '0.0000000',
        },
      ],
    });

    const result = await runAccountChecks(account, {
      ...defaultConfig,
      minTrustlineLimit: 500,
    });

    expect(result.valid).toBe(false);
    // Should have remediation for both XLM reserve and trustline limit
    expect(result.remediation).toContain('Send at least');
    expect(result.remediation).toContain('Increase the USDC trustline limit');
  });
});

describe('FailureReasonCode mapping (Issue #67)', () => {
  it('assigns SUCCESS when all checks pass', async () => {
    const result = await runAccountChecks(makeAccount(), defaultConfig);
    expect(result.reasonCode).toBe('SUCCESS');
  });

  it('assigns ACCOUNT_NOT_FUNDED for unfunded accounts', async () => {
    const result = unfundedAccountResult(TEST_ADDRESS, defaultConfig);
    expect(result.reasonCode).toBe('ACCOUNT_NOT_FUNDED');
  });

  it('assigns TRUSTLINE_MISSING when trustline is absent', async () => {
    const account = makeAccount({ balances: [{ balance: '10.0', asset_type: 'native', buying_liabilities: '0', selling_liabilities: '0' }] });
    const result = await runAccountChecks(account, defaultConfig);
    expect(result.reasonCode).toBe('TRUSTLINE_MISSING');
  });

  it('assigns RESERVE_TOO_LOW when XLM balance is low', async () => {
    const account = makeAccount({
      balances: [
        { balance: '0.1', asset_type: 'native', buying_liabilities: '0', selling_liabilities: '0' },
        { balance: '100.0', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER, buying_liabilities: '0', selling_liabilities: '0' },
      ],
    });
    const result = await runAccountChecks(account, defaultConfig);
    expect(result.reasonCode).toBe('RESERVE_TOO_LOW');
  });

  it('assigns TRUSTLINE_LIMIT_TOO_LOW when trustline limit is below threshold', async () => {
    const account = makeAccount({
      balances: [
        { balance: '10.0', asset_type: 'native', buying_liabilities: '0', selling_liabilities: '0' },
        { balance: '100.0', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER, limit: '50.0', buying_liabilities: '0', selling_liabilities: '0' },
      ],
    });
    const result = await runAccountChecks(account, { ...defaultConfig, minTrustlineLimit: 100 });
    expect(result.reasonCode).toBe('TRUSTLINE_LIMIT_TOO_LOW');
  });

  it('assigns HORIZON_TIMEOUT when Horizon times out', async () => {
    const result = horizonFailureResult('Request timed out after 15000ms', defaultConfig);
    expect(result.reasonCode).toBe('HORIZON_TIMEOUT');
  });

  it('assigns HORIZON_ERROR for generic Horizon failure', async () => {
    const result = horizonFailureResult('Internal server error', defaultConfig);
    expect(result.reasonCode).toBe('HORIZON_ERROR');
  });

  it('assigns TLS_ERROR for TLS failure', async () => {
    const result = tlsFailureResult('Certificate verification failed', defaultConfig);
    expect(result.reasonCode).toBe('TLS_ERROR');
  });
});

describe('claimable-balance-aware funded definition (Issue #260)', () => {
  it('ignores claimables by default (policy ignore): funded account with claimables still funded true, no claimable check row', async () => {
    const account = makeAccount({
      balances: [
        { balance: '10.0000000', asset_type: 'native', buying_liabilities: '0', selling_liabilities: '0' },
        { balance: '100.0000000', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER, buying_liabilities: '0', selling_liabilities: '0' },
        { balance: '5.0000000', asset_type: 'claimable_balance_id', claimable_balance_id: 'abc', buying_liabilities: '0', selling_liabilities: '0' } as unknown as import('../src/horizon').HorizonBalance,
      ],
    });
    const result = await runAccountChecks(account, { ...defaultConfig, claimableBalancePolicy: 'ignore' });
    expect(result.accountFunded).toBe(true);
    expect(result.hasClaimableBalances).toBe(true);
    expect(result.claimableBalanceCount).toBe(1);
    // No claimable check row when ignore
    expect(result.checks.some((c) => c.label === 'Claimable balances')).toBe(false);
  });

  it('count policy: unfunded with 2 claimables surfaces hint and remediation, empty claimables no hint', async () => {
    const configCount = { ...defaultConfig, claimableBalancePolicy: 'count' as const, horizonUrl: 'https://horizon.stellar.org' };
    const resultWith = unfundedAccountResult(TEST_ADDRESS, configCount, undefined, 2);
    expect(resultWith.checks.some((c) => c.label === 'Claimable balances')).toBe(true);
    expect(resultWith.checks.find((c) => c.label === 'Account funded')!.detail).toContain('claimable balance');
    expect(resultWith.remediation).toContain('claimable balance');
    expect(resultWith.hasClaimableBalances).toBe(true);
    expect(resultWith.claimableBalanceCount).toBe(2);
    expect(resultWith.accountFunded).toBe(false); // still unfunded

    const resultEmpty = unfundedAccountResult(TEST_ADDRESS, configCount, undefined, 0);
    expect(resultEmpty.checks.some((c) => c.label === 'Claimable balances')).toBe(false);
    expect(resultEmpty.checks.find((c) => c.label === 'Account funded')!.detail).not.toContain('claimable');
    expect(resultEmpty.hasClaimableBalances).toBe(false);
  });

  it('ignore policy: unfunded with claimables still no hint (default behavior preserved)', async () => {
    const configIgnore = { ...defaultConfig, claimableBalancePolicy: 'ignore' as const };
    const result = unfundedAccountResult(TEST_ADDRESS, configIgnore, undefined, 5);
    expect(result.checks.some((c) => c.label === 'Claimable balances')).toBe(false);
    expect(result.checks.find((c) => c.label === 'Account funded')!.detail).not.toContain('claimable');
  });

  it('count policy: funded account with claimables adds informational claimable check but valid unchanged', async () => {
    const account = makeAccount({
      balances: [
        { balance: '10.0000000', asset_type: 'native', buying_liabilities: '0', selling_liabilities: '0' },
        { balance: '100.0000000', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER, buying_liabilities: '0', selling_liabilities: '0' },
        { balance: '1.0000000', asset_type: 'claimable_balance_id', claimable_balance_id: 'id1', buying_liabilities: '0', selling_liabilities: '0' } as unknown as import('../src/horizon').HorizonBalance,
      ],
    });
    const result = await runAccountChecks(account, { ...defaultConfig, claimableBalancePolicy: 'count' });
    expect(result.valid).toBe(true);
    expect(result.checks.some((c) => c.label === 'Claimable balances')).toBe(true);
    expect(result.hasClaimableBalances).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Issue #248 — Unauthorized AUTH_REQUIRED trustlines
// ---------------------------------------------------------------------------

describe('Issue #248: unauthorized trustlines', () => {
  it('policy=fail: unauthorized trustline blocks valid and sets trustlineExists=false', async () => {
    const account = makeAccount({
      balances: [
        { balance: '10.0000000', asset_type: 'native', buying_liabilities: '0.0000000', selling_liabilities: '0.0000000' },
        {
          balance: '100.0000000', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER,
          buying_liabilities: '0.0000000', selling_liabilities: '0.0000000', is_authorized: false,
        },
      ],
    });
    const result = await runAccountChecks(account, { ...defaultConfig, unauthorizedTrustlinePolicy: 'fail' });

    expect(result.valid).toBe(false);
    expect(result.trustlineExists).toBe(false);
    expect(result.trustlineAuthorized).toBe(false);
    expect(result.checks[1].passed).toBe(false);
    expect(result.checks[1].detail).toMatch(/not authorized.*blocked by.*unauthorized_trustline_policy: fail/i);
    expect(result.remediation).toMatch(/Ask the asset issuer/i);
    expect(result.remediation).toMatch(/SetTrustLineFlags/i);
  });

  it('policy=warn (default): unauthorized trustline still passes but detail warns', async () => {
    const account = makeAccount({
      balances: [
        { balance: '10.0000000', asset_type: 'native', buying_liabilities: '0.0000000', selling_liabilities: '0.0000000' },
        {
          balance: '100.0000000', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER,
          buying_liabilities: '0.0000000', selling_liabilities: '0.0000000', is_authorized: false,
        },
      ],
    });
    const result = await runAccountChecks(account, defaultConfig);

    expect(result.valid).toBe(true);
    expect(result.trustlineExists).toBe(true);
    expect(result.trustlineAuthorized).toBe(false);
    expect(result.checks[1].passed).toBe(true);
    expect(result.checks[1].detail).toMatch(/not yet authorized/i);
    expect(result.checks[1].detail).toMatch(/transfers will fail until authorized/i);
  });

  it('policy=ignore: unauthorized trustline passes with no warning', async () => {
    const account = makeAccount({
      balances: [
        { balance: '10.0000000', asset_type: 'native', buying_liabilities: '0.0000000', selling_liabilities: '0.0000000' },
        {
          balance: '100.0000000', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER,
          buying_liabilities: '0.0000000', selling_liabilities: '0.0000000', is_authorized: false,
        },
      ],
    });
    const result = await runAccountChecks(account, { ...defaultConfig, unauthorizedTrustlinePolicy: 'ignore' });

    expect(result.valid).toBe(true);
    expect(result.trustlineExists).toBe(true);
    expect(result.checks[1].passed).toBe(true);
    expect(result.checks[1].detail).not.toMatch(/not authorized/i);
  });

  it('policy=fail: unauthorized trustline sets reasonCode=TRUSTLINE_MISSING', async () => {
    const account = makeAccount({
      balances: [
        { balance: '10.0000000', asset_type: 'native', buying_liabilities: '0.0000000', selling_liabilities: '0.0000000' },
        {
          balance: '100.0000000', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER,
          buying_liabilities: '0.0000000', selling_liabilities: '0.0000000', is_authorized: false,
        },
      ],
    });
    const result = await runAccountChecks(account, { ...defaultConfig, unauthorizedTrustlinePolicy: 'fail' });

    expect(result.reasonCode).toBe('TRUSTLINE_MISSING');
  });

  it('policy=warn: unauthorized trustline with auth_revocable issuer mentions revocation', async () => {
    const account = makeAccount({
      balances: [
        { balance: '10.0000000', asset_type: 'native', buying_liabilities: '0.0000000', selling_liabilities: '0.0000000' },
        {
          balance: '100.0000000', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER,
          buying_liabilities: '0.0000000', selling_liabilities: '0.0000000', is_authorized: false,
        },
      ],
      flags: { auth_required: true, auth_revocable: true },
    });
    const result = await runAccountChecks(account, defaultConfig);

    expect(result.checks[1].detail).toMatch(/not yet authorized/i);
    expect(result.checks[1].detail).toMatch(/AUTH_REVOCABLE/i);
    expect(result.checks[1].detail).toMatch(/revoked/i);
  });

  it('policy=fail: authorized trustline still passes even with auth_revocable issuer', async () => {
    const account = makeAccount({
      balances: [
        { balance: '10.0000000', asset_type: 'native', buying_liabilities: '0.0000000', selling_liabilities: '0.0000000' },
        {
          balance: '100.0000000', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER,
          buying_liabilities: '0.0000000', selling_liabilities: '0.0000000', is_authorized: true,
        },
      ],
      flags: { auth_required: true, auth_revocable: true },
    });
    const result = await runAccountChecks(account, { ...defaultConfig, unauthorizedTrustlinePolicy: 'fail' });

    expect(result.valid).toBe(true);
    expect(result.trustlineExists).toBe(true);
    expect(result.trustlineAuthorized).toBe(true);
    expect(result.checks[1].passed).toBe(true);
  });

  it('clawback enabled (non-strict): trustline passes but detail warns about clawback', async () => {
    const account = makeAccount({
      balances: [
        { balance: '10.0000000', asset_type: 'native', buying_liabilities: '0.0000000', selling_liabilities: '0.0000000' },
        {
          balance: '100.0000000', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER,
          buying_liabilities: '0.0000000', selling_liabilities: '0.0000000', is_clawback_enabled: true,
        },
      ],
    });
    const result = await runAccountChecks(account, { ...defaultConfig, clawbackStrictMode: false });

    expect(result.valid).toBe(true);
    expect(result.trustlineExists).toBe(true);
    expect(result.clawbackEnabled).toBe(true);
    expect(result.checks[1].passed).toBe(true);
    expect(result.checks[1].detail).toMatch(/clawback is enabled/i);
  });
});

// ---------------------------------------------------------------------------
// Issue #249 — LP share trustline exclusion edge cases
// ---------------------------------------------------------------------------

describe('Issue #249: LP share edge cases', () => {
  it('LP shares + other credit trustlines (not USDC): trustlineExists=false', async () => {
    const account = makeAccount({
      balances: [
        { balance: '10.0000000', asset_type: 'native', buying_liabilities: '0', selling_liabilities: '0' },
        {
          balance: '1.0000000', asset_type: 'liquidity_pool_shares', liquidity_pool_id: 'pool1',
          buying_liabilities: '0', selling_liabilities: '0', limit: '1000',
          is_authorized: true, is_authorized_to_maintain_liabilities: true,
        } as unknown as import('../src/horizon').HorizonBalance,
        {
          balance: '50.0000000', asset_type: 'credit_alphanum4', asset_code: 'EURC',
          asset_issuer: 'GCQTGZQQ5G4PTM2RNQRAXRJJEL5CQ5Z2OY5SUJRE763CPEKE6EJUMCU',
          buying_liabilities: '0', selling_liabilities: '0',
        },
      ],
    });

    const result = await runAccountChecks(account, defaultConfig);
    expect(result.trustlineExists).toBe(false);
    expect(result.checks[1].detail).toMatch(/not for \*\*USDC\*\*/i);
  });

  it('LP shares + USDC trustline: trustlineExists=true (USDC found correctly)', async () => {
    const account = makeAccount({
      balances: [
        { balance: '10.0000000', asset_type: 'native', buying_liabilities: '0', selling_liabilities: '0' },
        {
          balance: '1.0000000', asset_type: 'liquidity_pool_shares', liquidity_pool_id: 'pool1',
          buying_liabilities: '0', selling_liabilities: '0', limit: '1000',
          is_authorized: true, is_authorized_to_maintain_liabilities: true,
        } as unknown as import('../src/horizon').HorizonBalance,
        {
          balance: '100.0000000', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER,
          buying_liabilities: '0', selling_liabilities: '0',
        },
      ],
    });

    const result = await runAccountChecks(account, defaultConfig);
    expect(result.trustlineExists).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.assetBalance).toBe('100.0000000');
  });

  it('getAssetBalance returns 0 when only LP shares exist', async () => {
    const account = makeAccount({
      balances: [
        { balance: '10.0000000', asset_type: 'native', buying_liabilities: '0', selling_liabilities: '0' },
        {
          balance: '5.0000000', asset_type: 'liquidity_pool_shares', liquidity_pool_id: 'pool1',
          buying_liabilities: '0', selling_liabilities: '0', limit: '1000',
          is_authorized: true, is_authorized_to_maintain_liabilities: true,
        } as unknown as import('../src/horizon').HorizonBalance,
      ],
    });

    const result = await runAccountChecks(account, defaultConfig);
    expect(result.assetBalance).toBe('0');
    expect(result.trustlineExists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Issue #250 — Muxed (M...) address acceptance
// ---------------------------------------------------------------------------

describe('Issue #250: Muxed address support', () => {
  const M_ADDRESS = 'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUQ';
  const G_EXTRACTED_FROM_M = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';

  it('isValidMuxedAddress recognizes valid M-address', () => {
    expect(isValidMuxedAddress(M_ADDRESS)).toBe(true);
  });

  it('isValidMuxedAddress rejects G-address', () => {
    expect(isValidMuxedAddress('G' + 'A'.repeat(68))).toBe(false);
  });

  it('isValidMuxedAddress rejects too-short M-address', () => {
    expect(isValidMuxedAddress('MABC')).toBe(false);
  });

  it('decodeMuxedAddress extracts G-address and muxed ID', () => {
    const result = decodeMuxedAddress(M_ADDRESS);
    expect(result).not.toBeNull();
    expect(result!.gAddress).toBe(G_EXTRACTED_FROM_M);
    expect(result!.muxedId).toBe(0n);
  });

  it('decodeMuxedAddress returns null for invalid input', () => {
    expect(decodeMuxedAddress('not-a-muxed-address')).toBeNull();
    expect(decodeMuxedAddress(TEST_ADDRESS)).toBeNull();
  });

  it('convertMuxedToGAddress converts M to G', () => {
    expect(convertMuxedToGAddress(M_ADDRESS)).toBe(G_EXTRACTED_FROM_M);
  });

  it('convertMuxedToGAddress throws for invalid input', () => {
    expect(() => convertMuxedToGAddress('invalid')).toThrow(/Invalid Stellar muxed address/i);
  });

  it('validateStellarAddress accepts M-address', () => {
    expect(() => validateStellarAddress(M_ADDRESS)).not.toThrow();
  });
});
