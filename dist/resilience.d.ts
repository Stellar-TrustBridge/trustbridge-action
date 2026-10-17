/**
 * Advanced retry and rate-limiting strategies for resilient API interactions.
 *
 * Wave #26: GitHub Check Runs integration — resilience layer now surfaces
 * circuit-breaker state changes and per-attempt outcomes as GitHub Check Run
 * annotations so operators can observe retry / fallback activity directly in
 * the Actions UI rather than only in debug logs.
 *
 * Wave #36: Horizon HTTP mock matrix — deterministic per-scenario mock
 * factories (timeout, rate-limit, outage, success) for use in unit tests and
 * local dev without a live Horizon endpoint.
 *
 * Also exposes a local CLI check command that exercises the full resilience
 * pipeline against a live or stubbed Horizon endpoint (with optional secondary
 * Horizon failover).
 */
export declare class RateBudgetExhaustedError extends Error {
    statusCode: number;
    retryable: boolean;
    constructor(message: string);
}
export declare class RateBudgetTracker {
    private readonly maxRequests;
    private count;
    constructor(maxRequests: number);
    /**
     * Records a request. Throws RateBudgetExhaustedError if the budget is exceeded.
     * If maxRequests is 0, the budget is considered unlimited.
     */
    recordRequest(): void;
    get requestsMade(): number;
}
/**
 * Options accepted by the local CLI check command.
 */
