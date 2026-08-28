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
     * Checks in-memory cache first, then persistent backend if enabled.
     */
    get<T>(key: string): T | null;
    /**
     * Asynchronously restore cache from persistent backend on startup.
     * Should be called once at action start before any get() calls.
     */
    restoreAsync<T>(key: string): Promise<T | null>;
    /**
     * Set a value in the cache with an expiration time.
     * Persists to backend if enabled.
     * @param key Cache key
     * @param data Data to cache
     * @param ttlMs Time to live in milliseconds (default: 60 seconds)
     */
    set<T>(key: string, data: T, ttlMs?: number): void;
    /**
     * Clear all cached entries (in-memory and backend).
     */
    clear(): Promise<void>;
    /**
     * Get cache statistics for debugging.
     */
    getStats(): {
        size: number;
        entries: string[];
        backendEnabled: boolean;
    };
}
export declare const defaultCache: SimpleCache;
