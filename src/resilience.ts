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

import * as core from '@actions/core';
import { inferStellarNetworkPreset } from './links';

// ---------------------------------------------------------------------------
// Rate Budget Tracker
// ---------------------------------------------------------------------------

export class RateBudgetExhaustedError extends Error {
  statusCode: number;
  retryable: boolean;

  constructor(message: string) {
    super(message);
    this.name = 'RateBudgetExhaustedError';
    this.statusCode = 0;
    this.retryable = false;
  }
}

export class RateBudgetTracker {
  private count = 0;

  constructor(private readonly maxRequests: number) {}

  /**
   * Records a request. Throws RateBudgetExhaustedError if the budget is exceeded.
   * If maxRequests is 0, the budget is considered unlimited.
   */
  recordRequest(): void {
    if (this.maxRequests > 0) {
      this.count++;
      if (this.count > this.maxRequests) {
        throw new RateBudgetExhaustedError(
          `Rate budget exhausted: exceeded ${this.maxRequests} maximum Horizon requests per run.`,
        );
      }
    }
  }

  get requestsMade(): number {
    return this.count;
  }

  /**
   * True when another request can be recorded without exceeding the budget.
   * Lets batch loops mark remaining rows as exhausted without attempting a
   * fetch that is guaranteed to fail closed. Never consumes budget itself.
   */
  hasRemainingBudget(): boolean {
    return this.maxRequests === 0 || this.count < this.maxRequests;
  }
}

// ---------------------------------------------------------------------------
// CLI check command types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// RetryPolicy and defaults
// ---------------------------------------------------------------------------

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
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  timeoutMs: 15000,
  maxTotalWaitMs: 120000,
};

/**
 * Calculate the delay for a retry attempt using exponential backoff.
 */
export function calculateBackoffDelay(
  attempt: number,
  policy: RetryPolicy,
): number {
  const delay = policy.initialDelayMs * Math.pow(policy.backoffMultiplier, attempt);
  return Math.min(delay, policy.maxDelayMs);
}

/**
 * Add random jitter to a delay to prevent thundering herd.
 * Ensures the result is >= 0 and optionally respects a maximum cap.
 */
export function addJitter(delayMs: number, jitterPercent: number = 10, maxDelayMs?: number): number {
  const jitter = delayMs * (jitterPercent / 100);
  const randomJitter = (Math.random() - 0.5) * 2 * jitter;
  const jittered = Math.max(0, delayMs + randomJitter);
  return maxDelayMs !== undefined ? Math.min(jittered, maxDelayMs) : jittered;
}

/**
 * Sleep for a given duration.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------

/**
 * Simple rate limiter to throttle requests.
 */
export class RateLimiter {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillRatePerSecond: number;
  private lastRefillTime: number;

  /**
   * Create a rate limiter with token bucket algorithm.
   * @param capacity Maximum number of tokens (requests allowed per refill window)
   * @param refillRatePerSecond How many tokens to refill per second
   */
  constructor(capacity: number, refillRatePerSecond: number) {
    this.capacity = capacity;
    this.refillRatePerSecond = refillRatePerSecond;
    this.tokens = capacity;
    this.lastRefillTime = Date.now();
  }

  /**
   * Check if a request is allowed, consuming a token if so.
   */
  tryConsume(tokensNeeded: number = 1): boolean {
    this.refill();

    if (this.tokens >= tokensNeeded) {
      this.tokens -= tokensNeeded;
      return true;
    }

    return false;
  }

  /**
   * Get the number of milliseconds to wait before trying again.
   */
  waitTimeMs(tokensNeeded: number = 1): number {
    this.refill();

    if (this.tokens >= tokensNeeded) {
      return 0;
    }

    const deficit = tokensNeeded - this.tokens;
    return (deficit / this.refillRatePerSecond) * 1000;
  }