export interface CliCheckOptions {
    /** Stellar G-address to validate (required). */
    address: string;
    /** Horizon base URL (default: https://horizon.stellar.org). */
    horizonUrl?: string;
    /** Secondary Horizon URL for failover. */
    secondaryHorizonUrl?: string;
    /** List of fallback Horizon URLs. */
    fallbackUrls?: string[];
    /** Allow failover across different networks (e.g. mainnet to testnet). Default false. */
    allowCrossNetworkFailover?: boolean;
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
    /** Base URL of the Horizon endpoint that served the successful response. */
    horizonUrlUsed?: string;
    /** True if the response was served by the secondary endpoint after primary failover. */
    failedOver?: boolean;
}
export interface RetryPolicy {
    maxRetries: number;
    initialDelayMs: number;
    maxDelayMs: number;
    backoffMultiplier: number;
    timeoutMs: number;
    maxTotalWaitMs: number;
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
export type CircuitState = 'closed' | 'open' | 'half-open';
export interface CircuitBreakerOptions {
    /**
     * Number of consecutive failures before the circuit trips to 'open'.
     * Default: 5.
     */
    failureThreshold?: number;
    /**
     * Milliseconds to wait in 'open' state before transitioning to 'half-open'
     * and allowing a single probe request. Default: 30 000.
     */
    recoveryTimeoutMs?: number;
    /**
     * Number of consecutive successes in 'half-open' state required to fully
     * close the circuit again. Default: 2.
     */
    successThreshold?: number;
    /**
     * Optional callback fired on every state transition. Receives the previous
     * state, the next state, and a human-readable reason string.
     *
     * Wave #26: TrustBridge wires this to `core.notice` / `core.warning` so
     * that state changes surface as GitHub Check Run annotations in the Actions
     * summary panel without requiring `debug_mode: true`.
     */
    onStateChange?: (from: CircuitState, to: CircuitState, reason: string) => void;
}
/**
 * Circuit-breaker implementation for the TrustBridge resilience layer.
 *
 * Wave #26 integration: when `onStateChange` is omitted the constructor
 * falls back to emitting `core.warning` / `core.notice` annotations so that
 * circuit trips and recoveries are always visible as GitHub Check Run
 * annotations in the Actions UI, even without `debug_mode: true`.
 *
 * States:
 *  - **closed** — normal operation; failures are counted.
 *  - **open**   — requests are short-circuited (fast-fail); a recovery timer
 *                 controls transition to 'half-open'.
 *  - **half-open** — a single probe request is allowed; success closes the
 *                    circuit, failure re-opens it.
 */
export declare class CircuitBreaker {
    private state;
    private consecutiveFailures;
    private consecutiveSuccesses;
    private openedAt;
    private readonly failureThreshold;
    private readonly recoveryTimeoutMs;
    private readonly successThreshold;
    private readonly onStateChange;
    constructor(options?: CircuitBreakerOptions);
    /**
     * Current circuit state.
     */
    getState(): CircuitState;
    /**
     * Execute `fn` through the circuit breaker.
     *
     * - **closed / half-open**: delegates to `fn`; records success or failure.
     * - **open**: throws a `CircuitOpenError` immediately without calling `fn`.
     */
    execute<T>(fn: () => Promise<T>): Promise<T>;
    /**
     * Force-reset the circuit to closed state. Useful in tests and for manual
     * operator intervention.
     */
    reset(): void;
    /**
     * Snapshot of the breaker's internal counters — useful for tests and
     * metrics emission without exposing mutable state.
     */
    getStats(): {
        state: CircuitState;
        consecutiveFailures: number;
        consecutiveSuccesses: number;
        openedAt: number | null;
    };
    private _maybeTransitionToHalfOpen;
    private _recordSuccess;
    private _recordFailure;
}
/**
 * Thrown by `CircuitBreaker.execute` when the circuit is open and the
 * request was fast-failed without reaching the underlying operation.
 */
export declare class CircuitOpenError extends Error {
    constructor(message: string);
}
/**
 * Emit a GitHub Check Run annotation for a resilience event (retry, rate
 * limit, circuit trip, fallback switch). These surface in the "Annotations"
 * panel of the Actions summary page without requiring `debug_mode: true`.
 *
 * Severity mapping:
 *  - `notice`  — informational (retry scheduled, fallback succeeded)
 *  - `warning` — degraded but recovering (rate-limited, fallback in use)
 *  - `error`   — irrecoverable or circuit open
 */
export type CheckRunAnnotationLevel = 'notice' | 'warning' | 'error';
export interface CheckRunAnnotation {
    level: CheckRunAnnotationLevel;
    title: string;
    message: string;
}
/**
 * Post a resilience event as a GitHub Check Run annotation.
 *
 * Wraps `core.notice` / `core.warning` / `core.error` with a consistent
 * `[TrustBridge Resilience]` prefix so operators can filter the Actions log
 * for resilience events at a glance.
 */
export declare function emitCheckRunAnnotation(annotation: CheckRunAnnotation): void;
/**
 * Convenience wrapper: emit a retry-scheduled annotation.
 *
 * @param attempt   0-based attempt index that just failed.
 * @param delayMs   How long the backoff sleep will be before the next attempt.
 * @param reason    Human-readable description of what failed (error message).
 */
export declare function annotateRetry(attempt: number, delayMs: number, reason: string): void;
/**
 * Convenience wrapper: emit a rate-limit annotation.
 *
 * @param waitMs  How long the action will wait before retrying (from Retry-After).
 */
export declare function annotateRateLimit(waitMs: number): void;
/**
 * Convenience wrapper: emit a fallback-activated annotation.
 *
 * @param fallbackUrl  The fallback endpoint being tried (may be redacted by caller).
 * @param reason       Why primary failed.
 */
export declare function annotateFallback(fallbackUrl: string, reason: string): void;
/**
 * Convenience wrapper: emit a circuit-open annotation.
 *
 * @param consecutiveFailures  How many failures triggered the trip.
 */
export declare function annotateCircuitOpen(consecutiveFailures: number): void;
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
/**
 * Scenario identifiers for the Horizon HTTP mock matrix.
 *
 * Each scenario models a distinct failure or success mode that the
 * resilience layer must handle. Tests select a scenario by name rather than
 * hand-coding fetch mocks, ensuring consistent coverage across all retry /
 * fallback / circuit-breaker paths.
 */
export type HorizonScenario = 'success' | 'not_found' | 'rate_limit' | 'server_error' | 'bad_gateway' | 'gateway_timeout' | 'timeout' | 'network_error' | 'flaky_then_success' | 'always_fail';
/**
 * A minimal fetch-compatible response shape returned by the mock matrix.
 * Mirrors the subset of `node-fetch` Response that `fetchAccount` and the
 * resilience layer actually consume, keeping tests free of heavy dependencies.
 */
export interface MockResponse {
    ok: boolean;
    status: number;
    statusText: string;
    headers: {
        get(name: string): string | null;
    };
    json(): Promise<unknown>;
}
/**
 * A fetch function compatible with the `fetchFn` option in `FetchAccountOptions`.
 */
export type MockFetchFn = (url: string, init?: {
    signal?: AbortSignal;
    method?: string;
    headers?: Record<string, string>;
}) => Promise<MockResponse>;
/**
 * Options for `HttpMockMatrix.build`.
 */
export interface MockMatrixOptions {
    /**
     * For `flaky_then_success`: how many failures to emit before returning
     * the success response. Default: 2.
     */
    flakyFailCount?: number;
    /**
     * For `flaky_then_success`: which error scenario to use for the initial
     * failures. Default: `'rate_limit'`.
     */
    flakyErrorScenario?: Exclude<HorizonScenario, 'success' | 'flaky_then_success'>;
    /**
     * Custom account payload returned by the `success` / `flaky_then_success`
     * scenarios. Defaults to a minimal funded account.
     */
    accountPayload?: Record<string, unknown>;
    /**
     * Custom `Retry-After` header value (seconds) injected by the
     * `rate_limit` scenario. Default: `'0'` (retry immediately in tests).
     */
    retryAfterSeconds?: string;
    /**
     * For `timeout`: simulated abort delay in ms. The mock fires the
     * `AbortSignal`'s abort handler (if wired) after this duration.
     * Default: 0 (synchronous abort on next tick).
     */
    timeoutAfterMs?: number;
}
/**
 * Deterministic Horizon HTTP mock factory (Wave #36).
 *
 * Usage in tests:
 *
 * ```ts
 * const fetchFn = HttpMockMatrix.build('rate_limit');
 * await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, { fetchFn, maxRetries: 2 });
 * ```
 *
 * The matrix is intentionally thin — it returns the minimal response shape
 * that `fetchAccountOnce` / `fetchAccount` consumes, keeping it decoupled
 * from the full `node-fetch` Response surface.
 */
export declare class HttpMockMatrix {
    /**
     * Build a mock fetch function for the given scenario.
     */
    static build(scenario: HorizonScenario, options?: MockMatrixOptions): MockFetchFn;
    /**
     * Build a multi-scenario fetch function that serves different scenarios
     * for primary vs. fallback Horizon URLs. Useful for testing RPC fallback
     * paths without duplicating setup code.
     *
     * @param primaryScenario  Scenario served when the URL starts with `primaryUrl`.
     * @param fallbackScenario Scenario served for all other URLs.
     * @param primaryUrl       Prefix used to detect primary vs. fallback calls.
     *                         Default: `'https://horizon.stellar.org'`.
     */
    static buildFallbackMatrix(primaryScenario: HorizonScenario, fallbackScenario: HorizonScenario, primaryUrl?: string, options?: MockMatrixOptions): MockFetchFn;
    private static _makeHeaders;
    private static _defaultAccount;
    private static _successFetch;
    private static _staticResponseFetch;
    private static _timeoutFetch;
    private static _networkErrorFetch;
    private static _flakyFetch;
}
