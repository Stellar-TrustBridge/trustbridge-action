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
import * as fs from 'fs';
import * as path from 'path';
import * as horizonModule from '../src/horizon';
import { runBatchValidation } from '../src/batch';
import { formatCommentBody } from '../src/comment';
import { buildSarifDocument, sarifOutcomeFromResult, HOME_DOMAIN_RULE_ID } from '../src/sarif';
import { buildCheckAnnotations, buildCheckRunSummary, HOME_DOMAIN_CHECK_LABEL } from '../src/checks-run';

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

// ---------------------------------------------------------------------------
// Issue #708 — issuer account, reason codes, remediation, comments, SARIF,
// Check Run annotations and batch rows
// ---------------------------------------------------------------------------

function makeIssuer(homeDomain?: string): HorizonAccount {
  return {
    id: USDC_ISSUER,
    account_id: USDC_ISSUER,
    sequence: '1',
    subentry_count: 0,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [
      {
        balance: '1.0000000',
        asset_type: 'native',
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
      },
    ],
    ...(homeDomain === undefined ? {} : { home_domain: homeDomain }),
  };
}

describe('runAccountChecks — issuer account for home domain (Issue #708)', () => {
  it('evaluates the issuer account, not the contributor account, when provided', () => {
    // Contributor account carries an unrelated home_domain that must be ignored.
    const contributor = makeAccount({ home_domain: 'wallet.example' });
    const result = runAccountChecks(contributor, enabledStrictWithExpectedConfig, makeIssuer('centre.io'));
    expect(result.homeDomainCheck?.outcome).toBe('valid');
    expect(result.valid).toBe(true);
    expect(result.reasonCode).toBe('SUCCESS');
  });

  it('treats an unavailable issuer (null) as missing', () => {
    const result = runAccountChecks(makeAccount({ home_domain: 'centre.io' }), enabledStrictWithExpectedConfig, null);
    expect(result.homeDomainCheck?.outcome).toBe('missing');
    expect(result.valid).toBe(false);
  });
});

describe('home domain reason codes (Issue #708)', () => {
  it('strict mismatch sets reason_code HOME_DOMAIN_MISMATCH', () => {
    const result = runAccountChecks(makeAccount(), enabledStrictWithExpectedConfig, makeIssuer('other.io'));
    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe('HOME_DOMAIN_MISMATCH');
    expect(result.failedCheckLabels).toContain('home_domain');
  });

  it('strict empty on-chain home_domain sets reason_code HOME_DOMAIN_MISSING', () => {
    const result = runAccountChecks(makeAccount(), enabledStrictWithExpectedConfig, makeIssuer(''));
    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe('HOME_DOMAIN_MISSING');
  });

  it('warn mode mismatch keeps reason_code SUCCESS and valid=true', () => {
    const result = runAccountChecks(makeAccount(), enabledWithExpectedConfig, makeIssuer('other.io'));
    expect(result.valid).toBe(true);
    expect(result.reasonCode).toBe('SUCCESS');
  });

  it('a trustline failure still outranks the home domain code', () => {
    const noTrustline = makeAccount({ balances: [makeAccount().balances[0]] });
    const result = runAccountChecks(noTrustline, enabledStrictWithExpectedConfig, makeIssuer('other.io'));
    expect(result.reasonCode).toBe('TRUSTLINE_MISSING');
  });

  it('the new codes are in the reason_code catalog', () => {
    const catalog = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../schemas/reason-codes.json'), 'utf8'),
    ) as { codes: Array<{ code: string }> };
    const codes = new Set(catalog.codes.map((c) => c.code));
    expect(codes.has('HOME_DOMAIN_MISMATCH')).toBe(true);
    expect(codes.has('HOME_DOMAIN_MISSING')).toBe(true);
  });
});

