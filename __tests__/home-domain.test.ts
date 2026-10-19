// @ts-nocheck — pre-existing missing-await patterns; tracked in issue #293 for future cleanup
/**
 * Tests for the SEP-0001 home domain alignment check.
 *
 * Covers:
 *  - evaluateHomeDomain() pure helper (all outcome branches)
 *  - runAccountChecks() integration (check row + metrics emission)
 *  - unfundedAccountResult() integration (row appended, non-blocking)
 *  - horizonFailureResult() integration (row appended, skipped counter)
 *  - homeDomainPlugin (CheckPlugin interface via corePlugins)
 *  - Markdown-injection hardening (untrusted home_domain value)
 *  - Metrics counters incremented correctly
 */

import {
  evaluateHomeDomain,
  runAccountChecks,
  unfundedAccountResult,
  horizonFailureResult,
  CheckConfig,
} from '../src/checks';
import { HorizonAccount } from '../src/horizon';
import { homeDomainPlugin } from '../src/corePlugins';
import type { CheckPluginContext } from '../src/plugin';
import { globalMetrics } from '../src/metrics';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const TEST_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

const baseConfig: CheckConfig = {
  assetCode: 'USDC',
  assetIssuer: USDC_ISSUER,
  minXlmReserve: 1.5,
  horizonUrl: 'https://horizon.stellar.org',
};

const enabledWarnConfig: CheckConfig = {
  ...baseConfig,
  homeDomainCheckEnabled: true,
  homeDomainCheckMode: 'warn',
};

const enabledStrictConfig: CheckConfig = {
  ...baseConfig,
  homeDomainCheckEnabled: true,
  homeDomainCheckMode: 'strict',
};

const enabledWithExpectedConfig: CheckConfig = {
  ...baseConfig,
  homeDomainCheckEnabled: true,
  homeDomainCheckMode: 'warn',
  expectedHomeDomain: 'centre.io',
};

const enabledStrictWithExpectedConfig: CheckConfig = {
  ...baseConfig,
  homeDomainCheckEnabled: true,
  homeDomainCheckMode: 'strict',
  expectedHomeDomain: 'centre.io',
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

function makeCtx(
  accountOverride: HorizonAccount | null = makeAccount(),
  configOverride: CheckConfig = enabledWarnConfig,
): CheckPluginContext {
  return {
    account: accountOverride,
    config: configOverride,
    stellarAddress: TEST_ADDRESS,
  };
}

// ---------------------------------------------------------------------------
// Reset global metrics before each test so counters don't bleed between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  globalMetrics.reset();
});

// ---------------------------------------------------------------------------
// evaluateHomeDomain — null issuer account
// ---------------------------------------------------------------------------

describe('evaluateHomeDomain — null issuer account', () => {
  it('returns outcome=missing when issuer account is null', () => {
    const result = evaluateHomeDomain(null, enabledWarnConfig);
    expect(result.outcome).toBe('missing');
    expect(result.actualHomeDomain).toBeUndefined();
  });

  it('blocksValid=false in warn mode when issuer is null', () => {
    const result = evaluateHomeDomain(null, enabledWarnConfig);
    expect(result.blocksValid).toBe(false);
  });

  it('blocksValid=true in strict mode when issuer is null', () => {
    const result = evaluateHomeDomain(null, enabledStrictConfig);
    expect(result.blocksValid).toBe(true);
  });

  it('detail mentions issuer account data unavailable', () => {
    const result = evaluateHomeDomain(null, enabledWarnConfig);
    expect(result.detail).toMatch(/not available/i);
  });
});

// ---------------------------------------------------------------------------
// evaluateHomeDomain — home_domain absent on account
// ---------------------------------------------------------------------------

