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

suffix matches and IPs; ensure SSRF still applies to bypassed destinations as required by policy.

 
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
/** OTel-compatible span status code. */
export type TraceSpanStatus = 'UNSET' | 'OK' | 'ERROR';
/**
 * A single span record. Mirrors the OpenTelemetry Span data model fields
 * that are relevant to action instrumentation.
 */
export interface TraceSpan {
    /** Span name (e.g. "horizon.fetch_account"). */
    name: string;
    /** Unix timestamp in milliseconds when the span started. */
    startTimeMs: number;
    /** Wall-clock duration of the operation in milliseconds. */
    durationMs: number;
    /** OTel-compatible status. */
    status: TraceSpanStatus;
    /** Structured, PII-safe attributes. */
    attributes: Record<string, string | number | boolean>;
    /** Error message when status is "ERROR", undefined otherwise. */
    error?: string;
    /** Optional parent span name for nesting context. */
    parentName?: string;
}
/** Options for starting a traced operation. */
export interface TraceOptions {
    /** Span name. */
    name: string;
    /** Attributes to attach at span start (must be PII-safe). */
    attributes?: Record<string, string | number | boolean>;
    /** Parent span name for nesting context. */
    parentName?: string;
}
/**
 * Options for tracing a Horizon fetch operation (issue #757).
 * Emits OTel-compatible span attributes for latency and retry counts.
 */
export interface HorizonSpanOptions {
    /** Horizon endpoint URL (path is stripped before recording). */
    horizonUrl: string;
    /** Stellar account being fetched (redacted before recording). */
    accountId?: string;
    /** Number of retry attempts made before the fetch resolved. */
    retryCount?: number;
    /** Parent span name for nesting context. */
    parentName?: string;
}
/**
 * Whether tracing is enabled.
 * Reads `OTEL_TRACES_ENABLED` environment variable.
 * Default: false.
 */
export declare function isTracingEnabled(): boolean;
/**
 * The configured exporter type.
 * Reads `OTEL_TRACES_EXPORTER` environment variable.
 * Default: 'log' (core.debug).
 */
export type TraceExporterType = 'log' | 'console' | 'none' | 'otlp';
export declare function getExporterType(): TraceExporterType;
/**
 * Return all recorded trace spans (for testing).
 * Returns a shallow copy so callers cannot mutate the internal store.
 */
export declare function getTraceSpans(): TraceSpan[];
/**
 * Clear all recorded trace spans.
 * Call at the start of each test or action run.
 */
export declare function clearTraceSpans(): void;
/**
 * Redact a span attributes record so no PII escapes into exported spans.
 * - Stellar addresses (G…/C…, 56 chars) → first4…last4.
 * - Horizon / webhook URLs → host only (path stripped).
 * - Token / secret fields → [REDACTED].
 */
export declare function redactSpanAttributes(attrs: Record<string, string | number | boolean>): Record<string, string | number | boolean>;
/**
 * Execute an async operation within a named trace span.
 *
 * When tracing is disabled, `fn` is called directly with zero overhead.
 * When enabled, the span is recorded and exported after `fn` completes.
 *
 * @param opts  Span options (name, attributes, parentName).
 * @param fn    The async operation to trace.
 * @returns     The resolved value from `fn`.
 */
export declare function withSpan<T>(opts: TraceOptions, fn: () => Promise<T>): Promise<T>;
/**
 * Execute a Horizon fetch operation within an OTel-compatible span
 * (issue #757). Emits consistent span attributes for latency and retry
 * counts so operators can correlate Wave CI flakes without scraping logs.
 *
 * Attributes recorded on the span:
 * - `horizon.url`        — host-only Horizon endpoint (path stripped).
 * - `stellar_address`    — redacted account id (first4…last4), when provided.
 * - `horizon.retry_count`— number of retries performed (default 0).
 * - `horizon.latency_ms` — wall-clock latency of the fetch in milliseconds.
 *
 * When tracing is disabled, `fn` is called directly with zero overhead and
 * existing auth/pause/happy-path semantics are preserved.
 *
 * @param opts  Horizon span options (url, account, retryCount, parentName).
 * @param fn    The async Horizon fetch operation to trace.
 * @returns     The resolved value from `fn`.
 */
export declare function withHorizonSpan<T>(opts: HorizonSpanOptions, fn: () => Promise<T>): Promise<T>;
/**
 * Record a synchronous operation within a named trace span.
 *
 * @param opts  Span options.
 * @param fn    Synchronous operation to trace.
 * @returns     The value returned by `fn`.
 */
export declare function withSpanSync<T>(opts: TraceOptions, fn: () => T): T;
/**
 * Export a completed span to the configured exporter.
 * Never throws — observability must not break the action.
 */
export declare function exportSpan(span: TraceSpan): void;
/**
 * Trace the Horizon account fetch phase.
 * Attributes: endpoint kind (primary/fallback), redacted URL, redacted address.
 */
export declare function traceHorizonFetch<T>(horizonUrl: string, stellarAddress: string, fn: () => Promise<T>): Promise<T>;
/**
 * Trace the GitHub issue comment post/update phase.
 * Attributes: comment action (create/update), issue number.
 */
export declare function traceCommentPost<T>(issueNumber: number | null, action: 'create' | 'update' | 'skip', fn: () => Promise<T>): Promise<T>;
/**
 * Trace the dashboard webhook delivery phase.
 * Attributes: redacted webhook URL, auth mode.
 */
export declare function traceWebhookDeliver<T>(webhookUrl: string, authMode: string, fn: () => Promise<T>): Promise<T>;
/**
 * Trace the full action run (root span).
 * Attributes: redacted address, reason code, valid flag.
 */
export declare function traceActionRun<T>(stellarAddress: string, fn: () => Promise<T>): Promise<T>;
/**
 * Emit a human-readable summary of all collected spans to `core.info`.
 * Called at the end of a run when tracing is enabled.
 * Never throws.
 */
export declare function emitTraceSummary(): void;
