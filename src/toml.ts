/**
 * @file toml.ts
 * SEP-0001 stellar.toml fetch and caching with optional integrity validation.
 *
 * Responsibilities:
 *  - Fetch stellar.toml from https://{home_domain}/.well-known/stellar.toml
 *  - Cache fetches with configurable TTL to prevent hammering origins
 *  - Optional hash-pin validation for integrity checks (prevent poisoning)
 *  - SSRF protection (via fetchSSRFSafe)
 *  - Per-domain cache isolation (prevent cross-domain cache reuse)
 *
 * Privacy & Security:
 *  - Cache keys include domain (prevents cache poisoning across domains)
 *  - Body size capped at 256 KB before hash validation
 *  - Hash mismatch is a hard failure (compromised TOML blocks the check)
 *  - No credentials or auth headers in fetch
 */

import * as crypto from 'crypto';
import { fetchSSRFSafe } from './ssrf';
import { defaultCache } from './cache';
import { logger } from './logger';

/**
 * Hash pin format: "algorithm:hexvalue"
 * Examples:
 *  - "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
 *  - "sha512:cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e"
 */
export type HashPin = string;

/**
 * Parsed hash pin (algorithm + expected hash value).
 */
export interface ParsedHashPin {
  algorithm: 'sha256' | 'sha512';
  expectedHex: string;
}

/**
 * Result of a stellar.toml fetch attempt.
 */
export interface TomlFetchResult {
  ok: true;
  content: string;
  hash?: string;
  cachedAt: number;
  fetched: boolean; // true if fetched fresh; false if from cache
}

export interface TomlFetchError {
  ok: false;
  error: string;
  cachedAt: number;
}

export type TomlFetchOutcome = TomlFetchResult | TomlFetchError;

/**
 * Parse a hash pin string into algorithm + expected value.
 *
 * @param pin Format: "algorithm:hexvalue" (e.g. "sha256:abc123...")
 * @returns Parsed pin or undefined if format is invalid
 */
export function parseHashPin(pin: string): ParsedHashPin | undefined {
  if (!pin || typeof pin !== 'string') {
    return undefined;
  }

  const trimmed = pin.trim();
  const parts = trimmed.split(':');

  if (parts.length !== 2) {
    return undefined;
  }

  const [algorithm, expectedHex] = parts;
  const normalized = algorithm.toLowerCase();

  if (normalized !== 'sha256' && normalized !== 'sha512') {
    return undefined;
  }

  // Validate that expectedHex is a valid hex string
  if (!/^[0-9a-fA-F]+$/.test(expectedHex)) {
    return undefined;
  }

  // For SHA256: 64 hex chars (32 bytes)
  // For SHA512: 128 hex chars (64 bytes)
  const expectedLen = normalized === 'sha256' ? 64 : 128;
  if (expectedHex.length !== expectedLen) {
    return undefined;
  }

  return {
    algorithm: normalized as 'sha256' | 'sha512',
    expectedHex: expectedHex.toLowerCase(),
  };
}

/**
 * Compute the hash of a string using the specified algorithm.
 *
 * @param content The content to hash
 * @param algorithm 'sha256' or 'sha512'
 * @returns Hex-encoded hash
 */
export function computeHash(content: string, algorithm: 'sha256' | 'sha512'): string {
  const hash = crypto.createHash(algorithm);
  hash.update(content, 'utf8');
  return hash.digest('hex');
}

/**
 * Validate content against an optional hash pin.
 *
 * @param content The TOML content to validate
 * @param pin Optional hash pin (format: "algorithm:hexvalue")
 * @returns { valid: true, hash } on success, or { valid: false, error } on mismatch/error
 */
export function validateTomlHash(
  content: string,
  pin: string | undefined,
): { valid: true; hash: string } | { valid: false; error: string } {
  if (!pin) {
    // No pin provided — content is always valid
    return { valid: true, hash: '' };
  }

  const parsed = parseHashPin(pin);
  if (!parsed) {
    return {
      valid: false,
      error: `Invalid hash pin format. Expected "algorithm:hexvalue" (e.g. "sha256:abc123...")`,
    };
  }

  const computed = computeHash(content, parsed.algorithm);
  if (computed !== parsed.expectedHex) {
    return {
      valid: false,
      error: `TOML hash mismatch: got ${computed}, expected ${parsed.expectedHex}`,
    };
  }

  return { valid: true, hash: computed };
}

/**
 * Build a cache key for a TOML fetch, ensuring per-domain isolation.
 *
 * @param domain The home_domain (e.g. "centre.io")
 * @returns Cache key (e.g. "toml:centre.io")
 */
export function buildTomlCacheKey(domain: string): string {
  const normalized = domain.trim().toLowerCase();
  return `toml:${normalized}`;
}

/**
 * Cached TOML content + metadata.
 */
