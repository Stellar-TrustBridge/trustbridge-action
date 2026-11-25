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
 * Issue #888: Half-open probe budget — the circuit breaker now enforces a
 * configurable limit on the number of concurrent probe calls permitted while
 * the circuit is in half-open state. Without this guard, a burst of parallel
 * callers (e.g. a Wave batch run) can all pass the half-open gate
 * simultaneously and stampede a recovering Horizon endpoint. The budget is
 * enforced by tracking `halfOpenProbesInFlight`; calls beyond the budget
 * receive a `CircuitOpenError` immediately (fast-fail), identical to full-open
 * behavior. See `CircuitBreakerOptions.halfOpenMaxProbes` and
 * `docs/ARCHITECTURE.md#circuit-breaker-half-open-probe-budget`.
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
    /**
     * True when another request can be recorded without exceeding the budget.
     * Lets batch loops mark remaining rows as exhausted without attempting a
     * fetch that is guaranteed to fail closed. Never consumes budget itself.
     */
    hasRemainingBudget(): boolean;
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
 * - maxRetries: 3 attempts
 * - initialDelayMs: 1000ms (1 second)
 * - maxDelayMs: 30000ms (30 seconds)
 * - backoffMultiplier: 2x exponential backoff
 * - timeoutMs: 15000ms (15 seconds) request timeout
 * - maxTotalWaitMs: 120000ms (2 minutes) total wait budget
 */
export declare const DEFAULT_RETRY_POLICY: RetryPolicy;
/**
 * Calculate the delay for a retry attempt using exponential backoff.
 */
export declare function calculateBackoffDelay(attempt: number, policy: RetryPolicy): number;
/**
 * Add random jitter to a delay to prevent thundering herd.
 * Ensures the result is >= 0 and optionally respects a maximum cap.
 */
export declare function addJitter(delayMs: number, jitterPercent?: number, maxDelayMs?: number): number;
/**
 * `reason_code` values that mean "Horizon was degraded", not "the wallet is
 * not ready". A scheduled sweep should count these — never wallet failures
 * such as `TRUSTLINE_MISSING` — when deciding to pause. Documented in
 * docs/CRON_REVALIDATION.md#backoff-when-horizon-is-degraded.
 */
export declare const HORIZON_DEGRADED_REASON_CODES: readonly ["HORIZON_TIMEOUT", "HORIZON_ERROR", "CIRCUIT_OPEN", "RATE_BUDGET_EXHAUSTED", "HORIZON_WAIT_BUDGET_EXHAUSTED"];
export type HorizonDegradedReasonCode = (typeof HORIZON_DEGRADED_REASON_CODES)[number];
/** True when `reasonCode` signals a Horizon-side degradation. */
export declare function isHorizonDegradedReasonCode(reasonCode: string): reasonCode is HorizonDegradedReasonCode;
/** Tuning for {@link shouldPauseCronSweep} / {@link computeCronBackoffDelayMs}. */
export interface CronBackoffPolicy {
    /** Fraction (0–1] of degraded results in one sweep that pauses the sweep. */
    degradedRateThreshold: number;
    /** Minimum number of results before the rate is trusted. */
    minSampleSize: number;
    /** Delay before the first retry sweep after a degraded sweep. */
    baseDelayMs: number;
    /** Upper bound for the (pre-jitter) delay. */
    maxDelayMs: number;
    /** Jitter applied to the delay, as a percentage (± jitterPercent %). */
    jitterPercent: number;
}
/**
 * Defaults documented in docs/CRON_REVALIDATION.md: pause when ≥ 20 % of at
 * least 5 results are Horizon-degraded, then back off 15 min → 30 → 60 → …
 * capped at 6 h, with ± 20 % jitter so many Wave orgs do not resume together.
 */
export declare const DEFAULT_CRON_BACKOFF_POLICY: CronBackoffPolicy;
/**
 * Decide whether a cron sweep should stop dispatching further checks because
 * Horizon looks degraded (Issue #909).
 *
 * @param reasonCodes  `reason_code` outputs collected so far in this sweep.
 * @returns `true` once at least `minSampleSize` results were seen and the
 *          share of {@link HORIZON_DEGRADED_REASON_CODES} reaches
 *          `degradedRateThreshold`. Wallet failures never count.
 */
export declare function shouldPauseCronSweep(reasonCodes: readonly string[], policy?: CronBackoffPolicy): boolean;
/**
 * Delay before the next cron sweep after `consecutiveDegradedSweeps`
 * degraded sweeps in a row (Issue #909).
 *
 * `0` sweeps → `0` (run on the normal schedule). Otherwise
 * `min(baseDelayMs * 2^(n-1), maxDelayMs)` with ± `jitterPercent` jitter,
 * never above `maxDelayMs`. Negative or non-finite counts throw so a broken
 * counter in a workflow script fails loudly instead of hammering Horizon.
 *
 * @param random  Injectable RNG in [0, 1) for deterministic tests.
 */
