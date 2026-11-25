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
 * Redacts every Stellar address embedded in an arbitrary free-form
 * string — error messages, Horizon URLs, JSON snippets, stack traces, etc.
 * Uses the same first-4/last-4 policy as `redactStellarAddress`.
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
 * - Keys in `ADDRESS_CONTEXT_KEYS`  → run `redactStellarAddress` on the
 *   raw string value.
 * - Key == `horizonUrl`             → run `redactHorizonUrl`.
 * - Unknown string values           → scan and mask embedded addresses
 *   via `redactString` so free-form messages attached to context don't
 *   leak.
 * - Non-string values               → passed through as-is (numbers,
 *   booleans). Objects and arrays are recursed shallowly for the common
 *   case of nested debug payloads.
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
export {};