interface CachedTomlEntry {
  content: string;
  fetchedAt: number;
  hash?: string;
}

/**
 * Fetch stellar.toml for a home_domain with optional caching and hash validation.
 *
 * Process:
 *  1. Check in-memory cache (within TTL)
 *  2. If cache miss or expired, fetch https://{domain}/.well-known/stellar.toml
 *  3. Validate hash (if pin provided)
 *  4. Cache on success
 *  5. Return result
 *
 * @param domain The issuer's home_domain (e.g. "centre.io")
 * @param options Configuration options
 * @returns TomlFetchResult (success) or TomlFetchError (failure)
 */
export async function fetchTomlWithCache(
  domain: string,
  options: {
    cacheTtlMs?: number; // Default: 3600000 (1 hour)
    hashPin?: string; // Optional integrity pin
    maxBodyBytes?: number; // Default: 256 KB (handled by fetchSSRFSafe)
  } = {},
): Promise<TomlFetchOutcome> {
  const startTime = Date.now();
  const cacheTtlMs = options.cacheTtlMs ?? 3600000; // 1 hour
  const domainNorm = domain.trim().toLowerCase();

  if (!domainNorm) {
    return {
      ok: false,
      error: 'Domain is empty',
      cachedAt: startTime,
    };
  }

  const cacheKey = buildTomlCacheKey(domainNorm);

  // Check cache first
  const cached = defaultCache.get<CachedTomlEntry>(cacheKey);
  if (cached) {
    const age = Date.now() - cached.fetchedAt;
    if (age < cacheTtlMs) {
      logger.debug(`TOML cache hit for domain ${domainNorm} (age: ${age}ms)`, {
        component: 'toml',
        domain: domainNorm,
        cacheAge: age,
      });

      // If hash pin is provided, revalidate cached content
      if (options.hashPin) {
        const validation = validateTomlHash(cached.content, options.hashPin);
        if (!validation.valid) {
          logger.warn(`TOML hash mismatch on cached entry: ${validation.error}`, {
            component: 'toml',
            domain: domainNorm,
          });
          return {
            ok: false,
            error: validation.error,
            cachedAt: cached.fetchedAt,
          };
        }
      }

      return {
        ok: true,
        content: cached.content,
        hash: cached.hash,
        cachedAt: cached.fetchedAt,
        fetched: false,
      };
    }

    logger.debug(`TOML cache expired for domain ${domainNorm} (age: ${age}ms)`, {
      component: 'toml',
      domain: domainNorm,
      cacheAge: age,
    });
  }

  // Cache miss or expired — fetch fresh
  const tomlUrl = `https://${domainNorm}/.well-known/stellar.toml`;

  logger.debug(`Fetching stellar.toml from ${tomlUrl}`, {
    component: 'toml',
    domain: domainNorm,
  });

  const fetchResult = await fetchSSRFSafe(tomlUrl, {
    maxBodyBytes: options.maxBodyBytes ?? 256 * 1024, // 256 KB
    timeoutMs: 10000,
    followRedirects: false,
  });

  if (!fetchResult.ok) {
    logger.warn(`Failed to fetch stellar.toml from ${domainNorm}: ${fetchResult.error}`, {
      component: 'toml',
      domain: domainNorm,
      error: fetchResult.error,
      status: fetchResult.status,
    });

    return {
      ok: false,
      error: fetchResult.error,
      cachedAt: startTime,
    };
  }

  const content = await fetchResult.text();

  // Validate hash if pin provided
  if (options.hashPin) {
    const validation = validateTomlHash(content, options.hashPin);
    if (!validation.valid) {
      logger.warn(
        `TOML hash validation failed for ${domainNorm}: ${validation.error}`,
        {
          component: 'toml',
          domain: domainNorm,
          error: validation.error,
        },
      );

      return {
        ok: false,
        error: validation.error,
        cachedAt: startTime,
      };
    }

    // Hash is valid; cache it
    defaultCache.set<CachedTomlEntry>(
      cacheKey,
      {
        content,
        fetchedAt: startTime,
        hash: validation.hash,
      },
      cacheTtlMs,
    );

    return {
      ok: true,
      content,
      hash: validation.hash,
      cachedAt: startTime,
      fetched: true,
    };
  }

  // No hash pin; compute hash for diagnostics but don't validate
  const diagnosticHash = computeHash(content, 'sha256');

  // Cache the content
  defaultCache.set<CachedTomlEntry>(
    cacheKey,
    {
      content,
      fetchedAt: startTime,
      hash: diagnosticHash,
    },
    cacheTtlMs,
  );

  logger.debug(`Successfully fetched and cached stellar.toml for ${domainNorm}`, {
    component: 'toml',
    domain: domainNorm,
    sha256: diagnosticHash,
  });

  return {
    ok: true,
    content,
    hash: diagnosticHash,
    cachedAt: startTime,
    fetched: true,
  };
}
