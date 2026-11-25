import { MetricsCollector } from './metrics';
/**
 * Advanced retry and rate-limiting strategies for resilient API interactions.
 */
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
 * Records how long a named circuit remains open. Repeated open notifications
 * are idempotent; closing a circuit that was not open does nothing.
 */
export declare class CircuitOpenDurationTracker {
    private readonly circuitName;
    private readonly metrics;
    private readonly now;
    private openedAt;
    constructor(circuitName: string, metrics?: MetricsCollector, now?: () => number);
    open(): void;
    /** Returns the recorded duration in ms, or null when no open period existed. */
    close(): number | null;
    isOpen(): boolean;
}
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
