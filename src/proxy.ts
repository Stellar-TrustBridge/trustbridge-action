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

const PROXY_URL_WITH_USERINFO = /([a-z][a-z\d+.-]*:\/\/)([^\s/]+)@/gi;

/**
 * Mask URL userinfo in arbitrary error text while retaining the scheme and
 * proxy host. This intentionally works on malformed URLs too, since the
 * value commonly arrives inside a client error message rather than alone.
 */
export function redactProxyCredentials(value: string): string {
  if (!value) return value;
  return value.replace(PROXY_URL_WITH_USERINFO, '$1***@');
}

/** Normalize an unknown thrown value to safe, credential-redacted text. */
export function safeProxyErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactProxyCredentials(message);
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
/**
 * Lightweight opt-in OpenTelemetry-compatible tracing for TrustBridge Action.
 * (Issue #299)
 *
 * ## Design goals
 * - Default OFF: zero overhead when tracing is not enabled.
 * - No required SaaS or external collector.
 * - Zero new production dependencies: uses only Node.js built-ins.
 * - PII safe: Stellar addresses are redacted to first-4…last-4 before any
 *   span attribute is recorded or exported.
 * - Compatible with the OTel data model (Span, SpanStatus, Attributes) so
 *   a future upgrade to @opentelemetry/sdk-trace-node is a drop-in swap.
 *
 * ## Enabling tracing
 *
 * Set the environment variable before running the action:
 *
 *   OTEL_TRACES_ENABLED=true   # opt in to trace collection
 *   OTEL_TRACES_EXPORTER=log   # (default) emit spans as core.debug JSON lines
 *   OTEL_TRACES_EXPORTER=console  # emit to process.stdout (local dev)
 *   OTEL_TRACES_EXPORTER=none  # collect but do not export (for tests)
 *
 * All options are case-insensitive for the value.
 *
 * ## Instrumented phases
 *
 * | Phase | Span name |
 * |-------|-----------|
 * | Horizon account fetch | `horizon.fetch_account` |
 * | GitHub issue comment post/update | `github.post_comment` |
 * | Dashboard webhook delivery | `webhook.deliver` |
 * | Full action run | `trustbridge.run` |
 *
 * ## PII redaction
 *
 * - `stellar_address` attributes are masked to `first4…last4`.
 * - `horizon_url` attributes have the path stripped (host only).
 * - `webhook_url` attributes have the path stripped.
 * - `github_token` and `webhook_secret` are NEVER placed in any attribute.
 *
 * ## Exporting to a real collector
 *
 * When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, TrustBridge will attempt to
 * export spans via HTTP/JSON OTLP to that endpoint. The payload follows the
 * OTLP/HTTP JSON format so any standard OpenTelemetry collector can receive
 * it. Requires `OTEL_TRACES_EXPORTER=otlp` as well.
 *
 * Example for a local collector:
 * ```yaml
 * env:
 *   OTEL_TRACES_ENABLED: 'true'
 *   OTEL_TRACES_EXPORTER: 'otlp'
 *   OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318'
 * ```
 *
 * See docs/USAGE.md#opentelemetry-tracing for the full guide.
 */

import * as core from '@actions/core';
import { redactStellarAddress, redactHorizonUrl } from './logger';

// ---------------------------------------------------------------------------
// Types — mirror the OTel data model
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Whether tracing is enabled.
 * Reads `OTEL_TRACES_ENABLED` environment variable.
 * Default: false.
 */
export function isTracingEnabled(): boolean {
  const val = process.env['OTEL_TRACES_ENABLED'] ?? '';
  return val.toLowerCase() === 'true' || val === '1';
}

/**
 * The configured exporter type.
 * Reads `OTEL_TRACES_EXPORTER` environment variable.
 * Default: 'log' (core.debug).
 */
export type TraceExporterType = 'log' | 'console' | 'none' | 'otlp';

export function getExporterType(): TraceExporterType {
  const val = (process.env['OTEL_TRACES_EXPORTER'] ?? 'log').toLowerCase();
  if (val === 'console') return 'console';
  if (val === 'none') return 'none';
  if (val === 'otlp') return 'otlp';
  return 'log';
}

// ---------------------------------------------------------------------------
// In-process span store
// ---------------------------------------------------------------------------

const _traceSpans: TraceSpan[] = [];

/**
 * Return all recorded trace spans (for testing).
 * Returns a shallow copy so callers cannot mutate the internal store.
 */
export function getTraceSpans(): TraceSpan[] {
  return [..._traceSpans];
}

/**
 * Clear all recorded trace spans.
 * Call at the start of each test or action run.
 */
export function clearTraceSpans(): void {
  _traceSpans.length = 0;
}

