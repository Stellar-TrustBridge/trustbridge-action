/**
 * Simple in-memory cache for Horizon API responses.
 * Useful for reducing redundant calls within a single GitHub Actions job.
 */
export declare class SimpleCache {
    private store;
    /**
     * Get a cached value if it exists and hasn't expired.
     */
    get<T>(key: string): T | null;
    /**
     * Set a value in the cache with an expiration time.
     * @param key Cache key
     * @param data Data to cache
     * @param ttlMs Time to live in milliseconds (default: 60 seconds)
     */
    set<T>(key: string, data: T, ttlMs?: number): void;
    /**
     * Clear all cached entries.
     */
    clear(): void;
    /**
     * Get cache statistics for debugging.
     */
    getStats(): {
        size: number;
        entries: string[];
    };
}
export declare const defaultCache: SimpleCache;
