import { SSRFFetchOptions } from './ssrf';
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
export declare function parseHashPin(pin: string): ParsedHashPin | undefined;
export declare function computeHash(content: string, algorithm: 'sha256' | 'sha512'): string;
export declare function validateTomlHash(content: string, pin: string | undefined): {
    valid: true;
    hash: string;
} | {
    valid: false;
    error: string;
};
export declare function buildTomlCacheKey(domain: string): string;
/** Default stellar.toml cache TTL (1 hour), mirrors action.yml. */
export declare const DEFAULT_STELLAR_TOML_CACHE_TTL_MS = 3600000;
/**
 * Upper bound on the stellar.toml cache TTL (24 hours). Larger values are
 * clamped so a typo cannot keep a poisoned entry alive indefinitely.
 */
export declare const MAX_STELLAR_TOML_CACHE_TTL_MS = 86400000;
/**
 * Hard ceiling on a stellar.toml body (256 KB). `maxBodyBytes` may lower the
 * cap but can never raise it, so a misconfiguration cannot turn the fetch
 * into an unbounded download.
 */
export declare const MAX_STELLAR_TOML_BYTES: number;
/**
 * Media types accepted for a stellar.toml response. Parameters such as
 * `; charset=utf-8` are ignored. A response without a Content-Type header is
 * accepted (many static hosts omit it); any other declared type fails closed.
 */
export declare const STELLAR_TOML_ALLOWED_CONTENT_TYPES: readonly string[];
/** stellar.toml fetches never follow redirects (SEP-0001 requires the canonical URL). */
export declare const STELLAR_TOML_MAX_REDIRECTS = 0;
/** Returns true when `contentType` is absent or on the stellar.toml allowlist. */
export declare function isAllowedTomlContentType(contentType: string | null | undefined): boolean;
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
export declare function fetchTomlWithCache(domain: string, options?: TomlFetchOptions): Promise<TomlFetchOutcome>;
export interface StellarTomlCheckOptions extends TomlFetchOptions {
    /** `stellar_toml_fetch_enabled`. When false the network is never touched. */
    enabled: boolean;
}
export type StellarTomlCheckOutcome = {
    status: 'skipped';
    detail: string;
} | {
    status: 'ok';
    detail: string;
    hash?: string;
    fetched: boolean;
} | {
    status: 'failed';
    detail: string;
};
/**
 * Run the optional SEP-0001 stellar.toml fetch for `domain`.
 *
 * Returns `skipped` without calling the SSRF-guarded HTTP client when fetch
 * is disabled or no domain is known — the on-chain `home_domain` check is
 * evaluated independently and is unaffected.
 */
export declare function runStellarTomlCheck(domain: string | undefined, options: StellarTomlCheckOptions): Promise<StellarTomlCheckOutcome>;