/** Internal: record a completed span into the store. */
function storeSpan(span: TraceSpan): void {
  try {
    _traceSpans.push(span);
  } catch {
    // Observability must never break the action.
  }
}

// ---------------------------------------------------------------------------
// PII redaction for span attributes
// ---------------------------------------------------------------------------

/**
 * Redact a span attributes record so no PII escapes into exported spans.
 * - Stellar addresses (G…/C…, 56 chars) → first4…last4.
 * - Horizon / webhook URLs → host only (path stripped).
 * - Token / secret fields → [REDACTED].
 */
export function redactSpanAttributes(
  attrs: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {};
  const SECRET_KEYS = new Set(['token', 'secret', 'password', 'api_key', 'private_key', 'github_token', 'webhook_secret', 'webhook_secret_previous']);

  for (const [key, value] of Object.entries(attrs)) {
    if (SECRET_KEYS.has(key.toLowerCase())) {
      safe[key] = '[REDACTED]';
      continue;
    }
    if (typeof value === 'string') {
      // Redact embedded Stellar addresses
      let v = value.replace(/\b[GC][A-Z2-7]{55}\b/g, (addr) => redactStellarAddress(addr));
      // Redact Horizon/webhook URL paths (keep scheme + host only)
      if (key.toLowerCase().includes('url')) {
        v = redactHorizonUrl(v);
      }
      safe[key] = v;
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

// ---------------------------------------------------------------------------
// Span recording
// ---------------------------------------------------------------------------

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
export async function withSpan<T>(
  opts: TraceOptions,
  fn: () => Promise<T>,
): Promise<T> {
  if (!isTracingEnabled()) {
    return fn();
  }

  const startTimeMs = Date.now();
  let status: TraceSpanStatus = 'OK';
  let error: string | undefined;

  try {
    const result = await fn();
    return result;
  } catch (err) {
    status = 'ERROR';
    error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    const durationMs = Date.now() - startTimeMs;
    const safeAttrs = redactSpanAttributes(opts.attributes ?? {});

    const span: TraceSpan = {
      name: opts.name,
      startTimeMs,
      durationMs,
      status,
      attributes: safeAttrs,
      error,
      parentName: opts.parentName,
    };

    storeSpan(span);
    exportSpan(span);
  }
}

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
export async function withHorizonSpan<T>(
  opts: HorizonSpanOptions,
  fn: () => Promise<T>,
): Promise<T> {
  if (!isTracingEnabled()) {
    return fn();
  }

  const startTimeMs = Date.now();
  const retryCount = opts.retryCount ?? 0;
  let status: TraceSpanStatus = 'OK';
  let error: string | undefined;

  try {
    const result = await fn();
    return result;
  } catch (err) {
    status = 'ERROR';
    error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    const durationMs = Date.now() - startTimeMs;

    const attributes: Record<string, string | number | boolean> = {
      'horizon.url': opts.horizonUrl,
      'horizon.retry_count': retryCount,
      'horizon.latency_ms': durationMs,
    };
    if (opts.accountId) {
      attributes['stellar_address'] = opts.accountId;
    }

    const span: TraceSpan = {
      name: 'horizon.fetch_account',
      startTimeMs,
      durationMs,
      status,
      attributes: redactSpanAttributes(attributes),
      error,
      parentName: opts.parentName,
    };

    storeSpan(span);
    exportSpan(span);
  }
}

/**
 * Record a synchronous operation within a named trace span.
 *
 * @param opts  Span options.
 * @param fn    Synchronous operation to trace.
 * @returns     The value returned by `fn`.
 */
export function withSpanSync<T>(
  opts: TraceOptions,
  fn: () => T,
): T {
  if (!isTracingEnabled()) {
    return fn();
  }

  const startTimeMs = Date.now();
  let status: TraceSpanStatus = 'OK';
  let error: string | undefined;

  try {
    const result = fn();
    return result;
  } catch (err) {
    status = 'ERROR';
    error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    const durationMs = Date.now() - startTimeMs;
    const safeAttrs = redactSpanAttributes(opts.attributes ?? {});

    const span: TraceSpan = {
      name: opts.name,
      startTimeMs,
      durationMs,
      status,
      attributes: safeAttrs,
      error,
      parentName: opts.parentName,
    };

    storeSpan(span);
    exportSpan(span);
  }
}

// ---------------------------------------------------------------------------
// Span export
// ---------------------------------------------------------------------------

/**
 * Export a completed span to the configured exporter.
 * Never throws — observability must not break the action.
 */
export function exportSpan(span: TraceSpan): void {
  try {
    const exporter = getExporterType();
    switch (exporter) {
      case 'log':
        core.debug(`[TrustBridge][trace] ${JSON.stringify(span)}`);
        break;
      case 'console':
        console.log(`[TrustBridge][trace] ${JSON.stringify(span)}`);
        break;
      case 'none':
        // Collect but do not emit (used in tests to inspect spans without log noise).
        break;
      case 'otlp':
        // OTLP export is fire-and-forget — errors are swallowed so they never
        // affect the action result. The collector must be running at
        // OTEL_EXPORTER_OTLP_ENDPOINT for this to have any effect.
        void exportOtlp(span).catch(() => {
          // Silently ignore export failures.
        });
        break;
    }
  } catch {
    // Swallow all export errors.
  }
}

/**
 * Fire-and-forget OTLP/HTTP JSON export for a single span.
 * Only called when OTEL_TRACES_EXPORTER=otlp and OTEL_EXPORTER_OTLP_ENDPOINT is set.
 */
async function exportOtlp(span: TraceSpan): Promise<void> {
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  if (!endpoint) return;

  // Minimal OTLP/JSON payload for a single span
  const otlpPayload = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'trustbridge-action' } }] },
        scopeSpans: [
          {
            scope: { name: 'trustbridge-action', version: '1' },
            spans: [
              {
                name: span.name,
                kind: 1, // SPAN_KIND_INTERNAL
                startTimeUnixNano: String(span.startTimeMs * 1_000_000),
                endTimeUnixNano: String((span.startTimeMs + span.durationMs) * 1_000_000),
                status: {
                  code: span.status === 'OK' ? 1 : span.status === 'ERROR' ? 2 : 0,
                  message: span.error ?? '',
                },
                attributes: Object.entries(span.attributes).map(([k, v]) => ({
                  key: k,
                  value: typeof v === 'boolean'
                    ? { boolValue: v }
                    : typeof v === 'number'
                      ? { intValue: String(v) }
                      : { stringValue: String(v) },
                })),
              },
            ],
          },
        ],
      },
    ],
  };

  const url = endpoint.replace(/\/$/, '') + '/v1/traces';
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(otlpPayload),
    signal: AbortSignal.timeout(3000),
  });
}

