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
export declare function redactProxyUrl(url: string): string;
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
export declare function validateProxyUrl(proxyUrl: string): string | null;
/**
 * Read proxy configuration from environment variables.
 *
 * Returns an empty `proxyUrl` when no proxy is configured, which means
 * the caller should use a direct connection.
 */
export declare function getProxyConfig(): ProxyConfig;
/**
 * Check whether a given hostname should bypass the proxy based on NO_PROXY.
 *
 * Supports exact matches and wildcard (`*`) entries.
 */
export declare function shouldBypassProxy(hostname: string, noProxyHosts: string[]): boolean;
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
export declare function createProxyAgent(targetUrl: string, config?: ProxyConfig): HttpsProxyAgent<string> | undefined;
/**
 * Wrap a `node-fetch`-like function to route requests through an HTTPS proxy.
 *
 * The returned function has the same signature as `node-fetch` but transparently
 * injects the proxy agent into each request when a proxy is configured.
 *
 * SSRF protections remain active — the proxy agent only handles transport.
 */
export declare function createProxiedFetch(config?: ProxyConfig): ((url: string | import("node-fetch").Request, init?: import("node-fetch").RequestInit) => Promise<import("node-fetch").Response>) | undefined;
/**
 * Get Octokit options with proxy agent configured when needed.
 *
 * Returns an options object suitable for passing to `github.getOctokit(token, options)`.
 * When no proxy is configured or the GitHub API host is in NO_PROXY, returns
 * only the `baseUrl` (no proxy agent).
 */
export declare function getOctokitProxyOptions(baseUrl?: string): {
    baseUrl?: string;
    request?: {
        agent?: HttpsProxyAgent<string>;
    };
};
