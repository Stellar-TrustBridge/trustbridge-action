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
