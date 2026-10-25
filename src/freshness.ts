/**
 * Ledger freshness guard (Issue #107).
 *
 * Detects when a Horizon node is serving stale data by comparing the
 * latest ingested ledger sequence reported by the Horizon root endpoint
 * against the current wall-clock time and a configurable max-lag threshold.
 *
 * Chosen approach: Horizon root endpoint (`GET /`)
 * ─────────────────────────────────────────────────
 * Horizon exposes `core_latest_ledger`, `history_latest_ledger`, and
 * `history_latest_ledger_closed_at` on its root endpoint. We compare
 * `history_latest_ledger_closed_at` (an ISO-8601 timestamp) to the
 * current wall-clock time. If the gap exceeds `max_ledger_lag_seconds`
 * the guard fires.
 *
 * Why NOT account `last_modified_ledger`:
 * - That field only reflects when the specific account last changed, not
 *   whether Horizon is generally up to date. An inactive account could
 *   have a very old last_modified_ledger even on a perfectly fresh Horizon.
 * - The root endpoint gives a single authoritative freshness signal for
 *   the whole node, regardless of which account is being checked.
 *
 * Default behaviour: warn (not fail) when stale. Set
 * `ledger_freshness_fail_on_stale: true` to hard-fail.
 * The guard is opt-in: disabled by default to preserve backward
 * compatibility. Set `check_ledger_freshness: true` to enable.
 */

import { logger } from './logger';
import { globalMetrics } from './metrics';

/** Subset of Horizon root response we care about. */
export interface HorizonRootResponse {
  /** Sequence number of the latest ledger ingested by the history database. */
  history_latest_ledger?: number;
  /** ISO-8601 close time of the latest ledger ingested by the history database. */
  history_latest_ledger_closed_at?: string;
  /** Sequence number of the latest ledger known to the core validator. */
  core_latest_ledger?: number;
}

export interface FreshnessCheckResult {
  /** Whether the freshness check considers the node fresh enough. */
  fresh: boolean;
  /**
   * Lag in seconds between the latest ledger close time and now.
   * Null if the root endpoint did not return a usable timestamp.
   */
  lagSeconds: number | null;
  /** Latest ledger sequence reported by Horizon, if available. */
  latestLedger: number | null;
  /** Human-readable description of the outcome. */
  message: string;
  /**
   * 'ok'      — within threshold
   * 'stale'   — lag exceeded threshold
   * 'unknown' — could not read the freshness signal (endpoint error / missing field)
   */
  status: 'ok' | 'stale' | 'unknown';
}

export interface FreshnessOptions {
  /**
   * Maximum allowed lag in seconds between the latest ledger close time and
   * the current wall clock. Default: 60 seconds (approximately 5–6 Stellar
   * ledger close cycles at ~5–6 s each).
   */
  maxLagSeconds?: number;
  /** Request timeout for the root endpoint call, in milliseconds. */
  timeoutMs?: number;
  /** Override fetch function (for testing). */
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
}

const DEFAULT_MAX_LAG_SECONDS = 60;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Fetch the Horizon root endpoint and return the raw response object.
 * Throws a typed error on network failure or non-2xx status.
 */
export async function fetchHorizonRoot(
  horizonUrl: string,
  options: { timeoutMs?: number; fetchFn?: FreshnessOptions['fetchFn'] } = {},
): Promise<HorizonRootResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetch = options.fetchFn ?? ((globalThis as unknown as { fetch?: typeof globalThis.fetch }).fetch
    ?? (await import('node-fetch')).default as unknown as typeof globalThis.fetch);

  const url = horizonUrl.trim().replace(/\/+$/, '') + '/';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal as AbortSignal,
    });

    if (!response.ok) {
      throw new Error(`Horizon root endpoint returned HTTP ${response.status}`);
    }

    return (await response.json()) as HorizonRootResponse;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Horizon root endpoint timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check whether a Horizon node is serving sufficiently fresh data.
 *
 * Returns a FreshnessCheckResult describing the outcome without throwing —
 * callers decide how to surface the result (warn vs. fail).
 */