  /**
   * Refill tokens based on elapsed time.
   */
  private refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefillTime) / 1000;
    const tokensToAdd = elapsedSeconds * this.refillRatePerSecond;

    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefillTime = now;
  }

  /**
   * Get current token count.
   */
  getAvailableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /**
   * Reset the rate limiter to full capacity.
   */
  reset(): void {
    this.tokens = this.capacity;
    this.lastRefillTime = Date.now();
  }
}

// ---------------------------------------------------------------------------
// retryWithBackoff
// ---------------------------------------------------------------------------

/**
 * Execute a function with exponential backoff retry logic.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  shouldRetry: (error: unknown, attempt: number) => boolean = () => true,
): Promise<T> {
  let lastError: unknown;
  let totalWaitMs = 0;

  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt >= policy.maxRetries) {
        throw error;
      }

      if (!shouldRetry(error, attempt)) {
        throw error;
      }

      const delayMs = calculateBackoffDelay(attempt, policy);
      const delayWithJitter = addJitter(delayMs, 10, policy.maxDelayMs);
      
      if (delayWithJitter > policy.maxDelayMs || totalWaitMs + delayWithJitter > policy.maxTotalWaitMs) {
        throw new Error(
          `Retry wait budget exhausted (attempted wait ${delayWithJitter}ms, ` +
          `max delay ${policy.maxDelayMs}ms, total wait ${totalWaitMs}ms, ` +
          `max total ${policy.maxTotalWaitMs}ms).`,
        );
      }
      
      totalWaitMs += delayWithJitter;
      await sleep(delayWithJitter);
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// CircuitBreaker  (Wave #26 — GitHub Check Runs integration)
// ---------------------------------------------------------------------------

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
export const DEFAULT_MAX_RETRY_AFTER_MS = 300_000;

/**
 * Validate a millisecond duration option. Throws a `RangeError` with a stable
 * message for negative, NaN, or infinite values so misconfiguration fails
 * loudly at construction time instead of producing a circuit that never (or
 * instantly) recovers.
 */
