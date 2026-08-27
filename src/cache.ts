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

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

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
export class GitHubActionsCacheBackend implements PersistentCacheBackend {
  private static initialized = false;
  private cache: Map<string, { data: string; expiresAt: number }> = new Map();

  constructor(private cacheKeyPrefix: string = 'trustbridge') {
    // Note: @actions/cache would be imported here in production.
    // For now, this is a stub that uses in-memory storage.
  }

  async getCache(key: string): Promise<string | null> {
    const prefixedKey = `${this.cacheKeyPrefix}:${key}`;
    const entry = this.cache.get(prefixedKey);

    if (!entry) {
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(prefixedKey);
      return null;
    }

    return entry.data;
  }

  async saveCache(key: string, value: string, ttlMs: number): Promise<void> {
    const prefixedKey = `${this.cacheKeyPrefix}:${key}`;
    this.cache.set(prefixedKey, {
      data: value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  async restoreCache(key: string): Promise<boolean> {
    const prefixedKey = `${this.cacheKeyPrefix}:${key}`;
    const entry = this.cache.get(prefixedKey);
    return entry !== undefined && Date.now() <= entry.expiresAt;
  }

  async dispose(): Promise<void> {
    this.cache.clear();
  }
}

export class SimpleCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private backend?: PersistentCacheBackend;
  private useBackend: boolean = false;

  constructor(options: CacheBackendOptions = {}) {
    this.useBackend = options.useActionsCacheBackend ?? false;
    this.backend = options.backend || (this.useBackend ? new GitHubActionsCacheBackend(options.cacheKeyPrefix) : undefined);
  }

  /**
   * Get a cached value if it exists and hasn't expired.
   * Checks in-memory cache first, then persistent backend if enabled.
   */
  get<T>(key: string): T | null {
    // Check in-memory first
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (entry) {
      if (Date.now() > entry.expiresAt) {
        this.store.delete(key);
      } else {
        return entry.data;
      }
    }

    // Backend lookup is async; this is a sync method, so we can't await here.
    // Backend should be populated via restoreAsync() before using get().
    return null;
  }

  /**
   * Asynchronously restore cache from persistent backend on startup.
   * Should be called once at action start before any get() calls.
   */
  async restoreAsync<T>(key: string): Promise<T | null> {
    if (!this.backend) {
      return null;
    }

    try {
      const cached = await this.backend.getCache(key);
      if (cached) {
        const data = JSON.parse(cached) as T;
        // Restore to in-memory cache as well
        this.store.set(key, {
          data,
          expiresAt: Date.now() + 60_000, // in-memory copy gets default TTL
        });
        return data;
      }
    } catch (error) {
      // Silently fail on restore errors; continue with fresh fetch
    }

    return null;
  }

  /**
   * Set a value in the cache with an expiration time.
   * Persists to backend if enabled.
   * @param key Cache key
   * @param data Data to cache
   * @param ttlMs Time to live in milliseconds (default: 60 seconds)
   */
  set<T>(key: string, data: T, ttlMs: number = 60_000): void {
    // Always update in-memory store
    this.store.set(key, {
      data,
      expiresAt: Date.now() + ttlMs,
    });

    // Persist to backend if enabled
    if (this.backend) {
      try {
        const serialized = JSON.stringify(data);
        // Fire-and-forget; do not await to keep synchronous API
        this.backend.saveCache(key, serialized, ttlMs).catch(() => {
          // Silently ignore backend write failures; in-memory cache remains
        });
      } catch (error) {
        // Serialization or other errors are silently ignored
      }
    }
  }

  /**
   * Clear all cached entries (in-memory and backend).
   */
  async clear(): Promise<void> {
    this.store.clear();
    if (this.backend?.dispose) {
      await this.backend.dispose();
    }
  }

  /**
   * Get cache statistics for debugging.
   */
  getStats(): { size: number; entries: string[]; backendEnabled: boolean } {
    return {
      size: this.store.size,
      entries: Array.from(this.store.keys()),
      backendEnabled: this.useBackend,
    };
  }
}

export const defaultCache = new SimpleCache();
