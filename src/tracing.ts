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
 * Record a synchron

/* … truncated 6677 chars — edit only what you need near the top … */
