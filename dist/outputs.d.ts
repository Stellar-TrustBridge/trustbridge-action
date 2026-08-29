import { ValidationResult } from './checks';
import { ValidationDelta, ValidationArtifact } from './delta';
export interface ActionTimings {
    input_parse_ms?: number;
    horizon_fetch_ms?: number;
    checks_ms?: number;
    comment_post_ms?: number;
    total_ms?: number;
}
export interface ActionOutputExtras {
    horizonUrl?: string;
    assetCode?: string;
    assetIssuer?: string;
    timings?: ActionTimings;
    validatedAt?: string;
    /**
     * #319 — Conflict report to embed in outputs. When present,
     * `conflict_report` and `has_conflicts` outputs are set accordingly.
     */
    conflictReport?: ConflictReport | null;
}
/**
 * A single source that provided a value for a given field.
 */
export interface ConflictSource {
    /** Symbolic source name: 'workflow_input' | 'assignee_map' | 'contract' | 'config_file'. */
    source: string;
    /** The raw value provided by this source (redacted if privacyMode). */
    value: string;
}
/**
 * A detected conflict — two or more sources disagree on the same field.
 */
export interface ConflictEntry {
    /** The field that has conflicting values (e.g. 'stellar_address', 'asset_issuer'). */
    field: string;
    /** The value that was ultimately used (winning source according to precedence). */
    resolvedValue: string;
    /** All sources that provided a value, including the winner. */
    sources: ConflictSource[];
}
/**
 * Complete conflict report for a single run.
 */
export interface ConflictReport {
    /** True when at least one conflict was found. */
    hasConflicts: boolean;
    /** List of individual field conflicts. Empty when `hasConflicts` is false. */
    conflicts: ConflictEntry[];
    /** ISO-8601 timestamp. */
    generatedAt: string;
}
/**
 * Build a `ConflictReport` from a map of field → sources.
 * A conflict exists when a field has values from ≥ 2 sources that disagree.
 *
 * @param fieldSources  Map from field name to an array of `ConflictSource` items.
 * @param privacyMode   When true, address values are masked to first4…last4.
 * @param now           ISO-8601 timestamp override for testing.
 */
export declare function buildConflictReport(fieldSources: Record<string, ConflictSource[]>, options?: {
    privacyMode?: boolean;
    now?: string;
}): ConflictReport;
/**
 * Format a `ConflictReport` as a Markdown section for embedding in an issue
 * comment.
 *
 * Returns an empty string when there are no conflicts so callers can
 * unconditionally append the result.
 */
export declare function formatConflictReportMarkdown(report: ConflictReport | null | undefined): string;
export interface ActionOutputs {
    trustline_exists: string;
    xlm_balance: string;
    account_funded: string;
    comment_url: string;
    full_report_path: string;
    ready: string;
    validated_at: string;
    reason_code: string;
    horizon_url: string;
    asset_code: string;
    asset_issuer: string;
    checks_json: string;
    asset_balance: string;
    native_balance: string;
    badge_markdown: string;
    badge_url: string;
    timings_json: string;
    timing_input_parse_ms: string;
    timing_horizon_fetch_ms: string;
    timing_checks_ms: string;
    timing_comment_post_ms: string;
    timing_total_ms: string;
    num_sponsoring: string;
    num_sponsored: string;
    /**
     * #319 — Merge-resolution conflict report.
     * JSON string listing sources that disagree on the Stellar address or
     * validation inputs (e.g. workflow input vs assignee-map vs contract).
     * Empty string (`""`) when there are no conflicts.
     */
    conflict_report: string;
    /**
     * #319 — True when at least one source conflict was detected this run.
     * Allows downstream steps to gate on `steps.trustbridge.outputs.has_conflicts == 'true'`.
     */
    has_conflicts: string;
}
export declare function toActionOutputs(result: ValidationResult, commentUrl?: string, fullReportPath?: string, extras?: ActionOutputExtras): ActionOutputs;
export declare function setValidationOutputs(result: ValidationResult, commentUrl?: string, fullReportPath?: string, extras?: ActionOutputExtras): void;
export interface WriteValidationJsonOptions {
    result: ValidationResult;
    stellarAddress: string;
    assetCode: string;
    assetIssuer: string;
    horizonUrl?: string;
    outputPath: string;
    delta?: ValidationDelta | null;
    privacyMode?: boolean;
    workspaceRoot?: string;
}
/**
 * Write a structured `validation.json` artifact for security review and
 * cross-run delta comparison. Never includes `github_token` or auth headers.
 */
export declare function writeValidationJson(options: WriteValidationJsonOptions): ValidationArtifact;