function assertDurationMs(name: string, value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `CircuitBreaker option ${name} must be a finite number of milliseconds >= 0 (received ${String(value)}).`,
    );
  }
  return value;
}

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
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures: number = 0;
  private consecutiveSuccesses: number = 0;
  private openedAt: number | null = null;
  private lastErrorClass: string | null = null;
  /** Issue #920: epoch ms before which no probe may run (Retry-After floor). */
  private retryAfterUntil: number | null = null;

  /** Issue #888: in-flight probe count while in half-open state. */
  private halfOpenProbesInFlight: number = 0;
  /** Issue #888: total rejections due to probe budget exhaustion. */
  private halfOpenProbeBudgetExhaustedCount: number = 0;
  /** Issue #888: total probes that completed (resolved or rejected) in half-open. */
  private halfOpenProbesCompleted: number = 0;

  private readonly failureThreshold: number;
  private readonly recoveryTimeoutMs: number;
  private readonly successThreshold: number;
  private readonly halfOpenMaxProbes: number;
  private readonly maxRetryAfterMs: number;
  private readonly now: () => number;
  private readonly onStateChange: (from: CircuitState, to: CircuitState, reason: string) => void;
  private readonly onProbeBudgetExhausted: (inFlight: number, maxProbes: number) => void;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.recoveryTimeoutMs = assertDurationMs('recoveryTimeoutMs', options.recoveryTimeoutMs ?? 30_000);
    this.maxRetryAfterMs = assertDurationMs(
      'maxRetryAfterMs',
      options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS,
    );
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new TypeError('CircuitBreaker option now must be a function returning epoch milliseconds.');
    }
    this.now = options.now ?? (() => Date.now());
    this.successThreshold = options.successThreshold ?? 2;
    this.halfOpenMaxProbes = options.halfOpenMaxProbes ?? 1;

    // Wave #26: default handler surfaces state changes as Check Run annotations.
    this.onStateChange =
      options.onStateChange ??
      ((from, to, reason) => {
        if (to === 'open') {
          core.warning(
            `[TrustBridge CircuitBreaker] Circuit opened (${from} → open): ${reason}`,
          );
        } else if (to === 'closed') {
          core.notice(
            `[TrustBridge CircuitBreaker] Circuit closed (${from} → closed): ${reason}`,
          );
        } else {
          core.notice(
            `[TrustBridge CircuitBreaker] Circuit state changed (${from} → ${to}): ${reason}`,
          );
        }
      });

    // Issue #888: default probe-budget-exhausted handler emits a warning annotation.
    this.onProbeBudgetExhausted =
      options.onProbeBudgetExhausted ??
      ((inFlight, maxProbes) => {
        core.warning(
          `[TrustBridge CircuitBreaker] Half-open probe budget exhausted ` +
            `(${inFlight}/${maxProbes} probes in flight). ` +
            `Caller fast-failed without reaching Horizon.`,
        );
      });
  }

  /**
   * Current circuit state.
   */
  getState(): CircuitState {
    this._maybeTransitionToHalfOpen();
    return this.state;
  }

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
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this._maybeTransitionToHalfOpen();

    if (this.state === 'open') {
      const remainingCooldownMs = this.getRemainingCooldownMs();
      throw new CircuitOpenError(
        `Circuit breaker is open. Requests are temporarily blocked while waiting for recovery (threshold: ${this.failureThreshold} failures; ~${remainingCooldownMs}ms cooldown remaining).`,
        remainingCooldownMs,
      );
    }

    // Issue #920: a Retry-After recorded after the circuit went half-open
    // still gates probes — fast-fail until the server-requested deadline.
    if (this.state === 'half-open') {
      const remainingCooldownMs = this.getRemainingCooldownMs();
      if (remainingCooldownMs > 0) {
        throw new CircuitOpenError(
          `Circuit breaker is half-open but Horizon asked to wait (Retry-After); ` +
            `probe deferred for ~${remainingCooldownMs}ms.`,
          remainingCooldownMs,
        );
      }
    }

    // Issue #888: enforce probe budget in half-open state.
    if (this.state === 'half-open') {
      if (this.halfOpenProbesInFlight >= this.halfOpenMaxProbes) {
        this.halfOpenProbeBudgetExhaustedCount += 1;
        this.onProbeBudgetExhausted(this.halfOpenProbesInFlight, this.halfOpenMaxProbes);
        throw new CircuitOpenError(
          `Circuit breaker is half-open but the probe budget is exhausted ` +
            `(${this.halfOpenProbesInFlight}/${this.halfOpenMaxProbes} probes in flight). ` +
            `Request fast-failed to prevent stampeding retries on the recovering endpoint.`,
        );
      }
      this.halfOpenProbesInFlight += 1;
    }

    try {
      const result = await fn();
      this._recordSuccess();
      return result;
    } catch (err) {
      this._recordFailure(err);
      throw err;
    } finally {
      // Decrement the in-flight count whenever we were tracking a probe.
      if (this.state === 'half-open' || this._wasHalfOpenBeforeFailure) {
        // _wasHalfOpenBeforeFailure is a one-shot flag set by _recordFailure
        // when a probe failure immediately re-opened the circuit; we still
        // need to decrement the counter.
        if (this.halfOpenProbesInFlight > 0) {
          this.halfOpenProbesInFlight -= 1;
        }
        this.halfOpenProbesCompleted += 1;
        this._wasHalfOpenBeforeFailure = false;
      }
    }
  }

  /**
   * One-shot flag: set by `_recordFailure` when the circuit was half-open at
   * the time of the failure (and was re-opened). Used by the `finally` block
   * in `execute` to know it should still decrement `halfOpenProbesInFlight`
   * even though `this.state` is now `'open'` by the time `finally` runs.
   */
  private _wasHalfOpenBeforeFailure = false;

  /**
   * Force-reset the circuit to closed state. Useful in tests and for manual
   * operator intervention.
   */
  reset(): void {
    const prev = this.state;
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.openedAt = null;
    this.retryAfterUntil = null;
    this.halfOpenProbesInFlight = 0;
    this.halfOpenProbesCompleted = 0;
    this.halfOpenProbeBudgetExhaustedCount = 0;
    if (prev !== 'closed') {
      this.onStateChange(prev, 'closed', 'manual reset');
    }
  }

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
  noteRetryAfter(delayMs: number): boolean {
    if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0) {
      return false;
    }
    const until = this.now() + Math.min(delayMs, this.maxRetryAfterMs);
    if (this.retryAfterUntil !== null && this.retryAfterUntil >= until) {
      return false;
    }
    this.retryAfterUntil = until;
    return true;
  }

  /**
   * Milliseconds until the next probe may reach the wrapped operation
   * (Issue #920). Always ≥ 0.
   *
   * - **closed**: 0.
   * - **open**: the larger of the remaining recovery timeout and the
   *   remaining Retry-After deadline.
   * - **half-open**: the remaining Retry-After deadline (0 when none).
   */
  getRemainingCooldownMs(): number {
    this._maybeTransitionToHalfOpen();
    if (this.state === 'closed') return 0;
    const now = this.now();
    const retryAfterRemaining =
      this.retryAfterUntil !== null ? Math.max(0, this.retryAfterUntil - now) : 0;
    if (this.state === 'half-open') return retryAfterRemaining;
    const recoveryRemaining =
      this.openedAt !== null ? Math.max(0, this.openedAt + this.recoveryTimeoutMs - now) : 0;
    return Math.max(recoveryRemaining, retryAfterRemaining);
  }

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
  } {
    this._maybeTransitionToHalfOpen();
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      openedAt: this.openedAt,
      halfOpenProbesInFlight: this.halfOpenProbesInFlight,
      halfOpenProbeBudgetExhaustedCount: this.halfOpenProbeBudgetExhaustedCount,
      halfOpenMaxProbes: this.halfOpenMaxProbes,
    };
  }

  /**
   * Circuit-open metrics for the Job Summary (#788). Reports only the error
   * class name — never the error message — so raw Horizon response bodies
   * cannot leak into the summary.
   *
   * Issue #888: adds `halfOpenProbeStats` for probe budget observability.
   */
  getOpenMetrics(now: number = this.now()): CircuitOpenMetrics {
    const stats = this.getStats();
    return {
      state: stats.state,
      openDurationMs:
        stats.state === 'open' && stats.openedAt !== null
          ? Math.max(0, now - stats.openedAt)
          : 0,
      lastErrorClass: this.lastErrorClass,
      consecutiveFailures: stats.consecutiveFailures,
      halfOpenProbeStats: {
        inFlight: stats.halfOpenProbesInFlight,
        maxProbes: stats.halfOpenMaxProbes,
        budgetExhaustedCount: stats.halfOpenProbeBudgetExhaustedCount,
        completed: this.halfOpenProbesCompleted,
      },
    };
  }

  // ---- private helpers ----

  private _maybeTransitionToHalfOpen(): void {
    if (this.state !== 'open' || this.openedAt === null) return;
    const now = this.now();
    // Issue #920: a clock that moved backwards must not expire the cooldown
    // early (or leave it negative) — restart it from the current reading.
    if (now < this.openedAt) {
      this.openedAt = now;
      return;
    }
    const recoveryElapsed = now - this.openedAt >= this.recoveryTimeoutMs;
    const retryAfterElapsed = this.retryAfterUntil === null || now >= this.retryAfterUntil;
    if (recoveryElapsed && retryAfterElapsed) {
      const prev = this.state;
      this.state = 'half-open';
      this.consecutiveSuccesses = 0;
      this.halfOpenProbesInFlight = 0;
      this.halfOpenProbesCompleted = 0;
      this.halfOpenProbeBudgetExhaustedCount = 0;
      this.onStateChange(prev, 'half-open', `recovery timeout of ${this.recoveryTimeoutMs}ms elapsed`);
    }
  }

  private _recordSuccess(): void {
    if (this.state === 'half-open') {
      this.consecutiveSuccesses += 1;
      if (this.consecutiveSuccesses >= this.successThreshold) {
        const prev = this.state;
        this.state = 'closed';
        this.consecutiveFailures = 0;
        this.consecutiveSuccesses = 0;
        this.openedAt = null;
        this.halfOpenProbesInFlight = 0;
        this.halfOpenProbesCompleted = 0;
        this.halfOpenProbeBudgetExhaustedCount = 0;
        this.onStateChange(prev, 'closed', `${this.successThreshold} consecutive successes in half-open`);
      }
    } else if (this.state === 'closed') {
      // Reset failure counter on success so isolated blips don't accumulate.
      this.consecutiveFailures = 0;
    }
  }

  private _recordFailure(err: unknown): void {
    this.lastErrorClass = errorClassOf(err);
    if (this.state === 'half-open') {
      // Any failure in half-open immediately re-opens the circuit.
      this._wasHalfOpenBeforeFailure = true;
      const prev = this.state;
      this.state = 'open';
      this.openedAt = this.now();
      this.consecutiveSuccesses = 0;
      const reason = err instanceof Error ? err.message : String(err);
      this.onStateChange(prev, 'open', `probe failed in half-open: ${reason}`);
      return;
    }

    this.consecutiveFailures += 1;

    if (
      this.state === 'closed' &&
      this.consecutiveFailures >= this.failureThreshold
    ) {
      const prev = this.state;
      this.state = 'open';
      this.openedAt = this.now();
      const reason = err instanceof Error ? err.message : String(err);
      this.onStateChange(
        prev,
        'open',
        `${this.consecutiveFailures} consecutive failures (threshold: ${this.failureThreshold}): ${reason}`,
      );
    }
  }
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