export declare function computeCronBackoffDelayMs(consecutiveDegradedSweeps: number, policy?: CronBackoffPolicy, random?: () => number): number;
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
     * and allowing probe requests. Default: 30 000.
     */
    recoveryTimeoutMs?: number;
    /**
     * Number of consecutive successes in 'half-open' state required to fully
     * close the circuit again. Default: 2.
     */
    successThreshold?: number;
    /**
     * Maximum number of probe calls allowed **concurrently** while the circuit
     * is in `half-open` state. Default: 1.
     *
     * Issue #888 — without this cap, a burst of parallel callers (e.g. a Wave
     * batch run reaching half-open simultaneously) can stampede a recovering
     * Horizon endpoint. When the in-flight probe count reaches this limit any
     * additional callers receive a `CircuitOpenError` immediately (fast-fail),
     * identical to behavior in the fully-open state. The count is decremented
     * when each probe resolves (success or failure).
     *
     * Set to `Infinity` to restore the pre-#888 behavior (unlimited probes).
     */
    halfOpenMaxProbes?: number;
    /**
     * Optional callback fired on every state transition. Receives the previous
     * state, the next state, and a human-readable reason string.
     *
     * Wave #26: TrustBridge wires this to `core.notice` / `core.warning` so
     * that state changes surface as GitHub Check Run annotations in the Actions
     * summary panel without requiring `debug_mode: true`.
     */
    onStateChange?: (from: CircuitState, to: CircuitState, reason: string) => void;
    /**
     * Optional callback fired when a half-open probe is rejected because the
     * probe budget is exhausted. Receives the current in-flight count and the
     * configured maximum. Useful for metrics emission and observability.
     *
     * Issue #888.
     */
    onProbeBudgetExhausted?: (inFlight: number, maxProbes: number) => void;
    /**
     * Wall clock used for every open-state expiry decision. Returns epoch
     * milliseconds. Default: `() => Date.now()` (read at call time, so Jest
     * modern fake timers keep working).
     *
     * Open-state expiry is purely time-based: the circuit stays open until
     * `recoveryTimeoutMs` of wall-clock time has elapsed since it opened,
     * no matter how many calls are fast-failed in the meantime. Inject a fake
     * clock in tests to drive the cooldown deterministically.
     */
    now?: () => number;
    /**
     * Upper bound, in milliseconds, for a server-requested cooldown recorded
     * via `CircuitBreaker.noteRetryAfter()`. A hostile or misconfigured
     * Horizon cannot pin the circuit open longer than this. Default: 300 000
     * (5 minutes). Must be a finite number ≥ 0.
     */
    maxRetryAfterMs?: number;
}
/** Default cap for Retry-After driven cooldowns (5 minutes). */
export declare const DEFAULT_MAX_RETRY_AFTER_MS = 300000;
/**
 * Circuit-breaker implementation for the TrustBridge resilience layer.
 *
 * Wave #26 integration: when `onStateChange` is omitted the constructor
 * falls back to emitting `core.warning` / `core.notice` annotations so that
 * circuit trips and recoveries are always visible as GitHub Check Run
 * annotations in the Actions UI, even without `debug_mode: true`.
 *
 * Issue #888 — half-open probe budget: `halfOpenMaxProbes` (default: 1)
 * limits how many concurrent probe calls may be in-flight while the circuit
 * is in `half-open` state. Additional callers beyond the budget receive a
 * `CircuitOpenError` immediately (identical to open-state fast-fail) and
 * the rejection is counted in `halfOpenProbeBudgetExhaustedCount`. This
 * prevents stampeding retries during Horizon recovery under Wave batch peaks.
 *
 * States:
 *  - **closed** — normal operation; failures are counted.
 *  - **open**   — requests are short-circuited (fast-fail); a recovery timer
 *                 controls transition to 'half-open'.
 *  - **half-open** — up to `halfOpenMaxProbes` concurrent probe requests are
 *                    allowed; enough consecutive successes closes the circuit,
 *                    any failure re-opens it.
 *
 * Issue #920 — wall-clock open-state expiry: the open → half-open transition
 * is driven only by elapsed time on the injected clock (`options.now`), never
 * by how many calls were fast-failed. A server-requested `Retry-After`
 * recorded through `noteRetryAfter()` extends the cooldown: the circuit does
 * not go half-open, and half-open probes are not admitted, until both the
 * recovery timeout and the Retry-After deadline have passed. If the clock
 * moves backwards while open, the cooldown restarts from the new "now"
 * instead of expiring early.
 */
