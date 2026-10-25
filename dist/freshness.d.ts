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
/**
 * Fetch the Horizon root endpoint and return the raw response object.
 * Throws a typed error on network failure or non-2xx status.
 */
export declare function fetchHorizonRoot(horizonUrl: string, options?: {
    timeoutMs?: number;
    fetchFn?: FreshnessOptions['fetchFn'];
}): Promise<HorizonRootResponse>;
/**
 * Check whether a Horizon node is serving sufficiently fresh data.
 *
 * Returns a FreshnessCheckResult describing the outcome without throwing —
 * callers decide how to surface the result (warn vs. fail).
 */
export declare function checkLedgerFreshness(horizonUrl: string, options?: FreshnessOptions): Promise<FreshnessCheckResult>;
/** Cache-write stamp for a Horizon account payload. */
export interface FreshnessStamp {
    /** Epoch milliseconds when the payload was cached. */
    cachedAt: number;
    /** Time-to-live in milliseconds. */
    ttlMs: number;
}
/**
 * True when a cached payload is still within its TTL.
 * Boundary-exact (`age === ttlMs`), expired, skewed and malformed stamps
 * are all stale so Wave rechecks always refetch instead of trusting them.
 */
export declare function isFresh(stamp: FreshnessStamp, nowMs: number): boolean;
/**
 * Milliseconds of TTL remaining, clamped to zero for stale, skewed or
 * malformed stamps.
 */
export declare function freshnessRemainingMs(stamp: FreshnessStamp, nowMs: number): number;
