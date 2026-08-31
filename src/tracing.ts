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
  const SECRET_KEYS = new Set(['token', 'secret', 'password', 'api_key', 'private_key', 'github_token', 'webhook_secret']);

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
