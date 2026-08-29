import { ValidationResult } from './checks';
export interface CheckSummary {
    total: number;
    passed: number;
    failed: number;
    failedLabels: string[];
}
export declare function summarizeChecks(result: ValidationResult): CheckSummary;
export declare function formatFailureSummary(result: ValidationResult): string;
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
