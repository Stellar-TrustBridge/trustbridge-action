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
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  timeoutMs: 15000,
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
 */
export function addJitter(delayMs: number, jitterPercent: number = 10): number {
  const jitter = delayMs * (jitterPercent / 100);
  const randomJitter = (Math.random() - 0.5) * 2 * jitter;
  return Math.max(0, delayMs + randomJitter);
}

/**
 * Sleep for a given duration.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

/**
 * Execute a function with exponential backoff retry logic.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  shouldRetry: (error: unknown, attempt: number) => boolean = () => true,
): Promise<T> {
  let lastError: unknown;

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
      const delayWithJitter = addJitter(delayMs);
      await sleep(delayWithJitter);
    }
  }

  throw lastError;
}
