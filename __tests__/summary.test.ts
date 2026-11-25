import { ValidationResult } from '../src/checks';
import {
  summarizeChecks,
  formatFailureSummary,
  aggregateDigest,
  formatDigestComment,
  DigestEntry,
  DIGEST_MAX_LISTED_ISSUES,
} from '../src/summary';

function makeResult(checks: { label: string; passed: boolean }[]): ValidationResult {
  return { valid: checks.every((c) => c.passed), checks } as ValidationResult;
}

describe('summarizeChecks', () => {
  it('counts all-pass checks', () => {
    const result = makeResult([
      { label: 'account exists', passed: true },
      { label: 'has trustline', passed: true },
    ]);
    expect(summarizeChecks(result)).toEqual({
      total: 2,
      passed: 2,
      failed: 0,
      failedLabels: [],
    });
  });

  it('collects failed labels', () => {
    const result = makeResult([
      { label: 'account exists', passed: true },
      { label: 'has trustline', passed: false },
      { label: 'not frozen', passed: false },
    ]);
    expect(summarizeChecks(result)).toEqual({
      total: 3,
      passed: 1,
      failed: 2,
      failedLabels: ['has trustline', 'not frozen'],
    });
  });

  it('handles empty checks', () => {
    expect(summarizeChecks(makeResult([]))).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      failedLabels: [],
    });
  });
});

describe('formatFailureSummary', () => {
  it('returns "none" when all checks pass', () => {
    const result = makeResult([{ label: 'account exists', passed: true }]);
    expect(formatFailureSummary(result)).toBe('none');
  });

  it('returns "none" for empty checks', () => {
    expect(formatFailureSummary(makeResult([]))).toBe('none');
  });

  it('joins failed labels with commas', () => {
    const result = makeResult([
      { label: 'has trustline', passed: false },
      { label: 'not frozen', passed: false },
    ]);
    expect(formatFailureSummary(result)).toBe('has trustline, not frozen');
  });

  it('formats long label lists', () => {
    const labels = Array.from({ length: 25 }, (_, i) => `check-${i}`);
    const result = makeResult(labels.map((label) => ({ label, passed: false })));
    const formatted = formatFailureSummary(result);
    expect(formatted.split(', ')).toHaveLength(25);
    expect(formatted).toContain('check-0');
    expect(formatted).toContain('check-24');
  });
});

describe('aggregateDigest', () => {
  const address = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';

  function entry(issueNumber: number, passed: boolean): DigestEntry {
    return {
      issueNumber,
      stellarAddress: address,
      result: makeResult([{ label: 'account exists', passed }]),
    };
  }

  it('splits ready and blocked entries', () => {
    const report = aggregateDigest([entry(1, true), entry(2, false)], {
      now: '2024-01-01T00:00:00.000Z',
    });
    expect(report.totalIssues).toBe(2);
    expect(report.readyCount).toBe(1);
    expect(report.blockedCount).toBe(1);
    expect(report.readyRate).toBe('50.0%');
    expect(report.generatedAt).toBe('2024-01-01T00:00:00.000Z');
  });

  it('handles empty entries', () => {
    const report = aggregateDigest([], { now: '2024-01-01T00:00:00.000Z' });
    expect(report.totalIssues).toBe(0);
    expect(report.readyRate).toBe('0.0%');
  });

  it('redacts full addresses when privacyMode is on', () => {
    const report = aggregateDigest([entry(1, true)], { privacyMode: true });
    expect(report.privacyMode).toBe(true);
    expect(report.readyEntries[0].stellarAddress).not.toBe(address);
    expect(report.readyEntries[0].stellarAddress).not.toContain(address);
  });

  it('keeps full addresses when privacyMode is off', () => {
    const report = aggregateDigest([entry(1, true)]);
    expect(report.privacyMode).toBe(false);
    expect(report.readyEntries[0].stellarAddress).toBe(address);
  });

  it('caps listed entries at DIGEST_MAX_LISTED_ISSUES', () => {
    const entries = Array.from({ length: DIGEST_MAX_LISTED_ISSUES + 5 }, (_, i) =>
      entry(i + 1, true),
    );
    const report = aggregateDigest(entries);
    expect(report.readyEntries).toHaveLength(DIGEST_MAX_LISTED_ISSUES);
    expect(report.readyCount).toBe(DIGEST_MAX_LISTED_ISSUES + 5);
  });
});

describe('formatDigestComment', () => {
  const address = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';

  function entry(issueNumber: number, passed: boolean): DigestEntry {
    return {
      issueNumber,
      stellarAddress: address,
      result: makeResult([{ label: 'account exists', passed }]),
    };
  }

  it('renders summary and sections', () => {
    const report = aggregateDigest([entry(1, true), entry(2, false)], {
      now: '2024-01-01T00:00:00.000Z',
    });
    const comment = formatDigestComment(report);
    expect(comment).toContain('## TrustBridge — Weekly Wallet Digest');
    expect(comment).toContain('| Total issues checked | **2** |');
    expect(comment).toContain('### ❌ Blocked contributors');
    expect(comment).toContain('### ✅ Ready contributors');
  });

  it('does not leak full addresses when privacyMode is on', () => {
    const report = aggregateDigest([entry(1, true), entry(2, false)], {
      privacyMode: true,
    });
    const comment = formatDigestComment(report);
    expect(comment).not.toContain(address);
  });

  it('notes truncation when entries exceed the cap', () => {
    const entries = Array.from({ length: DIGEST_MAX_LISTED_ISSUES + 3 }, (_, i) =>
      entry(i + 1, true),
    );
    const report = aggregateDigest(entries);
    const comment = formatDigestComment(report);
    expect(comment).toContain('more (capped at');
  });
});
