/**
 * Metrics collection for monitoring action performance and behavior.
 *
 * Wave #27 additions:
 *   - `JobSummaryRow` / `JobSummarySection` types for structured summary output
 *   - `MetricsCollector.buildJobSummary()` — produce a machine-readable
 *     `JobSummaryReport` from the current metrics state
 *   - `writeJobSummary()` — write the summary to GitHub Actions Job Summary
 *     via `@actions/core`; no-ops outside a GitHub Actions context
 */
export interface MetricPoint {
    name: string;
    value: number;
    unit: string;
    timestamp: number;
    tags?: Record<string, string>;
}
/**
 * Tag key that flags a metric as carrying a Soroban contract ("C-address").
 * Metrics tagged this way are validated against the contract address
 * policy before being recorded, so a malformed or malicious value never
 * makes it into the JSON metrics artifact (see toJSON()).
 */
export declare const CONTRACT_ADDRESS_TAG_KEY = "contractAddress";
/**
 * Outcome categories for an Octokit API call.
 *
 * - `success`      — HTTP 2xx; operation completed normally.
 * - `auth_error`   — HTTP 401/403; token invalid or missing `issues: write`.
 * - `not_found`    — HTTP 404; issue/repo not found or token lacks read access.
 * - `rate_limited` — HTTP 429 or 403 with rate-limit headers.
 * - `server_error` — HTTP 5xx; transient GitHub infrastructure failure.
 * - `network_error`— Fetch / DNS / TLS failure before a response arrived.
 * - `unknown`      — Any other non-2xx code.
 */
export type OctokitOutcome = 'success' | 'auth_error' | 'not_found' | 'rate_limited' | 'server_error' | 'network_error' | 'unknown';
/**
 * A single recorded Octokit operation — the raw data that feeds both the
 * in-memory metrics store and the JSON artifact.
 */
export interface OctokitOperationRecord {
    /** Logical name of the operation, e.g. `"issues.createComment"`. */
    operation: string;
    /** HTTP status code returned by the GitHub API, or 0 for network errors. */
    statusCode: number;
    /** Wall-clock milliseconds from call start to response (or error). */
    latencyMs: number;
    /** Classified outcome for dashboards and payout automation. */
    outcome: OctokitOutcome;
    /** Number of retries attempted before this result (0 = first attempt succeeded). */
    retries: number;
    /** ISO-8601 timestamp of when the call was initiated. */
    startedAt: string;
    /** Optional human-readable error message on non-success outcomes. */
    errorMessage?: string;
}
/**
 * Classify an HTTP status code into an `OctokitOutcome`.
 */
export declare function classifyOctokitStatus(statusCode: number, headers?: Record<string, string | undefined>): OctokitOutcome;
/**
 * Summary exported in the JSON artifact and available to downstream jobs.
 */
export interface OctokitMetricsSummary {
    totalCalls: number;
    successCount: number;
    failureCount: number;
    totalLatencyMs: number;
    averageLatencyMs: number;
    totalRetries: number;
    outcomeBreakdown: Record<OctokitOutcome, number>;
    operations: OctokitOperationRecord[];
}
/**
 * Instruments GitHub API (Octokit) calls for Wave #37.
 *
 * Usage:
 * ```ts
 * const octokitMetrics = new OctokitMetrics();
 * const result = await octokitMetrics.track('issues.createComment', () =>
 *   octokit.rest.issues.createComment({ ... })
 * );
 * ```
 *
 * After the run, `toJSON()` returns a structured artifact ready for upload
 * with `actions/upload-artifact` or inline debug output.
 */