describe('evaluateHomeDomain — home_domain absent', () => {
  it('returns outcome=missing when home_domain field is absent', () => {
    const account = makeAccount(); // no home_domain set
    const result = evaluateHomeDomain(account, enabledWarnConfig);
    expect(result.outcome).toBe('missing');
  });

  it('returns outcome=missing when home_domain is empty string', () => {
    const account = makeAccount({ home_domain: '' });
    const result = evaluateHomeDomain(account, enabledWarnConfig);
    expect(result.outcome).toBe('missing');
  });

  it('returns outcome=missing when home_domain is whitespace only', () => {
    const account = makeAccount({ home_domain: '   ' });
    const result = evaluateHomeDomain(account, enabledWarnConfig);
    expect(result.outcome).toBe('missing');
  });

  it('blocksValid=false in warn mode', () => {
    const result = evaluateHomeDomain(makeAccount(), enabledWarnConfig);
    expect(result.blocksValid).toBe(false);
  });

  it('blocksValid=true in strict mode', () => {
    const result = evaluateHomeDomain(makeAccount(), enabledStrictConfig);
    expect(result.blocksValid).toBe(true);
  });

  it('detail mentions expected domain when configured', () => {
    const account = makeAccount();
    const result = evaluateHomeDomain(account, enabledWithExpectedConfig);
    expect(result.detail).toContain('centre.io');
  });
});

// ---------------------------------------------------------------------------
// evaluateHomeDomain — home_domain present, no expected (any non-empty is valid)
// ---------------------------------------------------------------------------

describe('evaluateHomeDomain — home_domain present, no expectedHomeDomain', () => {
  it('returns outcome=valid when home_domain is set and no expectation configured', () => {
    const account = makeAccount({ home_domain: 'example.com' });
    const result = evaluateHomeDomain(account, enabledWarnConfig);
    expect(result.outcome).toBe('valid');
    expect(result.actualHomeDomain).toBe('example.com');
  });

  it('blocksValid=false for valid outcome regardless of mode', () => {
    const account = makeAccount({ home_domain: 'example.com' });
    expect(evaluateHomeDomain(account, enabledWarnConfig).blocksValid).toBe(false);
    expect(evaluateHomeDomain(account, enabledStrictConfig).blocksValid).toBe(false);
  });

  it('detail contains the actual home domain', () => {
    const account = makeAccount({ home_domain: 'stellar.org' });
    const result = evaluateHomeDomain(account, enabledWarnConfig);
    expect(result.detail).toContain('stellar.org');
  });
});

// ---------------------------------------------------------------------------
// evaluateHomeDomain — expectedHomeDomain matching
// ---------------------------------------------------------------------------

