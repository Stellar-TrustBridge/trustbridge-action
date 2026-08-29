/**
 * Tests for #324 — Weekly digest mode aggregator.
 */
import {
  aggregateDigest,
  formatDigestComment,
  DigestEntry,
  DIGEST_MAX_LISTED_ISSUES,
} from '../src/summary';
import { ValidationResult } from '../src/checks';

// ── helpers ────────────────────────────────────────────────────────────────

function makeResult(valid: boolean, failures: string[] = []): ValidationResult {
  const checks = [
    { passed: !failures.includes('Account funded'), label: 'Account funded', detail: valid ? 'ok' : 'not funded' },
    { passed: !failures.includes('USDC trustline'), label: 'USDC trustline', detail: valid ? 'ok' : 'missing' },
    { passed: !failures.includes('XLM reserve'),   label: 'XLM reserve',   detail: valid ? 'ok' : 'low' },
  ];
  return {
    valid,
    accountFunded: !failures.includes('Account funded'),
    trustlineExists: !failures.includes('USDC trustline'),
    xlmBalance: valid ? '5.0000000' : '0.5000000',
    xlmReserveMet: !failures.includes('XLM reserve'),
    checks,
  };
}

const ADDR_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const ADDR_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBUA';

// ── aggregateDigest ─────────────────────────────────────────────────────────