export declare class CircuitBreaker {
    private state;
    private consecutiveFailures;
    private consecutiveSuccesses;
    private openedAt;
    private lastErrorClass;
    /** Issue #920: epoch ms before which no probe may run (Retry-After floor). */
    private retryAfterUntil;
    /** Issue #888: in-flight probe count while in half-open state. */
    private halfOpenProbesInFlight;
    /** Issue #888: total rejections due to probe budget exhaustion. */
    private halfOpenProbeBudgetExhaustedCount;
    /** Issue #888: total probes that completed (resolved or rejected) in half-open. */
    private halfOpenProbesCompleted;
    private readonly failureThreshold;
    private readonly recoveryTimeoutMs;
    private readonly successThreshold;
    private readonly halfOpenMaxProbes;
    private readonly maxRetryAfterMs;
    private readonly now;
    private readonly onStateChange;
    private readonly onProbeBudgetExhausted;
    constructor(options?: CircuitBreakerOptions);
    /**
     * Current circuit state.
     */
    getState(): CircuitState;
    /**
     * Execute `fn` through the circuit breaker.
     *
     * - **closed**: delegates to `fn`; records success or failure.
     * - **open**: throws a `CircuitOpenError` immediately without calling `fn`.
     * - **half-open**: allows up to `halfOpenMaxProbes` concurrent probes.
     *   Callers beyond the budget receive `CircuitOpenError` immediately.
     *   Success closes the circuit after `successThreshold` consecutive wins;
     *   any failure re-opens it and resets the in-flight count.
     */
    execute<T>(fn: () => Promise<T>): Promise<T>;
    /**
     * One-shot flag: set by `_recordFailure` when the circuit was half-open at
     * the time of the failure (and was re-opened). Used by the `finally` block
     * in `execute` to know it should still decrement `halfOpenProbesInFlight`
     * even though `this.state` is now `'open'` by the time `finally` runs.
     */
    private _wasHalfOpenBeforeFailure;
    /**
     * Force-reset the circuit to closed state. Useful in tests and for manual
     * operator intervention.
     */
    reset(): void;
    /**
     * Record a server-requested cooldown (Issue #920), typically the parsed
     * `Retry-After` of a Horizon 429/503. The circuit will not move from open
     * to half-open — and a half-open circuit will not admit probes — until
     * `delayMs` has elapsed on the breaker's clock.
     *
     * - Values are clamped to `maxRetryAfterMs` so a hostile header cannot pin
     *   the circuit open indefinitely.
     * - Negative, NaN, or non-finite values are ignored (returns `false`), the
     *   same way `parseRetryAfterMs` treats them as absent.
     * - A shorter Retry-After never shortens an existing, longer deadline.
     * - In the closed state the deadline is remembered but does not block
     *   calls; the retry loop already sleeps for Retry-After. It only takes
     *   effect if the circuit opens before the deadline passes.
     *
     * Returns `true` when the deadline was recorded or extended.
     */
    noteRetryAfter(delayMs: number): boolean;
    /**
     * Milliseconds until the next probe may reach the wrapped operation
     * (Issue #920). Always ≥ 0.
     *
     * - **closed**: 0.
     * - **open**: the larger of the remaining recovery timeout and the
     *   remaining Retry-After deadline.
     * - **half-open**: the remaining Retry-After deadline (0 when none).
     */
    getRemainingCooldownMs(): number;
    /**
     * Snapshot of the breaker's internal counters — useful for tests and
     * metrics emission without exposing mutable state.
     */
    getStats(): {
        state: CircuitState;
        consecutiveFailures: number;
        consecutiveSuccesses: number;
        openedAt: number | null;
        /** Issue #888: probes currently in-flight during half-open. */
        halfOpenProbesInFlight: number;
        /** Issue #888: total probes rejected due to budget exhaustion. */
        halfOpenProbeBudgetExhaustedCount: number;
        /** Issue #888: configured maximum concurrent probes. */
        halfOpenMaxProbes: number;
    };
    /**
     * Circuit-open metrics for the Job Summary (#788). Reports only the error
     * class name — never the error message — so raw Horizon response bodies
     * cannot leak into the summary.
     *
     * Issue #888: adds `halfOpenProbeStats` for probe budget observability.
     */
    getOpenMetrics(now?: number): CircuitOpenMetrics;
    private _maybeTransitionToHalfOpen;
    private _recordSuccess;
    private _recordFailure;
}
/**
 * Snapshot returned by `CircuitBreaker.getOpenMetrics` (#788).
 */
export interface CircuitOpenMetrics {
    state: CircuitState;
    /** Milliseconds the circuit has been open; 0 unless state is 'open'. */
    openDurationMs: number;
    /** Class name of the last recorded failure (e.g. 'TypeError'), or null. */
    lastErrorClass: string | null;
    consecutiveFailures: number;
    /**
     * Issue #888: half-open probe budget stats. Always present; callers can
     * read `inFlight` and `budgetExhaustedCount` to populate dashboards.
     */
    halfOpenProbeStats: {
        /** Probes currently in-flight (concurrent) in half-open state. */
        inFlight: number;
        /** Configured maximum concurrent probes (`halfOpenMaxProbes`). */
        maxProbes: number;
        /** Total calls rejected due to budget exhaustion since last transition to half-open. */
        budgetExhaustedCount: number;
        /** Total probes that completed (resolved or rejected) since last transition to half-open. */
        completed: number;
    };
}
/**
 * Thrown by `CircuitBreaker.execute` when the circuit is open and the
 * request was fast-failed without reaching the underlying operation.
 */
export declare class CircuitOpenError extends Error {
    /**
     * Issue #920: milliseconds until the breaker will admit a probe, when
     * known. Callers can surface this as a hint ("retry in ~Ns") without
     * guessing the recovery timeout.
     */
    readonly remainingCooldownMs?: number;
    constructor(message: string, remainingCooldownMs?: number);
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