describe('evaluateHomeDomain — expectedHomeDomain matching', () => {
  it('returns outcome=valid when domain matches exactly', () => {
    const account = makeAccount({ home_domain: 'centre.io' });
    const result = evaluateHomeDomain(account, enabledWithExpectedConfig);
    expect(result.outcome).toBe('valid');
  });

  it('matching is case-insensitive', () => {
    const account = makeAccount({ home_domain: 'CENTRE.IO' });
    const result = evaluateHomeDomain(account, enabledWithExpectedConfig);
    expect(result.outcome).toBe('valid');
  });

  it('matching trims whitespace from home_domain', () => {
    const account = makeAccount({ home_domain: '  centre.io  ' });
    const result = evaluateHomeDomain(account, enabledWithExpectedConfig);
    expect(result.outcome).toBe('valid');
  });

  it('returns outcome=mismatch when domain does not match', () => {
    const account = makeAccount({ home_domain: 'other.io' });
    const result = evaluateHomeDomain(account, enabledWithExpectedConfig);
    expect(result.outcome).toBe('mismatch');
    expect(result.actualHomeDomain).toBe('other.io');
    expect(result.expectedHomeDomain).toBe('centre.io');
  });

  it('mismatch detail contains both actual and expected domains', () => {
    const account = makeAccount({ home_domain: 'other.io' });
    const result = evaluateHomeDomain(account, enabledWithExpectedConfig);
    expect(result.detail).toContain('other.io');
    expect(result.detail).toContain('centre.io');
  });

  it('blocksValid=false for mismatch in warn mode', () => {
    const account = makeAccount({ home_domain: 'other.io' });
    const result = evaluateHomeDomain(account, enabledWithExpectedConfig);
    expect(result.blocksValid).toBe(false);
  });

  it('blocksValid=true for mismatch in strict mode', () => {
    const account = makeAccount({ home_domain: 'other.io' });
    const result = evaluateHomeDomain(account, enabledStrictWithExpectedConfig);
    expect(result.blocksValid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Markdown injection hardening
// ---------------------------------------------------------------------------

describe('evaluateHomeDomain — Markdown injection hardening', () => {
  it('escapes backticks in malicious home_domain value', () => {
    const account = makeAccount({ home_domain: 'evil` [click](https://evil.example) `end' });
    const result = evaluateHomeDomain(account, enabledWarnConfig);
    expect(result.detail).not.toContain('evil` [click]');
    expect(result.detail).toContain('\\`');
  });

  it('escapes brackets and asterisks in home_domain', () => {
    const account = makeAccount({ home_domain: '[evil](https://x.com)*bold*' });
    const result = evaluateHomeDomain(account, enabledWarnConfig);
    expect(result.detail).not.toContain('[evil](https://x.com)');
    expect(result.detail).toContain('\\[evil\\]');
  });

  it('escapes malicious expectedHomeDomain in mismatch detail', () => {
    const config: CheckConfig = {
      ...enabledStrictConfig,
      expectedHomeDomain: 'good` [inject](https://evil.example) `end',
    };
    const account = makeAccount({ home_domain: 'other.io' });
    const result = evaluateHomeDomain(account, config);
    expect(result.detail).not.toContain('[inject](https://evil.example)');
  });
});

// ---------------------------------------------------------------------------
// runAccountChecks — home domain check integration
// ---------------------------------------------------------------------------

describe('runAccountChecks — home domain check integration', () => {
  it('does not add SEP-0001 check row when disabled (default)', () => {
    const result = runAccountChecks(makeAccount(), baseConfig);
    const labels = result.checks.map((c) => c.label);
    expect(labels).not.toContain('SEP-0001 home domain');
    expect(result.homeDomainCheck).toBeUndefined();
  });

  it('adds SEP-0001 check row when enabled', () => {
    const account = makeAccount({ home_domain: 'centre.io' });
    const result = runAccountChecks(account, enabledWarnConfig);
    const labels = result.checks.map((c) => c.label);
    expect(labels).toContain('SEP-0001 home domain');
  });

  it('check row passes in warn mode even when home_domain is missing', () => {
    const account = makeAccount(); // no home_domain
    const result = runAccountChecks(account, enabledWarnConfig);
    const hdCheck = result.checks.find((c) => c.label === 'SEP-0001 home domain');
    expect(hdCheck).toBeDefined();
    expect(hdCheck!.passed).toBe(true); // warn mode — non-blocking
    expect(result.valid).toBe(true); // overall result unaffected
  });

  it('check row fails and blocks valid in strict mode when home_domain missing', () => {
    const account = makeAccount(); // no home_domain
    const result = runAccountChecks(account, enabledStrictConfig);
    const hdCheck = result.checks.find((c) => c.label === 'SEP-0001 home domain');
    expect(hdCheck!.passed).toBe(false);
    expect(result.valid).toBe(false);
  });

  it('check row passes in strict mode when domain matches expected', () => {
    const account = makeAccount({ home_domain: 'centre.io' });
    const result = runAccountChecks(account, enabledStrictWithExpectedConfig);
    const hdCheck = result.checks.find((c) => c.label === 'SEP-0001 home domain');
    expect(hdCheck!.passed).toBe(true);
    expect(result.valid).toBe(true);
  });

  it('populates homeDomainCheck on result', () => {
    const account = makeAccount({ home_domain: 'centre.io' });
    const result = runAccountChecks(account, enabledWithExpectedConfig);
    expect(result.homeDomainCheck).toBeDefined();
    expect(result.homeDomainCheck!.outcome).toBe('valid');
    expect(result.homeDomainCheck!.actualHomeDomain).toBe('centre.io');
  });

  it('emits home_domain_valid counter when outcome is valid', () => {
    const account = makeAccount({ home_domain: 'centre.io' });
    runAccountChecks(account, enabledWithExpectedConfig);
    expect(globalMetrics.getCounter('home_domain_valid')).toBe(1);
  });

  it('emits home_domain_missing counter when no domain set', () => {
    runAccountChecks(makeAccount(), enabledWarnConfig);
    expect(globalMetrics.getCounter('home_domain_missing')).toBe(1);
  });

  it('emits home_domain_mismatch counter on mismatch', () => {
    const account = makeAccount({ home_domain: 'wrong.io' });
    runAccountChecks(account, enabledWithExpectedConfig);
    expect(globalMetrics.getCounter('home_domain_mismatch')).toBe(1);
  });

  it('does not emit any home_domain counter when check is disabled', () => {
    runAccountChecks(makeAccount(), baseConfig);
    expect(globalMetrics.getCounter('home_domain_valid')).toBe(0);
    expect(globalMetrics.getCounter('home_domain_missing')).toBe(0);
    expect(globalMetrics.getCounter('home_domain_mismatch')).toBe(0);
    expect(globalMetrics.getCounter('home_domain_skipped')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// unfundedAccountResult — home domain check integration
// ---------------------------------------------------------------------------

describe('unfundedAccountResult — home domain check integration', () => {
  it('does not add SEP-0001 row when disabled', () => {
    const result = unfundedAccountResult(TEST_ADDRESS, baseConfig);
    const labels = result.checks.map((c) => c.label);
    expect(labels).not.toContain('SEP-0001 home domain');
  });

  it('adds a passing non-blocking SEP-0001 row when enabled', () => {
    const result = unfundedAccountResult(TEST_ADDRESS, enabledWarnConfig);
    const hdCheck = result.checks.find((c) => c.label === 'SEP-0001 home domain');
    expect(hdCheck).toBeDefined();
    expect(hdCheck!.passed).toBe(true); // always non-blocking on unfunded path
  });

  it('does not change valid=false even in strict mode', () => {
    const result = unfundedAccountResult(TEST_ADDRESS, enabledStrictConfig);
    expect(result.valid).toBe(false); // still false due to account funded check
    const hdCheck = result.checks.find((c) => c.label === 'SEP-0001 home domain');
    expect(hdCheck!.passed).toBe(true); // home domain row itself passes
  });

  it('emits home_domain_missing counter (issuer null on unfunded path)', () => {
    unfundedAccountResult(TEST_ADDRESS, enabledWarnConfig);
    expect(globalMetrics.getCounter('home_domain_missing')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// horizonFailureResult — home domain check integration
// ---------------------------------------------------------------------------

describe('horizonFailureResult — home domain check integration', () => {
  it('does not add SEP-0001 row when disabled', () => {
    const result = horizonFailureResult('Network error', baseConfig);
    const labels = result.checks.map((c) => c.label);
    expect(labels).not.toContain('SEP-0001 home domain');
    expect(result.homeDomainCheck).toBeUndefined();
  });

  it('adds a passing SEP-0001 row when enabled (non-blocking on Horizon failure)', () => {
    const result = horizonFailureResult('Network error', enabledWarnConfig);
    const hdCheck = result.checks.find((c) => c.label === 'SEP-0001 home domain');
    expect(hdCheck).toBeDefined();
    expect(hdCheck!.passed).toBe(true);
  });

  it('populates homeDomainCheck with outcome=skipped', () => {
    const result = horizonFailureResult('timeout', enabledWarnConfig);
    expect(result.homeDomainCheck?.outcome).toBe('skipped');
  });

  it('emits home_domain_skipped counter', () => {
    horizonFailureResult('timeout', enabledWarnConfig);
    expect(globalMetrics.getCounter('home_domain_skipped')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// homeDomainPlugin — CheckPlugin interface
// ---------------------------------------------------------------------------

describe('homeDomainPlugin', () => {
  it('has stable id and label', () => {
    expect(homeDomainPlugin.id).toBe('trustbridge/home-domain');
    expect(homeDomainPlugin.label).toBe('SEP-0001 home domain');
  });

  it('returns passed=true and no-op detail when check is disabled', () => {
    const ctx = makeCtx(makeAccount(), baseConfig); // disabled by default
    const result = homeDomainPlugin.run(ctx);
    expect(result.passed).toBe(true);
    expect(result.detail).toMatch(/disabled/i);
    expect(result.remediation).toBeUndefined();
    expect(globalMetrics.getCounter('home_domain_skipped')).toBe(1);
  });

  it('passes when home_domain is set and no expectation configured (warn mode)', () => {
    const ctx = makeCtx(makeAccount({ home_domain: 'stellar.org' }), enabledWarnConfig);
    const result = homeDomainPlugin.run(ctx);
    expect(result.passed).toBe(true);
    expect(globalMetrics.getCounter('home_domain_valid')).toBe(1);
  });

  it('passes (non-blocking) in warn mode when home_domain is missing', () => {
    const ctx = makeCtx(makeAccount(), enabledWarnConfig);
    const result = homeDomainPlugin.run(ctx);
    expect(result.passed).toBe(true);
    expect(result.remediation).toBeUndefined();
    expect(globalMetrics.getCounter('home_domain_missing')).toBe(1);
  });

  it('fails in strict mode when home_domain is missing', () => {
    const ctx = makeCtx(makeAccount(), enabledStrictConfig);
    const result = homeDomainPlugin.run(ctx);
    expect(result.passed).toBe(false);
    expect(result.remediation).toBeDefined();
    expect(result.remediation).toMatch(/home_domain/);
  });

  it('passes when domain matches expectedHomeDomain (case-insensitive)', () => {
    const ctx = makeCtx(
      makeAccount({ home_domain: 'CENTRE.IO' }),
      enabledWithExpectedConfig,
    );
    const result = homeDomainPlugin.run(ctx);
    expect(result.passed).toBe(true);
    expect(globalMetrics.getCounter('home_domain_valid')).toBe(1);
  });

  it('passes (non-blocking) in warn mode on mismatch', () => {
    const ctx = makeCtx(makeAccount({ home_domain: 'wrong.io' }), enabledWithExpectedConfig);
    const result = homeDomainPlugin.run(ctx);
    expect(result.passed).toBe(true);
    expect(globalMetrics.getCounter('home_domain_mismatch')).toBe(1);
  });

  it('fails in strict mode on mismatch with remediation guidance', () => {
    const ctx = makeCtx(
      makeAccount({ home_domain: 'wrong.io' }),
      enabledStrictWithExpectedConfig,
    );
    const result = homeDomainPlugin.run(ctx);
    expect(result.passed).toBe(false);
    expect(result.remediation).toMatch(/expected/i);
    expect(result.remediation).toContain('centre.io');
    expect(globalMetrics.getCounter('home_domain_mismatch')).toBe(1);
  });

  it('passes (non-blocking) when account is null and mode is warn', () => {
    const ctx = makeCtx(null, enabledWarnConfig);
    const result = homeDomainPlugin.run(ctx);
    expect(result.passed).toBe(true);
    expect(globalMetrics.getCounter('home_domain_missing')).toBe(1);
  });

  it('fails when account is null and mode is strict', () => {
    const ctx = makeCtx(null, enabledStrictConfig);
    const result = homeDomainPlugin.run(ctx);
    expect(result.passed).toBe(false);
    expect(globalMetrics.getCounter('home_domain_missing')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Metrics tag values
// ---------------------------------------------------------------------------

describe('home domain metrics tag values', () => {
  it('records home_domain_check metric with correct outcome tag on valid', () => {
    const account = makeAccount({ home_domain: 'centre.io' });
    runAccountChecks(account, enabledWithExpectedConfig);
    const summary = globalMetrics.getSummary();
    const metric = summary.metrics.find(
      (m) => m.name === 'home_domain_check' && m.tags?.outcome === 'valid',
    );
    expect(metric).toBeDefined();
    expect(metric!.tags?.mode).toBe('warn');
  });

  it('records home_domain_check metric with outcome=missing tag', () => {
    runAccountChecks(makeAccount(), enabledStrictConfig);
    const summary = globalMetrics.getSummary();
    const metric = summary.metrics.find(
      (m) => m.name === 'home_domain_check' && m.tags?.outcome === 'missing',
    );
    expect(metric).toBeDefined();
    expect(metric!.tags?.mode).toBe('strict');
  });
});