const ERROR_CLASS_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

function errorClassOf(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name || err.constructor?.name || 'Error';
    return ERROR_CLASS_PATTERN.test(name) ? name : 'Error';
  }
  return 'NonErrorThrown';
}

/**
 * Thrown by `CircuitBreaker.execute` when the circuit is open and the
 * request was fast-failed without reaching the underlying operation.
 */
export class CircuitOpenError extends Error {
  /**
   * Issue #920: milliseconds until the breaker will admit a probe, when
   * known. Callers can surface this as a hint ("retry in ~Ns") without
   * guessing the recovery timeout.
   */
  public readonly remainingCooldownMs?: number;

  constructor(message: string, remainingCooldownMs?: number) {
    super(message);
    this.name = 'CircuitOpenError';
    if (remainingCooldownMs !== undefined && Number.isFinite(remainingCooldownMs)) {
      this.remainingCooldownMs = Math.max(0, Math.round(remainingCooldownMs));
    }
  }
}

// ---------------------------------------------------------------------------
// GitHub Check Run annotations  (Wave #26)
// ---------------------------------------------------------------------------

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
export function emitCheckRunAnnotation(annotation: CheckRunAnnotation): void {
  const formatted = `[TrustBridge Resilience] ${annotation.title}: ${annotation.message}`;
  switch (annotation.level) {
    case 'notice':
      core.notice(formatted);
      break;
    case 'warning':
      core.warning(formatted);
      break;
    case 'error':
      core.error(formatted);
      break;
  }
}

