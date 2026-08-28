/**
 * @file ssrf.ts
 * SSRF-safe HTTP fetch utilities for TrustBridge.
 *
 * This module provides helpers for making HTTP requests with built-in
 * protections against Server-Side Request Forgery (SSRF) attacks:
 * - HTTPS-only (no HTTP, file://, ftp://, etc.)
 * - No private/internal IP ranges (127.0.0.1, 192.168.x.x, 10.x.x.x, etc.)
 * - Request size and timeout limits
 * - No redirect chains to different origins
 *
 * CURRENT SCOPE: Used by Horizon fetches. Future enhancements may use this
 * for SEP-0001 stellar.toml fetches when opted in by workflows.
 */
/**
 * SSRF blocklist: IP ranges that should never be fetched from inside a
 * GitHub Actions workflow.
 *
 * Covers:
 * - Loopback: 127.0.0.0/8
 * - Private RFC1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 * - Link-local: 169.254.0.0/16
 * - Multicast: 224.0.0.0/4
 * - Reserved: 240.0.0.0/4
 * - Localhost IPv6: ::1
 * - Link-local IPv6: fe80::/10
 */
export declare const SSRF_BLOCKED_RANGES: {
    name: string;
    pattern: RegExp;
}[];
/**
 * Check if a hostname/IP is in the SSRF blocklist.
 *
 * Returns `{ blocked: true, reason }` if the host should be rejected,
 * or `{ blocked: false }` if it's safe to fetch from.
 */
export declare function isSSRFBlocked(host: string): {
    blocked: true;
    reason: string;
} | {
    blocked: false;
};
export interface SSRFFetchOptions {
    /**
     * Maximum allowed response body size in bytes. Default: 256 KB.
     * Prevents attackers from triggering large uploads to GitHub Actions.
     */
    maxBodyBytes?: number;
    /**
     * Request timeout in milliseconds. Default: 10000 (10 seconds).
     */
    timeoutMs?: number;
    /**
     * Whether to follow redirects. When true, only same-origin redirects
     * are allowed. Default: false (no redirects).
     */
    followRedirects?: boolean;
}
/**
 * Validate that a URL is safe for SSRF-protected HTTP fetch.
 *
 * Checks:
 * - Scheme is HTTPS (no HTTP, file://, ftp://, etc.)
 * - Hostname is not in the SSRF blocklist
 * - URL has a valid hostname (not relative, not localhost, etc.)
 *
 * Returns `{ valid: true }` or `{ valid: false; errors: [...] }`.
 */
export declare function validateSSRFSafeUrl(urlStr: string): {
    valid: true;
} | {
    valid: false;
    errors: string[];
};
/**
 * Example SSRF-safe fetch wrapper (for future use with stellar.toml).
 *
 * NOT currently called by TrustBridge, but available for future enhancements
 * that need to safely fetch HTTP resources from URLs in Horizon data.
 *
 * Usage:
 * ```ts
 * const result = await fetchSSRFSafe(homeDomainUrl, { maxBodyBytes: 256 * 1024 });
 * if (!result.ok) {
 *   logger.warn(`Fetch failed: ${result.error}`);
 *   return;
 * }
 * const text = await result.text();
 * ```
 */
export declare function fetchSSRFSafe(urlStr: string, options?: SSRFFetchOptions): Promise<{
    ok: true;
    status: number;
    text: () => Promise<string>;
    headers: Headers;
} | {
    ok: false;
    error: string;
    status?: number;
}>;
