/**
 * Simple in-memory cache for Horizon API responses.
 * Useful for reducing redundant calls within a single GitHub Actions job.
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export class SimpleCache {
  private store = new Map<string, CacheEntry<unknown>>();

  /**
   * Get a cached value if it exists and hasn't expired.
   */
  get<T>(key: string): T | null {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry) {
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return entry.data;
  }

  /**
   * Set a value in the cache with an expiration time.
   * @param key Cache key
   * @param data Data to cache
   * @param ttlMs Time to live in milliseconds (default: 60 seconds)
   */
  set<T>(key: string, data: T, ttlMs: number = 60_000): void {
    this.store.set(key, {
      data,
      expiresAt: Date.now() + ttlMs,
    });
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Get cache statistics for debugging.
   */
  getStats(): { size: number; entries: string[] } {
    return {
      size: this.store.size,
      entries: Array.from(this.store.keys()),
    };
  }
}

export const defaultCache = new SimpleCache();