/**
 * Convenience wrapper: emit a retry-scheduled annotation.
 *
 * @param attempt   0-based attempt index that just failed.
 * @param delayMs   How long the backoff sleep will be before the next attempt.
 * @param reason    Human-readable description of what failed (error message).
 */
export function annotateRetry(attempt: number, delayMs: number, reason: string): void {
  emitCheckRunAnnotation({
    level: 'notice',
    title: `Retry scheduled (attempt ${attempt + 1})`,
    message: `Backing off ${delayMs}ms before next attempt. Reason: ${reason}`,
  });
}

/**
 * Convenience wrapper: emit a rate-limit annotation.
 *
 * @param waitMs  How long the action will wait before retrying (from Retry-After).
 */
export function annotateRateLimit(waitMs: number): void {
  emitCheckRunAnnotation({
    level: 'warning',
    title: 'Rate limited',
    message: `Horizon returned 429. Waiting ${waitMs}ms before retrying (Retry-After header respected).`,
  });
}

/**
 * Convenience wrapper: emit a fallback-activated annotation.
 *
 * @param fallbackUrl  The fallback endpoint being tried (may be redacted by caller).
 * @param reason       Why primary failed.
 */
export function annotateFallback(fallbackUrl: string, reason: string): void {
  emitCheckRunAnnotation({
    level: 'warning',
    title: 'RPC fallback activated',
    message: `Primary Horizon endpoint exhausted. Switching to fallback (${fallbackUrl}). Reason: ${reason}`,
  });
}

