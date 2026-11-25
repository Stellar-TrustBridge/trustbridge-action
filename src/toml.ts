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

// ---------------------------------------------------------------------------
// Issue #914 — cache keys carry the request URL and the redirect-final host
// ---------------------------------------------------------------------------

/** Build the canonical SEP-0001 stellar.toml URL for `domain`. */
export function buildStellarTomlUrl(domain: string): string {
  return `https://${domain.trim().toLowerCase()}/.well-known/stellar.toml`;
}

/**
 * Normalize a stellar.toml request target. A bare domain is expanded to its
 * canonical `/.well-known/stellar.toml` URL; a full URL is parsed so the
 * scheme and host are lower-cased (the path is kept verbatim).
 *
 * @throws When `target` is empty or is not a parseable URL.
 */
export function normalizeTomlRequestUrl(target: string): string {
  const trimmed = typeof target === 'string' ? target.trim() : '';
  if (!trimmed) {
    throw new Error('toml: cache key target must be a non-empty domain or URL');
  }
  const candidate = trimmed.includes('://') ? trimmed : buildStellarTomlUrl(trimmed);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`toml: cache key target is not a valid URL: ${trimmed}`);
  }
  return parsed.toString();
}

/** Lower-cased hostname of `url`, or `''` when it cannot be parsed. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Build the cache key for a stellar.toml document (Issue #914).
 *
 * The key always includes both the normalized request URL **and** the host
 * that actually served the document after redirects (`finalHost`). Two
 * fetches of the same URL that resolve to different hosts therefore never
 * share an entry, so a redirect remap can never serve a document that was
 * cached for another host (which would turn into a false home_domain pass
 * or fail).
 *
 * @param target    A bare domain (`example.com`) or a full stellar.toml URL.
 * @param finalHost Host that served the response after redirects. Defaults
 *                  to the request URL's own host (no redirect).
 */
export function buildTomlCacheKey(target: string, finalHost?: string): string {
  const requestUrl = normalizeTomlRequestUrl(target);
  const resolvedHost = (finalHost ?? '').trim().toLowerCase() || hostOf(requestUrl);
  return `toml:${requestUrl}|final:${resolvedHost}`;
}

/**
 * Key of the alias entry that remembers which final host last served
 * `target` (Issue #914). Lookups read the alias first so they can build the
 * full {@link buildTomlCacheKey} before the network is touched.
 */
export function buildTomlFinalHostAliasKey(target: string): string {
  return `toml-final-host:${normalizeTomlRequestUrl(target)}`;
}

interface CachedTomlEntry {
  content: string;
  fetchedAt: number;
  hash?: string;
  /** Normalized request URL the entry was fetched for (Issue #914). */
  requestUrl?: string;
  /** Host that served the body after redirects (Issue #914). */
  finalHost?: string;
}

interface CachedTomlFinalHostAlias {
  finalHost: string;
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
 * - Cache entries are keyed on the request URL **and** the redirect-final
 *   host (Issue #914, {@link buildTomlCacheKey}); a remap to another host
 *   evicts the old entry instead of serving it.
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

  let requestUrl: string;
  try {
    requestUrl = normalizeTomlRequestUrl(domainNorm);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), cachedAt: startTime };
  }
  const requestHost = hostOf(requestUrl);
  const aliasKey = buildTomlFinalHostAliasKey(requestUrl);

  // Issue #914: resolve the host that last served this URL, then read the
  // entry keyed on both. An entry whose recorded URL/host do not match the
  // key it was read from is never served.
  const alias = cacheTtlMs > 0 ? defaultCache.get<CachedTomlFinalHostAlias>(aliasKey) : null;
  const knownFinalHost = alias?.finalHost || requestHost;
  const cacheKey = buildTomlCacheKey(requestUrl, knownFinalHost);
  const cached = cacheTtlMs > 0 ? defaultCache.get<CachedTomlEntry>(cacheKey) : null;
  if (cached) {
    const age = startTime - cached.fetchedAt;
    const fresh = age >= 0 && age < cacheTtlMs;
    const pinOk = !options.hashPin || validateTomlHash(cached.content, options.hashPin).valid;
    const keyOk =
      (cached.requestUrl === undefined || cached.requestUrl === requestUrl) &&
      (cached.finalHost === undefined || cached.finalHost === knownFinalHost);
    if (fresh && pinOk && keyOk) {
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

  const fetchResult = await fetchSSRFSafe(requestUrl, {
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
    // Issue #914: key the body on the host that actually served it. When a
    // redirect remaps the URL to a different host, the entry cached for the
    // previous host is evicted so it can never be served for this URL again.
    const finalHost = hostOf(fetchResult.url ?? requestUrl) || requestHost;
    if (alias?.finalHost && alias.finalHost !== finalHost) {
      defaultCache.delete(buildTomlCacheKey(requestUrl, alias.finalHost));
      logger.warn(`stellar.toml for ${domainNorm} now resolves to a different final host; cache entry re-keyed`, {
        component: 'toml',
        domain: domainNorm,
        previousFinalHost: alias.finalHost,
        finalHost,
      });
    }
    defaultCache.set<CachedTomlEntry>(
      buildTomlCacheKey(requestUrl, finalHost),
      { content, fetchedAt: startTime, hash, requestUrl, finalHost },
      cacheTtlMs,
    );
    defaultCache.set<CachedTomlFinalHostAlias>(aliasKey, { finalHost }, cacheTtlMs);
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
