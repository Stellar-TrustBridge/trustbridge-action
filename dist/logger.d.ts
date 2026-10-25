/**
 * Enhanced logging with context and structured output.
 * Useful for debugging TrustBridge Action execution.
 *
 * Every user-identifying or account-identifying value that could reach a
 * log line is run through a redaction step before it is written to GitHub
 * Actions log output. See `redactStellarAddress`, `redactHorizonUrl`, and
 * `redactContext` for the exact policies.
 *
 * Structured logs always carry a stable `reason_code` and `check` label so
 * Wave CI failures can be grepped and triaged automatically (Issue #771).
 */
export interface LogContext {
    component?: string;
    stellarAddress?: string;
    horizonUrl?: string;
    reason_code?: string;
    check?: string;
    [key: string]: unknown;
}
/**
 * Stable structured field keys that every structured log line must include
 * so automated triage can grep Wave CI failures (Issue #771).
 */
export declare const STRUCTURED_FIELD_KEYS: readonly ["reason_code", "check"];
/**
 * Fallback values used when a caller does not supply a structured field.
 * These keep the keys present (never `undefined`) so log lines stay
 * greppable even on unexpected failure paths.
 */
export declare const DEFAULT_REASON_CODE = "unknown";
export declare const DEFAULT_CHECK_LABEL = "unknown";
/**
 * Ensure a log context always carries the structured `reason_code` and
 * `check` fields. Existing values are preserved (trimmed); missing or empty
 * values are filled with stable defaults so the keys are never absent.
 */
export declare function withStructuredFields(context?: LogContext): LogContext;
export declare function isSensitiveSecretKey(key: string): boolean;
/**
 * Redacts a single Stellar address to its first 4 and last 4 characters,
 * separated by `...`. Handles:
 *   - G-addresses and C-addresses (Soroban contracts): exactly 56 characters.
 *   - Muxed M-addresses: exactly 69 characters (M + 68 base32 chars).
 * Non-address strings are returned unchanged so non-address log values
 * never collide with the redaction pass.
 *
 * Examples:
 *   redactStellarAddress('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
 *     => 'GA5Z...KZVN'
 *   redactStellarAddress('MA7QYNF7SOWQ3GLR2BGMZEHXR8' + 'A'.repeat(43))
 *     => 'MA7Q...AAAA'
 */
export declare function redactStellarAddress(address: string): string;
/**
 * Redact a Soroban contract id (C-address) for log output (Issue #730).
 *
 * SAC issuers are contract ids, not accounts, but they carry exactly the same
 * redaction requirement: a debug log line must never contain the full
 * contract id. Delegates to {@link redactStellarAddress} so the C-address and
 * G-address policies can never drift apart, and returns the input unchanged
 * when it is not a well-formed C-address so a non-address value is never
 * mangled.
 *
 * Examples:
 *   redactContractAddress('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM')
 *     => 'CAAA...D2KM'
 */
export declare function redactContractAddress(contractId: string): string;
/**
 * Redacts every Stellar address (G-, C-, and muxed M-addresses), JWT and PEM
 * private key embedded in an arbitrary free-form string — error messages,
 * Horizon URLs, JSON snippets, stack traces, etc.
 *
 * Muxed M-addresses (69 chars) are scanned first so their longer pattern
 * cannot be partially matched by the 56-char G/C regex.
 */
export declare function redactString(value: string): string;
/**
 * Redacts a Horizon endpoint URL so any embedded account address in the
 * path (e.g. `/accounts/G...`) is masked and any query-string values
 * matching an address shape are masked before the URL reaches a log line.
 * The base hostname / protocol is preserved so operators can still verify
 * which Horizon instance was called.
 *
 * Handles all three Stellar address forms:
 *   - G-addresses and C-addresses (56 chars)
 *   - Muxed M-addresses (69 chars)
 */
export declare function redactHorizonUrl(url: string): string;
/**
 * Redacts a log context object. Address-bearing keys are masked with
 * {@link redactStellarAddress}; sensitive secret keys are replaced with
 * `[REDACTED]`; all other string values are passed through
 * {@link redactString} so embedded addresses never leak.
 */
