import * as crypto from 'crypto';
import { fetchSSRFSafe, SSRFFetchOptions } from './ssrf';
import { defaultCache } from './cache';
import { logger } from './logger';
import { escapeMarkdownInline } from './markdown';

export type HashPin = string;

export interface ParsedHashPin {
  algorithm: 'sha256' | 'sha512';
  expectedHex: string;
}

export interface TomlFetchResult {
  ok: true;
  content: string;
  hash?: string;
  cachedAt: number;
  fetched: boolean;
}

export interface TomlFetchError {
  ok: false;
  error: string;
  cachedAt: number;
}

export type TomlFetchOutcome = TomlFetchResult | TomlFetchError;

export function parseHashPin(pin: string): ParsedHashPin | undefined {
  if (!pin || typeof pin !== 'string') return undefined;
  const parts = pin.trim().split(':');
  if (parts.length !== 2) return undefined;
  const [algorithm, expectedHex] = parts;
  const normalized = algorithm.toLowerCase();
  if (normalized !== 'sha256' && normalized !== 'sha512') return undefined;
  const expectedLen = normalized === 'sha256' ? 64 : 128;
  if (!new RegExp(`^[0-9a-fA-F]{${expectedLen}}$`).test(expectedHex)) return undefined;
  return { algorithm: normalized, expectedHex: expectedHex.toLowerCase() };
}

export function computeHash(content: string, algorithm: 'sha256' | 'sha512'): string {
  return crypto.createHash(algorithm).update(content, 'utf8').digest('hex');
}

export function validateTomlHash(
  content: string,
  pin: string | undefined,
): { valid: true; hash: string } | { valid: false; error: string } {
  if (!pin) return { valid: true, hash: '' };
  const parsed = parseHashPin(pin);
  if (!parsed) return { valid: false, error: 'Invalid hash pin format.' };
  const computed = computeHash(content, parsed.algorithm);
  return computed === parsed.expectedHex
    ? { valid: true, hash: computed }
    : { valid: false, error: `TOML hash mismatch: got ${computed}, expected ${parsed.expectedHex}` };
}

export function buildTomlCacheKey(domain: string): string {
  return `toml:${domain.trim().toLowerCase()}`;
}

interface CachedTomlEntry {
  content: string;
  fetchedAt: number;
  hash?: string;
}

/** Default stellar.toml cache TTL (1 hour), mirrors action.yml. */
export const DEFAULT_STELLAR_TOML_CACHE_TTL_MS = 3_600_000;

/**
 * Upper bound on the stellar.toml cache TTL (24 hours). Larger values are
 * clamped so a typo cannot keep a poisoned entry alive indefinitely.
 */
export const MAX_STELLAR_TOML_CACHE_TTL_MS = 86_400_000;

/**
 * Hard ceiling on a stellar.toml body (256 KB). `maxBodyBytes` may lower the
 * cap but can never raise it, so a misconfiguration cannot turn the fetch
 * into an unbounded download.
 */
export const MAX_STELLAR_TOML_BYTES = 256 * 1024;

/**
 * Media types accepted for a stellar.toml response. Parameters such as
 * `; charset=utf-8` are ignored. A response without a Content-Type header is
 * accepted (many static hosts omit it); any other declared type fails closed.
 */
export const STELLAR_TOML_ALLOWED_CONTENT_TYPES: readonly string[] = [
  'application/toml',
  'application/x-toml',
  'text/toml',
  'text/x-toml',
  'text/plain',
];

/** stellar.toml fetches never follow redirects (SEP-0001 requires the canonical URL). */
export const STELLAR_TOML_MAX_REDIRECTS = 0;

/** Returns true when `contentType` is absent or on the stellar.toml allowlist. */
export function isAllowedTomlContentType(contentType: string | null | undefined): boolean {
  if (contentType === null || contentType === undefined || contentType.trim() === '') return true;
  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  return STELLAR_TOML_ALLOWED_CONTENT_TYPES.includes(mediaType);
}

function clampTomlMaxBytes(bytes: number | undefined): number {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return MAX_STELLAR_TOML_BYTES;
  return Math.min(Math.floor(bytes), MAX_STELLAR_TOML_BYTES);
}

export interface TomlFetchOptions {
  /** Cache TTL in milliseconds (`stellar_toml_cache_ttl_ms`). 0 disables caching. */
  cacheTtlMs?: number;
  /** `algorithm:hex` integrity pin (`stellar_toml_hash_pin`). */
  hashPin?: string;
  /** Download cap passed to the SSRF-guarded fetch. Default and maximum 256 KB. */
  maxBodyBytes?: number;
  /** Resolver for the DNS-rebinding guard (injectable for tests). */
  dnsLookup?: SSRFFetchOptions['dnsLookup'];
}

function clampTomlTtl(ttl: number | undefined): number {
  if (ttl === undefined || !Number.isFinite(ttl)) return DEFAULT_STELLAR_TOML_CACHE_TTL_MS;
  return Math.min(Math.max(0, Math.floor(ttl)), MAX_STELLAR_TOML_CACHE_TTL_MS);
}

/**
 * Fetch `https://{domain}/.well-known/stellar.toml` through the shared SSRF
 * gate, with TTL caching and optional hash pinning.
 *
 * - Cache hits are only served while `now - fetchedAt` is within the TTL.
 *   Entries dated in the future (clock skew) are treated as expired, so a
 *   skewed clock can never extend the TTL.
 * - A pinned hash is verified on every read, including cache hits. A cached
 *   body that no longer matches the pin (e.g. after pin rotation) is evicted
 *   and re-fetched; a fetched body that does not match fails closed and is
 *   never cached.
 * - Redirects are refused (`followRedirects: false`, `maxRedirects: 0`), so
 *   a 3xx to another host can never bypass the SSRF policy.
 * - The body is capped at `MAX_STELLAR_TOML_BYTES`, a declared Content-Type
 *   must be on `STELLAR_TOML_ALLOWED_CONTENT_TYPES`, and an empty body is
 *   rejected. Rejected bodies are never cached.
 */
