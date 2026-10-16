/**
 * Advanced retry and rate-limiting strategies for resilient API interactions.
 *
 * This module also exposes a local CLI check command that exercises the full
 * resilience pipeline (backoff, rate-limiting, circuit-breaking) against a
 * live or stubbed Horizon endpoint without requiring a GitHub Actions context.
 *
 * Usage (compiled binary or `ts-node`):
 *   node dist/resilience.js check --address G... [--horizon-url URL] [--timeout-ms N]
 */
/**
 * Options accepted by the local CLI check command.
 */
export interface CliCheckOptions {
    /** Stellar G-address to validate (required). */
    address: string;
    /** Horizon base URL (default: https://horizon.stellar.org). */
    horizonUrl?: string;
    /** Request timeout in milliseconds (default: 15 000). */
    timeoutMs?: number;
    /** Retry policy overrides. */
    retryPolicy?: Partial<RetryPolicy>;
}
/**
 * Result returned by the local CLI check command.
 */
export interface CliCheckResult {
    /** True when Horizon returned a 200 for the address. */
    reachable: boolean;
    /** HTTP status code from Horizon, or undefined on network error. */
    statusCode?: number;
    /** Duration of the check in milliseconds (including retries). */
    durationMs: number;
    /** Human-readable summary. */
    message: string;
    /** Number of retry attempts made (0 = first try succeeded). */
    retries: number;
}
/**
 * Circuit-breaker state machine.
 * CLOSED  = normal operation
 * OPEN    = requests are rejected immediately
 * HALF    = one probe request is allowed to test recovery
 */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF';
export interface RetryPolicy {
    maxRetries: number;
    initialDelayMs: number;
    maxDelayMs: number;
    backoffMultiplier: number;
    timeoutMs: number;
}
/**
 * Default retry policy for API calls.
 */
export declare const DEFAULT_RETRY_POLICY: RetryPolicy;
/**
 * Calculate the delay for a retry attempt using exponential backoff.
 */
export declare function calculateBackoffDelay(attempt: number, policy: RetryPolicy): number;
/**
 * Add random jitter to a delay to prevent thundering herd.
 */
export declare function addJitter(delayMs: number, jitterPercent?: number): number;
/**
 * Sleep for a given duration.
 */
export declare function sleep(ms: number): Promise<void>;
/**
 * Simple rate limiter to throttle requests.
 */
export declare class RateLimiter {
    private tokens;
    private readonly capacity;
    private readonly refillRatePerSecond;
    private lastRefillTime;
    /**
     * Create a rate limiter with token bucket algorithm.
     * @param capacity Maximum number of tokens (requests allowed per refill window)
     * @param refillRatePerSecond How many tokens to refill per second
     */
    constructor(capacity: number, refillRatePerSecond: number);
    /**
     * Check if a request is allowed, consuming a token if so.
     */
    tryConsume(tokensNeeded?: number): boolean;
    /**
     * Get the number of milliseconds to wait before trying again.
     */
    waitTimeMs(tokensNeeded?: number): number;
    /**
     * Refill tokens based on elapsed time.
     */
    private refill;
    /**
     * Get current token count.
     */
    getAvailableTokens(): number;
    /**
     * Reset the rate limiter to full capacity.
     */
    reset(): void;
}
/**
 * Execute a function with exponential backoff retry logic.
 */
export declare function retryWithBackoff<T>(fn: () => Promise<T>, policy?: RetryPolicy, shouldRetry?: (error: unknown, attempt: number) => boolean): Promise<T>;
/**
 * Simple circuit-breaker that wraps any async function.
 *
 * - CLOSED  → requests flow normally; failures are counted.
 * - OPEN    → requests are rejected immediately until `resetTimeoutMs` passes.
 * - HALF    → one probe is allowed; if it succeeds the breaker closes again.
 */
export declare class CircuitBreaker {
    private readonly failureThreshold;
    private readonly resetTimeoutMs;
    private state;
    private failureCount;
    private lastFailureTime;
    constructor(failureThreshold?: number, resetTimeoutMs?: number);
    getState(): CircuitState;
    /** Reset to closed state (e.g. for test isolation). */
    reset(): void;
    execute<T>(fn: () => Promise<T>): Promise<T>;
}
/** Minimal fetch-like type accepted by runCliCheck for testability. */
export type FetchFn = (url: string, init?: {
    signal?: AbortSignal;
}) => Promise<{
    status: number;
}>;
/**
 * Run a local CLI check against a Horizon endpoint.
 *
 * The check exercises the full resilience pipeline: timeout (via AbortSignal),
 * exponential backoff retries, and optional circuit-breaker integration. It
 * is intentionally side-effect-free (no GitHub Actions core calls) so it can
 * be used in local development, CI smoke tests, or scripting without a
 * GitHub context.
 *
 * @param options  CLI check options (address, horizon URL, timeout, policy).
 * @param fetchFn  Optional fetch override for unit tests (default: global fetch).
 * @returns        A {@link CliCheckResult} with reachability, timing, and retry info.
 *
 * @example
 * ```ts
 * const result = await runCliCheck({
 *   address: 'GABC...XYZ',
 *   horizonUrl: 'https://horizon-testnet.stellar.org',
 *   timeoutMs: 5000,
 * });
 * console.log(result.message);
 * ```
 */
export declare function runCliCheck(options: CliCheckOptions, fetchFn?: FetchFn): Promise<CliCheckResult>;