// ---------------------------------------------------------------------------
// Named span helpers for the three instrumented phases
// ---------------------------------------------------------------------------

/**
 * Trace the Horizon account fetch phase.
 * Attributes: endpoint kind (primary/fallback), redacted URL, redacted address.
 */
export async function traceHorizonFetch<T>(
  horizonUrl: string,
  stellarAddress: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withSpan(
    {
      name: 'horizon.fetch_account',
      attributes: {
        'horizon_url': horizonUrl,
        'stellar_address': stellarAddress,
      },
    },
    fn,
  );
}

/**
 * Trace the GitHub issue comment post/update phase.
 * Attributes: comment action (create/update), issue number.
 */
export async function traceCommentPost<T>(
  issueNumber: number | null,
  action: 'create' | 'update' | 'skip',
  fn: () => Promise<T>,
): Promise<T> {
  return withSpan(
    {
      name: 'github.post_comment',
      attributes: {
        'issue_number': issueNumber ?? 0,
        'comment_action': action,
      },
    },
    fn,
  );
}

/**
 * Trace the dashboard webhook delivery phase.
 * Attributes: redacted webhook URL, auth mode.
 */
export async function traceWebhookDeliver<T>(
  webhookUrl: string,
  authMode: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withSpan(
    {
      name: 'webhook.deliver',
      attributes: {
        'webhook_url': webhookUrl,
        'auth_mode': authMode,
      },
    },
    fn,
  );
}

/**
 * Trace the full action run (root span).
 * Attributes: redacted address, reason code, valid flag.
 */
export async function traceActionRun<T>(
  stellarAddress: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withSpan(
    {
      name: 'trustbridge.run',
      attributes: {
        'stellar_address': stellarAddress,
      },
    },
    fn,
  );
}

// ---------------------------------------------------------------------------
// Summary export
// ---------------------------------------------------------------------------

/**
 * Emit a human-readable summary of all collected spans to `core.info`.
 * Called at the end of a run when tracing is enabled.
 * Never throws.
 */
export function emitTraceSummary(): void {
  if (!isTracingEnabled()) return;
  try {
    const spans = getTraceSpans();
    if (spans.length === 0) return;
    const totalMs = spans.reduce((sum, s) => sum + s.durationMs, 0);
    const errorCount = spans.filter((s) => s.status === 'ERROR').length;
    core.info(
      `[TrustBridge][trace] Run complete — ${spans.length} span(s), ` +
      `${totalMs}ms total, ${errorCount} error(s). ` +
      `Set OTEL_TRACES_EXPORTER=otlp + OTEL_EXPORTER_OTLP_ENDPOINT to forward to a collector.`,
    );
  } catch {
    // Never throw from observability.
  }
}