export async function fetchTomlWithCache(
  domain: string,
  options: TomlFetchOptions = {},
): Promise<TomlFetchOutcome> {
  const startTime = Date.now();
  const cacheTtlMs = clampTomlTtl(options.cacheTtlMs);
  const domainNorm = domain.trim().toLowerCase();
  if (!domainNorm) return { ok: false, error: 'Domain is empty', cachedAt: startTime };

  if (options.hashPin && !parseHashPin(options.hashPin)) {
    return {
      ok: false,
      error: 'Invalid stellar_toml_hash_pin format. Expected "sha256:<64 hex>" or "sha512:<128 hex>".',
      cachedAt: startTime,
    };
  }

  const cacheKey = buildTomlCacheKey(domainNorm);
  const cached = cacheTtlMs > 0 ? defaultCache.get<CachedTomlEntry>(cacheKey) : null;
  if (cached) {
    const age = startTime - cached.fetchedAt;
    const fresh = age >= 0 && age < cacheTtlMs;
    const pinOk = !options.hashPin || validateTomlHash(cached.content, options.hashPin).valid;
    if (fresh && pinOk) {
      return { ok: true, content: cached.content, hash: cached.hash, cachedAt: cached.fetchedAt, fetched: false };
    }
    defaultCache.delete(cacheKey);
    if (fresh && !pinOk) {
      logger.warn(`Cached stellar.toml for ${domainNorm} no longer matches stellar_toml_hash_pin; re-fetching`, {
        component: 'toml',
        domain: domainNorm,
      });
    }
  }

  const fetchResult = await fetchSSRFSafe(`https://${domainNorm}/.well-known/stellar.toml`, {
    maxBodyBytes: clampTomlMaxBytes(options.maxBodyBytes),
    timeoutMs: 10000,
    followRedirects: false,
    maxRedirects: STELLAR_TOML_MAX_REDIRECTS,
    dnsLookup: options.dnsLookup,
  });
  if (!fetchResult.ok) {
    const error = 'error' in fetchResult ? fetchResult.error : 'Unknown TOML fetch error';
    logger.warn(`Failed to fetch stellar.toml from ${domainNorm}: ${error}`, { component: 'toml', domain: domainNorm });
    return { ok: false, error, cachedAt: startTime };
  }

  const contentType = fetchResult.headers?.get?.('content-type') ?? null;
  if (!isAllowedTomlContentType(contentType)) {
    const error = `stellar.toml from ${domainNorm} rejected: unexpected Content-Type "${contentType}"`;
    logger.warn(error, { component: 'toml', domain: domainNorm });
    return { ok: false, error, cachedAt: startTime };
  }

  const content = await fetchResult.text();
  if (content.trim() === '') {
    const error = `stellar.toml from ${domainNorm} rejected: empty body`;
    logger.warn(error, { component: 'toml', domain: domainNorm });
    return { ok: false, error, cachedAt: startTime };
  }
  const validation = validateTomlHash(content, options.hashPin);
  if (!validation.valid) {
    const error = 'error' in validation ? validation.error : 'Invalid TOML hash';
    logger.warn(`stellar.toml from ${domainNorm} failed hash pin verification`, { component: 'toml', domain: domainNorm });
    return { ok: false, error: `stellar.toml from ${domainNorm} rejected: ${error}`, cachedAt: startTime };
  }
  const hash = validation.hash || computeHash(content, 'sha256');
  if (cacheTtlMs > 0) {
    defaultCache.set<CachedTomlEntry>(cacheKey, { content, fetchedAt: startTime, hash }, cacheTtlMs);
  }
  return { ok: true, content, hash, cachedAt: startTime, fetched: true };
}

export interface StellarTomlCheckOptions extends TomlFetchOptions {
  /** `stellar_toml_fetch_enabled`. When false the network is never touched. */
  enabled: boolean;
}

export type StellarTomlCheckOutcome =
  | { status: 'skipped'; detail: string }
  | { status: 'ok'; detail: string; hash?: string; fetched: boolean }
  | { status: 'failed'; detail: string };

/**
 * Run the optional SEP-0001 stellar.toml fetch for `domain`.
 *
 * Returns `skipped` without calling the SSRF-guarded HTTP client when fetch
 * is disabled or no domain is known — the on-chain `home_domain` check is
 * evaluated independently and is unaffected.
 */
export async function runStellarTomlCheck(
  domain: string | undefined,
  options: StellarTomlCheckOptions,
): Promise<StellarTomlCheckOutcome> {
  if (!options.enabled) {
    return { status: 'skipped', detail: 'stellar.toml fetch disabled (stellar_toml_fetch_enabled: false).' };
  }
  const target = domain?.trim();
  if (!target) {
    return { status: 'skipped', detail: 'stellar.toml fetch skipped: no home domain to fetch from.' };
  }

  const result = await fetchTomlWithCache(target, options);
  if (!result.ok) {
    // Escaped: the domain may come from the on-chain home_domain and the
    // detail is rendered into the issue comment.
    return {
      status: 'failed',
      detail: escapeMarkdownInline('error' in result ? result.error : 'stellar.toml fetch failed'),
    };
  }
  return {
    status: 'ok',
    detail: options.hashPin
      ? `stellar.toml for \`${escapeMarkdownInline(target)}\` matches the pinned hash ✓`
      : `stellar.toml for \`${escapeMarkdownInline(target)}\` fetched ✓`,
    hash: result.hash,
    fetched: result.fetched,
  };
}
