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

import * as core from '@actions/core';
import * as actionsCache from '@actions/cache';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { logger } from './logger';

/** Supported named backend identifiers for `CacheBackendOptions.selectedBackend`. */
const SUPPORTED_NAMED_BACKENDS = new Set<string>(['memory', 'github-actions']);

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

  /**
   * Named backend selector. Supported values: `"github-actions"` (persists via
   * GitHub Actions cache API) and `"memory"` (in-memory only, default).
   *
   * Any other value is **not supported** and will be ignored with a warning.
   * The cache will fall back to in-memory-only mode so the workflow does not
   * break, but the selected backend will not be active.
   *
   * @example
   * ```ts
   * new SimpleCache({ selectedBackend: 'github-actions' })
   * ```
   */
  selectedBackend?: string;
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
 * Uses the @actions/cache module to store and retrieve check-result data in the
 * GitHub Actions cache backend across matrix jobs and workflow runs.
 */
export class GitHubActionsCacheBackend implements PersistentCacheBackend {
  private cacheDir: string;
  private memCache: Map<string, { data: string; expiresAt: number }> = new Map();

  constructor(private cacheKeyPrefix: string = 'trustbridge') {
    this.cacheDir = path.join(os.tmpdir(), 'trustbridge-actions-cache');
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
    } catch {
      // Ignore directory creation failure (will use memory cache)
    }
  }

  private hashKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
  }

  private getFilePath(key: string): string {
    return path.join(this.cacheDir, `${this.hashKey(key)}.json`);
  }

  private getActionsCacheKey(key: string): string {
    return `${this.cacheKeyPrefix}-check-${this.hashKey(key)}`;
  }

  async getCache(key: string): Promise<string | null> {
    const mem = this.memCache.get(key);
    if (mem) {
      if (Date.now() > mem.expiresAt) {
        this.memCache.delete(key);
        return null;
      }
      return mem.data;
    }

    const filePath = this.getFilePath(key);
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw) as { data: string; expiresAt: number };
        if (Date.now() <= parsed.expiresAt) {
          this.memCache.set(key, parsed);
          return parsed.data;
        } else {
          try {
            fs.unlinkSync(filePath);
          } catch {}
          return null;
        }
      } catch {
        // Fall through to Actions cache restore on corrupted file
      }
    }

    try {
      if (
        actionsCache &&
        typeof actionsCache.isFeatureAvailable === 'function' &&
        actionsCache.isFeatureAvailable()
      ) {
        const actionsKey = this.getActionsCacheKey(key);
        const hitKey = await actionsCache.restoreCache([filePath], actionsKey);
        if (hitKey && fs.existsSync(filePath)) {
          const raw = fs.readFileSync(filePath, 'utf8');
          const parsed = JSON.parse(raw) as { data: string; expiresAt: number };
          if (Date.now() <= parsed.expiresAt) {
            this.memCache.set(key, parsed);
            return parsed.data;
          }
        }
      }
    } catch (err) {
      logger.debug('Failed to restore from GitHub Actions cache', {
        component: 'cache',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return null;
  }

  async saveCache(key: string, value: string, ttlMs: number): Promise<void> {
    const expiresAt = Date.now() + ttlMs;
    this.memCache.set(key, { data: value, expiresAt });

    const filePath = this.getFilePath(key);
    try {
      fs.writeFileSync(
        filePath,
        JSON.stringify({ key, data: value, expiresAt }),
        'utf8',
      );
    } catch (err) {
      logger.debug('Failed to write local cache entry file', {
        component: 'cache',
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    try {
      if (
        actionsCache &&
        typeof actionsCache.isFeatureAvailable === 'function' &&
        actionsCache.isFeatureAvailable()
      ) {
        const actionsKey = this.getActionsCacheKey(key);
        await actionsCache.saveCache([filePath], actionsKey);
      }
    } catch (err) {
      logger.debug('Failed to save to GitHub Actions cache backend', {
        component: 'cache',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async restoreCache(key: string): Promise<boolean> {
    const val = await this.getCache(key);
    return val !== null;
  }

  async dispose(): Promise<void> {
    this.memCache.clear();
    try {
      if (fs.existsSync(this.cacheDir)) {
        fs.rmSync(this.cacheDir, { recursive: true, force: true });
      }
    } catch {}
  }
}

export class SimpleCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private backend?: PersistentCacheBackend;
  private useBackend: boolean = false;

  constructor(options: CacheBackendOptions = {}) {
    // Warn when an unsupported named backend is requested so operators learn
    // immediately instead of silently getting in-memory-only behaviour.
    // Issue #462: unsupported backend values must not fail the workflow, but
    // they must emit a clear warning so the misconfiguration is visible.
    if (options.selectedBackend !== undefined && options.selectedBackend !== '') {
      if (!SUPPORTED_NAMED_BACKENDS.has(options.selectedBackend)) {
        try {
          core.warning(
            `[TrustBridge] cache: unsupported backend "${options.selectedBackend}" ` +
              `was requested but is not recognised. ` +
              `Supported values: ${[...SUPPORTED_NAMED_BACKENDS].map((b) => `"${b}"`).join(', ')}. ` +
              `Falling back to in-memory cache. ` +
              `Set selectedBackend to "github-actions" to enable GitHub Actions cache persistence, ` +
              `or omit the option to use the default in-memory backend.`,
          );
        } catch {
          // core.warning may throw outside GitHub Actions context (local dev / tests).
          // Swallow so the cache is still usable.
        }
      }
      // When selectedBackend is 'github-actions', honour it by treating it as
      // equivalent to useActionsCacheBackend: true (unless a backend was already
      // explicitly provided).
      if (options.selectedBackend === 'github-actions' && !options.backend) {
        options = { ...options, useActionsCacheBackend: true };
      }
    }
    this.useBackend = options.useActionsCacheBackend ?? false;
    this.backend = options.backend || (this.useBackend ? new GitHubActionsCacheBackend(options.cacheKeyPrefix) : undefined);
  }

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
   * Remove all cached entries from the in-memory store and, if a persistent
   * backend is configured, call its `dispose` lifecycle hook.
   *
   * This is a full reset — all keys, regardless of their remaining TTL, are
   * discarded.  Useful in tests to guarantee a clean slate between cases.
   */
  async clear(): Promise<void> {
    this.store.clear();
    if (this.backend?.dispose) {
      await this.backend.dispose();
    }
  }

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
  getStats(): { size: number; entries: string[]; backendEnabled?: boolean } {
    const stats: { size: number; entries: string[]; backendEnabled?: boolean } = {
      size: this.store.size,
      entries: Array.from(this.store.keys()),
    };
    if (this.useBackend) {
      stats.backendEnabled = true;
    }
    return stats;
  }
}

export const defaultCache = new SimpleCache();
