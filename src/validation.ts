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

// ---------------------------------------------------------------------------
// Span types and in-process span store
// ---------------------------------------------------------------------------

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

const _spans: ValidationSpan[] = [];

/**
 * Return all recorded validation spans (for testing or debug export).
 * Returns a shallow copy so callers cannot mutate the internal store.
 */
export function getSpans(): ValidationSpan[] {
  return [..._spans];
}

/**
 * Clear all recorded spans (call in test `afterEach` or on action start).
 */
export function clearSpans(): void {
  _spans.length = 0;
}

/**
 * Record a completed span into the in-process store.
 * Safe to call from every validator; never throws.
 */
function recordSpan(span: ValidationSpan): void {
  try {
    _spans.push(span);
  } catch {
    // Swallow — observability must not break validation.
  }
}

/**
 * Internal helper that wraps a synchronous validation callback with span
 * instrumentation. Captures start time, duration, and status automatically.
 *
 * @param name       Span name (validator function name).
 * @param attributes Attributes to attach (no raw user-supplied values).
 * @param fn         The validation logic to run.
 * @returns          The `ValidationResult` produced by `fn`.
 */
function withSpan(
  name: string,
  attributes: ValidationSpan['attributes'],
  fn: () => ValidationResult,
): ValidationResult {
  const startTimeMs = Date.now();
  try {
    const result = fn();
    const durationMs = Date.now() - startTimeMs;
    recordSpan({
      name,
      attributes: { ...attributes, valid: result.valid, errorCount: result.errors.length },
      status: result.valid ? 'ok' : 'error',
      durationMs,
      startTimeMs,
      error: result.errors.length > 0 ? result.errors[0] : undefined,
    });
    return result;
  } catch (err) {
    const durationMs = Date.now() - startTimeMs;
    const message = err instanceof Error ? err.message : String(err);
    recordSpan({
      name,
      attributes: { ...attributes, thrown: true },
      status: 'error',
      durationMs,
      startTimeMs,
      error: message,
    });
    throw err;
  }
}



// ---------------------------------------------------------------------------
// ValidationResult (shared by all validators)
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Validators (each instrumented with an OTel-style span)
// ---------------------------------------------------------------------------

/**
 * Validates a numeric input string with min/max bounds.
 */
export function validateNumericInput(
  value: string,
  fieldName: string,
  options: {
    min?: number;
    max?: number;
    allowNegative?: boolean;
  } = {},
): ValidationResult {
  return withSpan(
    'validateNumericInput',
    { fieldName, hasMin: options.min !== undefined, hasMax: options.max !== undefined },
    () => {
      const errors: string[] = [];
      const warnings: string[] = [];

      const parsed = Number(value);
      if (Number.isNaN(parsed)) {
        errors.push(`${fieldName} must be a valid number, got: "${value}"`);
        return { valid: false, errors, warnings };
      }

      if (!options.allowNegative && parsed < 0) {
        errors.push(`${fieldName} cannot be negative, got: ${parsed}`);
      }

      if (options.min !== undefined && parsed < options.min) {
        errors.push(`${fieldName} must be >= ${options.min}, got: ${parsed}`);
      }

      if (options.max !== undefined && parsed > options.max) {
        errors.push(`${fieldName} must be <= ${options.max}, got: ${parsed}`);
      }

      return {
        valid: errors.length === 0,
        errors,
        warnings,
      };
    },
  );
}

/** Soroban contract address ("C-address") StrKey format: "C" + 55 base32 chars. */
const CONTRACT_ADDRESS_REGEX = /^C[A-Z2-7]{55}$/;

/**
 * Validates a Soroban contract address ("C-address") against the
 * StrKey structural policy: must be exactly 56 characters, start with
 * "C", and use only the Stellar base32 alphabet (A-Z, 2-7).
 *
 * Records an OTel-style span for every call (success and failure).
 */
export function validateContractAddress(address: string): ValidationResult {
  return withSpan(
    'validateContractAddress',
    // Redact the raw address — only record structural metadata in the span.
    { inputLength: address.trim().length, startsWithC: address.trim().startsWith('C') },
    () => {
      const errors: string[] = [];
      const warnings: string[] = [];

      const trimmed = address.trim();

      if (!trimmed) {
        errors.push('Contract address cannot be empty');
        return { valid: false, errors, warnings };
      }

      if (!trimmed.startsWith('C')) {
        errors.push(`Contract address must start with "C", got: "${trimmed}"`);
      }

      if (trimmed.length !== 56) {
        errors.push(`Contract address must be 56 characters, got: ${trimmed.length}`);
      }

      if (!CONTRACT_ADDRESS_REGEX.test(trimmed)) {
        errors.push(
          `Contract address must match StrKey format "C" + 55 base32 characters (A-Z, 2-7), got: "${trimmed}"`,
        );
      }

      return {
        valid: errors.length === 0,
        errors,
        warnings,
      };
    },
  );
}