/**
 * Convenience wrapper: emit a circuit-open annotation.
 *
 * @param consecutiveFailures  How many failures triggered the trip.
 */
export function annotateCircuitOpen(consecutiveFailures: number): void {
  emitCheckRunAnnotation({
    level: 'error',
    title: 'Circuit breaker opened',
    message: `${consecutiveFailures} consecutive failures exceeded the threshold. Requests are temporarily blocked.`,
  });
}

// ---------------------------------------------------------------------------

/** Minimal fetch-like type accepted by runCliCheck for testability. */
export type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<{ status: number }>;

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
export async function runCliCheck(
  options: CliCheckOptions,
  fetchFn: FetchFn = (url, init) => fetch(url, init) as Promise<{ status: number }>,
): Promise<CliCheckResult> {
  const horizonUrl = options.horizonUrl ?? 'https://horizon.stellar.org';
  const secondaryUrl = options.secondaryHorizonUrl || (options.fallbackUrls && options.fallbackUrls[0]);
  const policy: RetryPolicy = {
    ...DEFAULT_RETRY_POLICY,
    timeoutMs: options.timeoutMs ?? DEFAULT_RETRY_POLICY.timeoutMs,
    ...options.retryPolicy,
  };

  const accountUrl = `${horizonUrl.replace(/\/$/, '')}/accounts/${options.address}`;

  const startMs = Date.now();
  let retries = 0;
  let statusCode: number | undefined;
  let horizonUrlUsed = horizonUrl;
  let failedOver = false;

  try {
    await retryWithBackoff(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), policy.timeoutMs);

        try {
          const response = await fetchFn(accountUrl, { signal: controller.signal });
          statusCode = response.status;

          // Only retry on server-side transient errors.
          if (response.status === 429 || (response.status >= 500 && response.status !== 503)) {
            throw new Error(`Transient HTTP ${response.status} — retrying`);
          }
          // 404 = not found, not a transient error.
        } finally {
          clearTimeout(timer);
        }
      },
      policy,
      (_error, attempt) => {
        retries = attempt + 1;
        return true;
      },
    );
  } catch {
    // Exhausted retries or non-retryable error — fall through to result.
  }

  // If primary failed on transient error (not 404), fail over to secondary URL
  if (statusCode !== 200 && statusCode !== 404 && secondaryUrl) {
    const primaryNet = inferStellarNetworkPreset(horizonUrl);
    const secondaryNet = inferStellarNetworkPreset(secondaryUrl);
    if (primaryNet === secondaryNet || options.allowCrossNetworkFailover) {
      const secondaryAccountUrl = `${secondaryUrl.replace(/\/$/, '')}/accounts/${options.address}`;
      let secondaryRetries = 0;
      try {
        await retryWithBackoff(
          async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
            try {
              const response = await fetchFn(secondaryAccountUrl, { signal: controller.signal });
              statusCode = response.status;
              if (response.status === 429 || (response.status >= 500 && response.status !== 503)) {
                throw new Error(`Transient HTTP ${response.status} on secondary — retrying`);
              }
            } finally {
              clearTimeout(timer);
            }
          },
          policy,
          (_error, attempt) => {
            secondaryRetries = attempt + 1;
            return true;
          },
        );
        if (statusCode === 200 || statusCode === 404) {
          failedOver = true;
          horizonUrlUsed = secondaryUrl;
          retries += secondaryRetries;
        }
      } catch {
        retries += secondaryRetries;
      }
    }
  }

  const durationMs = Date.now() - startMs;
  const reachable = statusCode === 200;

  const message = reachable
    ? failedOver
      ? `Account ${options.address} is reachable on secondary Horizon ${horizonUrlUsed} (${durationMs}ms after primary failover).`
      : `Account ${options.address} is reachable on Horizon (${durationMs}ms, ${retries} retries).`
    : statusCode === 404
      ? `Account ${options.address} was not found on Horizon (404) — not yet funded.`
      : statusCode !== undefined
        ? `Horizon returned HTTP ${statusCode} for ${options.address} (${durationMs}ms, ${retries} retries).`
        : `Could not reach Horizon at ${horizonUrl} (${durationMs}ms, ${retries} retries).`;

  return { reachable, statusCode, durationMs, message, retries, horizonUrlUsed, failedOver };
}

