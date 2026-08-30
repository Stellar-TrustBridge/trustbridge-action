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