describe('home domain comment output: warn vs strict (Issue #708)', () => {
  const commentConfig = {
    ...baseConfig,
    stellarAddress: TEST_ADDRESS,
    horizonUrl: 'https://horizon.stellar.org',
  };

  it('strict mismatch puts the mismatch detail in the remediation section', () => {
    const result = runAccountChecks(makeAccount(), enabledStrictWithExpectedConfig, makeIssuer('other.io'));
    expect(result.remediation).toContain('other.io');
    expect(result.remediation).toContain('centre.io');
    expect(result.remediation).toContain('home_domain_check_mode: strict');

    const body = formatCommentBody(result, commentConfig);
    const remediationIdx = body.indexOf('expected_home_domain');
    expect(remediationIdx).toBeGreaterThan(-1);
    expect(body).toContain('other.io');
  });

  it('strict missing domain uses missing-specific remediation text', () => {
    const result = runAccountChecks(makeAccount(), enabledStrictConfig, makeIssuer());
    expect(result.remediation).toContain('no verifiable on-chain');
    expect(result.remediation).not.toContain('expected_home_domain` is');
  });

  it('warn mismatch posts a visible warning row without remediation or failure', () => {
    const result = runAccountChecks(makeAccount(), enabledWithExpectedConfig, makeIssuer('other.io'));
    const row = result.checks.find((c) => c.label === 'SEP-0001 home domain');
    expect(row?.passed).toBe(true);
    expect(row?.detail).toContain('⚠️');
    expect(row?.detail).toContain('home_domain_check_mode: warn');
    expect(result.remediation).toBeUndefined();

    const body = formatCommentBody(result, commentConfig);
    expect(body).toContain('home_domain_check_mode: warn');
    expect(body).toContain('other.io');
  });

  it('warn mode aligned domain shows no warning marker', () => {
    const result = runAccountChecks(makeAccount(), enabledWithExpectedConfig, makeIssuer('centre.io'));
    const row = result.checks.find((c) => c.label === 'SEP-0001 home domain');
    expect(row?.detail).not.toContain('⚠️');
  });
});

describe('home domain SARIF and Check Run integration (Issue #708)', () => {
  const sarifContext = {
    horizonUrl: 'https://horizon.stellar.org',
    stellarAddress: TEST_ADDRESS,
    assetCode: 'USDC',
  };

  it('adds the TB004 home domain rule with an error result on strict failure', () => {
    const result = runAccountChecks(makeAccount(), enabledStrictWithExpectedConfig, makeIssuer('other.io'));
    const doc = buildSarifDocument(
      sarifOutcomeFromResult(result, { ...sarifContext, homeDomainCheckMode: 'strict' }),
    );
    const rule = doc.runs[0].tool.driver.rules.find((r) => r.id === HOME_DOMAIN_RULE_ID);
    expect(rule).toBeDefined();
    expect(rule?.helpUri).toContain('SEP0001_HOME_DOMAIN.md');
    expect(rule?.help?.markdown).toContain('home_domain_check_mode');
    const hd = doc.runs[0].results.find((r) => r.ruleId === HOME_DOMAIN_RULE_ID);
    expect(hd?.level).toBe('error');
    expect(hd?.message.text).toContain('other.io');
  });

  it('reports warn-mode failures as SARIF warnings', () => {
    const result = runAccountChecks(makeAccount(), enabledWithExpectedConfig, makeIssuer('other.io'));
    const doc = buildSarifDocument(sarifOutcomeFromResult(result, { ...sarifContext, homeDomainCheckMode: 'warn' }));
    expect(doc.runs[0].results.find((r) => r.ruleId === HOME_DOMAIN_RULE_ID)?.level).toBe('warning');
  });

  it('reports aligned domains at level none', () => {
    const result = runAccountChecks(makeAccount(), enabledStrictWithExpectedConfig, makeIssuer('centre.io'));
    const doc = buildSarifDocument(sarifOutcomeFromResult(result, { ...sarifContext, homeDomainCheckMode: 'strict' }));
    expect(doc.runs[0].results.find((r) => r.ruleId === HOME_DOMAIN_RULE_ID)?.level).toBe('none');
  });

  it('omits the home domain rule when the check is disabled', () => {
    const result = runAccountChecks(makeAccount(), baseConfig);
    const doc = buildSarifDocument(sarifOutcomeFromResult(result, sarifContext));
    expect(doc.runs[0].tool.driver.rules.map((r) => r.id)).toEqual(['TB001', 'TB002', 'TB003']);
  });

  it('Check Run annotates warn-mode problems as warnings and strict failures as failures', () => {
    const warn = runAccountChecks(makeAccount(), enabledWithExpectedConfig, makeIssuer('other.io'));
    const warnAnnotation = buildCheckAnnotations(warn).find((a) => a.title === HOME_DOMAIN_CHECK_LABEL);
    expect(warnAnnotation?.annotation_level).toBe('warning');

    const strict = runAccountChecks(makeAccount(), enabledStrictWithExpectedConfig, makeIssuer('other.io'));
    const strictAnnotation = buildCheckAnnotations(strict).find((a) => a.title === HOME_DOMAIN_CHECK_LABEL);
    expect(strictAnnotation?.annotation_level).toBe('failure');
    expect(buildCheckRunSummary(strict)).toContain('reason_code: HOME_DOMAIN_MISMATCH');
  });
});