// HttpMockMatrix  (Wave #36 — Horizon HTTP mock matrix)
// ---------------------------------------------------------------------------

/**
 * Scenario identifiers for the Horizon HTTP mock matrix.
 *
 * Each scenario models a distinct failure or success mode that the
 * resilience layer must handle. Tests select a scenario by name rather than
 * hand-coding fetch mocks, ensuring consistent coverage across all retry /
 * fallback / circuit-breaker paths.
 */
export type HorizonScenario =
  | 'success'
  | 'not_found'
  | 'rate_limit'
  | 'server_error'
  | 'bad_gateway'
  | 'gateway_timeout'
  | 'timeout'
  | 'network_error'
  | 'flaky_then_success'
  | 'always_fail';

/**
 * A minimal fetch-compatible response shape returned by the mock matrix.
 * Mirrors the subset of `node-fetch` Response that `fetchAccount` and the
 * resilience layer actually consume, keeping tests free of heavy dependencies.
 */
export interface MockResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

/**
 * A fetch function compatible with the `fetchFn` option in `FetchAccountOptions`.
 */
export type MockFetchFn = (
  url: string,
  init?: { signal?: AbortSignal; method?: string; headers?: Record<string, string> },
) => Promise<MockResponse>;

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
export class HttpMockMatrix {
  /**
   * Build a mock fetch function for the given scenario.
   */
  static build(
    scenario: HorizonScenario,
    options: MockMatrixOptions = {},
  ): MockFetchFn {
    switch (scenario) {
      case 'success':
        return HttpMockMatrix._successFetch(options);
      case 'not_found':
        return HttpMockMatrix._staticResponseFetch(404, 'Not Found', {
          type: 'https://stellar.org/horizon-errors/not_found',
          title: 'Resource Missing',
          status: 404,
          detail: 'The resource at the requested endpoint does not exist.',
        });
      case 'rate_limit':
        return HttpMockMatrix._staticResponseFetch(
          429,
          'Too Many Requests',
          {
            type: 'https://stellar.org/horizon-errors/rate_limit_exceeded',
            title: 'Rate Limit Exceeded',
            status: 429,
            detail: 'Too many requests to Horizon.',
          },
          { 'retry-after': options.retryAfterSeconds ?? '0' },
        );
      case 'server_error':
        return HttpMockMatrix._staticResponseFetch(503, 'Service Unavailable', {
          type: 'https://stellar.org/horizon-errors/server_error',
          title: 'Service Unavailable',
          status: 503,
          detail: 'Horizon is temporarily unavailable.',
        });
      case 'bad_gateway':
        return HttpMockMatrix._staticResponseFetch(502, 'Bad Gateway', {
          type: 'https://stellar.org/horizon-errors/bad_gateway',
          title: 'Bad Gateway',
          status: 502,
          detail: 'Upstream gateway error.',
        });
      case 'gateway_timeout':
        return HttpMockMatrix._staticResponseFetch(504, 'Gateway Timeout', {
          type: 'https://stellar.org/horizon-errors/gateway_timeout',
          title: 'Gateway Timeout',
          status: 504,
          detail: 'Upstream gateway timed out.',
        });
      case 'timeout':
        return HttpMockMatrix._timeoutFetch(options.timeoutAfterMs ?? 0);
      case 'network_error':
        return HttpMockMatrix._networkErrorFetch();
      case 'flaky_then_success':
        return HttpMockMatrix._flakyFetch(options);
      case 'always_fail':
        return HttpMockMatrix._staticResponseFetch(503, 'Service Unavailable', {
          type: 'https://stellar.org/horizon-errors/server_error',
          title: 'Service Unavailable',
          status: 503,
          detail: 'Horizon is consistently unavailable.',
        });
      default: {
        const _exhaustive: never = scenario;
        throw new Error(`Unknown HorizonScenario: ${String(_exhaustive)}`);
      }
    }
  }

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
  static buildFallbackMatrix(
    primaryScenario: HorizonScenario,
    fallbackScenario: HorizonScenario,
    primaryUrl: string = 'https://horizon.stellar.org',
    options: MockMatrixOptions = {},
  ): MockFetchFn {
    const primaryFetch = HttpMockMatrix.build(primaryScenario, options);
    const fallbackFetch = HttpMockMatrix.build(fallbackScenario, options);

    return (url, init) => {
      if (url.startsWith(primaryUrl)) {
        return primaryFetch(url, init);
      }
      return fallbackFetch(url, init);
    };
  }

