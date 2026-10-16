/**
 * Extended input validation utilities for TrustBridge Action.
 * Provides reusable validators with detailed error messages.
 *
 * ## OpenTelemetry-style spans
 *
 * Every public validator records a lightweight, structured span via
 * `recordSpan()`. Spans are purely in-process and carry:
 *   - `name`       – validator identity (e.g. "validateContractAddress")
 *   - `attributes` – key/value pairs relevant to the call (no PII values)
 *   - `status`     – "ok" | "error"
 *   - `durationMs` – wall-clock time of the validation logic
 *   - `error`      – error message if status is "error"
 *
 * Spans are exported through `getSpans()` / `clearSpans()`. In a GitHub
 * Actions context they are surfaced as debug log lines when `debug_mode`
 * is enabled. In tests they can be inspected directly to assert
 * observability behaviour without mocking `core.debug`.
 *
 * This is an intentionally thin, zero-dependency implementation that
 * mirrors the OpenTelemetry Traces data model (SpanStatus, Attributes)
 * without pulling in the full OTEL SDK, keeping the action bundle small.
 * A real OTEL exporter can be plugged in by replacing `recordSpan()`.
 */
/** Mirror of the OTel SpanStatus codes relevant to validation. */
export type SpanStatus = 'ok' | 'error';
/** Lightweight span record — mirrors the OTel Span data model. */
export interface ValidationSpan {
    /** Validator function name (e.g. "validateContractAddress"). */
    name: string;
    /** Structured attributes attached to the span. Never contains raw PII values. */
    attributes: Record<string, string | number | boolean>;
    /** Outcome of the validation. */
    status: SpanStatus;
    /** Wall-clock duration of the validation in milliseconds. */
    durationMs: number;
    /** Unix timestamp (ms) when the span started. */
    startTimeMs: number;
    /** Error message when status is "error", undefined otherwise. */
    error?: string;
}
/**
 * Return all recorded validation spans (for testing or debug export).
 * Returns a shallow copy so callers cannot mutate the internal store.
 */
export declare function getSpans(): ValidationSpan[];
/**
 * Clear all recorded spans (call in test `afterEach` or on action start).
 */
export declare function clearSpans(): void;
export interface ValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
}
/**
 * Validates a numeric input string with min/max bounds.
 */
export declare function validateNumericInput(value: string, fieldName: string, options?: {
    min?: number;
    max?: number;
    allowNegative?: boolean;
}): ValidationResult;
/**
 * Validates a Soroban contract address ("C-address") against the
 * StrKey structural policy: must be exactly 56 characters, start with
 * "C", and use only the Stellar base32 alphabet (A-Z, 2-7).
 *
 * Records an OTel-style span for every call (success and failure).
 */
export declare function validateContractAddress(address: string): ValidationResult;
/**
 * Validates an asset code (e.g., "USDC", "ETH", "BTC").
 *
 * Records an OTel-style span for every call.
 */
export declare function validateAssetCode(code: string): ValidationResult;
/**
 * Validates a URL format and protocol.
 *
 * Records an OTel-style span. The URL value itself is not placed in span
 * attributes to avoid leaking potentially sensitive endpoint paths; only the
 * protocol and field name are recorded.
 */
export declare function validateUrl(url: string, fieldName: string, options?: {
    protocols?: string[];
}): ValidationResult;
/**
 * Combines multiple validation results into a single summary.
 */
export declare function combineResults(...results: ValidationResult[]): ValidationResult;
/**
 * Validates a URL for use in consumer-supplied trustbridge.yml config,
 * blocking SSRF targets (private IPs, loopback, metadata endpoints, file://).
 *
 * Enforces https-only by default; pass `{ allowHttp: true }` only for
 * testnet convenience (never for production).
 */
export declare function validateSsrfSafeUrl(url: string, fieldName: string, options?: {
    allowHttp?: boolean;
}): ValidationResult;
/**
 * Sanitizes a single string field read from a consumer trustbridge.yml,
 * returning a ValidationResult.  Callers should reject the entire config
 * if any field fails.
 */
export declare function sanitizeConfigString(value: string, fieldName: string): ValidationResult;
/**
 * Well-known field names in a trustbridge.yml that may carry secret
 * material (API keys, tokens, private keys).  Values for these fields are
 * never logged and are redacted to `***` in any sanitized snapshot.
 */
export declare const SECRET_FIELD_NAMES: Set<string>;
/**
 * Redacts secret fields in a consumer-supplied config object.  Any key
 * whose name appears in `SECRET_FIELD_NAMES` has its value replaced with
 * `"***"` in the returned object.  All other keys are returned as-is.
 *
 * The original object is never mutated; a shallow copy is returned.
 */
export declare function redactSecretFields(config: Record<string, unknown>): Record<string, unknown>;
/**
 * Represents a parsed and validated trustbridge.yml consumer config.
 * All fields are optional so the reader can be used for partial overrides.
 */
export interface TrustbridgeConsumerConfig {
    /** Override for the Horizon API base URL. */
    horizon_url?: string;
    /** Optional fallback Horizon URL. */
    horizon_url_fallback?: string;
    /** Optional Soroban RPC fallback URL. */
    rpc_fallback_url?: string;
    /** Asset code override (e.g. "USDC"). */
    asset_code?: string;
    /** Asset issuer override. */
    asset_issuer?: string;
    /** Minimum XLM reserve override. */
    min_xlm_reserve?: string;
    /** Whether to fail the step on missing checks. */
    fail_on_missing?: boolean;
}
/**
 * Validates a parsed trustbridge.yml object against the full security
 * policy: SSRF-safe URLs, injection-clean strings, and contract-address
 * format for any C-address issuer.
 *
 * Returns a `ValidationResult` whose `errors` list every violation found
 * so the caller can surface them all at once rather than one-at-a-time.
 */
export declare function validateTrustbridgeConfig(raw: Record<string, unknown>): ValidationResult;
