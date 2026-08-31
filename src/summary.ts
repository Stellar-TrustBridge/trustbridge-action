import { ValidationResult } from './checks';
import { privacyMaskAddress } from './delta';

export interface CheckSummary {
  total: number;
  passed: number;
  failed: number;
  failedLabels: string[];
}

export function summarizeChecks(result: ValidationResult): CheckSummary {
  const failedLabels = result.checks
    .filter((check) => !check.passed)
    .map((check) => check.label);

  return {
    total: result.checks.length,
    passed: result.checks.length - failedLabels.length,
    failed: failedLabels.length,
    failedLabels,
  };
}

export function formatFailureSummary(result: ValidationResult): string {
  const summary = summarizeChecks(result);
  return summary.failedLabels.length > 0
    ? summary.failedLabels.join(', ')
    : 'none';
}

// ---------------------------------------------------------------------------
// #324 — Weekly digest mode
// ---------------------------------------------------------------------------

/**
 * A single entry in the digest, representing one issue/address validation run.
 */
export interface DigestEntry {
  /** GitHub issue number (e.g. 42). */
  issueNumber: number;
  /** Stellar address validated. Redacted when privacyMode is true. */
  stellarAddress: string;
  /** Validation result for this entry. */
  result: ValidationResult;
  /** ISO-8601 timestamp of this validation run. */
  validatedAt?: string;
  /** Optional issue title for display purposes. */
  issueTitle?: string;
}

/**
 * Aggregated digest across multiple `DigestEntry` items, produced by
 * `aggregateDigest`.
 */
export interface DigestReport {
  /** Total issues validated. */
  totalIssues: number;
  /** Number of issues where all checks passed. */
  readyCount: number;
  /** Number of issues where at least one check failed. */
  blockedCount: number;
  /** Ready rate as a percentage string (e.g. "66.7%"). */
  readyRate: string;
  /** Entries that are fully ready (all checks pass). */
  readyEntries: DigestEntry[];
  /** Entries that have at least one failed check. */
  blockedEntries: DigestEntry[];
  /** ISO-8601 digest generation timestamp. */
  generatedAt: string;
  /** Whether address redaction is active. */
  privacyMode: boolean;
}

/**
 * Maximum number of entries listed per section in the Markdown digest.
 * Caps the comment size on large Wave issues (e.g. 200+ contributors).
 */
export const DIGEST_MAX_LISTED_ISSUES = 50;

/**
 * Aggregate multiple `DigestEntry` items into a `DigestReport`.
 *
 * - When `privacyMode` is true, addresses are hashed (sha256 prefix) in the
 *   report so the digest can be posted publicly without leaking contributor
 *   addresses.
 * - Entries are capped at `DIGEST_MAX_LISTED_ISSUES` per section to keep
 *   comment size within GitHub limits.
 *
 * @param entries  One entry per issue/address validation run.
 * @param options  Aggregation options.
 */
export function aggregateDigest(
  entries: DigestEntry[],
  options: { privacyMode?: boolean; now?: string } = {},
): DigestReport {
  const privacyMode = Boolean(options.privacyMode);
  const generatedAt = options.now ?? new Date().toISOString();

  // Apply privacy masking to addresses only when privacyMode is on.
  const maskedEntries: DigestEntry[] = entries.map((entry) => ({
    ...entry,
    stellarAddress: privacyMode
      ? privacyMaskAddress(entry.stellarAddress, true)
      : entry.stellarAddress,
  }));

  const readyEntries = maskedEntries.filter((e) => e.result.valid);
  const blockedEntries = maskedEntries.filter((e) => !e.result.valid);
  const totalIssues = maskedEntries.length;
  const readyCount = readyEntries.length;
  const blockedCount = blockedEntries.length;
  const readyRateNum = totalIssues > 0 ? (readyCount / totalIssues) * 100 : 0;
  const readyRate = `${readyRateNum.toFixed(1)}%`;

  return {
    totalIssues,
    readyCount,
    blockedCount,
    readyRate,
    readyEntries: readyEntries.slice(0, DIGEST_MAX_LISTED_ISSUES),
    blockedEntries: blockedEntries.slice(0, DIGEST_MAX_LISTED_ISSUES),
    generatedAt,
    privacyMode,
  };
}

/**
 * Format a `DigestReport` as a Markdown string suitable for posting as a
 * GitHub issue comment.
 *
 * - Lists ready and blocked contributors with their issue numbers and
 *   (optionally redacted) addresses.
 * - Caps each section at `DIGEST_MAX_LISTED_ISSUES` with a note when
 *   truncated.
 * - Includes a machine-readable gate summary (ready/blocked counts).
 */
export function formatDigestComment(report: DigestReport): string {
  const lines: string[] = [
    '<!-- trustbridge-action:digest -->',
    '## TrustBridge — Weekly Wallet Digest',
    '',
    `_Generated: \`${report.generatedAt}\`_`,
    `_Privacy mode: ${report.privacyMode ? '**on** (addresses hashed)' : 'off'}_`,
    '',
    '### Summary',
    '',
    `| Metric | Value |`,
    `| --- | --- |`,
    `| Total issues checked | **${report.totalIssues}** |`,
    `| ✅ Ready | **${report.readyCount}** |`,
    `| ❌ Blocked | **${report.blockedCount}** |`,
    `| Ready rate | **${report.readyRate}** |`,
    '',
  ];

  // Blocked section
  if (report.blockedEntries.length > 0) {
    lines.push('### ❌ Blocked contributors', '');
    for (const entry of report.blockedEntries) {
      const failedLabels = entry.result.checks
        .filter((c) => !c.passed)
        .map((c) => c.label)
        .join(', ');
      const title = entry.issueTitle ? ` — ${entry.issueTitle}` : '';
      lines.push(
        `- **#${entry.issueNumber}**${title}: \`${entry.stellarAddress}\` — ❌ ${failedLabels}`,
      );
    }
    if (report.blockedCount > DIGEST_MAX_LISTED_ISSUES) {
      lines.push(
        `- _… and ${report.blockedCount - DIGEST_MAX_LISTED_ISSUES} more (capped at ${DIGEST_MAX_LISTED_ISSUES})_`,
      );
    }
    lines.push('');
  }

  // Ready section
  if (report.readyEntries.length > 0) {
    lines.push('### ✅ Ready contributors', '');
    for (const entry of report.readyEntries) {
      const title = entry.issueTitle ? ` — ${entry.issueTitle}` : '';
      lines.push(`- **#${entry.issueNumber}**${title}: \`${entry.stellarAddress}\` — ✅ all checks pass`);
    }
    if (report.readyCount > DIGEST_MAX_LISTED_ISSUES) {
      lines.push(
        `- _… and ${report.readyCount - DIGEST_MAX_LISTED_ISSUES} more (capped at ${DIGEST_MAX_LISTED_ISSUES})_`,
      );
    }
    lines.push('');
  }

  lines.push(
    '---',
    '_Posted by [trustbridge-action](https://github.com/Stellar-TrustBridge/trustbridge-action) — digest mode_',
  );

  return lines.join('\n');
}
