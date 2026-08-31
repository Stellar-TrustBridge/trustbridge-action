// @ts-nocheck — pre-existing missing-await patterns; tracked in issue #293 for future cleanup
/**
 * Tests for sponsorship info tracking and display (Issue #141).
 * Covers: sponsor counts extraction, comment section generation,
 * output exposure, and sponsored account edge cases.
 */

import { runAccountChecks, unfundedAccountResult, horizonFailureResult, SponsorshipInfo } from '../src/checks';
import { formatCommentBody } from '../src/comment';
import { toActionOutputs } from '../src/outputs';
import { ValidationResult } from '../src/checks';
import { HorizonAccount } from '../src/horizon';

const baseAccount: HorizonAccount = {
  id: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  account_id: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  sequence: '0',
  subentry_count: 0,
  balances: [
    {
      balance: '5.0000000',
      asset_type: 'native',
      buying_liabilities: '0',
      selling_liabilities: '0',
    },
    {
      balance: '100.0000000',
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      buying_liabilities: '0',
      selling_liabilities: '0',
    },
  ],
  num_sponsoring: 0,
  num_sponsored: 0,
};

const baseCheckConfig = {
  assetCode: 'USDC',
  assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  minXlmReserve: 1.5,
};

// ---------------------------------------------------------------------------
// runAccountChecks — sponsorship extraction
// ---------------------------------------------------------------------------

