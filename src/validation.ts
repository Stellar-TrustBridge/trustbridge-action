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
  options: { protocols?: string[]; allowPathTraversal?: boolean } = {},
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

      let parsed: URL;
      try {
        parsed = new URL(trimmed);
      } catch {
        errors.push(`${fieldName} is not a valid URL: "${trimmed}"`);
        return { valid: false, errors, warnings };
      }

      const allowedProtos = options.protocols || ['http', 'https'];

      if (!allowedProtos.includes(parsed.protocol.replace(':', ''))) {
        errors.push(
          `${fieldName} must use one of these protocols: ${allowedProtos.join(', ')}`,
        );
      }

      if (parsed.username || parsed.password) {
        errors.push(
          `${fieldName} must not contain embedded credentials (userinfo)`,
        );
      }

      if (!options.allowPathTraversal) {
        const pathSegments = parsed.pathname.split('/');
        for (const segment of pathSegments) {
          if (segment === '..') {
            errors.push(
              `${fieldName} must not contain path traversal segments ("..")`,
            );
            break;
          }
        }
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
export const SSRF_BLOCKED_PATTERNS: RegExp[] = [
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

  // Strip embedded credentials (http://user:pass@host → http://host) so
  // SSRF patterns always match against the actual target host regardless
  // of whether the URL contains a userinfo component.
  const strippedUrl = trimmed.replace(/^(https?:\/\/)[^@/]*@/, '$1');

  // SSRF pattern check — run against credential-stripped URL
  for (const pattern of SSRF_BLOCKED_PATTERNS) {
    if (pattern.test(strippedUrl)) {
      errors.push(
        `${fieldName} targets a blocked address (private IP, loopback, or metadata endpoint): "${trimmed}"`,
      );
      break;
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

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
export function validateHorizonUrl(
  url: string,
  fieldName = 'horizon_url',
  options: { allowHttp?: boolean; allowlist?: string[] } = {},
): ValidationResult {
  // Allow http by default (testnet / private mirrors); pass allowHttp:false for https-only.
  const allowHttp = options.allowHttp !== false;
  const trimmed = url.trim();
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!trimmed) {
    return { valid: false, errors: [`${fieldName} cannot be empty`], warnings };
  }

  // Reject path traversal / dot-segments on the raw string before URL() normalizes them away.
  if (/(?:^|\/)(?:\.\.|%2e%2e)(?:\/|$)/i.test(trimmed) || /\/\.\//.test(trimmed)) {
    errors.push(`${fieldName} must not contain path traversal segments ("..") or invalid path dots`);
  }

  const ssrf = validateSsrfSafeUrl(url, fieldName, { allowHttp });
  const urlCheck = validateUrl(url, fieldName, {
    protocols: allowHttp ? ['http', 'https'] : ['https'],
  });

  for (const e of [...urlCheck.errors, ...ssrf.errors]) {
    if (!errors.includes(e)) errors.push(e);
  }
  for (const w of [...urlCheck.warnings, ...ssrf.warnings]) {
    if (!warnings.includes(w)) warnings.push(w);
  }

  // Issue #315: Strict allowlist check
  if (options.allowlist && options.allowlist.length > 0 && urlCheck.valid) {
    try {
      const parsedTarget = new URL(trimmed);
      const targetHost = parsedTarget.host.toLowerCase();

      let matched = false;
      for (const allowed of options.allowlist) {
        const cleanAllowed = allowed.trim();
        if (!cleanAllowed) continue;

        try {
          // If the allowlist entry is a full URL, parse and compare hosts
          const parsedAllowed = new URL(cleanAllowed);
          if (targetHost === parsedAllowed.host.toLowerCase()) {
            matched = true;
            break;
          }
        } catch {
          // If the allowlist entry is just a hostname/port
          if (targetHost === cleanAllowed.toLowerCase() || parsedTarget.hostname.toLowerCase() === cleanAllowed.toLowerCase()) {
            matched = true;
            break;
          }
        }
      }

      if (!matched) {
        errors.push(`${fieldName} host "${targetHost}" is not in the allowlist`);
      }
    } catch {
      // Ignore URL parse errors here, let urlCheck handle invalid format
    }
  }

  const normalizedErrors = errors.map((e) => {
    if (e.toLowerCase().includes('protocol')) return e;
    if (e.includes('must use one of these protocols') || e.includes('must use http or https') || e.includes('must use https')) {
      return e.includes('protocol') ? e : e.replace(/must use/, 'must use protocol');
    }
    return e;
  });

  return {
    valid: normalizedErrors.length === 0,
    errors: normalizedErrors,
    warnings,
  };
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
      } else if (urlField === 'horizon_url' || urlField === 'horizon_url_fallback') {
        results.push(validateHorizonUrl(val, urlField, { allowHttp: true }));
      } else {
        results.push(validateSsrfSafeUrl(val, urlField, { allowHttp: true }));
      }
    }
  }

  // String fields — injection sanitization
  for (const strField of ['asset_code', 'asset_issuer', 'min_xlm_reserve', 'min_asset_balance'] as const) {
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
    } else if (!SECRET_FIELD_NAMES.has(trimmedIssuer)) {
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

// ---------------------------------------------------------------------------
// Issue #15 — Dynamic reserve engine
// ---------------------------------------------------------------------------
//
// A static `min_xlm_reserve` input assumes a fixed number of ledger entries
// (trustlines, offers, data entries, sponsorships) on the account being
// checked. In practice an account's *actual* network-enforced minimum
// balance grows with every subentry and sponsorship it carries — Stellar
// computes it as:
//
//   minBalance = (2 + numSubentries + numSponsoring - numSponsored) * baseReserve
//
// (base reserve is 0.5 XLM on both testnet and pubnet as of this writing).
// If the static config value is lower than this real requirement, a check
// can report "reserve met" for an account that is one payout away from
// failing at Horizon submission time. The dynamic reserve engine recomputes
// the true requirement from live account state so payout gating reflects
// reality instead of a maintainer's guess made when the workflow was set up.

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

/** Threshold below which a passing check still emits a "thin margin" warning. */
const RESERVE_MARGIN_WARNING_XLM = 0.5;

function sanitizeReserveCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Default base reserve (XLM per ledger entry) on the Stellar network. */
const STELLAR_BASE_RESERVE_XLM_DEFAULT = 0.5;

/**
 * Computes the real Stellar network minimum balance for an account from its
 * live subentry/sponsorship counters, per the protocol formula:
 *   (2 + subentries + sponsoring - sponsored) * baseReserve
 *
 * Malformed (negative or non-finite) counters are treated as 0 rather than
 * allowed to reduce the computed requirement — a corrupt or partial Horizon
 * response must never cause the engine to under-report what's required.
 */
export function computeBaseReserveRequirement(
  state: AccountReserveState,
  baseReserveXlm: number = STELLAR_BASE_RESERVE_XLM_DEFAULT,
): number {
  const subentryCount = sanitizeReserveCount(state.subentryCount);
  const numSponsoring = sanitizeReserveCount(state.numSponsoring);
  const numSponsored = sanitizeReserveCount(state.numSponsored);

  const reserveEntries = 2 + subentryCount + numSponsoring - numSponsored;
  return Math.max(0, reserveEntries) * baseReserveXlm;
}

/**
 * Validates that an account's actual XLM balance meets the dynamically
 * computed reserve requirement (base reserve for its live subentry/
 * sponsorship state, plus an optional safety buffer).
 *
 * Records an OTel-style span. Attributes carry only counts and computed
 * numbers — never a raw account balance or address.
 */
export function validateDynamicReserve(
  state: AccountReserveState,
  actualXlmBalance: number,
  options: { bufferXlm?: number; baseReserveXlm?: number } = {},
): DynamicReserveResult {
  const startTimeMs = Date.now();
  const bufferXlm = options.bufferXlm !== undefined && Number.isFinite(options.bufferXlm) && options.bufferXlm > 0
    ? options.bufferXlm
    : 0;

  const errors: string[] = [];
  const warnings: string[] = [];

  if (!Number.isFinite(actualXlmBalance)) {
    errors.push(`actualXlmBalance must be a finite number, got: ${actualXlmBalance}`);
  }
  for (const [field, value] of Object.entries(state) as [string, number][]) {
    if (!Number.isFinite(value) || value < 0) {
      warnings.push(`${field} was invalid (${value}) and was treated as 0`);
    }
  }

  const baseReserveRequirement = computeBaseReserveRequirement(state, options.baseReserveXlm);
  const totalRequirement = baseReserveRequirement + bufferXlm;
  const safeActual = Number.isFinite(actualXlmBalance) ? actualXlmBalance : 0;
  const met = errors.length === 0 && safeActual >= totalRequirement;

  if (errors.length === 0 && !met) {
    errors.push(
      `XLM balance ${safeActual} is below the dynamically computed reserve requirement of ${totalRequirement} ` +
        `(base ${baseReserveRequirement} + buffer ${bufferXlm})`,
    );
  } else if (met && safeActual - totalRequirement < RESERVE_MARGIN_WARNING_XLM) {
    warnings.push(
      `XLM balance ${safeActual} clears the reserve requirement of ${totalRequirement} by less than ` +
        `${RESERVE_MARGIN_WARNING_XLM} XLM — consider funding additional headroom before future payouts.`,
    );
  }

  const result: DynamicReserveResult = {
    valid: errors.length === 0 && met,
    errors,
    warnings,
    baseReserveRequirement,
    bufferXlm,
    totalRequirement,
  };

  recordSpan({
    name: 'validateDynamicReserve',
    attributes: {
      subentryCount: sanitizeReserveCount(state.subentryCount),
      numSponsoring: sanitizeReserveCount(state.numSponsoring),
      numSponsored: sanitizeReserveCount(state.numSponsored),
      baseReserveRequirement,
      bufferXlm,
      totalRequirement,
      valid: result.valid,
      errorCount: errors.length,
    },
    status: result.valid ? 'ok' : 'error',
    durationMs: Date.now() - startTimeMs,
    startTimeMs,
    error: errors.length > 0 ? errors[0] : undefined,
  });

  return result;
}

/**
 * Computes the effective minimum reserve to enforce for an account: the
 * greater of the maintainer-configured static floor and the dynamically
 * computed requirement (base reserve for current account state, plus any
 * configured buffer). Never returns less than `configuredMinXlmReserve`, so
 * enabling the dynamic engine can only raise the bar, never lower it below
 * what a maintainer explicitly set.
 */
export function computeEffectiveReserveRequirement(
  configuredMinXlmReserve: number,
  state: AccountReserveState,
  options: { bufferXlm?: number; baseReserveXlm?: number } = {},
): number {
  const dynamic = computeBaseReserveRequirement(state, options.baseReserveXlm) + (options.bufferXlm ?? 0);
  const floor = Number.isFinite(configuredMinXlmReserve) ? configuredMinXlmReserve : 0;
  return Math.max(floor, dynamic);
}