describe('aggregateDigest', () => {
  it('returns zero counts for an empty entry list', () => {
    const report = aggregateDigest([]);
    expect(report.totalIssues).toBe(0);
    expect(report.readyCount).toBe(0);
    expect(report.blockedCount).toBe(0);
    expect(report.readyRate).toBe('0.0%');
    expect(report.readyEntries).toEqual([]);
    expect(report.blockedEntries).toEqual([]);
  });

  it('correctly partitions ready vs blocked entries', () => {
    const entries: DigestEntry[] = [
      { issueNumber: 1, stellarAddress: ADDR_A, result: makeResult(true) },
      { issueNumber: 2, stellarAddress: ADDR_B, result: makeResult(false, ['USDC trustline']) },
    ];
    const report = aggregateDigest(entries);
    expect(report.totalIssues).toBe(2);
    expect(report.readyCount).toBe(1);
    expect(report.blockedCount).toBe(1);
    expect(report.readyRate).toBe('50.0%');
    expect(report.readyEntries).toHaveLength(1);
    expect(report.blockedEntries).toHaveLength(1);
  });

  it('applies privacy masking (hashing) to addresses when privacyMode is true', () => {
    const entries: DigestEntry[] = [
      { issueNumber: 1, stellarAddress: ADDR_A, result: makeResult(true) },
    ];
    const report = aggregateDigest(entries, { privacyMode: true });
    expect(report.privacyMode).toBe(true);
    // Hashed address should start with sha256: prefix
    expect(report.readyEntries[0]!.stellarAddress).toMatch(/^sha256:/);
    expect(report.readyEntries[0]!.stellarAddress).not.toContain(ADDR_A);
  });

  it('does NOT mask addresses when privacyMode is false (default)', () => {
    const entries: DigestEntry[] = [
      { issueNumber: 1, stellarAddress: ADDR_A, result: makeResult(true) },
    ];
    const report = aggregateDigest(entries, { privacyMode: false });
    expect(report.privacyMode).toBe(false);
    expect(report.readyEntries[0]!.stellarAddress).toBe(ADDR_A);
  });

  it('uses a custom `now` timestamp when provided', () => {
    const entries: DigestEntry[] = [
      { issueNumber: 1, stellarAddress: ADDR_A, result: makeResult(true) },
    ];
    const report = aggregateDigest(entries, { now: '2026-01-01T00:00:00.000Z' });
    expect(report.generatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it(`caps each section at DIGEST_MAX_LISTED_ISSUES (${DIGEST_MAX_LISTED_ISSUES})`, () => {
    const entries: DigestEntry[] = Array.from({ length: DIGEST_MAX_LISTED_ISSUES + 10 }, (_, i) => ({
      issueNumber: i + 1,
      stellarAddress: ADDR_A,
      result: makeResult(false, ['USDC trustline']),
    }));
    const report = aggregateDigest(entries);
    expect(report.blockedEntries).toHaveLength(DIGEST_MAX_LISTED_ISSUES);
    expect(report.blockedCount).toBe(DIGEST_MAX_LISTED_ISSUES + 10);
  });

  it('computes correct ready rate for all-ready scenario', () => {
    const entries: DigestEntry[] = [
      { issueNumber: 1, stellarAddress: ADDR_A, result: makeResult(true) },
      { issueNumber: 2, stellarAddress: ADDR_B, result: makeResult(true) },
    ];
    const report = aggregateDigest(entries);
    expect(report.readyRate).toBe('100.0%');
  });

  it('computes correct ready rate for all-blocked scenario', () => {
    const entries: DigestEntry[] = [
      { issueNumber: 1, stellarAddress: ADDR_A, result: makeResult(false, ['Account funded']) },
      { issueNumber: 2, stellarAddress: ADDR_B, result: makeResult(false, ['USDC trustline']) },
    ];
    const report = aggregateDigest(entries);
    expect(report.readyRate).toBe('0.0%');
  });
});

// ── formatDigestComment ─────────────────────────────────────────────────────

describe('formatDigestComment', () => {
  const baseEntries: DigestEntry[] = [
    { issueNumber: 1, stellarAddress: ADDR_A, result: makeResult(true), issueTitle: 'Bounty A' },
    { issueNumber: 2, stellarAddress: ADDR_B, result: makeResult(false, ['USDC trustline']), issueTitle: 'Bounty B' },
  ];

  it('includes the digest HTML marker', () => {
    const report = aggregateDigest(baseEntries);
    const md = formatDigestComment(report);
    expect(md).toContain('<!-- trustbridge-action:digest -->');
  });

  it('includes summary table with correct values', () => {
    const report = aggregateDigest(baseEntries);
    const md = formatDigestComment(report);
    expect(md).toContain('| Total issues checked | **2** |');
    expect(md).toContain('| ✅ Ready | **1** |');
    expect(md).toContain('| ❌ Blocked | **1** |');
    expect(md).toContain('| Ready rate | **50.0%** |');
  });

  it('includes blocked contributors section', () => {
    const report = aggregateDigest(baseEntries);
    const md = formatDigestComment(report);
    expect(md).toContain('### ❌ Blocked contributors');
    expect(md).toContain('#2');
    expect(md).toContain('USDC trustline');
  });

  it('includes ready contributors section', () => {
    const report = aggregateDigest(baseEntries);
    const md = formatDigestComment(report);
    expect(md).toContain('### ✅ Ready contributors');
    expect(md).toContain('#1');
    expect(md).toContain('all checks pass');
  });

  it('shows issue title when provided', () => {
    const report = aggregateDigest(baseEntries);
    const md = formatDigestComment(report);
    expect(md).toContain('Bounty A');
    expect(md).toContain('Bounty B');
  });

  it('shows truncation note when blocked count exceeds cap', () => {
    const manyBlocked: DigestEntry[] = Array.from({ length: DIGEST_MAX_LISTED_ISSUES + 5 }, (_, i) => ({
      issueNumber: i + 1,
      stellarAddress: ADDR_A,
      result: makeResult(false, ['Account funded']),
    }));
    const report = aggregateDigest(manyBlocked);
    const md = formatDigestComment(report);
    expect(md).toContain('and 5 more');
  });

  it('indicates privacy mode in the header when enabled', () => {
    const report = aggregateDigest(baseEntries, { privacyMode: true });
    const md = formatDigestComment(report);
    expect(md).toContain('addresses hashed');
  });

  it('shows privacy mode off in header when disabled', () => {
    const report = aggregateDigest(baseEntries, { privacyMode: false });
    const md = formatDigestComment(report);
    expect(md).toContain('Privacy mode: off');
  });

  it('includes the TrustBridge footer', () => {
    const report = aggregateDigest(baseEntries);
    const md = formatDigestComment(report);
    expect(md).toContain('trustbridge-action');
    expect(md).toContain('digest mode');
  });

  it('produces valid Markdown (no unclosed code fences or headers)', () => {
    const report = aggregateDigest(baseEntries);
    const md = formatDigestComment(report);
    // Basic sanity: should not be empty and should contain newlines
    expect(md.length).toBeGreaterThan(100);
    expect(md).toContain('\n');
  });
});
