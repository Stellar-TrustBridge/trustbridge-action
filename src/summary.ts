import { ValidationResult } from './checks';
import { privacyMaskAddress } from './delta';
import { CircuitOpenMetrics } from './resilience';

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
// #788 — Circuit-open metrics in the Job Summary
// ---------------------------------------------------------------------------

/**
 * Render a Job Summary section explaining why Horizon checks paused. Returns
 * an empty string when the circuit is not open. Only the error class name is
 * shown; raw Horizon bodies and error messages are never included.
 */
export function formatCircuitOpenSummary(metrics: CircuitOpenMetrics | null | undefined): string {
  if (!metrics || metrics.state !== 'open') return '';
  const seconds = Math.round(Math.max(0, metrics.openDurationMs) / 1000);
  const errorClass = metrics.lastErrorClass ?? 'unknown';
  return [
    '### ⚡ Horizon circuit breaker open',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Open duration | ${seconds}s |`,
    `| Last error class | \`${errorClass}\` |`,
    `| Consecutive failures | ${metrics.consecutiveFailures} |`,
    '',
  ].join('\n');
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
  /**
   * Number of issues blocked specifically by `clawback_strict_mode`
   * (Issue #725). Counted separately from warn-mode clawback warnings so the
   * digest can distinguish a policy block from an informational warning.
   */
  clawbackStrictFailureCount: number;
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
 * Detect a clawback strict-mode failure in a `ValidationResult`
 * (Issue #725).
 *
 * `checks.ts` emits a dedicated `"<ASSET> clawback safety"` check that only
 * fails when the matched trustline has clawback enabled *and*
 * `clawback_strict_mode` is on — so a failed clawback check is by definition a
 * strict-mode block, never a warn-mode advisory.
 */
export function isClawbackStrictFailure(result: ValidationResult): boolean {
  return result.checks.some(
    (check) => !check.passed && /clawback/i.test(check.label),
  );
}

/** Count how many of `results` failed because of `clawback_strict_mode`. */
export function countClawbackStrictFailures(
  results: ValidationResult[],
): number {
  return results.filter(isClawbackStrictFailure).length;
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
    clawbackStrictFailureCount: countClawbackStrictFailures(
      maskedEntries.map((e) => e.result),
    ),
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
  const clawbackStrictFailureCount = report.clawbackStrictFailureCount ?? 0;
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
  ];

  // Issue #725: strict clawback blocks are counted (and labelled) separately
  // from every other blocked contributor so triage can distinguish a policy
  // block from a missing trustline or low reserve.
  if (clawbackStrictFailureCount > 0) {
    lines.push(
      `| 🚫 Clawback strict blocks | **${clawbackStrictFailureCount}** |`,
    );
  }

  lines.push('');

  // Blocked section
  if (report.blockedEntries.length > 0) {
    lines.push('### ❌ Blocked contributors', '');
    for (const entry of report.blockedEntries) {
      const failedLabels = entry.result.checks
        .filter((c) => !c.passed)
        .map((c) => c.label)
        .join(', ');
      const title = entry.issueTitle ? ` — ${entry.issueTitle}` : '';
      const clawbackSuffix = isClawbackStrictFailure(entry.result)
        ? ' (`CLAWBACK_STRICT_MODE`)'
        : '';
      lines.push(
        `- **#${entry.issueNumber}**${title}: \`${entry.stellarAddress}\` — ❌ ${failedLabels}${clawbackSuffix}`,
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

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// #764 — Delta reporting between successive runs
// ---------------------------------------------------------------------------

/**
 * A single human-readable change detected between two successive runs.
 * `kind` is a stable machine token so callers/tests can assert on it without
 * parsing the human `label`.
 */
export interface DeltaChange {
  kind:
    | 'new_trustline'
    | 'funded'
    | 'clawback_cleared'
    | 'clawback_added'
    | 'check_passed'
    | 'check_failed';
  label: string;
}

/**
 * Compute the delta between a previous and current `ValidationResult`.
 *
 * Surfaces progress signals (new trustline, funded, clawback cleared) plus
 * generic pass/fail transitions so the rendered comment can show what changed
 * instead of repeating an identical full check dump.
 *
 * Returns an empty array when nothing changed. Throws a stable error when
 * either input is missing or malformed so CI fails loudly rather than silently
 * dropping the delta.
 */
export function computeDelta(
  previous: ValidationResult | null | undefined,
  current: ValidationResult | null | undefined,
): DeltaChange[] {
  if (!previous || !Array.isArray(previous.checks)) {
    throw new Error('delta: previous validation result is missing or malformed');
  }
  if (!current || !Array.isArray(current.checks)) {
    throw new Error('delta: current validation result is missing or malformed');
  }

  const prevByLabel = new Map(previous.checks.map((c) => [c.label, c]));
  const changes: DeltaChange[] = [];

  for (const check of current.checks) {
    const prev = prevByLabel.get(check.label);
    const wasPassing = prev ? prev.passed : false;

    if (!prev) {
      // A brand-new check appearing is a new trustline / newly evaluated asset.
      if (/trustline/i.test(check.label)) {
        changes.push({
          kind: 'new_trustline',
          label: `New trustline detected: ${check.label}`,
        });
      }
      continue;
    }

    if (!wasPassing && check.passed) {
      if (/clawback/i.test(check.label)) {
        changes.push({
          kind: 'clawback_cleared',
          label: `Clawback cleared: ${check.label}`,
        });
      } else if (/fund|reserve|balance/i.test(check.label)) {
        changes.push({
          kind: 'funded',
          label: `Now funded: ${check.label}`,
        });
      } else {
        changes.push({
          kind: 'check_passed',
          label: `Now passing: ${check.label}`,
        });
      }
    } else if (wasPassing && !check.passed) {
      if (/clawback/i.test(check.label)) {
        changes.push({
          kind: 'clawback_added',
          label: `Clawback enabled: ${check.label}`,
        });
      } else {
        changes.push({
          kind: 'check_failed',
          label: `Now failing: ${check.label}`,
        });
      }
    }
  }

  return changes;
}

/**
 * Render a Markdown delta section for the comment. Returns an empty string
 * when there are no changes so callers can omit the section entirely.
 */
export function formatDeltaSection(changes: DeltaChange[]): string {
  if (changes.length === 0) {
    return '';
  }
  const lines = ['### 🔄 Changes since last run', ''];
  for (const change of changes) {
    lines.push(`- ${change.label}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// #780 — Job Summary markdown size guard
// ---------------------------------------------------------------------------

/**
 * GitHub rejects step summaries larger than 1 MiB (1,048,576 bytes). Large
 * batch results must be truncated before `core.summary.write()` so the Wave
 * results are never silently dropped.
 */
export const JOB_SUMMARY_MAX_BYTES = 1024 * 1024;

/** Stable marker appended to every truncated Job Summary. */
export const JOB_SUMMARY_TRUNCATED_MARKER = '<!-- trustbridge-action:summary-truncated -->';

export interface JobSummaryGuardResult {
  markdown: string;
  truncated: boolean;
  /** UTF-8 byte length of the original markdown. */
  originalBytes: number;
}

/**
 * Ensure `markdown` fits within the GitHub Job Summary size limit.
 *
 * Content under the limit is returned unchanged. Oversized content is cut at
 * the last line boundary that fits (never splitting a multi-byte character)
 * and followed by a notice pointing readers at the issue comment, when one is
 * known, or the workflow logs otherwise.
 *
 * @throws When `markdown` is not a string or `maxBytes` is not a positive
 *         integer large enough to hold the truncation notice.
 */
export function guardJobSummaryMarkdown(
  markdown: string,
  options: { maxBytes?: number; commentUrl?: string } = {},
): JobSummaryGuardResult {
  if (typeof markdown !== 'string') {
    throw new Error('summary: Job Summary markdown must be a string');
  }
  const maxBytes = options.maxBytes ?? JOB_SUMMARY_MAX_BYTES;
  const originalBytes = Buffer.byteLength(markdown, 'utf8');
  if (originalBytes <= maxBytes) {
    return { markdown, truncated: false, originalBytes };
  }

  const pointer = options.commentUrl
    ? `See the [full results in the issue comment](${options.commentUrl}).`
    : 'See the workflow logs for full details.';
  const notice = `\n\n${JOB_SUMMARY_TRUNCATED_MARKER}\n> ⚠️ Job Summary truncated (${originalBytes} bytes exceeds the ${maxBytes}-byte limit). ${pointer}\n`;
  const budget = maxBytes - Buffer.byteLength(notice, 'utf8');
  if (!Number.isInteger(maxBytes) || budget <= 0) {
    throw new Error(`summary: maxBytes (${maxBytes}) is too small to hold the truncation notice`);
  }

  // Cut on a byte budget, then drop any partial trailing character and line.
  let head = Buffer.from(markdown, 'utf8').subarray(0, budget).toString('utf8');
  if (head.endsWith('�')) head = head.slice(0, -1);
  const lastNewline = head.lastIndexOf('\n');
  if (lastNewline > 0) head = head.slice(0, lastNewline);

  return { markdown: head + notice, truncated: true, originalBytes };
}