export declare function redactContext(context?: LogContext): LogContext;
/**
 * Format a structured log line. Always includes the `reason_code` and
 * `check` fields (Issue #771) so Wave CI failures can be grepped, and
 * redacts the context before serialization.
 */
export declare function formatStructuredLog(message: string, context?: LogContext): string;
export declare function logInfo(message: string, context?: LogContext): void;
export declare function logWarning(message: string, context?: LogContext): void;
export declare function logError(message: string, context?: LogContext): void;
declare class StructuredLogger {
    private debugMode;
    constructor(debugMode?: boolean);
    /**
     * Enable or disable debug output.
     */
    setDebugMode(enabled: boolean): void;
    /**
     * Log an informational message.
     */
    info(message: string, context?: LogContext): void;
    /**
     * Log a warning message.
     */
    warn(message: string, context?: LogContext): void;
    /**
     * Log an error message.
     */
    error(message: string, context?: LogContext, error?: Error): void;
    /**
     * Log a debug message (only shown in debug mode).
     */
    debug(message: string, context?: LogContext): void;
    /**
     * Log a structured Horizon retry event (Issue #697).
     *
     * Scheduled retries are written at debug level; final exhaustion is
     * written at warning level so operators can find rate-limit failures
     * without enabling debug mode. The context always uses the fixed
     * {@link HORIZON_RETRY_LOG_FIELDS} schema and is run through
     * `redactContext` like every other log line.
     */
    horizonRetry(event: HorizonRetryEvent): void;
    /**
     * Log performance metrics.
     */
    logMetric(name: string, value: number, unit?: string, context?: LogContext): void;
    /**
     * Format a message with context information.
     *
     * Precondition: `message` and every string in `context` have already
     * been run through their respective redaction helpers. This method is
     * purely responsible for layout.
     */
    private formatMessage;
}
/**
 * Structured Horizon retry event (Issue #697).
 *
 * - `scheduled`: a retry will be attempted after `delayMs`.
 * - `exhausted`: no further retries will be attempted; the request fails.
 */
export interface HorizonRetryEvent {
    phase: 'scheduled' | 'exhausted';
    /** Zero-based index of the attempt that just failed. */
    attempt: number;
    /** Total attempts allowed (maxRetries + 1). */
    maxAttempts: number;
    /** HTTP status of the failed attempt; 0 for transport errors. */
    status: number;
    /** Wait before the next attempt (0 when exhausted). */
    delayMs: number;
    /** True when the wait was clamped by retry_max_delay_ms. */
    capped: boolean;
    /** What failed: an HTTP status, a timeout, or a network error. */
    kind: 'http' | 'timeout' | 'network';
    /** Which endpoint was used: the primary horizon_url or a fallback. */
    endpointKind: 'primary' | 'fallback';
    /** Horizon base URL; reduced to a query-free, redacted base before logging. */
    horizonUrl: string;
    /** Account being fetched; redacted to first-4/last-4 before logging. */
    stellarAddress?: string;
    /** True when the delay came from a Retry-After header. */
    retryAfterFromHeader?: boolean;
    /** Why retries stopped (exhausted phase only). */
    reason?: 'max_retries' | 'wait_budget';
}
export type HorizonRetryLogLevel = 'debug' | 'info' | 'warning';
/**
 * Fixed field names emitted with every Horizon retry log line. Documented in
 * docs/TROUBLESHOOTING.md — keep both in sync.
 */
export declare const HORIZON_RETRY_LOG_FIELDS: readonly ["event", "phase", "endpointKind", "horizonUrl", "stellarAddress", "attempt", "maxAttempts", "nextAttempt", "status", "kind", "delayMs", "capped", "retryAfterFromHeader", "reasonCode"];
/** reason_code-style tag for a Horizon retry event. */
export declare const HORIZON_RETRY_REASON_CODES: {
    readonly scheduled: "HORIZON_RETRY_SCHEDULED";
    readonly max_retries: "HORIZON_RETRIES_EXHAUSTED";
    readonly wait_budget: "HORIZON_WAIT_BUDGET_EXHAUSTED";
};
/**
 * Choose the log level for a retry event: scheduled retries are debug noise,
 * final exhaustion is a warning.
 */