  // ---- private factories ----

  private static _makeHeaders(
    headers: Record<string, string> = {},
  ): { get(name: string): string | null } {
    const lowered: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      lowered[k.toLowerCase()] = v;
    }
    return { get: (name: string) => lowered[name.toLowerCase()] ?? null };
  }

  private static _defaultAccount(
    options: MockMatrixOptions,
  ): Record<string, unknown> {
    return (
      options.accountPayload ?? {
        id: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        account_id: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        sequence: '1',
        subentry_count: 1,
        num_sponsoring: 0,
        num_sponsored: 0,
        balances: [
          {
            balance: '10.0000000',
            asset_type: 'native',
            buying_liabilities: '0.0000000',
            selling_liabilities: '0.0000000',
          },
        ],
      }
    );
  }

  private static _successFetch(options: MockMatrixOptions): MockFetchFn {
    const payload = HttpMockMatrix._defaultAccount(options);
    return async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: HttpMockMatrix._makeHeaders(),
      json: async () => payload,
    });
  }

  private static _staticResponseFetch(
    status: number,
    statusText: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): MockFetchFn {
    return async () => ({
      ok: false,
      status,
      statusText,
      headers: HttpMockMatrix._makeHeaders(headers),
      json: async () => body,
    });
  }

  private static _timeoutFetch(timeoutAfterMs: number): MockFetchFn {
    return (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;

        const abort = () => {
          const err = new Error('The operation was aborted');
          (err as NodeJS.ErrnoException).name = 'AbortError';
          reject(err);
        };

        if (signal) {
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener('abort', abort);
        }

        if (timeoutAfterMs > 0) {
          setTimeout(() => {
            if (signal && !signal.aborted) {
              abort();
            }
          }, timeoutAfterMs);
        }
        // If timeoutAfterMs === 0 the mock just hangs until the AbortSignal fires.
      });
  }

  private static _networkErrorFetch(): MockFetchFn {
    return async () => {
      throw new Error('fetch failed: ECONNREFUSED');
    };
  }

  private static _flakyFetch(options: MockMatrixOptions): MockFetchFn {
    const failCount = options.flakyFailCount ?? 2;
    const errorScenario = options.flakyErrorScenario ?? 'rate_limit';
    const errorFetch = HttpMockMatrix.build(errorScenario, options);
    const successFetch = HttpMockMatrix._successFetch(options);

    let calls = 0;
    return (url, init) => {
      calls += 1;
      if (calls <= failCount) {
        return errorFetch(url, init);
      }
      return successFetch(url, init);
    };
  }
}