export async function checkLedgerFreshness(
  horizonUrl: string,
  options: FreshnessOptions = {},
): Promise<FreshnessCheckResult> {
  const maxLagSeconds = options.maxLagSeconds ?? DEFAULT_MAX_LAG_SECONDS;

  let root: HorizonRootResponse;
  try {
    root = await fetchHorizonRoot(horizonUrl, {
      timeoutMs: options.timeoutMs,
      fetchFn: options.fetchFn,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    logger.debug('Ledger freshness check: failed to fetch Horizon root', {
      component: 'freshness',
      horizonUrl,
      error: message,
    });
    globalMetrics.recordMetric('freshness_check_failed', 1, 'count');
    globalMetrics.incrementCounter('freshness_check_failed');
    return {
      fresh: true, // fail-open: unknown is not treated as stale
      lagSeconds: null,
      latestLedger: null,
      message: `Could not fetch Horizon root for freshness check: ${message}. Proceeding (fail-open).`,
      status: 'unknown',
    };
  }

  const latestLedger = root.history_latest_ledger ?? null;
  const closedAtRaw = root.history_latest_ledger_closed_at;

  if (!closedAtRaw) {
    logger.debug('Ledger freshness check: history_latest_ledger_closed_at missing from root', {
      component: 'freshness',
      horizonUrl,
      latestLedger,
    });
    globalMetrics.recordMetric('freshness_check_unknown', 1, 'count');
    return {
      fresh: true,
      lagSeconds: null,
      latestLedger,
      message: 'Horizon root did not include history_latest_ledger_closed_at; freshness unknown. Proceeding (fail-open).',
      status: 'unknown',
    };
  }

  const closedAtMs = Date.parse(closedAtRaw);
  if (Number.isNaN(closedAtMs)) {
    logger.debug('Ledger freshness check: could not parse history_latest_ledger_closed_at', {
      component: 'freshness',
      horizonUrl,
      latestLedger,
    });
    globalMetrics.recordMetric('freshness_check_unknown', 1, 'count');
    return {
      fresh: true,
      lagSeconds: null,
      latestLedger,
      message: `Horizon root history_latest_ledger_closed_at ("${closedAtRaw}") could not be parsed; freshness unknown. Proceeding (fail-open).`,
      status: 'unknown',
    };
  }

  const lagSeconds = Math.max(0, (Date.now() - closedAtMs) / 1000);

  globalMetrics.recordMetric('freshness_lag_seconds', lagSeconds, 'seconds');
  if (latestLedger !== null) {
    globalMetrics.recordMetric('freshness_latest_ledger', latestLedger, 'ledger');
  }

  logger.debug('Ledger freshness check result', {
    component: 'freshness',
    horizonUrl,
    latestLedger,
    lagSeconds,
    maxLagSeconds,
    stale: lagSeconds > maxLagSeconds,
  });

  if (lagSeconds > maxLagSeconds) {
    globalMetrics.incrementCounter('freshness_stale_count');
    return {
      fresh: false,
      lagSeconds,
      latestLedger,
      message: `Horizon appears stale: latest ledger was closed ${lagSeconds.toFixed(1)}s ago (threshold: ${maxLagSeconds}s). ` +
        `Latest ledger sequence: ${latestLedger ?? 'unknown'}. ` +
        `This may indicate a lagging Horizon node. Results may not reflect the current network state.`,
      status: 'stale',
    };
  }

  globalMetrics.incrementCounter('freshness_ok_count');
  return {
    fresh: true,
    lagSeconds,
    latestLedger,
    message: `Horizon is fresh: latest ledger closed ${lagSeconds.toFixed(1)}s ago (threshold: ${maxLagSeconds}s, ledger #${latestLedger ?? 'unknown'}).`,
    status: 'ok',
  };
}

// ---------------------------------------------------------------------------
// Cached-payload TTL helpers (Issue #759)
// ---------------------------------------------------------------------------

/** Cache-write stamp for a Horizon account payload. */
export interface FreshnessStamp {
  /** Epoch milliseconds when the payload was cached. */
  cachedAt: number;
  /** Time-to-live in milliseconds. */
  ttlMs: number;
}

function stampAgeMs(stamp: FreshnessStamp, nowMs: number): number | null {
  if (!stamp || !Number.isFinite(stamp.cachedAt) || !Number.isFinite(stamp.ttlMs) || stamp.ttlMs < 0) {
    return null;
  }
  const age = nowMs - stamp.cachedAt;
  // Backward clock skew must never read as "fresh forever".
  if (!Number.isFinite(age) || age < 0) {
    return null;
  }
  return age;
}

/**
 * True when a cached payload is still within its TTL.
 * Boundary-exact (`age === ttlMs`), expired, skewed and malformed stamps
 * are all stale so Wave rechecks always refetch instead of trusting them.
 */
export function isFresh(stamp: FreshnessStamp, nowMs: number): boolean {
  const age = stampAgeMs(stamp, nowMs);
  return age !== null && age < stamp.ttlMs;
}

/**
 * Milliseconds of TTL remaining, clamped to zero for stale, skewed or
 * malformed stamps.
 */
export function freshnessRemainingMs(stamp: FreshnessStamp, nowMs: number): number {
  const age = stampAgeMs(stamp, nowMs);
  if (age === null) {
    return 0;
  }
  return Math.max(0, stamp.ttlMs - age);
}
