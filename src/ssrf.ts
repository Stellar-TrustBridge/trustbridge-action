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
export const SSRF_BLOCKED_RANGES = [
  { name: 'loopback', pattern: /^127\.|^::1$|^localhost$/i },
  { name: 'private_10', pattern: /^10\./ },
  { name: 'private_172', pattern: /^172\.(1[6-9]|2[0-9]|3[01])\./ },
  { name: 'private_192', pattern: /^192\.168\./ },
  { name: 'link_local_169', pattern: /^169\.254\./ },
  { name: 'multicast', pattern: /^224\.|^225\.|^226\.|^227\.|^228\.|^229\.|^230\.|^231\.|^232\.|^233\.|^234\.|^235\.|^236\.|^237\.|^238\.|^239\./ },
  { name: 'reserved_240', pattern: /^240\./ },
  { name: 'ipv6_link_local', pattern: /^fe80:/i },
  // IPv4-mapped IPv6 loopback
  { name: 'ipv6_mapped_loopback', pattern: /^::ffff:127\./i },
  // IPv4-mapped IPv6 private ranges
  { name: 'ipv6_mapped_private', pattern: /^::ffff:(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.)/i },
  // IPv6 ULA (Unique Local Addresses: fc00::/7)
  { name: 'ipv6_ula', pattern: /^f[cd][0-9a-f]{2}:/i },
  // IPv6 loopback full-form (0:0:0:0:0:0:0:1)
  { name: 'ipv6_loopback_full', pattern: /^0{0,4}:0{0,4}:0{0,4}:0{0,4}:0{0,4}:0{0,4}:0{0,4}:0*1$/i },
];

/**
 * Check if a hostname/IP is in the SSRF blocklist.
 *
 * Returns `{ blocked: true, reason }` if the host should be rejected,
 * or `{ blocked: false }` if it's safe to fetch from.
 */
export function isSSRFBlocked(
  host: string,
): { blocked: true; reason: string } | { blocked: false } {
  const normalized = host.toLowerCase();

  for (const range of SSRF_BLOCKED_RANGES) {
    if (range.pattern.test(normalized)) {
      return { blocked: true, reason: `Host matches SSRF blocklist: ${range.name}` };
    }
  }

  return { blocked: false };
}

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
export function validateSSRFSafeUrl(
  urlStr: string,
): { valid: true } | { valid: false; errors: string[] } {
  const errors: string[] = [];

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    errors.push('Invalid URL format');
    return { valid: false, errors };
  }

  // Only HTTPS allowed
  if (parsed.protocol !== 'https:') {
    errors.push(`Scheme must be HTTPS, got: ${parsed.protocol}`);
  }

  // No credentials in URL
  if (parsed.username || parsed.password) {
    errors.push('URL must not contain credentials (username/password)');
  }

  // Hostname must be present and not empty
  if (!parsed.hostname) {
    errors.push('URL must have a non-empty hostname');
  }

  // Check SSRF blocklist
  if (parsed.hostname) {
    const blocked = isSSRFBlocked(parsed.hostname);
    if (blocked.blocked) {
      errors.push(`Hostname blocked by SSRF policy: ${blocked.reason}`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true };
}

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
export async function fetchSSRFSafe(
  urlStr: string,
  options: SSRFFetchOptions = {},
): Promise<
  | { ok: true; status: number; text: () => Promise<string>; headers: Headers }
  | { ok: false; error: string; status?: number }
> {
  const maxBodyBytes = options.maxBodyBytes ?? 256 * 1024; // 256 KB
  const timeoutMs = options.timeoutMs ?? 10000;
  const maxRedirects = options.maxRedirects ?? 5;
  let currentUrl = urlStr;
  const seenRedirects = new Set<string>();
  let redirectCount = 0;

  while (true) {
    const validation = validateSSRFSafeUrl(currentUrl);
    if (!validation.valid) {
      return { ok: false, error: validation.errors.join('; ') };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': 'TrustBridge/1.0',
          Accept: 'application/toml, text/plain, */*',
        },
      });

      clearTimeout(timeout);

      if (response.status >= 300 && response.status < 400) {
        if (!options.followRedirects) {
          return { ok: false, error: `HTTP ${response.status}`, status: response.status };
        }

        const locationHeader = response.headers.get('location');
        if (!locationHeader) {
          return { ok: false, error: `HTTP ${response.status} redirect without a Location header`, status: response.status };
        }

        if (redirectCount >= maxRedirects) {
          return {
            ok: false,
            error: `Too many redirects while fetching ${currentUrl} (limit: ${maxRedirects})`,
            status: response.status,
          };
        }

        const nextUrl = new URL(locationHeader, currentUrl).toString();
        const nextTarget = new URL(nextUrl);
        const hopValidation = validateSSRFSafeUrl(nextUrl);
        if (!hopValidation.valid) {
          return {
            ok: false,
            error: `Unsafe redirect target: ${hopValidation.errors.join('; ')}`,
            status: response.status,
          };
        }

        const currentOrigin = new URL(currentUrl).origin;
        const nextOrigin = nextTarget.origin;

        if (nextTarget.protocol !== 'https:') {
          return {
            ok: false,
            error: `Redirect protocol downgrade not allowed: ${currentUrl} -> ${nextUrl}`,
            status: response.status,
          };
        }

        if (currentOrigin !== nextOrigin) {
          return {
            ok: false,
            error: `Redirect target crosses origin: ${currentUrl} -> ${nextUrl}`,
            status: response.status,
          };
        }

        if (seenRedirects.has(nextUrl)) {
          return {
            ok: false,
            error: `Redirect loop detected: ${nextUrl}`,
            status: response.status,
          };
        }

        seenRedirects.add(nextUrl);
        redirectCount += 1;
        currentUrl = nextUrl;
        continue;
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength) {
        const bytes = parseInt(contentLength, 10);
        if (bytes > maxBodyBytes) {
          return {
            ok: false,
            error: `Response body too large: ${bytes} bytes (max ${maxBodyBytes})`,
            status: response.status,
          };
        }
      }

      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}`, status: response.status };
      }

      const textData = await response.text();
      if (Buffer.byteLength(textData, 'utf8') > maxBodyBytes) {
        return {
          ok: false,
          error: `Response body exceeds limit after decompression`,
          status: response.status,
        };
      }

      return {
        ok: true,
        status: response.status,
        text: async () => textData,
        headers: response.headers,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isTimeout = message.includes('signal') || message.includes('timeout');
      return { ok: false, error: isTimeout ? 'Request timeout' : `Fetch failed: ${message}` };
    }
  }
}
