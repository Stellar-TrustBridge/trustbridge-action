/**
 * HTTPS proxy support for enterprise environments (Issue #237).
 *
 * GHES runners often require an HTTP/HTTPS proxy to reach both the
 * Stellar Horizon API and the GitHub API. This module reads standard
 * proxy environment variables and returns a configured agent when needed.
 *
 * Environment variables honored:
 *   - `HTTPS_PROXY` / `https_proxy` — proxy URL for HTTPS requests
 *   - `HTTP_PROXY` / `http_proxy` — fallback proxy URL (used when HTTPS_PROXY is unset)
 *   - `NO_PROXY` / `no_proxy` — comma-separated list of hosts to bypass
 *
 * Security notes:
 *   - Proxy URLs containing userinfo (username:password) are redacted in logs.
 *   - SSRF protections are NOT disabled when using a proxy.
 *   - Only HTTPS proxies are supported for Horizon requests.
 *   - Proxy URLs are validated against the same SSRF rules as `ssrf.ts`
 *     (Issue #758): loopback, link-local, private ranges, and cloud
 *     metadata endpoints are rejected, as are scheme-smuggling forms
 *     (non-http(s) schemes, embedded credentials, non-canonical hosts).
 */

import { HttpsProxyAgent } from 'https-proxy-agent';
import { URL } from 'url';
import { logger } from './logger';
import { isSSRFBlocked } from './ssrf';

/**
 * Resolved proxy configuration from environment variables.
 */
export interface ProxyConfig {
  /** The proxy URL string (e.g. `http://proxy.corp:8080`), or empty if no proxy. */
  proxyUrl: string;
  /** Parsed NO_PROXY entries (lowercased hostnames). */
  noProxyHosts: string[];
}

/**
 * Redact userinfo from a proxy URL for safe logging.
 *
 * `http://user:pass@proxy:8080` → `http://proxy:8080`
 */
export function redactProxyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    }
  } catch {
    // Not a valid URL — return as-is (caller will handle).
  }
  return url;
}

/**
 * Validate a proxy URL against SSRF pivots and scheme-smuggling forms.
 *
 * Returns `null` when the URL is acceptable, or a stable error message
 * describing why it was rejected. The checks mirror `ssrf.ts` so that
 * proxy-derived Horizon traffic is subject to the same guard as direct
 * Horizon URLs.
 *
 * Rejected forms:
 *   - empty / malformed URLs
 *   - non-http(s) schemes (e.g. `file:`, `ftp:`, `gopher:`)
 *   - embedded credentials (`user:pass@host`)
 *   - loopback, link-local, private ranges, and metadata endpoints
 *   - non-canonical / obfuscated hosts (e.g. `0x7f.0.0.1`, `2130706433`)
 */
export function validateProxyUrl(proxyUrl: string): string | null {
  if (!proxyUrl || typeof proxyUrl !== 'string' || proxyUrl.trim() === '') {
    return 'Proxy URL is empty';
  }

  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    return 'Proxy URL is malformed';
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return `Proxy URL has unsupported scheme: ${parsed.protocol}`;
  }

  if (parsed.username || parsed.password) {
    return 'Proxy URL must not contain embedded credentials';
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    return 'Proxy URL is missing a hostname';
  }

  // Reject non-canonical / obfuscated host forms that could smuggle an
  // internal address past naive string checks (e.g. `0x7f.0.0.1`,
  // `2130706433`, trailing dots, percent-encoding).
  if (hostname !== hostname.toLowerCase()) {
    return 'Proxy URL hostname must be lowercase';
  }
  if (hostname.endsWith('.')) {
    return 'Proxy URL hostname must not have a trailing dot';
  }
  if (hostname.includes('%')) {
    return 'Proxy URL hostname must not be percent-encoded';
  }

  if (isSSRFBlocked(hostname).blocked) {
    return `Proxy URL host is blocked by SSRF policy: ${hostname}`;
  }

  return null;
}

/**
 * Read proxy configuration from environment variables.
 *
 * Returns an empty `proxyUrl` when no proxy is configured, which means
 * the caller should use a direct connection.
 */
export function getProxyConfig(): ProxyConfig {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    '';

  const noProxyRaw =
    process.env.NO_PROXY ||
    process.env.no_proxy ||
    '';

  const noProxyHosts = noProxyRaw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  return { proxyUrl, noProxyHosts };
}