/**
 * Validates an asset code (e.g., "USDC", "ETH", "BTC").
 *
 * Records an OTel-style span for every call.
 */
export function validateAssetCode(code: string): ValidationResult {
  return withSpan(
    'validateAssetCode',
    { inputLength: code.trim().length },
    () => {
      const errors: string[] = [];
      const warnings: string[] = [];

      const trimmed = code.trim();

      if (!trimmed) {
        errors.push('Asset code cannot be empty');
        return { valid: false, errors, warnings };
      }

      if (trimmed.length > 12) {
        errors.push(`Asset code must be <= 12 characters, got: ${trimmed.length}`);
      }

      if (!/^[A-Za-z0-9]+$/.test(trimmed)) {
        errors.push(`Asset code must be alphanumeric, got: "${trimmed}"`);
      }

      return {
        valid: errors.length === 0,
        errors,
        warnings,
      };
    },
  );
}

/**
 * Validates a URL format and protocol.
 *
 * Records an OTel-style span. The URL value itself is not placed in span
 * attributes to avoid leaking potentially sensitive endpoint paths; only the
 * protocol and field name are recorded.
 */
export function validateUrl(
  url: string,
  fieldName: string,
  options: { protocols?: string[] } = {},
): ValidationResult {
  return withSpan(
    'validateUrl',
    { fieldName, allowedProtocols: (options.protocols ?? ['http', 'https']).join(',') },
    () => {
      const errors: string[] = [];
      const warnings: string[] = [];

      const trimmed = url.trim();
      if (!trimmed) {
        errors.push(`${fieldName} cannot be empty`);
        return { valid: false, errors, warnings };
      }

      try {
        const parsed = new URL(trimmed);
        const allowedProtos = options.protocols || ['http', 'https'];

        if (!allowedProtos.includes(parsed.protocol.replace(':', ''))) {
          errors.push(
            `${fieldName} must use one of these protocols: ${allowedProtos.join(', ')}`,
          );
        }
      } catch {
        errors.push(`${fieldName} is not a valid URL: "${trimmed}"`);
      }

      return {
        valid: errors.length === 0,
        errors,
        warnings,
      };
    },
  );
}

/**
 * Combines multiple validation results into a single summary.
 */
export function combineResults(...results: ValidationResult[]): ValidationResult {
  const allErrors = results.flatMap((r) => r.errors);
  const allWarnings = results.flatMap((r) => r.warnings);

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
  };
}

// ---------------------------------------------------------------------------
// Issue #45 — trustbridge.yml consumer config reader security layer
// ---------------------------------------------------------------------------

/**
 * Private IP ranges and loopback patterns that must never appear in a
 * consumer-supplied Horizon or RPC URL (SSRF prevention).
 */
const SSRF_BLOCKED_PATTERNS: RegExp[] = [
  // IPv4 loopback
  /^https?:\/\/127\./,
  // IPv4 link-local
  /^https?:\/\/169\.254\./,
  // IPv4 private class-A
  /^https?:\/\/10\./,
  // IPv4 private class-B
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,
  // IPv4 private class-C
  /^https?:\/\/192\.168\./,
  // IPv6 loopback / link-local
  /^https?:\/\/\[?::1\]?/,
  /^https?:\/\/\[?fe80:/i,
  // Bare "localhost"
  /^https?:\/\/localhost[:/]/i,
  /^https?:\/\/localhost$/i,
  // Metadata endpoints (AWS, GCP, Azure)
  /^https?:\/\/169\.254\.169\.254/,
  /^https?:\/\/metadata\.google\.internal/i,
  // file:// protocol
  /^file:\/\//i,
];

/**
 * Validates a URL for use in consumer-supplied trustbridge.yml config,
 * blocking SSRF targets (private IPs, loopback, metadata endpoints, file://).
 *
 * Enforces https-only by default; pass `{ allowHttp: true }` only for
 * testnet convenience (never for production).
 */
export function validateSsrfSafeUrl(
  url: string,
  fieldName: string,
  options: { allowHttp?: boolean } = {},
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const trimmed = url.trim();
  if (!trimmed) {
    errors.push(`${fieldName} cannot be empty`);
    return { valid: false, errors, warnings };
  }

  // Protocol check
  const allowedProtocols = options.allowHttp ? ['http', 'https'] : ['https'];
  try {
    const parsed = new URL(trimmed);
    const proto = parsed.protocol.replace(':', '');
    if (!allowedProtocols.includes(proto)) {
      errors.push(
        `${fieldName} must use ${options.allowHttp ? 'http or https' : 'https'}, got: "${proto}"`,
      );
    }
  } catch {
    errors.push(`${fieldName} is not a valid URL: "${trimmed}"`);
    return { valid: false, errors, warnings };
  }

  // SSRF pattern check
  for (const pattern of SSRF_BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      errors.push(
        `${fieldName} targets a blocked address (private IP, loopback, or metadata endpoint): "${trimmed}"`,
      );
      break;
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Characters and patterns that must not appear in consumer-supplied
 * string fields of a trustbridge.yml file (injection prevention).
 *
 * Policy:
 *   - No shell meta-characters: ; & | ` $ ( ) < > ! \
 *   - No newlines (CR or LF) — prevents header injection
 *   - No null bytes
 */
const INJECTION_PATTERNS: RegExp[] = [
  /[;&|`$()<>!\\]/,
  /[\r\n]/,
];

/** Returns true when the string contains a null byte (U+0000). */
function containsNullByte(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) === 0) return true;
  }
  return false;
}

