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
 * - Host normalization before matching (Issue #702): decimal / octal / hex
 *   IPv4 encodings, IDNA full-width digits, trailing dots, IPv6 zone IDs and
 *   IPv4-mapped / NAT64 / 6to4 IPv6 forms are canonicalized first, so
 *   `https://2130706433/`, `https://0x7f.1/` and `https://[::ffff:7f00:1]/`
 *   are all rejected exactly like `https://127.0.0.1/`.
 * - DNS rebinding mitigation: hostnames are resolved before each request
 *   (and before each redirect hop) and rejected when any resolved address
 *   falls inside a blocked range.
 *
 * SCOPE: Shared by Horizon URL validation (`validation.ts`), SEP-0001
 * stellar.toml fetches (`toml.ts`) and federation lookups (`federation.ts`)
 * so every outbound fetch goes through the same SSRF gate.
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
 * Canonicalize a hostname before SSRF matching.
 *
 * - lowercases and trims
 * - strips IPv6 brackets and zone IDs (`fe80::1%eth0`, `fe80::1%25eth0`)
 * - strips trailing dots (`localhost.` → `localhost`)
 * - runs the WHATWG URL host parser, which applies IDNA mapping
 *   (full-width digits, ideographic full stops) and canonicalizes
 *   decimal / octal / hex IPv4 encodings (`2130706433`, `0177.0.0.1`,
 *   `0x7f.1`) to dotted-quad form, and compresses IPv6 addresses.
 *
 * Returns the normalized host (no brackets) or the best-effort lowercase
 * input when the URL parser rejects it.
 */
export declare function normalizeHostForSSRF(host: string): string;
/**
 * Check if a hostname/IP is in the SSRF blocklist.
 *
 * The host is normalized first (see {@link normalizeHostForSSRF}) so
 * alternate encodings of private addresses cannot slip through.
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
/**
 * Resolve a hostname to the list of IP addresses it currently points at.
 * Injectable so tests (and callers with their own resolver) never touch
 * real DNS.
 */
export type SSRFDnsLookup = (hostname: string) => Promise<string[]>;
/** Default resolver backed by the OS resolver (`getaddrinfo`). */
export declare const defaultSSRFDnsLookup: SSRFDnsLookup;
/**
 * DNS rebinding guard: resolve `hostname` and reject when any returned
 * address is in a blocked range (e.g. `127.0.0.1.nip.io`, or an attacker
 * domain whose A record flips to `169.254.169.254`).
 *
 * IP literals are skipped (they were already checked by
 * {@link isSSRFBlocked}). Resolver failures are treated as "no answer":
 * the subsequent fetch cannot connect to an unresolvable name either.
 */
export declare function checkResolvedAddresses(hostname: string, lookup?: SSRFDnsLookup): Promise<{
    blocked: true;
    reason: string;
} | {
    blocked: false;
}>;
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
     * Whether to follow redirects. When true, only same-origin HTTPS redirects
     * are allowed. Default: false (no redirects).
     */
    followRedirects?: boolean;
    /**
     * Maximum number of redirect hops to follow before aborting. Default: 5.
     * Prevents redirect loops and chained exfiltration attempts.
     */
    maxRedirects?: number;
    /**
     * DNS resolver used for the rebinding guard. Defaults to the OS resolver.
     * Pass `false` to skip resolution (only when the caller already pins the
     * connection to a vetted address).
     */
    dnsLookup?: SSRFDnsLookup | false;
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
 * SSRF-safe fetch wrapper used for SEP-0001 stellar.toml and federation
 * lookups.
 *
 * Every hop (the initial URL and each redirect target) is validated with
 * {@link validateSSRFSafeUrl} and its hostname is resolved through
 * {@link checkResolvedAddresses} before the request is sent. Redirects are
 * refused unless `followRedirects` is explicitly enabled, and even then must
 * stay same-origin and HTTPS.
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
