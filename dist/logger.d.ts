/**
 * Enhanced logging with context and structured output.
 * Useful for debugging TrustBridge Action execution.
 *
 * Every user-identifying or account-identifying value that could reach a
 * log line is run through a redaction step before it is written to GitHub
 * Actions log output. See `redactStellarAddress`, `redactHorizonUrl`, and
 * `redactContext` for the exact policies.
 */
export interface LogContext {
    component?: string;
    stellarAddress?: string;
    horizonUrl?: string;
    [key: string]: unknown;
}
export declare function isSensitiveSecretKey(key: string): boolean;
/**
 * Redacts a single Stellar address (G- or C-address) to its first 4 and
 * last 4 characters, separated by `...`. Non-address strings are returned
 * unchanged so non-address log values never collide with the redaction
 * pass.
 *
 * Examples:
 *   redactStellarAddress('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
 *     => 'GA5Z...KZVN'
 */
export declare function redactStellarAddress(address: string): string;
/**
 * Redacts every Stellar address and PEM private key embedded in an arbitrary free-form
 * string — error messages, Horizon URLs, JSON snippets, stack traces, etc.
 */
export declare function redactString(value: string): string;
/**
 * Redacts a Horizon endpoint URL so any embedded account address in the
 * path (e.g. `/accounts/G...`) is masked and any query-string values
 * matching an address shape are masked before the URL reaches a log line.
 * The base hostname / protocol is preserved so operators can still verify
 * which Horizon instance was called.
 */
export declare function redactHorizonUrl(url: string): string;
/**
 * Redacts a `LogContext` record in place (returns a new object, no
 * mutation) for safe logging. Policy per key type:
 *
 * - Keys in `SENSITIVE_SECRET_KEYS` → redact to '[REDACTED]'.
 * - Keys in `ADDRESS_CONTEXT_KEYS`  → run `redactStellarAddress` on the
 *   raw string value.
 * - Key == `horizonUrl`             → run `redactHorizonUrl`.
 * - Unknown string values           → scan and mask embedded addresses
 *   and PEM keys via `redactString`.
 */
export declare function redactContext(context: LogContext | undefined): LogContext | undefined;
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
export declare const logger: StructuredLogger;
/**
 * Create a timing helper for performance measurement.
 */
export declare class Timer {
    private startTime;
    private name;
    constructor(name: string);
    /**
     * Get elapsed time since timer creation.
     */
    elapsed(): number;
    /**
     * Log the elapsed time and reset the timer.
     */
    logAndReset(): number;
    /**
     * Return a formatted elapsed time string.
     */
    toString(): string;
}
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
    minTrustlineLimit: string;
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
