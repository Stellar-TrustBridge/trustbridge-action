import { ValidationResult } from './checks';
import { CircuitOpenMetrics } from './resilience';
export interface CheckSummary {
    total: number;
    passed: number;
    failed: number;
    failedLabels: string[];
}
export declare function summarizeChecks(result: ValidationResult): CheckSummary;
export declare function formatFailureSummary(result: ValidationResult): string;
/**
 * Render a Job Summary section explaining why Horizon checks paused. Returns
 * an empty string when the circuit is not open. Only the error class name is
 * shown; raw Horizon bodies and error messages are never included.
 */
export declare function formatCircuitOpenSummary(metrics: CircuitOpenMetrics | null | undefined): string;
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
export declare function isClawbackStrictFailure(result: ValidationResult): boolean;
/** Count how many of `results` failed because of `clawback_strict_mode`. */
export declare function countClawbackStrictFailures(results: ValidationResult[]): number;
/**
 * Maximum number of entries listed per section in the Markdown digest.
 * Caps the comment size on large Wave issues (e.g. 200+ contributors).
 */
export declare const DIGEST_MAX_LISTED_ISSUES = 50;
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
export declare function aggregateDigest(entries: DigestEntry[], options?: {
    privacyMode?: boolean;
    now?: string;
}): DigestReport;
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
export declare function formatDigestComment(report: DigestReport): string;
/**
 * A single human-readable change detected between two successive runs.
 * `kind` is a stable machine token so callers/tests can assert on it without
 * parsing the human `label`.
 */
export interface DeltaChange {
    kind: 'new_trustline' | 'funded' | 'clawback_cleared' | 'clawback_added' | 'check_passed' | 'check_failed';
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
export declare function computeDelta(previous: ValidationResult | null | undefined, current: ValidationResult | null | undefined): DeltaChange[];
/**
 * Render a Markdown delta section for the comment. Returns an empty string
 * when there are no changes so callers can omit the section entirely.
 */
export declare function formatDeltaSection(changes: DeltaChange[]): string;
/**
 * GitHub rejects step summaries larger than 1 MiB (1,048,576 bytes). Large
 * batch results must be truncated before `core.summary.write()` so the Wave
 * results are never silently dropped.
 */
export declare const JOB_SUMMARY_MAX_BYTES: number;
/** Stable marker appended to every truncated Job Summary. */
export declare const JOB_SUMMARY_TRUNCATED_MARKER = "<!-- trustbridge-action:summary-truncated -->";
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
export declare function guardJobSummaryMarkdown(markdown: string, options?: {
    maxBytes?: number;
    commentUrl?: string;
}): JobSummaryGuardResult;
