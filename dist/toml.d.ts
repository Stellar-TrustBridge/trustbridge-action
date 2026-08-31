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
    fetched: boolean;
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
export declare function parseHashPin(pin: string): ParsedHashPin | undefined;
/**
 * Compute the hash of a string using the specified algorithm.
 *
 * @param content The content to hash
 * @param algorithm 'sha256' or 'sha512'
 * @returns Hex-encoded hash
 */
export declare function computeHash(content: string, algorithm: 'sha256' | 'sha512'): string;
/**
 * Validate content against an optional hash pin.
 *
 * @param content The TOML content to validate
 * @param pin Optional hash pin (format: "algorithm:hexvalue")
 * @returns { valid: true, hash } on success, or { valid: false, error } on mismatch/error
 */
export declare function validateTomlHash(content: string, pin: string | undefined): {
    valid: true;
    hash: string;
} | {
    valid: false;
    error: string;
};
/**
 * Build a cache key for a TOML fetch, ensuring per-domain isolation.
 *
 * @param domain The home_domain (e.g. "centre.io")
 * @returns Cache key (e.g. "toml:centre.io")
 */
export declare function buildTomlCacheKey(domain: string): string;
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
export declare function fetchTomlWithCache(domain: string, options?: {
    cacheTtlMs?: number;
    hashPin?: string;
    maxBodyBytes?: number;
}): Promise<TomlFetchOutcome>;
