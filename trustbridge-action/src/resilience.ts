/**
 * Resilience helpers for Horizon interactions.
 *
 * Provides retry/backoff utilities and Retry-After parsing so callers
 * (e.g. wait_until_funded polling) can honor rate-limit responses instead
 * of hammering Horizon and amplifying 429s.
 */

export interface RetryAfterInfo {
  /** Delay in milliseconds derived from the Retry-After header. */
  delayMs: number;
  /** Raw header value as received. */
  raw: string;
}

/**
 * Parse a Retry-After header value.
 *
 * Supports both forms defined by RFC 7231:
 *  - delay-seconds: a non-negative integer number of seconds
 *  - HTTP-date: an absolute date; the delay is computed relative to `now`
 *
 * Returns `null` when the value is missing or cannot be parsed.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now(),
): RetryAfterInfo | null {
  if (value === null || value === undefined) {
    return null;
  }

  const raw = String(value).trim();
  if (raw === '') {
    return null;
  }

  // delay-seconds form (integer seconds).
  if (/^\d+$/.test(raw)) {
    const seconds = Number.parseInt(raw, 10);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return null;
    }
    return { delayMs: seconds * 1000, raw };
  }

  // HTTP-date form.
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) {
    const delayMs = Math.max(0, parsed - now);
    return { delayMs, raw };
  }

  return null;
}

/**
 * Extract a Retry-After delay (ms) from a response-like object.
 *
 * Accepts either a `Headers` instance or a plain header map so it can be
 * used with fetch responses as well as test doubles.
 */
export function retryAfterFromHeaders(
  headers: Headers | Record<string, string | undefined> | null | undefined,
  now: number = Date.now(),
): RetryAfterInfo | null {
  if (!headers) {
    return null;
  }

  let value: string | null | undefined;
  if (typeof (headers as Headers).get === 'function') {
    value = (headers as Headers).get('retry-after');
  } else {
    const map = headers as Record<string, string | undefined>;
    value = map['retry-after'] ?? map['Retry-After'];
  }

  return parseRetryAfter(value, now);
}

/**
 * Compute the delay to wait before the next poll given an HTTP status and
 * optional Retry-After header.
 *
 * For 429 (and 503) responses the Retry-After value is honored when present;
 * otherwise a bounded exponential backoff is used. Non-rate-limit statuses
 * fall back to the provided base delay.
 */
export function nextPollDelayMs(options: {
  status?: number;
  headers?: Headers | Record<string, string | undefined> | null;
  attempt: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  now?: number;
}): number {
  const {
    status,
    headers,
    attempt,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    now = Date.now(),
  } = options;

  const isRateLimited = status === 429 || status === 503;

  if (isRateLimited) {
    const retryAfter = retryAfterFromHeaders(headers, now);
    if (retryAfter) {
      return Math.min(retryAfter.delayMs, maxDelayMs);
    }
  }

  const exponential = baseDelayMs * Math.pow(2, Math.max(0, attempt));
  return Math.min(exponential, maxDelayMs);
}

/**
 * Sleep helper used by polling loops.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