export declare class OctokitMetrics {
    private records;
    /**
     * Wrap an Octokit call with latency and outcome tracking.
     *
     * @param operation  Logical name, e.g. `"issues.createComment"`.
     * @param fn         The async Octokit call to execute.
     * @param retries    Number of retries already attempted before this call.
     *                   Pass the retry count from your retry loop; defaults to 0.
     */
    track<T extends {
        status: number;
        headers?: Record<string, string>;
    }>(operation: string, fn: () => Promise<T>, retries?: number): Promise<T>;
    /**
     * Record a pre-resolved outcome directly (e.g. from a catch block where
     * the Octokit call already resolved but the caller handled the error).
     */
    record(record: OctokitOperationRecord): void;
    /**
     * Build the summary object used for both in-memory inspection and JSON export.
     */
    getSummary(): OctokitMetricsSummary;
    /**
     * Export the Octokit metrics as a JSON artifact string.
     * Safe to pass directly to `core.debug()` or write to a file for
     * `actions/upload-artifact`.
     */
    toJSON(): string;
    /**
     * Return how many operations have been recorded.
     */
    get size(): number;
    /**
     * Clear all recorded operations.
     */
    reset(): void;
}
export interface TimingBreakdown {
    input_parse_ms: number;
    horizon_fetch_ms: number;
    checks_ms: number;
    comment_post_ms: number;
    total_ms: number;
}
export declare class MetricsCollector {
    private metrics;
    private counters;
    private timers;
    /**
     * Record a numeric metric. If a `contractAddress` tag is present, it is
     * validated against the Soroban C-address policy first; an invalid
     * address throws rather than being silently recorded.
     */
    recordMetric(name: string, value: number, unit?: string, tags?: Record<string, string>): void;
    /**
     * Convenience wrapper for recording a metric tagged with a Soroban
     * contract address, enforcing the C-address policy up front.
     */
    recordContractMetric(name: string, value: number, contractAddress: string, unit?: string, extraTags?: Record<string, string>): void;
    /**
     * Increment a counter.
     */
    incrementCounter(name: string, amount?: number): void;
    /**
     * Get counter value.
     */
    getCounter(name: string): number;
    /**
     * Start a timer.
     */
    startTimer(name: string): void;
    /**
     * Stop a timer and record the elapsed time.
     */
    stopTimer(name: string, unit?: string): number | null;
    /**
     * Get a timing breakdown of execution phases in milliseconds (Issue #93).
     */
    getTimingBreakdown(): TimingBreakdown;
    /**
     * Get a single timer value by name (e.g., 'input_parse' → milliseconds).
     * Returns 0 if timer was never started or stopped.
     */
    getTimerValue(name: string): number;
    /**
     * Get a summary of all recorded metrics.
     */
    getSummary(): {
        metrics: MetricPoint[];
        counters: Record<string, number>;
        totalMetrics: number;
    };
    /**
     * Export metrics in JSON format.
     */
    toJSON(): string;
    /**
     * Clear all metrics.
     */
    reset(): void;
    /**
     * Record campaign preset metric.
     */
    recordPresetMetric(presetId: string, network: string): void;
    /**
     * Get average value for a metric.
     */
    getAverageMetric(name: string): number | null;
    /**
     * Build a structured Job Summary report from current metrics state.
     *
     * The report contains:
     *   - `latencyMs`     – average duration of any `*_duration` metrics (ms)
     *   - `failureCodes`  – unique HTTP status codes recorded via
     *                       `recordMetric('horizon_error', code, 'http_status')`
     *   - `totalRuns`     – value of the `runs` counter
     *   - `totalErrors`   – value of the `errors` counter
     *   - `jsonArtifact`  – the full `getSummary()` payload serialised as JSON
     *                       (tags stripped — no contract addresses)
     *
     * Safe to call at any time; never throws.
     */
    buildJobSummary(): JobSummaryReport;
}
/**
 * Structured report produced by `MetricsCollector.buildJobSummary()`.
 */
export interface JobSummaryReport {
    /** Average latency across all `*_duration` metrics, or null if none recorded. */
    latencyMs: number | null;
    /** Unique HTTP failure codes recorded as `horizon_error` metrics. */
    failureCodes: number[];
    /** Value of the `runs` counter (how many account checks were attempted). */
    totalRuns: number;
    /** Value of the `errors` counter (how many runs ended in an error state). */
    totalErrors: number;
    /** Sanitised JSON artifact — no tags, no contract addresses. */
    jsonArtifact: string;
}
/**
 * Write a `JobSummaryReport` to the GitHub Actions Job Summary markdown
 * table using `core.summary`.
 *
 * No-ops (safe to call) when `GITHUB_STEP_SUMMARY` is not set, which is
 * always the case in local development and test environments.
 *
 * The output is intentionally human-readable so maintainers can inspect
 * the Job Summary tab in GitHub Actions for latency and failure-code trends
 * across Wave runs without reading raw log output.
 *
 * @param report   The report to render, typically from `MetricsCollector.buildJobSummary()`.
 * @param runLabel Optional label for the run (e.g. the Stellar address prefix, wave issue
 *                 number) — must not contain raw addresses; callers should redact before passing.
 */
export declare function writeJobSummary(report: JobSummaryReport, runLabel?: string): Promise<void>;
export declare const globalMetrics: MetricsCollector;
/** Global Octokit metrics instance — wired into `postIssueComment` and label operations. */
export declare const globalOctokitMetrics: OctokitMetrics;
/**
 * Normalize a Horizon URL down to a host label safe for metric tags.
 */
export declare function normalizeMetricHost(url: string): string;
