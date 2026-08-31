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
    allowPathTraversal?: boolean;
}): ValidationResult;
/**
 * Combines multiple validation results into a single summary.
 */
export declare function combineResults(...results: ValidationResult[]): ValidationResult;
/**
 * Private IP ranges and loopback patterns that must never appear in a
 * consumer-supplied Horizon or RPC URL (SSRF prevention).
 *
 * ## Horizon SSRF Allowlist (Wave #20)
 *
 * Any URL that reaches `validateSsrfSafeUrl` is blocked if it matches any
 * entry in this list. The allowlist is intentionally _block_-oriented:
 * everything is permitted unless it matches a known-dangerous pattern.
 *
 * Blocked categories:
 *   - IPv4 loopback (127.x.x.x)
 *   - IPv4 link-local (169.254.x.x) — includes AWS/GCP/Azure metadata
 *   - IPv4 private class-A (10.x.x.x)
 *   - IPv4 private class-B (172.16–31.x.x)
 *   - IPv4 private class-C (192.168.x.x)
 *   - IPv6 loopback (::1)
 *   - IPv6 link-local (fe80::)
 *   - Bare "localhost" hostname
 *   - AWS instance metadata (169.254.169.254)
 *   - GCP metadata (metadata.google.internal)
 *   - file:// protocol
 *
 * Exported as `SSRF_BLOCKED_PATTERNS` so the CI audit job and tests can
 * assert that every category is covered without re-implementing the list.
 */
export declare const SSRF_BLOCKED_PATTERNS: RegExp[];
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
 * Convenience wrapper: validates a Horizon (or RPC fallback) URL against
 * the full SSRF block-list. Intended as the single entry-point used in
 * the CI audit job (Wave #20) and anywhere a Horizon URL is accepted.
 *
 * Compared to the lower-level `validateSsrfSafeUrl` this helper:
 *   - Always allows both http and https (testnet runs use http)
 *   - Uses the exported `SSRF_BLOCKED_PATTERNS` list so the audit can
 *     introspect the exact list that is enforced at runtime
 *
 * @param url       The candidate Horizon or RPC URL.
 * @param fieldName Human-readable field label used in error messages.
 */
export declare function validateHorizonUrl(url: string, fieldName?: string, options?: {
    allowHttp?: boolean;
    allowlist?: string[];
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
    /** Optional minimum asset balance floor. */
    min_asset_balance?: string;
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
/** Live Stellar reserve-relevant counters read from a Horizon account. */
export interface AccountReserveState {
    /** Number of subentries (trustlines, offers, data entries, signers). */
    subentryCount: number;
    /** Number of reserve entries this account is sponsoring for others. */
    numSponsoring: number;
    /** Number of this account's own reserve entries sponsored by others. */
    numSponsored: number;
}
/** Result of a dynamic reserve computation, extending the base validation shape. */
export interface DynamicReserveResult extends ValidationResult {
    /** Network-enforced base reserve requirement computed from account state. */
    baseReserveRequirement: number;
    /** Additional safety buffer applied on top of the base requirement. */
    bufferXlm: number;
    /** baseReserveRequirement + bufferXlm — the total XLM the account must hold. */
    totalRequirement: number;
}
/**
 * Computes the real Stellar network minimum balance for an account from its
 * live subentry/sponsorship counters, per the protocol formula:
 *   (2 + subentries + sponsoring - sponsored) * baseReserve
 *
 * Malformed (negative or non-finite) counters are treated as 0 rather than
 * allowed to reduce the computed requirement — a corrupt or partial Horizon
 * response must never cause the engine to under-report what's required.
 */
export declare function computeBaseReserveRequirement(state: AccountReserveState, baseReserveXlm?: number): number;
/**
 * Validates that an account's actual XLM balance meets the dynamically
 * computed reserve requirement (base reserve for its live subentry/
 * sponsorship state, plus an optional safety buffer).
 *
 * Records an OTel-style span. Attributes carry only counts and computed
 * numbers — never a raw account balance or address.
 */
export declare function validateDynamicReserve(state: AccountReserveState, actualXlmBalance: number, options?: {
    bufferXlm?: number;
    baseReserveXlm?: number;
}): DynamicReserveResult;
/**
 * Computes the effective minimum reserve to enforce for an account: the
 * greater of the maintainer-configured static floor and the dynamically
 * computed requirement (base reserve for current account state, plus any
 * configured buffer). Never returns less than `configuredMinXlmReserve`, so
 * enabling the dynamic engine can only raise the bar, never lower it below
 * what a maintainer explicitly set.
 */
export declare function computeEffectiveReserveRequirement(configuredMinXlmReserve: number, state: AccountReserveState, options?: {
    bufferXlm?: number;
    baseReserveXlm?: number;
}): number;
