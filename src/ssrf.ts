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

import { promises as dnsPromises } from 'dns';
import { isIP } from 'net';

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
 * Hostnames (after normalization) that always point at the runner itself or
 * at a cloud metadata service, regardless of what DNS says.
 */
const SSRF_BLOCKED_HOSTNAMES: ReadonlyArray<{ name: string; test: (host: string) => boolean }> = [
  { name: 'loopback', test: (h) => h === 'localhost' || h.endsWith('.localhost') },
  { name: 'loopback', test: (h) => h === 'localhost.localdomain' },
  { name: 'cloud_metadata', test: (h) => h === 'metadata.google.internal' || h === 'metadata' },
  { name: 'cloud_metadata', test: (h) => h === 'instance-data' || h === 'instance-data.ec2.internal' },
];

/**
 * IPv4 CIDR blocklist evaluated against the canonical dotted-quad form.
 * Each entry is `[network, prefixLength, reason]`.
 */
const SSRF_BLOCKED_IPV4_CIDRS: ReadonlyArray<[string, number, string]> = [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private_10'],
  ['100.64.0.0', 10, 'carrier_grade_nat'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link_local_169'],
  ['172.16.0.0', 12, 'private_172'],
  ['192.0.0.0', 24, 'ietf_protocol_assignments'],
  ['192.168.0.0', 16, 'private_192'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved_240'],
];

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function classifyIPv4(ip: string): string | null {
  const value = ipv4ToNumber(ip);
  if (value === null) return null;
  for (const [network, prefix, reason] of SSRF_BLOCKED_IPV4_CIDRS) {
    const base = ipv4ToNumber(network) as number;
    const size = 2 ** (32 - prefix);
    if (value >= base && value < base + size) return reason;
  }
  return null;
}

/**
 * Expand an IPv6 address (no brackets, no zone) into eight 16-bit groups.
 * Handles `::` compression and a trailing embedded dotted IPv4 suffix.
 */
function expandIPv6(ip: string): number[] | null {
  let address = ip;
  const tail: number[] = [];
  const v4Match = address.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4Match) {
    const v4 = ipv4ToNumber(v4Match[2]);
    if (v4 === null) return null;
    tail.push(Math.floor(v4 / 65536), v4 % 65536);
    address = v4Match[1].endsWith('::') ? v4Match[1] : v4Match[1].slice(0, -1);
  }

  const halves = address.split('::');
  if (halves.length > 2) return null;
  const parse = (chunk: string): number[] | null => {
    if (!chunk) return [];
    const groups: number[] = [];
    for (const g of chunk.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !rest) return null;

  const explicit = head.length + rest.length + tail.length;
  if (halves.length === 1) {
    return explicit === 8 ? [...head, ...tail] : null;
  }
  if (explicit > 7) return null;
  return [...head, ...new Array(8 - explicit).fill(0), ...rest, ...tail];
}

function groupsToIPv4(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

function classifyIPv6(ip: string): string | null {
  const g = expandIPv6(ip);
  if (!g) return null;
  const allZeroUntil = (n: number) => g.slice(0, n).every((x) => x === 0);

  if (allZeroUntil(8)) return 'ipv6_unspecified';
  if (allZeroUntil(7) && g[7] === 1) return 'ipv6_loopback';
  if ((g[0] & 0xffc0) === 0xfe80) return 'ipv6_link_local';
  if ((g[0] & 0xfe00) === 0xfc00) return 'ipv6_ula';
  if ((g[0] & 0xff00) === 0xff00) return 'ipv6_multicast';

  // IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible (::a.b.c.d)
  if (allZeroUntil(5) && (g[5] === 0xffff || g[5] === 0)) {
    const embedded = classifyIPv4(groupsToIPv4(g[6], g[7]));
    if (embedded) return g[5] === 0xffff ? `ipv6_mapped_${embedded}` : `ipv6_compat_${embedded}`;
  }
  // NAT64 well-known prefix 64:ff9b::/96
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    const embedded = classifyIPv4(groupsToIPv4(g[6], g[7]));
    if (embedded) return `ipv6_nat64_${embedded}`;
  }
  // 6to4 2002:AABB:CCDD::/48 embeds an IPv4 address in groups 1–2
  if (g[0] === 0x2002) {
    const embedded = classifyIPv4(groupsToIPv4(g[1], g[2]));
    if (embedded) return `ipv6_6to4_${embedded}`;
  }
  return null;
}

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
export function normalizeHostForSSRF(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const zone = h.indexOf('%');
  if (zone !== -1 && h.includes(':')) h = h.slice(0, zone);
  h = h.replace(/\.+$/, '');
  if (!h) return h;

  try {
    const parsedHost = h.includes(':')
      ? new URL(`http://[${h}]/`).hostname
      : new URL(`http://${h}/`).hostname;
    h = parsedHost.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  } catch {
    // Keep the lowercase form; the regex blocklist still applies below.
  }
  return h;
}

/**
 * Check if a hostname/IP is in the SSRF blocklist.
 *
 * The host is normalized first (see {@link normalizeHostForSSRF}) so
 * alternate encodings of private addresses cannot slip through.
 *
 * Returns `{ blocked: true, reason }` if the host should be rejected,
 * or `{ blocked: false }` if it's safe to fetch from.
 */
export function isSSRFBlocked(
  host: string,
): { blocked: true; reason: string } | { blocked: false } {
  const normalized = normalizeHostForSSRF(host);
  const raw = host.trim().toLowerCase().replace(/^\[|\]$/g, '');

  for (const candidate of [normalized, raw]) {
    for (const range of SSRF_BLOCKED_RANGES) {
      if (range.pattern.test(candidate)) {
        return { blocked: true, reason: `Host matches SSRF blocklist: ${range.name}` };
      }
    }
  }

  for (const entry of SSRF_BLOCKED_HOSTNAMES) {
    if (entry.test(normalized)) {
      return { blocked: true, reason: `Host matches SSRF blocklist: ${entry.name}` };
    }
  }

  const family = isIP(normalized);
  const reason =
    family === 4 ? classifyIPv4(normalized) : family === 6 ? classifyIPv6(normalized) : null;
  if (reason) {
    return { blocked: true, reason: `Host matches SSRF blocklist: ${reason}` };
  }

  return { blocked: false };
}

/**
 * Resolve a hostname to the list of IP addresses it currently points at.
 * Injectable so tests (and callers with their own resolver) never touch
 * real DNS.
 */
export type SSRFDnsLookup = (hostname: string) => Promise<string[]>;

/** Default resolver backed by the OS resolver (`getaddrinfo`). */
export const defaultSSRFDnsLookup: SSRFDnsLookup = async (hostname) => {
  const records = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

/**
 * DNS rebinding guard: resolve `hostname` and reject when any returned
 * address is in a blocked range (e.g. `127.0.0.1.nip.io`, or an attacker
 * domain whose A record flips to `169.254.169.254`).
 *
 * IP literals are skipped (they were already checked by
 * {@link isSSRFBlocked}). Resolver failures are treated as "no answer":
 * the subsequent fetch cannot connect to an unresolvable name either.
 */
export async function checkResolvedAddresses(
  hostname: string,
  lookup: SSRFDnsLookup = defaultSSRFDnsLookup,
): Promise<{ blocked: true; reason: string } | { blocked: false }> {
  const normalized = normalizeHostForSSRF(hostname);
  if (!normalized || isIP(normalized) !== 0) return { blocked: false };

  let addresses: string[];
  try {
    addresses = await lookup(normalized);
  } catch {
    return { blocked: false };
  }

  for (const address of addresses) {
    const verdict = isSSRFBlocked(address);
    if (verdict.blocked) {
      return {
        blocked: true,
        reason: `Hostname "${normalized}" resolves to a blocked address (${verdict.reason.replace('Host matches SSRF blocklist: ', '')}); possible DNS rebinding`,
      };
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
      errors.push(
        `Hostname blocked by SSRF policy: ${blocked.reason}. ` +
          'Private, loopback, link-local and cloud-metadata addresses are never fetched; ' +
          'use a publicly resolvable HTTPS hostname (see docs/INPUT_VALIDATION.md).',
      );
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true };
}

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
      return { ok: false, error: 'errors' in validation ? validation.errors.join('; ') : 'Unsafe URL' };
    }

    if (options.dnsLookup !== false) {
      const resolved = await checkResolvedAddresses(new URL(currentUrl).hostname, options.dnsLookup);
      if (resolved.blocked) {
        return { ok: false, error: `Hostname blocked by SSRF policy: ${'reason' in resolved ? resolved.reason : 'blocked address'}` };
      }
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
            error: `Unsafe redirect target: ${'errors' in hopValidation ? hopValidation.errors.join('; ') : 'Unsafe URL'}`,
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

      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}`, status: response.status };
      }

      const reader = response.body?.getReader();
      if (!reader) {
        return { ok: false, error: 'Response body is not readable', status: response.status };
      }

      const chunks: Uint8Array[] = [];
      let totalBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        totalBytes += value.byteLength;
        if (totalBytes > maxBodyBytes) {
          await reader.cancel();
          return {
            ok: false,
            error: `Response body exceeds limit of ${maxBodyBytes} bytes`,
            status: response.status,
          };
        }

        chunks.push(value);
      }

      const decoder = new TextDecoder();
      const text = chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode();

      return {
        ok: true,
        status: response.status,
        headers: response.headers,
        text: async () => text,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Fetch failed: ${message}` };
    }
  }
}