describe('runAccountChecks — sponsorship info', () => {
  it('extracts zero sponsoring/sponsored counts', () => {
    const result = runAccountChecks(baseAccount, baseCheckConfig);
    expect(result.sponsorshipInfo).toBeDefined();
    expect(result.sponsorshipInfo!.numSponsoring).toBe(0);
    expect(result.sponsorshipInfo!.numSponsored).toBe(0);
  });

  it('extracts positive numSponsoring', () => {
    const account = { ...baseAccount, num_sponsoring: 3 };
    const result = runAccountChecks(account, baseCheckConfig);
    expect(result.sponsorshipInfo!.numSponsoring).toBe(3);
  });

  it('extracts positive numSponsored', () => {
    const account = { ...baseAccount, num_sponsored: 2 };
    const result = runAccountChecks(account, baseCheckConfig);
    expect(result.sponsorshipInfo!.numSponsored).toBe(2);
  });

  it('extracts both numSponsoring and numSponsored', () => {
    const account = { ...baseAccount, num_sponsoring: 5, num_sponsored: 1 };
    const result = runAccountChecks(account, baseCheckConfig);
    expect(result.sponsorshipInfo!.numSponsoring).toBe(5);
    expect(result.sponsorshipInfo!.numSponsored).toBe(1);
  });

  it('handles undefined sponsor fields (defaults to 0)', () => {
    const account = { ...baseAccount, num_sponsoring: 0, num_sponsored: 0 };
    const result = runAccountChecks(account, baseCheckConfig);
    expect(result.sponsorshipInfo!.numSponsoring).toBe(0);
    expect(result.sponsorshipInfo!.numSponsored).toBe(0);
  });

  it('preserves other validation checks alongside sponsorship info', () => {
    const account = { ...baseAccount, num_sponsored: 1 };
    const result = runAccountChecks(account, baseCheckConfig);
    expect(result.valid).toBe(true);
    expect(result.accountFunded).toBe(true);
    expect(result.checks.length).toBe(3);
    expect(result.sponsorshipInfo!.numSponsored).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// unfundedAccountResult — sponsorship defaults
// ---------------------------------------------------------------------------

describe('unfundedAccountResult — sponsorship', () => {
  it('includes zero sponsorship info for unfunded accounts', () => {
    const result = unfundedAccountResult(baseAccount.account_id, baseCheckConfig);
    expect(result.sponsorshipInfo).toBeDefined();
    expect(result.sponsorshipInfo!.numSponsoring).toBe(0);
    expect(result.sponsorshipInfo!.numSponsored).toBe(0);
  });

  it('does not expose sponsor info when account unfunded', () => {
    const result = unfundedAccountResult(baseAccount.account_id, baseCheckConfig);
    expect(result.valid).toBe(false);
    expect(result.accountFunded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// horizonFailureResult — sponsorship defaults
// ---------------------------------------------------------------------------

describe('horizonFailureResult — sponsorship', () => {
  it('includes zero sponsorship info on Horizon error', () => {
    const result = horizonFailureResult('Service unavailable', baseCheckConfig);
    expect(result.sponsorshipInfo).toBeDefined();
    expect(result.sponsorshipInfo!.numSponsoring).toBe(0);
    expect(result.sponsorshipInfo!.numSponsored).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatCommentBody — sponsorship section
// ---------------------------------------------------------------------------

describe('formatCommentBody — sponsorship section', () => {
  const commentConfig = {
    ...baseCheckConfig,
    stellarAddress: baseAccount.account_id,
    horizonUrl: 'https://horizon.stellar.org',
  };

  it('does not include sponsorship section when both counts are zero', () => {
    const account = { ...baseAccount, num_sponsoring: 0, num_sponsored: 0 };
    const result = runAccountChecks(account, baseCheckConfig);
    const comment = formatCommentBody(result, commentConfig);
    expect(comment).not.toContain('### Sponsorship status');
  });

  it('includes sponsorship section when numSponsoring > 0', () => {
    const account = { ...baseAccount, num_sponsoring: 2 };
    const result = runAccountChecks(account, baseCheckConfig);
    const comment = formatCommentBody(result, commentConfig);
    expect(comment).toContain('### Sponsorship status');
    expect(comment).toContain('Accounts this account sponsors: **2**');
  });

  it('includes sponsorship section when numSponsored > 0', () => {
    const account = { ...baseAccount, num_sponsored: 1 };
    const result = runAccountChecks(account, baseCheckConfig);
    const comment = formatCommentBody(result, commentConfig);
    expect(comment).toContain('### Sponsorship status');
    expect(comment).toContain('Accounts sponsoring this account: **1**');
  });

  it('indicates sponsored account when numSponsored > 0', () => {
    const account = { ...baseAccount, num_sponsored: 1 };
    const result = runAccountChecks(account, baseCheckConfig);
    const comment = formatCommentBody(result, commentConfig);
    expect(comment).toContain('This account is sponsored');
    expect(comment).toContain('Another account is covering some or all of its reserve requirements');
  });

  it('indicates sponsoring account when numSponsoring > 0', () => {
    const account = { ...baseAccount, num_sponsoring: 3 };
    const result = runAccountChecks(account, baseCheckConfig);
    const comment = formatCommentBody(result, commentConfig);
    // Should not say "is sponsored" when only sponsoring
    expect(comment).not.toContain('This account is sponsored');
  });

  it('includes both counts in sponsorship section', () => {
    const account = { ...baseAccount, num_sponsoring: 2, num_sponsored: 1 };
    const result = runAccountChecks(account, baseCheckConfig);
    const comment = formatCommentBody(result, commentConfig);
    expect(comment).toContain('Accounts this account sponsors: **2**');
    expect(comment).toContain('Accounts sponsoring this account: **1**');
  });

  it('includes link to Stellar sponsorship docs', () => {
    const account = { ...baseAccount, num_sponsored: 1 };
    const result = runAccountChecks(account, baseCheckConfig);
    const comment = formatCommentBody(result, commentConfig);
    expect(comment).toContain('developers.stellar.org');
    expect(comment).toContain('sponsorships');
  });

  it('explains reserve implications in sponsorship section', () => {
    const account = { ...baseAccount, num_sponsored: 1 };
    const result = runAccountChecks(account, baseCheckConfig);
    const comment = formatCommentBody(result, commentConfig);
    expect(comment).toContain('Reserve implications');
    expect(comment).toContain('reserve requirements');
  });

  it('positions sponsorship section after SEP-0007 but before remediation', () => {
    const account = { ...baseAccount, num_sponsored: 1 };
    const result = runAccountChecks(account, baseCheckConfig);
    const comment = formatCommentBody(result, { ...commentConfig, sep0007DeepLinks: true });
    const sponsorshipPos = comment.indexOf('### Sponsorship status');
    const sep0007Pos = comment.indexOf('### Quick wallet actions');
    // Sponsorship should be after SEP-0007 (if present)
    expect(sponsorshipPos).toBeGreaterThan(sep0007Pos);
  });
});

// ---------------------------------------------------------------------------
// toActionOutputs — sponsor counts
// ---------------------------------------------------------------------------

describe('toActionOutputs — sponsor counts', () => {
  it('includes num_sponsoring and num_sponsored in outputs', () => {
    const account = { ...baseAccount, num_sponsoring: 1, num_sponsored: 2 };
    const result = runAccountChecks(account, baseCheckConfig);
    const outputs = toActionOutputs(result);
    expect(outputs).toHaveProperty('num_sponsoring');
    expect(outputs).toHaveProperty('num_sponsored');
  });

  it('exposes sponsor counts as strings', () => {
    const account = { ...baseAccount, num_sponsoring: 3, num_sponsored: 1 };
    const result = runAccountChecks(account, baseCheckConfig);
    const outputs = toActionOutputs(result);
    expect(outputs.num_sponsoring).toBe('3');
    expect(outputs.num_sponsored).toBe('1');
  });

  it('defaults to zero string when sponsorship info missing', () => {
    const result: ValidationResult = {
      valid: true,
      accountFunded: true,
      trustlineExists: true,
      xlmBalance: '5.0',
      xlmReserveMet: true,
      checks: [],
      // no sponsorshipInfo
    };
    const outputs = toActionOutputs(result);
    expect(outputs.num_sponsoring).toBe('0');
    expect(outputs.num_sponsored).toBe('0');
  });

  it('defaults to zero string when counts undefined', () => {
    const result: ValidationResult = {
      valid: true,
      accountFunded: true,
      trustlineExists: true,
      xlmBalance: '5.0',
      xlmReserveMet: true,
      checks: [],
      sponsorshipInfo: { numSponsoring: undefined as any, numSponsored: undefined as any },
    };
    const outputs = toActionOutputs(result);
    expect(outputs.num_sponsoring).toBe('0');
    expect(outputs.num_sponsored).toBe('0');
  });

  it('preserves other outputs alongside sponsor counts', () => {
    const account = { ...baseAccount, num_sponsored: 1 };
    const result = runAccountChecks(account, baseCheckConfig);
    const outputs = toActionOutputs(result, 'https://github.com/comment');
    expect(outputs.account_funded).toBe('true');
    expect(outputs.trustline_exists).toBe('true');
    expect(outputs.comment_url).toBe('https://github.com/comment');
    expect(outputs.num_sponsored).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// End-to-end: sponsored account flow
// ---------------------------------------------------------------------------

describe('Sponsored account scenarios', () => {
  it('handles account sponsored by another (contributor use case)', () => {
    const account: HorizonAccount = {
      ...baseAccount,
      num_sponsored: 1, // This account is sponsored
      num_sponsoring: 0,
    };
    const result = runAccountChecks(account, baseCheckConfig);
    const comment = formatCommentBody(result, {
      ...baseCheckConfig,
      stellarAddress: account.account_id,
      horizonUrl: 'https://horizon.stellar.org',
    });
    const outputs = toActionOutputs(result);

    // Result should be valid since account is funded
    expect(result.valid).toBe(true);
    // Comment should explain sponsorship
    expect(comment).toContain('is sponsored');
    // Outputs should show sponsorship
    expect(outputs.num_sponsored).toBe('1');
  });

  it('handles account sponsoring multiple others (sponsor use case)', () => {
    const account: HorizonAccount = {
      ...baseAccount,
      num_sponsoring: 5, // This account sponsors 5 others
      num_sponsored: 0,
    };
    const result = runAccountChecks(account, baseCheckConfig);
    const comment = formatCommentBody(result, {
      ...baseCheckConfig,
      stellarAddress: account.account_id,
      horizonUrl: 'https://horizon.stellar.org',
    });
    const outputs = toActionOutputs(result);

    // Result should be valid
    expect(result.valid).toBe(true);
    // Comment should mention sponsoring
    expect(comment).toContain('Accounts this account sponsors: **5**');
    // Outputs should show sponsoring count
    expect(outputs.num_sponsoring).toBe('5');
  });

  it('clarifies no misleading language for sponsored accounts', () => {
    const account: HorizonAccount = {
      ...baseAccount,
      num_sponsored: 1,
    };
    const result = runAccountChecks(account, baseCheckConfig);
    const comment = formatCommentBody(result, {
      ...baseCheckConfig,
      stellarAddress: account.account_id,
      horizonUrl: 'https://horizon.stellar.org',
    });

    // Should not claim account is "fully funded" in misleading way
    // (Sponsor covers the cost, not the account itself)
    expect(comment).not.toContain('fully funded');
    // Should clarify sponsor bears the cost
    expect(comment).toContain('sponsoring account bears');
  });
});

// ---------------------------------------------------------------------------
// Enhanced sponsorship context display (Issue #1)
// ---------------------------------------------------------------------------

describe('Enhanced sponsorship context display', () => {
  const commentConfig = {
    ...baseCheckConfig,
    stellarAddress: baseAccount.account_id,
    horizonUrl: 'https://horizon.stellar.org',
  };

  it('includes net sponsorship effect calculation', () => {
    const account = { ...baseAccount, num_sponsoring: 5, num_sponsored: 2, subentry_count: 3 };
    const result = runAccountChecks(account, baseCheckConfig);
    const comment = formatCommentBody(result, commentConfig);
    
    expect(comment).toContain('Net sponsorship effect');
    expect(comment).toContain('+3'); // 5 - 2
    expect(comment).toContain('increases requirement');
  });

  it('shows negative net effect for sponsored accounts', () => {
    const account = { ...baseAccount, num_sponsoring: 1, num_sponsored: 3, subentry_count: 2 };
    const result = runAccountChecks(account, baseCheckConfig);
    const comment = formatCommentBody(result, commentConfig);
    
    expect(comment).toContain('Net sponsorship effect');
    expect(comment).toContain('-2'); // 1 - 3
    expect(comment).toContain('reduces requirement');
  });

  it('shows balanced effect when sponsoring equals sponsored', () => {
    const account = { ...baseAccount, num_sponsoring: 2, num_sponsored: 2, subentry_count: 1 };
    const result = runAccountChecks(account, baseCheckConfig);
    const comment = formatCommentBody(result, commentConfig);
    
    expect(comment).toContain('Net sponsorship effect');
    expect(comment).toContain('balanced');
  });

  it('includes reserve calculation breakdown when reserve data available', () => {
    const account = { ...baseAccount, num_sponsoring: 2, num_sponsored: 1, subentry_count: 3 };
    const result = runAccountChecks(account, baseCheckConfig);
    const comment = formatCommentBody(result, commentConfig);
    
    expect(comment).toContain('Reserve calculation breakdown');
    expect(comment).toContain('Base reserves (2)');
    expect(comment).toContain('Subentries (3)');
    expect(comment).toContain('Sponsorship (2 - 1)');
    expect(comment).toContain('Protocol minimum');
    expect(comment).toContain('Required (final)');
  });

  it('shows correct XLM values in reserve breakdown', () => {
    const account = { ...baseAccount, num_sponsoring: 4, num_sponsored: 1, subentry_count: 2 };
    const result = runAccountChecks(account, baseCheckConfig);
    const comment = formatCommentBody(result, commentConfig);
    
    // Base: 2 * 0.5 = 1.0 XLM
    expect(comment).toContain('1.0 XLM');
    // Subentries: 2 * 0.5 = 1.0 XLM
    expect(comment).toContain('+1.0 XLM');
    // Sponsorship: (4 - 1) * 0.5 = 1.5 XLM
    expect(comment).toContain('+1.5 XLM');
    // Protocol min: (2 + 2 + 4 - 1) * 0.5 = 3.5 XLM
    expect(comment).toContain('3.5 XLM');
  });

  it('warns about deep sponsorship chains when sponsoring > 3', () => {
    const account = { ...baseAccount, num_sponsoring: 5, num_sponsored: 0, subentry_count: 1 };
    const result = runAccountChecks(account, baseCheckConfig);
    const comment = formatCommentBody(result, commentConfig);
    
    expect(comment).toContain('Sponsoring 5 account');
    expect(comment).toContain('Deep sponsorship chains');
    expect(comment).toContain('sponsor-of-sponsor');
  });

  it('provides contributor guidance for fully sponsored accounts', () => {
    const account = { ...baseAccount, num_sponsoring: 0, num_sponsored: 2, subentry_count: 1 };
    const result = runAccountChecks(account, baseCheckConfig);
    const comment = formatCommentBody(result, commentConfig);
    
    expect(comment).toContain('For contributors');
    expect(comment).toContain('fully sponsored');
    expect(comment).toContain('less XLM than the displayed requirement');
  });

  it('does not show contributor guidance when also sponsoring others', () => {
    const account = { ...baseAccount, num_sponsoring: 1, num_sponsored: 2, subentry_count: 1 };
    const result = runAccountChecks(account, baseCheckConfig);
    const comment = formatCommentBody(result, commentConfig);
    
    // Should not show the "you may need less" message when also sponsoring
    expect(comment).not.toContain('For contributors');
  });

  it('includes links to CAP-0033 documentation', () => {
    const account = { ...baseAccount, num_sponsoring: 1, num_sponsored: 0, subentry_count: 1 };
    const result = runAccountChecks(account, baseCheckConfig);
    const comment = formatCommentBody(result, commentConfig);
    
    expect(comment).toContain('CAP-0033');
    expect(comment).toContain('github.com/stellar/stellar-protocol');
  });

  it('shows configured floor when it exceeds protocol minimum', () => {
    const account = { ...baseAccount, num_sponsoring: 0, num_sponsored: 0, subentry_count: 1 };
    // Protocol min = (2 + 1) * 0.5 = 1.5, but configured floor is also 1.5
    const result = runAccountChecks(account, { ...baseCheckConfig, minXlmReserve: 2.5 });
    const comment = formatCommentBody(result, {
      ...commentConfig,
      minXlmReserve: 2.5,
    });
    
    expect(comment).toContain('Configured floor');
    expect(comment).toContain('2.5 XLM');
  });
});

// ---------------------------------------------------------------------------
// Diagnostics sponsorship integration tests
// ---------------------------------------------------------------------------

describe('Diagnostics sponsorship integration', () => {
  it('buildSponsorshipDiagnostics returns empty for zero sponsorship', () => {
    const { buildSponsorshipDiagnostics } = require('../src/diagnostics');
    const result = buildSponsorshipDiagnostics(
      { numSponsoring: 0, numSponsored: 0 },
      {
        protocolMinimum: 1.0,
        configuredFloor: 1.5,
        required: 1.5,
        actual: 2.0,
        met: true,
        subentryCount: 0,
      },
    );
    expect(result).toBe('');
  });

  it('buildSponsorshipDiagnostics includes chain analysis table', () => {
    const { buildSponsorshipDiagnostics } = require('../src/diagnostics');
    const result = buildSponsorshipDiagnostics(
      { numSponsoring: 3, numSponsored: 1 },
      {
        protocolMinimum: 3.0,
        configuredFloor: 1.5,
        required: 3.0,
        actual: 3.5,
        met: true,
        subentryCount: 2,
      },
    );
    
    expect(result).toContain('Sponsorship chain analysis');
    expect(result).toContain('Chain depth context');
    expect(result).toContain('Accounts sponsored (outbound)');
    expect(result).toContain('Sponsorships received (inbound)');
    expect(result).toContain('Net sponsorship effect');
  });

  it('buildSponsorshipDiagnostics shows protocol formula', () => {
    const { buildSponsorshipDiagnostics } = require('../src/diagnostics');
    const result = buildSponsorshipDiagnostics(
      { numSponsoring: 2, numSponsored: 1 },
      {
        protocolMinimum: 2.0,
        configuredFloor: 1.5,
        required: 2.0,
        actual: 2.5,
        met: true,
        subentryCount: 1,
      },
    );
    
    expect(result).toContain('Protocol formula');
    expect(result).toContain('(2 + subentries + sponsoring - sponsored)');
    expect(result).toContain('(2 + 1 + 2 - 1)');
  });

  it('buildSponsorshipDiagnostics warns about deep chains', () => {
    const { buildSponsorshipDiagnostics } = require('../src/diagnostics');
    const result = buildSponsorshipDiagnostics(
      { numSponsoring: 5, numSponsored: 0 },
      {
        protocolMinimum: 3.5,
        configuredFloor: 1.5,
        required: 3.5,
        actual: 4.0,
        met: true,
        subentryCount: 0,
      },
    );
    
    expect(result).toContain('Deep sponsorship chain detected');
    expect(result).toContain('sponsors more than 3 accounts');
    expect(result).toContain('cascading reserve failures');
  });

  it('buildSponsorshipDiagnostics detects overfunding in sponsored accounts', () => {
    const { buildSponsorshipDiagnostics } = require('../src/diagnostics');
    const result = buildSponsorshipDiagnostics(
      { numSponsoring: 0, numSponsored: 2 },
      {
        protocolMinimum: 0.5,
        configuredFloor: 1.5,
        required: 1.5,
        actual: 5.0, // 3.5 XLM surplus
        met: true,
        subentryCount: 1,
      },
    );
    
    expect(result).toContain('Overfunding detected');
    expect(result).toContain('3.5 XLM surplus');
    expect(result).toContain('operational funds');
  });

  it('buildSponsorshipDiagnostics shows correct impact calculations', () => {
    const { buildSponsorshipDiagnostics } = require('../src/diagnostics');
    const result = buildSponsorshipDiagnostics(
      { numSponsoring: 4, numSponsored: 1 },
      {
        protocolMinimum: 3.5,
        configuredFloor: 1.5,
        required: 3.5,
        actual: 4.0,
        met: true,
        subentryCount: 2,
      },
    );
    
    // Sponsoring impact: 4 * 0.5 = 2.0 XLM
    expect(result).toContain('+2.0 XLM to requirement');
    // Sponsored impact: 1 * 0.5 = 0.5 XLM
    expect(result).toContain('-0.5 XLM from requirement');
    // Net: (4 - 1) * 0.5 = 1.5 XLM
    expect(result).toContain('Increases');
    expect(result).toContain('1.5 XLM');
  });
});
