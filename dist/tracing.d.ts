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
