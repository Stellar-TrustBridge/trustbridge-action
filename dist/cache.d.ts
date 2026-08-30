/**
 * Simple in-memory cache for Horizon API responses.
 *
 * Lifetime: this cache lives only in the Node.js process heap for a single
 * invocation of the action (one workflow step run). It is created fresh
 * every time `dist/index.js` starts and is discarded when that process
 * exits. It is never persisted to disk and never shared across:
 *   - separate steps in the same job (each `uses:` step is its own process),
 *   - separate jobs in the same workflow,
 *   - matrix legs (each matrix combination runs on its own runner/process),
 *   - concurrent or subsequent workflow runs.
 *
 * Cache keys are built in `horizon.ts` (`buildCacheKey`) from the
 * normalized Horizon base URL and the Stellar address being checked, so
 * entries for different Horizon endpoints (e.g. mainnet vs testnet in a
 * matrix build) or different accounts never collide even when a cache
 * instance is reused programmatically (e.g. in tests).
 *
 * When enabled via `useActionsCacheBackend: true`, this cache also persists
 * to GitHub Actions cache backend on save operations, allowing data to be
 * reused across matrix legs and subsequent workflow runs (subject to TTL).
 */
export interface CacheBackendOptions {
    /**
     * Enable GitHub Actions cache backend persistence (true) or in-memory only (false).
     * Default: false (backward compatible).
     */
    useActionsCacheBackend?: boolean;
    /**
     * Cache namespace prefix to avoid collisions with other actions.
     * Only used when useActionsCacheBackend is true.
     * Default: 'trustbridge'
     */
    cacheKeyPrefix?: string;
    /**
     * Optional cache backend implementation (for testing or alternative storage).
     * When provided, overrides useActionsCacheBackend.
     */
    backend?: PersistentCacheBackend;
}
/**
 * Interface for pluggable persistent cache backends (GitHub Actions cache, Redis, etc.).
 */
export interface PersistentCacheBackend {
    /**
     * Retrieve a cached value, returning null if not found or expired.
     */
    getCache(key: string): Promise<string | null>;
    /**
     * Save a value to the persistent cache.
     */
    saveCache(key: string, value: string, ttlMs: number): Promise<void>;
    /**
     * Attempt to restore cache from persistent storage on startup.
     * Returns true if cache was found and restored, false otherwise.
     */
    restoreCache?(key: string): Promise<boolean>;
    /**
     * Clean up resources when cache is disposed.
     */
    dispose?(): Promise<void>;
}
/**
 * GitHub Actions cache backend implementation.
 * Uses the @actions/cache module to store data in GitHub Actions cache backend.
 */
export declare class GitHubActionsCacheBackend implements PersistentCacheBackend {
    private cacheKeyPrefix;
    private static initialized;
    private cache;
    constructor(cacheKeyPrefix?: string);
    getCache(key: string): Promise<string | null>;
    saveCache(key: string, value: string, ttlMs: number): Promise<void>;
    restoreCache(key: string): Promise<boolean>;
    dispose(): Promise<void>;
}
export declare class SimpleCache {
    private store;
    private backend?;
    private useBackend;
    constructor(options?: CacheBackendOptions);
    /**
     * Get a cached value if it exists and hasn't expired.
     *
     * Checks the in-memory store first; entries are evicted lazily on access
     * when their TTL has elapsed.  If a persistent backend is configured, it
     * must be pre-warmed via {@link restoreAsync} because this method is
     * synchronous and cannot await a backend call.
     *
     * Cache keys are opaque strings.  In practice they are built by
     * `buildCacheKey` in `horizon.ts` using the format
     * `horizon:account:<normalizedHorizonUrl>:<stellarAddress>`, which ensures
     * that entries for different Horizon endpoints (mainnet vs testnet matrix
     * legs) and different Stellar addresses never collide even when a single
     * `SimpleCache` instance is shared across calls.
     *
     * @param key  The opaque cache key (built by `buildCacheKey` in `horizon.ts`).
     * @returns    The cached value, or `null` on a miss or after expiry.
     */
    get<T>(key: string): T | null;
    /**
     * Asynchronously restore a single cache entry from the persistent backend.
     *
     * Must be called before any {@link get} calls when using a persistent
     * backend, because {@link get} is synchronous.  If no backend is configured
     * this is a no-op and returns `null`.  Restored entries are also written to
     * the in-memory store with the default 60-second in-memory TTL so that
     * subsequent synchronous reads remain fast.
     *
     * @param key  The opaque cache key to look up in the backend.
     * @returns    The restored value, or `null` if not found, expired, or on error.
     */
    restoreAsync<T>(key: string): Promise<T | null>;
    /**
     * Store a value in the cache with an expiration time.
     *
     * The entry is written to the in-memory store immediately.  If a
     * persistent backend is configured the write is also dispatched
     * asynchronously (fire-and-forget) — backend write failures are silently
     * swallowed so they never block the caller or break the primary code path.
     *
     * **Note on key isolation.** Each `(horizonUrl, stellarAddress)` pair
     * receives its own distinct key (see `buildCacheKey` in `horizon.ts`), so
     * there is no risk of a mainnet entry overwriting a testnet entry even when
     * the same `SimpleCache` instance is reused across matrix legs.
     *
     * **Note on 404 responses.** Account-not-found (404) results are *never*
     * passed to `set` — the caller (`fetchAccount` in `horizon.ts`) skips
     * caching entirely for not-found responses so a contributor who funds their
     * account mid-job is picked up on the next request.
     *
     * @param key     Opaque cache key (built by `buildCacheKey` in `horizon.ts`).
     * @param data    The value to store.  Must be JSON-serializable when a
     *                persistent backend is configured.
     * @param ttlMs   Time to live in milliseconds.  Defaults to 60 seconds.
     */
    set<T>(key: string, data: T, ttlMs?: number): void;
    /**
     * Remove all cached entries from the in-memory store and, if a persistent
     * backend is configured, call its `dispose` lifecycle hook.
     *
     * This is a full reset — all keys, regardless of their remaining TTL, are
     * discarded.  Useful in tests to guarantee a clean slate between cases.
     */
    clear(): Promise<void>;
    /**
     * Return a snapshot of the current in-memory cache state for debugging.
     *
     * Keys in the returned `entries` array are **not** redacted here — callers
     * that log or export the stats should pass them through `redactCacheStats`
     * in `horizon.ts` before they reach any log output so that embedded
     * Stellar addresses are masked to first-4/last-4.
     *
     * @returns `{ size, entries }` — count of live entries and their raw keys.
     *          Also includes `backendEnabled: true` when a persistent backend
     *          is active.
     */
    getStats(): {
        size: number;
        entries: string[];
        backendEnabled?: boolean;
    };
}
export declare const defaultCache: SimpleCache;