/**
 * Check whether a given hostname should bypass the proxy based on NO_PROXY.
 *
 * Supports exact matches and wildcard (`*`) entries.
 */
export function shouldBypassProxy(hostname: string, noProxyHosts: string[]): boolean {
  const lower = hostname.toLowerCase();
  if (noProxyHosts.includes('*')) return true;
  if (noProxyHosts.includes(lower)) return true;
  // Support domain suffix matching: `.example.com` matches `foo.example.com`
  for (const entry of noProxyHosts) {
    if (entry.startsWith('.') && lower.endsWith(entry)) return true;
    if (lower.endsWith('.' + entry)) return true;
  }
  return false;
}

/**
 * Create an HTTPS proxy agent for a given target URL.
 *
 * Returns `undefined` when:
 *   - No proxy is configured
 *   - The target hostname is in the NO_PROXY list
 *   - The proxy URL is invalid or fails SSRF validation
 *
 * The returned agent is an `https-proxy-agent` instance that can be passed
 * as the `agent` option to `node-fetch` or Octokit's `httpAgent`.
 */
export function createProxyAgent(
  targetUrl: string,
  config?: ProxyConfig,
): HttpsProxyAgent<string> | undefined {
  const cfg = config ?? getProxyConfig();
  if (!cfg.proxyUrl) return undefined;

  let targetHost: string;
  try {
    targetHost = new URL(targetUrl).hostname;
  } catch {
    logger.warn('Invalid target URL for proxy agent', {
      component: 'proxy',
      targetUrl: '(redacted)',
    });
    return undefined;
  }

  if (shouldBypassProxy(targetHost, cfg.noProxyHosts)) {
    logger.debug('Proxy bypass for hostname', {
      component: 'proxy',
      hostname: targetHost,
    });
    return undefined;
  }

  const validationError = validateProxyUrl(cfg.proxyUrl);
  if (validationError) {
    logger.warn(`Rejected proxy URL: ${validationError}`, {
      component: 'proxy',
      proxyUrl: redactProxyUrl(cfg.proxyUrl),
    });
    return undefined;
  }

  try {
    const safeProxyUrl = redactProxyUrl(cfg.proxyUrl);
    logger.info('Creating proxy agent', {
      component: 'proxy',
      proxyUrl: safeProxyUrl,
      targetHost,
    });
    return new HttpsProxyAgent(cfg.proxyUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Failed to create proxy agent: ${msg}`, { component: 'proxy' });
    return undefined;
  }
}

/**
 * Wrap a `node-fetch`-like function to route requests through an HTTPS proxy.
 *
 * The returned function has the same signature as `node-fetch` but transparently
 * injects the proxy agent into each request when a proxy is configured.
 *
 * SSRF protections remain active — the proxy agent only handles transport.
 */
export function createProxiedFetch(config?: ProxyConfig) {
  const cfg = config ?? getProxyConfig();
  if (!cfg.proxyUrl) {
    // No proxy configured — return the default fetch unchanged.
    return undefined;
  }

  return async function proxiedFetch(
    url: string | import('node-fetch').Request,
    init?: import('node-fetch').RequestInit,
  ): Promise<import('node-fetch').Response> {
    const targetUrl = typeof url === 'string' ? url : url.url;
    const agent = createProxyAgent(targetUrl, cfg);
    if (!agent) {
      // Bypass proxy for this specific request (NO_PROXY match or error).
      const { default: fetch } = await import('node-fetch');
      return fetch(url, init);
    }
    const { default: fetch } = await import('node-fetch');
    return fetch(url, { ...init, agent });
  };
}

/**
 * Get Octokit options with proxy agent configured when needed.
 *
 * Returns an options object suitable for passing to `github.getOctokit(token, options)`.
 * When no proxy is configured or the GitHub API host is in NO_PROXY, returns
 * only the `baseUrl` (no proxy agent).
 */
export function getOctokitProxyOptions(
  baseUrl?: string,
): { baseUrl?: string; request?: { agent?: HttpsProxyAgent<string> } } {
  const cfg = getProxyConfig();
  if (!cfg.proxyUrl) return { baseUrl };

  const targetUrl = baseUrl || 'https://api.github.com';
  const agent = createProxyAgent(targetUrl, cfg);
  if (!agent) return { baseUrl };

  return { baseUrl, request: { agent } };
}
