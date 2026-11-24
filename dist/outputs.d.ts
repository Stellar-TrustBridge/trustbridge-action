import { ValidationResult } from './checks';
import { ValidationDelta, ValidationArtifact } from './delta';
export interface ActionTimings {
    input_parse_ms?: number;
    horizon_fetch_ms?: number;
    checks_ms?: number;
    comment_post_ms?: number;
    total_ms?: number;
}
export interface AssetTrustlineStatus {
    assetCode: string;
    assetIssuer: string;
    trustlineExists: boolean;
    balance: string;
}
export interface ActionOutputExtras {
    horizonUrl?: string;
    assetCode?: string;
    assetIssuer?: string;
    assetsTrustlineStatus?: AssetTrustlineStatus[];
    timings?: ActionTimings;
    validatedAt?: string;
    assigneeLogin?: string;
    stellarAddress?: string;
    /**
     * #319 — Conflict report to embed in outputs. When present,
     * `conflict_report` and `has_conflicts` outputs are set accordingly.
     */
    conflictReport?: ConflictReport | null;
    /** #459 — Friendbot outputs */
    friendbotCalled?: boolean;
    friendbotSuccess?: boolean;
    friendbotTransactionHash?: string;
    /**
     * #550 — GitHub Check Run outputs. When `use_check_runs` is enabled,
     * index.ts passes the created run's id and conclusion here so
     * `setValidationOutputs` stays the single publisher of every action.yml
     * output. Absent values publish as empty strings, matching the
     * "empty otherwise" contract documented in action.yml.
     */
    checkRunId?: string;
    checkRunConclusion?: string;
    /**
     * #696 — Numeric REST id of the issue comment TrustBridge created or
     * updated this run, as a string. Absent when no comment was posted
     * (`posting_mode: dry-run` / `off`, no issue context, or a failed post),
     * which publishes `comment_id` as an empty string.
     */
    commentId?: string;
    /**
     * #799 — True when the comment posted/updated this run happened
     * specifically because an active snooze window just lapsed (see
     * `PostedIssueComment.snoozeExpired` in `src/comment.ts`). Defaults to
     * `false`, publishing `snooze_expired` as `"false"` when absent.
     */
    snoozeExpired?: boolean;
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
/**
 * Budget for a single JSON output value, in UTF-8 bytes. Set below GitHub
 * Actions' documented 1MB per-output limit to leave headroom for the output
 * name, the `GITHUB_OUTPUT` file's own delimiter syntax, and any other
 * output written in the same step.
 */
export declare const MAX_OUTPUT_VALUE_BYTES = 900000;
/**
 * GitHub's documented limit for one step output value: 1 MiB, the same on
 * github.com and GHES. `MAX_OUTPUT_VALUE_BYTES` stays below it. See
 * docs/GHES_COMPATIBILITY.md#actions-outputs-summaries-and-annotations-issue-897.
 */
export declare const GITHUB_OUTPUT_VALUE_LIMIT_BYTES: number;
/**
 * GitHub's documented limits on workflow-command annotations
 * (`core.warning` / `core.error` / `core.notice`). Annotations past these
 * caps are dropped from the run UI but still printed to the log.
 */
export declare const WORKFLOW_ANNOTATION_LIMITS: Readonly<{
    errorsPerStep: 10;
    warningsPerStep: 10;
    perJob: 50;
}>;
/**
 * How `core.setOutput()` delivers outputs on this runner.
 *
 * - `file-command`: the runner sets `GITHUB_OUTPUT` (current github.com
 *   runners and up-to-date GHES runners).
 * - `workflow-command`: `GITHUB_OUTPUT` is missing (older GHES runners), so
 *   `@actions/core` falls back to the deprecated `::set-output` command.
 *   Outputs still work, but the runner logs a deprecation warning, and
 *   multi-line values are less reliable.
 *
 * Mirrors `@actions/core`, which only checks that the variable is non-empty.
 */
export type OutputTransport = 'file-command' | 'workflow-command';
export declare function resolveOutputTransport(env?: Record<string, string | undefined>): OutputTransport;
/** Result of truncating an array-shaped JSON output to fit a byte budget. */
export interface TruncatedJsonResult {
    /** The (possibly truncated) JSON string, always within `maxBytes`. */
    json: string;
    /** True when one or more entries were dropped to fit the budget. */
    truncated: boolean;
    /** Number of entries included in `json`. */
    includedCount: number;
    /** Number of entries in the original input. */
    totalCount: number;
}
/**
 * Serialize `items` to JSON via `toJson`, truncating deterministically from
 * the end until the result fits within `maxBytes`.
 *
 * Deterministic and order-preserving: for a given `items` array, the
 * included prefix is always the same — earlier entries are kept, later ones
 * are dropped — so two runs over the same (even differently-ordered-by-
 * network-timing) input never disagree about which entries survive, as
 * long as the caller passes `items` in a stable order.
 *
 * Correct on multibyte input: size is measured with `Buffer.byteLength`
 * (UTF-8 bytes), not `String.length` (UTF-16 code units), so an array of
 * entries containing emoji, CJK text, or other multibyte characters is
 * capped by actual output size, not character count.
 *
 * @param items    Entries to serialize, in the order they should be kept.
 * @param toJson   Serializes a prefix of `items` (e.g. `(xs) => JSON.stringify(xs)`).
 * @param maxBytes Byte budget; defaults to {@link MAX_OUTPUT_VALUE_BYTES}.
 */
export declare function truncateJsonArray<T>(items: readonly T[], toJson: (subset: T[]) => string, maxBytes?: number): TruncatedJsonResult;
export interface ActionOutputs {
    trustline_exists: string;
    xlm_balance: string;
    account_funded: string;
    comment_url: string;
    /**
     * #696 — Numeric REST id of the created or updated issue comment, as a
     * string. Empty when no comment was posted.
     */
    comment_id: string;
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
    badge_etag: string;
    snooze_expired: string;
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
    network_passphrase_mismatch: string;
    expected_network_passphrase: string;
    actual_network_passphrase: string;
    assignee_results_json: string;
    matrix_ready_map: string;
    /**
     * GitHub Checks API integration (Wave #26 / Issue #421). ID of the created
     * Check Run when `use_check_runs` is true, empty otherwise.
     */
    check_run_id: string;
    /** Conclusion of the created Check Run (success/failure), empty when skipped. */
    check_run_conclusion: string;
    friendbot_called: string;
    friendbot_success: string;
    friendbot_transaction_hash: string;
    assets_trustline_status: string;
    trustlines_summary: string;
    /**
     * Batch-mode outputs (Issue #670).
     *
     * Published on the batch code path in index.ts, which returns before
     * `setValidationOutputs` runs. Single-address runs publish empty strings here
     * so the action.yml output contract stays total: every declared output has a
     * value in every mode, and a consumer never has to distinguish "unset" from
     * "empty string".
     */
    batch_summary_json: string;
    batch_passed_count: string;
    batch_failed_count: string;
    /**
     * Issue #854 — `"true"` when any JSON/array output this run produced
     * (currently `assets_trustline_status`; batch mode also sets this via
     * `batch_summary_json`'s own truncation in `src/index.ts`) was truncated
     * to stay within `MAX_OUTPUT_VALUE_BYTES`. `"false"` otherwise. Always
     * set — never empty — so a consumer can gate on it unconditionally:
     * `if: steps.trustbridge.outputs.outputs_truncated == 'true'`.
     */
    outputs_truncated: string;
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
export interface AssigneeResult {
    ready: boolean;
    stellar_address: string;
    xlm_balance: string;
    account_funded: boolean;
    trustline_exists: boolean;
    reason_code: string;
    validated_at: string;
}
export type AssigneeResultsMap = Record<string, AssigneeResult>;
export type MatrixReadyMap = Record<string, boolean>;
/**
 * Build matrix-friendly JSON outputs from multiple validation results.
 * This enables GitHub matrix workflows to access per-assignee results via
 * `fromJSON(steps.trustbridge.outputs.matrix_ready_map)`.
 *
 * Example usage in a matrix workflow:
 * ```yaml
 * strategy:
 *   matrix:
 *     assignee: [alice, bob, charlie]
 * steps:
 *   - id: check
 *     run: |
 *       READY=$(echo '${{ steps.trustbridge.outputs.matrix_ready_map }}' | jq -r '.["${{ matrix.assignee }}"]')
 *       echo "ready=$READY" >> $GITHUB_OUTPUT
 * ```
 *
 * @param results Array of validation results with assignee metadata
 * @returns JSON string maps for assignee_results_json and matrix_ready_map
 */
/** Return shape of {@link buildMatrixOutputs}, including the Issue #854 truncation report. */
export interface MatrixOutputsResult {
    assigneeResultsJson: string;
    matrixReadyMap: string;
    /** True when one or more assignees were dropped to stay within {@link MAX_OUTPUT_VALUE_BYTES}. */
    truncated: boolean;
    /** Number of assignees included in the (possibly truncated) outputs. */
    includedCount: number;
    /** Number of assignees in the input, before any truncation. */
    totalCount: number;
}
export declare function buildMatrixOutputs(results: Array<{
    assigneeLogin: string;
    stellarAddress: string;
    validationResult: ValidationResult;
    validatedAt?: string;
}>): MatrixOutputsResult;
/**
 * Sanitize a GitHub username for use as a matrix dimension or output key.
 * Replaces characters that could cause issues in GitHub Actions expressions
 * with safe alternatives.
 *
 * Rules:
 * - Hyphens and underscores preserved
 * - Other special characters replaced with underscore
 * - Leading digits prefixed with underscore
 * - Empty string becomes "unknown"
 *
 * @param username GitHub username (e.g., from assignee.login)
 * @returns Sanitized key safe for GitHub Actions output names
 */
export declare function sanitizeUsernameForMatrix(username: string): string;