describe('home domain in batch validation (Issue #708)', () => {
  const ADDR_A = TEST_ADDRESS;
  const ADDR_B = `G${'B'.repeat(52)}WHF`;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function spyContributorFetch(): void {
    jest.spyOn(horizonModule, 'fetchAccount').mockImplementation(async (_url, address) =>
      makeAccount({ id: address, account_id: address, home_domain: 'wallet.example' }),
    );
  }

  it('evaluates the issuer home domain for every row and fails strict mismatches', async () => {
    spyContributorFetch();
    const results = await runBatchValidation(
      [ADDR_A, ADDR_B],
      enabledStrictWithExpectedConfig,
      'https://horizon.stellar.org',
      { requestDelayMs: 0, issuerAccount: makeIssuer('other.io') },
    );
    expect(results).toHaveLength(2);
    for (const row of results) {
      expect(row.valid).toBe(false);
      expect(row.homeDomainOutcome).toBe('mismatch');
      expect(row.reasonCode).toBe('HOME_DOMAIN_MISMATCH');
      expect(row.failureReason).toContain('home domain mismatch');
    }
  });

  it('passes every row when the issuer domain is aligned', async () => {
    spyContributorFetch();
    const results = await runBatchValidation(
      [ADDR_A, ADDR_B],
      enabledStrictWithExpectedConfig,
      'https://horizon.stellar.org',
      { requestDelayMs: 0, issuerAccount: makeIssuer('centre.io') },
    );
    expect(results.every((r) => r.valid && r.homeDomainOutcome === 'valid')).toBe(true);
  });

  it('keeps rows valid in warn mode while recording the outcome', async () => {
    spyContributorFetch();
    const results = await runBatchValidation(
      [ADDR_A],
      enabledWithExpectedConfig,
      'https://horizon.stellar.org',
      { requestDelayMs: 0, issuerAccount: makeIssuer('other.io') },
    );
    expect(results[0].valid).toBe(true);
    expect(results[0].homeDomainOutcome).toBe('mismatch');
  });

  it('fetches the issuer once per batch when no issuer account is supplied', async () => {
    spyContributorFetch();
    const issuerSpy = jest
      .spyOn(horizonModule, 'fetchHomeDomainIssuerAccount')
      .mockResolvedValue(makeIssuer('centre.io'));
    const results = await runBatchValidation(
      [ADDR_A, ADDR_B],
      enabledStrictWithExpectedConfig,
      'https://horizon.stellar.org',
      { requestDelayMs: 0 },
    );
    expect(issuerSpy).toHaveBeenCalledTimes(1);
    expect(issuerSpy).toHaveBeenCalledWith('https://horizon.stellar.org', USDC_ISSUER, {});
    expect(results.every((r) => r.valid)).toBe(true);
  });

  it('does not fetch the issuer or set an outcome when the check is disabled', async () => {
    spyContributorFetch();
    const issuerSpy = jest.spyOn(horizonModule, 'fetchHomeDomainIssuerAccount');
    const results = await runBatchValidation([ADDR_A], baseConfig, 'https://horizon.stellar.org', {
      requestDelayMs: 0,
    });
    expect(issuerSpy).not.toHaveBeenCalled();
    expect(results[0].homeDomainOutcome).toBeUndefined();
  });
});

describe('fetchHomeDomainIssuerAccount (Issue #708)', () => {
  it('returns null for Soroban contract (C-address) issuers without calling Horizon', async () => {
    const fetchFn = jest.fn();
    const result = await horizonModule.fetchHomeDomainIssuerAccount(
      'https://horizon.stellar.org',
      'C' + 'A'.repeat(55),
      { fetchFn, cacheTtlMs: 0 },
    );
    expect(result).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns null instead of throwing when Horizon fails', async () => {
    const fetchFn = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await horizonModule.fetchHomeDomainIssuerAccount(
      'https://horizon.stellar.org',
      USDC_ISSUER,
      { fetchFn, cacheTtlMs: 0, maxRetries: 0 },
    );
    expect(result).toBeNull();
  });
});