export declare function horizonRetryLogLevel(event: HorizonRetryEvent): HorizonRetryLogLevel;
/**
 * Reduce a Horizon URL to its redacted base: credentials, query string and
 * fragment are dropped so failover logs can say which host was used without
 * leaking query params, and any account path segment is masked.
 */
export declare function redactHorizonBaseUrl(url: string): string;
/**
 * Build the fixed-schema, redacted log context for a retry event. Only the
 * keys in {@link HORIZON_RETRY_LOG_FIELDS} are emitted, so no response body
 * or extra field can reach the log line.
 */
export declare function buildHorizonRetryLogContext(event: HorizonRetryEvent): LogContext;
/**
 * Human-readable summary line for a retry event. Contains no URL or address;
 * those live (redacted) in the structured context.
 */
export declare function formatHorizonRetryMessage(event: HorizonRetryEvent): string;
export declare const logger: StructuredLogger;
/**
 * Logs an informational message. Context values are redacted before output.
 */
export declare function log(message: string, context?: LogContext): void;
/**
 * Logs a debug message. Only emitted when the `debug` input is enabled, but
 * the redaction pass runs unconditionally so enabling debug can never leak a
 * raw address or token into public Actions logs.
 */
export declare function debug(message: string, context?: LogContext): void;
/**
 * Logs a warning message. Context values are redacted before output.
 */
export declare function warning(message: string, context?: LogContext): void;
/**
 * Logs an error message. Context values are redacted before output.
 */
export declare function error(message: string, context?: LogContext): void;
/**
 * Represents the full set of resolved action inputs that may be logged
 * as a structured JSON artifact when `log_inputs` is enabled.
 *
 * Every field that could carry a Stellar address or sensitive URL is typed
 * as `string` so the redaction helpers can process it uniformly before the
 * record reaches any log output.
 */
export interface ActionInputsLogRecord {
    horizonUrl: string;
    horizonUrlFallback: string;
    rpcFallbackUrl: string;
    assetCode: string;
    assetIssuer: string;
    minXlmReserve: string;
    /** Optional minimum trustline limit (Issue #140). */
    minTrustlineLimit?: string;
    stellarAddress: string;
    failOnMissing: boolean;
    debugMode: boolean;
    horizonTimeoutMs: number;
    stickyComment: boolean;
    waitUntilFunded: boolean;
    waitUntilFundedTimeoutMs: number;
    waitUntilFundedIntervalMs: number;
    horizonCacheTtlMs: number;
    useCache: boolean;
    horizonMaxRequests: number;
    maxRetries?: number;
    retryBaseDelayMs?: number;
    retryMaxDelayMs: number;
    logInputs: boolean;
    allowCrossNetworkFallback?: boolean;
}
/**
 * Build a redacted copy of the resolved action inputs suitable for writing
 * to structured log output.  All Stellar addresses and Horizon/RPC URLs are
 * masked before the record is returned; no value is emitted verbatim.
 *
 * The returned object is plain JSON-serialisable — every value is a
 * primitive (string, number, boolean) so `JSON.stringify` produces a
 * deterministic, machine-readable artifact.
 */
export declare function buildInputsLogRecord(inputs: ActionInputsLogRecord): ActionInputsLogRecord;
/**
 * Emit a structured JSON log record of all resolved action inputs to GitHub
 * Actions log output.  The record is built via `buildInputsLogRecord` so
 * every address/URL field is already redacted before it is written.
 *
 * The record is emitted with `core.info` so it is always visible (not gated
 * on debug mode) whenever the caller opts in via `log_inputs: true`.
 *
 * @param inputs  The raw resolved inputs from `src/index.ts`.
 */
export declare function emitInputsLogRecord(inputs: ActionInputsLogRecord): void;
export {};