/**
 * Sanitizes a single string field read from a consumer trustbridge.yml,
 * returning a ValidationResult.  Callers should reject the entire config
 * if any field fails.
 */
export function sanitizeConfigString(value: string, fieldName: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof value !== 'string') {
    errors.push(`${fieldName} must be a string`);
    return { valid: false, errors, warnings };
  }

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(value)) {
      errors.push(
        `${fieldName} contains a disallowed character or pattern (injection risk): "${value}"`,
      );
      return { valid: false, errors, warnings };
    }
  }

  if (containsNullByte(value)) {
    errors.push(
      `${fieldName} contains a disallowed character or pattern (injection risk): null byte`,
    );
    return { valid: false, errors, warnings };
  }

  return { valid: true, errors, warnings };
}

/**
 * Well-known field names in a trustbridge.yml that may carry secret
 * material (API keys, tokens, private keys).  Values for these fields are
 * never logged and are redacted to `***` in any sanitized snapshot.
 */
export const SECRET_FIELD_NAMES = new Set<string>([
  'github_token',
  'api_key',
  'secret',
  'secret_key',
  'private_key',
  'token',
  'password',
  'passphrase',
]);

/**
 * Redacts secret fields in a consumer-supplied config object.  Any key
 * whose name appears in `SECRET_FIELD_NAMES` has its value replaced with
 * `"***"` in the returned object.  All other keys are returned as-is.
 *
 * The original object is never mutated; a shallow copy is returned.
 */
export function redactSecretFields(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    safe[key] = SECRET_FIELD_NAMES.has(key) ? '***' : value;
  }
  return safe;
}

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
export function validateTrustbridgeConfig(
  raw: Record<string, unknown>,
): ValidationResult {
  const results: ValidationResult[] = [];

  // URL fields — SSRF-safe, https or http (http for testnet)
  for (const urlField of ['horizon_url', 'horizon_url_fallback', 'rpc_fallback_url'] as const) {
    const val = raw[urlField];
    if (val !== undefined && val !== null && val !== '') {
      if (typeof val !== 'string') {
        results.push({ valid: false, errors: [`${urlField} must be a string`], warnings: [] });
      } else {
        results.push(validateSsrfSafeUrl(val, urlField, { allowHttp: true }));
      }
    }
  }

  // String fields — injection sanitization
  for (const strField of ['asset_code', 'asset_issuer', 'min_xlm_reserve'] as const) {
    const val = raw[strField];
    if (val !== undefined && val !== null && val !== '') {
      if (typeof val !== 'string') {
        results.push({ valid: false, errors: [`${strField} must be a string`], warnings: [] });
      } else {
        results.push(sanitizeConfigString(val, strField));
      }
    }
  }

  // asset_issuer — if present and passes injection check, also validate
  // format (G-address or C-address)
  const issuerVal = raw['asset_issuer'];
  if (typeof issuerVal === 'string' && issuerVal.trim()) {
    const trimmedIssuer = issuerVal.trim();
    if (trimmedIssuer.startsWith('C')) {
      results.push(validateContractAddress(trimmedIssuer));
    } else if (trimmedIssuer.startsWith('G')) {
      // Validate G-address: 56 chars, base32 alphabet
      const G_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;
      if (trimmedIssuer.length !== 56 || !G_ADDRESS_REGEX.test(trimmedIssuer)) {
        results.push({
          valid: false,
          errors: [
            `asset_issuer must be a valid Stellar G-address (56 chars, G + 55 base32) or C-address, got: "${trimmedIssuer}"`,
          ],
          warnings: [],
        });
      }
    } else if (!SECRET_FIELD_NAMES.has('asset_issuer')) {
      // Neither G nor C — invalid format
      results.push({
        valid: false,
        errors: [`asset_issuer must start with "G" or "C", got: "${trimmedIssuer}"`],
        warnings: [],
      });
    }
  }

  // fail_on_missing — must be boolean if present
  if (raw['fail_on_missing'] !== undefined) {
    if (typeof raw['fail_on_missing'] !== 'boolean') {
      results.push({
        valid: false,
        errors: ['fail_on_missing must be a boolean (true or false)'],
        warnings: [],
      });
    }
  }

  return combineResults(...results);
}
