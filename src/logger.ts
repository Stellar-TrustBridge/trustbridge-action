import * as core from '@actions/core';

/**
 * Enhanced logging with context and structured output.
 * Useful for debugging TrustBridge Action execution.
 *
 * Every user-identifying or account-identifying value that could reach a
 * log line is run through a redaction step before it is written to GitHub
 * Actions log output. See `redactStellarAddress`, `redactHorizonUrl`, and
 * `redactContext` for the exact policies.
 *
 * Structured logs always carry a stable `reason_code` and `check` label so
 * Wave CI failures can be grepped and triaged automatically (Issue #771).
 */

export interface LogContext {
  component?: string;
  stellarAddress?: string;
  horizonUrl?: string;
  reason_code?: string;
  check?: string;
  [key: string]: unknown;
}

/**
 * Stable structured field keys that every structured log line must include
 * so automated triage can grep Wave CI failures (Issue #771).
 */
export const STRUCTURED_FIELD_KEYS = ['reason_code', 'check'] as const;

/**
 * Fallback values used when a caller does not supply a structured field.
 * These keep the keys present (never `undefined`) so log lines stay
 * greppable even on unexpected failure paths.
 */
export const DEFAULT_REASON_CODE = 'unknown';

export const DEFAULT_CHECK_LABEL = 'unknown';

/**
 * Normalize a structured field value to a non-empty string. Empty, nullish,
 * or whitespace-only values fall back to the provided default so the key is
 * always emitted with a stable, greppable value.
 */
function normalizeStructuredField(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return fallback;
}

/**
 * Ensure a log context always carries the structured `reason_code` and
 * `check` fields. Existing values are preserved (trimmed); missing or empty
 * values are filled with stable defaults so the keys are never absent.
 */
export function withStructuredFields(context: LogContext = {}): LogContext {
  return {
    ...context,
    reason_code: normalizeStructuredField(context.reason_code, DEFAULT_REASON_CODE),
    check: normalizeStructuredField(context.check, DEFAULT_CHECK_LABEL),
  };
}

/**
 * Well-known context keys whose string values always carry a Stellar
 * address (G-address or C-address) and must be redacted.
 */
const ADDRESS_CONTEXT_KEYS = new Set<string>([
  'stellarAddress',
  'stellar_address',
  'assetIssuer',
  'asset_issuer',
  'issuer',
  'accountId',
  'account_id',
  'contractAddress',
  'contract_address',
  // Issue #730 — Soroban SAC issuers are contract ids (C-addresses). Any log
  // context key that carries one must be redacted exactly like a G-address so
  // debug output never leaks a full contract id.
  'contractId',
  'contract_id',
  'sacContractId',
  'issuerContractId',
]);

/**
 * Pattern matching Stellar account identifiers that may appear in logs:
 * classic G-addresses (56 chars), C-addresses / Soroban contracts (56 chars),
 * and short-form M-address-like patterns (56 chars starting with M).
 * All standard StrKey addresses begin with G or C and are exactly 56 characters.
 *
 * Issue #675 — boundaries follow the StrKey alphabet rather than `\b`, so the
 * match covers exactly what `validation.ts` accepts as a C-address
 * (`/^C[A-Z2-7]{55}$/`) and a G-address, wherever it is embedded. `\b`
 * treated `_`, lowercase letters and digits as word characters, so a
 * contract id glued to an identifier (`sac_CAAA…`, `issuer=xCAAA…`) leaked
 * unredacted. A 56-char run that is part of a longer base32 run is still
 * left alone.
 */
const STELLAR_ADDRESS_REGEX = /(?<![A-Z2-7])([GC][A-Z2-7]{55})(?![A-Z2-7])/g;

/**
 * Compact JWS/JWT (`header.payload.signature`, base64url). OIDC ID tokens
 * must never reach a log line even inside a provider error message
 * (Issue #674).
 */
const JWT_REGEX = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

/**
 * Pattern matching muxed M-addresses in free-form text.
 * Muxed accounts encode as 69 characters: M + 68 base32 chars (version byte,
 * 32-byte ed25519 key, 8-byte muxed ID, 2-byte CRC-16/XMODEM checksum).
 * These are distinct from G/C addresses and require a separate regex.
 */
const MUXED_ADDRESS_REGEX = /\bM[A-Z2-7]{68}\b/g;

const PEM_PRIVATE_KEY_REGEX =
  /-----BEGIN[ A-Z0-9_-]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z0-9_-]* PRIVATE KEY-----/gi;

const SECRET_ASSIGNMENT_REGEX =
  /((?:[A-Za-z0-9_-]*?(?:token|secret|signature|hmac|key|auth|authorization)[A-Za-z0-9_-]*?)\s*(?:=|:)\s*)(?!-----BEGIN)([^\s,;]+)/gi;

const SENSITIVE_SECRET_KEYS = new Set<string>([
  'token',
  'githubtoken',
  'github_token',
  'githubapptoken',
  'github_app_token',
  'apptoken',
  'app_token',
  'key',
  'privatekey',
  'private_key',
  'appprivatekey',
  'app_private_key',
  'secret',
  'secretkey',
  'secret_key',
  'apikey',
  'api_key',
  'auth',
  'authorization',
  'password',
]);

export function isSensitiveSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  const normalized = lower.replace(/[-_]/g, '');
  return (
    SENSITIVE_SECRET_KEYS.has(lower) ||
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('privatekey') ||
    normalized.includes('signature') ||
    normalized.includes('hmac') ||
    normalized.includes('authorization') ||
    normalized.includes('auth')
  );
}

/**
 * Redacts a single Stellar address to its first 4 and last 4 characters,
 * separated by `...`. Handles:
 *   - G-addresses and C-addresses (Soroban contracts): exactly 56 characters.
 *   - Muxed M-addresses: exactly 69 characters (M + 68 base32 chars).
 * Non-address strings are returned unchanged so non-address log values
 * never collide with the redaction pass.
 *
 * Examples:
 *   redactStellarAddress('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
 *     => 'GA5Z...KZVN'
 *   redactStellarAddress('MA7QYNF7SOWQ3GLR2BGMZEHXR8' + 'A'.repeat(43))
 *     => 'MA7Q...AAAA'
 */
export function redactStellarAddress(address: string): string {
  if (!address) return address;
  const trimmed = address.trim();
  const first = trimmed.charAt(0);

  // Muxed M-address: exactly 69 chars
  if (first === 'M' && trimmed.length === 69) {
    MUXED_ADDRESS_REGEX.lastIndex = 0;
    if (MUXED_ADDRESS_REGEX.test(trimmed)) {
      MUXED_ADDRESS_REGEX.lastIndex = 0;
      return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
    }
    MUXED_ADDRESS_REGEX.lastIndex = 0;
    return address;
  }

  // Classic G-address or C-address: exactly 56 chars
  if ((first === 'G' || first === 'C') && trimmed.length === 56) {
    STELLAR_ADDRESS_REGEX.lastIndex = 0;
    if (!STELLAR_ADDRESS_REGEX.test(trimmed)) {
      // Reset regex state (global flag); bail out if it's not a clean match.
      STELLAR_ADDRESS_REGEX.lastIndex = 0;
      return address;
    }
    STELLAR_ADDRESS_REGEX.lastIndex = 0;
    return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
  }

  return address;
}

/**
 * Redact a Soroban contract id (C-address) for log output (Issue #730).
 *
 * SAC issuers are contract ids, not accounts, but they carry exactly the same
 * redaction requirement: a debug log line must never contain the full
 * contract id. Delegates to {@link redactStellarAddress} so the C-address and
 * G-address policies can never drift apart, and returns the input unchanged
 * when it is not a well-formed C-address so a non-address value is never
 * mangled.
 *
 * Examples:
 *   redactContractAddress('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM')
 *     => 'CAAA...D2KM'
 */
export function redactContractAddress(contractId: string): string {
  if (!contractId) return contractId;
  const trimmed = contractId.trim();
  if (!/^C[A-Z2-7]{55}$/.test(trimmed)) {
    return contractId;
  }
  return redactStellarAddress(trimmed);
}

/**
 * Redacts every Stellar address (G-, C-, and muxed M-addresses), JWT and PEM
 * private key embedded in an arbitrary free-form string — error messages,
 * Horizon URLs, JSON snippets, stack traces, etc.
 *
 * Muxed M-addresses (69 chars) are scanned first so their longer pattern
 * cannot be partially matched by the 56-char G/C regex.
 */
export function redactString(value: string): string {
  if (!value) return value;
  let masked = value.replace(PEM_PRIVATE_KEY_REGEX, '[REDACTED_PRIVATE_KEY]');
  masked = masked.replace(SECRET_ASSIGNMENT_REGEX, (_match, prefix: string, rawValue: string) => {
    if (rawValue.startsWith('-----') || rawValue.startsWith('[REDACTED')) {
      return `${prefix}${rawValue}`;
    }
    return `${prefix}[REDACTED]`;
  });
  masked = masked.replace(JWT_REGEX, '[REDACTED_JWT]');
  // Redact muxed M-addresses (69 chars) before G/C addresses (56 chars)
  MUXED_ADDRESS_REGEX.lastIndex = 0;
  masked = masked.replace(MUXED_ADDRESS_REGEX, (match) => `${match.slice(0, 4)}...${match.slice(-4)}`);
  STELLAR_ADDRESS_REGEX.lastIndex = 0;
  return masked.replace(STELLAR_ADDRESS_REGEX, (match) => redactStellarAddress(match));
}

/**
 * Redacts a Horizon endpoint URL so any embedded account address in the
 * path (e.g. `/accounts/G...`) is masked and any query-string values
 * matching an address shape are masked before the URL reaches a log line.
 * The base hostname / protocol is preserved so operators can still verify
 * which Horizon instance was called.
 *
 * Handles all three Stellar address forms:
 *   - G-addresses and C-addresses (56 chars)
 *   - Muxed M-addresses (69 chars)
 */
export function redactHorizonUrl(url: string): string {
  if (!url) return url;
  const hadTrailingSlash = /\/(?:\?|#|$)/.test(url);
  // Redact muxed M-addresses (69 chars) in path segments first
  let masked = url.replace(
    /\/accounts\/(M[A-Z2-7]{68})([^A-Z2-7]|$)/g,
    (_m, addr, rest) => `/accounts/${addr.slice(0, 4)}...${addr.slice(-4)}${rest ?? ''}`,
  );
  // Then redact classic G/C addresses (56 chars) in path segments
  masked = masked.replace(
    /\/accounts\/([GC][A-Z2-7]{55})([^A-Z2-7]|$)/g,
    (_m, addr, rest) => `/accounts/${redactStellarAddress(addr)}${rest ?? ''}`,
  );
  try {
    const parsed = new URL(masked);
    const safeParams = new URLSearchParams();
    for (const [key, rawValue] of parsed.searchParams.entries()) {
      if (isSensitiveSecretKey(key)) {
        safeParams.set(key, '[REDACTED]');
      } else {
        safeParams.set(key, redactString(rawValue));
      }
    }
    const query = safeParams.toString();
    parsed.search = query ? `?${query}` : '';
    masked = parsed.toString();
    if (hadTrailingSlash && !masked.endsWith('/')) {
      masked = `${masked}/`;
    }
    return masked;
  } catch {
    // Not a parseable URL — fall back to string-level redaction.
    masked = redactString(masked);
  }
  return masked;
}

/**
 * Redacts a log context object. Address-bearing keys are masked with
 * {@link redactStellarAddress}; sensitive secret keys are replaced with
 * `[REDACTED]`; all other string values are passed through
 * {@link redactString} so embedded addresses never leak.
 */
export function redactContext(context: LogContext = {}): LogContext {
  const redacted: LogContext = {};
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined || value === null) {
      redacted[key] = value;
      continue;
    }
    if (isSensitiveSecretKey(key)) {
      redacted[key] = '[REDACTED]';
      continue;
    }
    if (typeof value === 'string') {
      if (ADDRESS_CONTEXT_KEYS.has(key)) {
        redacted[key] = redactStellarAddress(value);
      } else if (key === 'horizonUrl') {
        redacted[key] = redactHorizonUrl(value);
      } else {
        redacted[key] = redactString(value);
      }
      continue;
    }
    // Deep-redact nested objects/arrays (Issue #225) so tokens embedded in
    // structured context values can never reach the Actions log unmasked.
    redacted[key] = redactValue(value);
  }
  return redacted;
}

/**
 * Format a structured log line. Always includes the `reason_code` and
 * `check` fields (Issue #771) so Wave CI failures can be grepped, and
 * redacts the context before serialization.
 */
export function formatStructuredLog(message: string, context: LogContext = {}): string {
  const safeContext = redactContext(withStructuredFields(context));
  return `${redactString(message)} ${JSON.stringify(safeContext)}`;
}

function emit(level: 'info' | 'warning' | 'error', message: string, context: LogContext = {}): void {
  const line = formatStructuredLog(message, context);
  if (level === 'error') {
    core.error(line);
  } else if (level === 'warning') {
    core.warning(line);
  } else {
    core.info(line);
  }
}

export function logInfo(message: string, context: LogContext = {}): void {
  emit('info', message, context);
}

export function logWarning(message: string, context: LogContext = {}): void {
  emit('warning', message, context);
}

export function logError(message: string, context: LogContext = {}): void {
  emit('error', message, context);
}

// ---------------------------------------------------------------------------
// StructuredLogger, Horizon retry helpers and the shared `logger` instance.
// Restored after the #771 rewrite dropped them while src/horizon.ts,
// src/webhook.ts and ~10 other modules still import `logger`.
// ---------------------------------------------------------------------------

function redactValue(raw: unknown): unknown {
  if (typeof raw === 'string') return redactString(raw);
  if (raw === null || raw === undefined) return raw;
  if (Array.isArray(raw)) return raw.map((item) => redactValue(item));
  if (typeof raw === 'object') {
    const safeObj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (isSensitiveSecretKey(k)) {
        safeObj[k] = '[REDACTED]';
      } else if (ADDRESS_CONTEXT_KEYS.has(k) && typeof v === 'string') {
        safeObj[k] = redactStellarAddress(v);
      } else if (k === 'horizonUrl' && typeof v === 'string') {
        safeObj[k] = redactHorizonUrl(v);
      } else {
        safeObj[k] = redactValue(v);
      }
    }
    return safeObj;
  }
  return raw;
}

class StructuredLogger {
  private debugMode: boolean;

  constructor(debugMode: boolean = false) {
    this.debugMode = debugMode;
  }

  /**
   * Enable or disable debug output.
   */
  setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
  }

  /**
   * Log an informational message.
   */
  info(message: string, context?: LogContext): void {
    core.info(this.formatMessage(redactString(message), redactContext(context)));
  }

  /**
   * Log a warning message.
   */
  warn(message: string, context?: LogContext): void {
    core.warning(this.formatMessage(redactString(message), redactContext(context)));
  }

  /**
   * Log an error message.
   */
  error(message: string, context?: LogContext, error?: Error): void {
    let fullMessage = this.formatMessage(redactString(message), redactContext(context));
    if (error) {
      fullMessage += `\n  Error: ${redactString(error.message)}`;
      if (error.stack) {
        fullMessage += `\n  Stack: ${redactString(error.stack)}`;
      }
    }
    core.error(fullMessage);
  }

  /**
   * Log a debug message (only shown in debug mode).
   */
  debug(message: string, context?: LogContext): void {
    if (this.debugMode) {
      core.debug(this.formatMessage(`[DEBUG] ${redactString(message)}`, redactContext(context)));
    }
  }

  /**
   * Log a structured Horizon retry event (Issue #697).
   *
   * Scheduled retries are written at debug level; final exhaustion is
   * written at warning level so operators can find rate-limit failures
   * without enabling debug mode. The context always uses the fixed
   * {@link HORIZON_RETRY_LOG_FIELDS} schema and is run through
   * `redactContext` like every other log line.
   */
  horizonRetry(event: HorizonRetryEvent): void {
    const level = horizonRetryLogLevel(event);
    const message = formatHorizonRetryMessage(event);
    const context = buildHorizonRetryLogContext(event);
    if (level === 'warning') {
      this.warn(message, context);
    } else if (level === 'info') {
      this.info(message, context);
    } else {
      this.debug(message, context);
    }
  }

  /**
   * Log performance metrics.
   */
  logMetric(name: string, value: number, unit: string = 'ms', context?: LogContext): void {
    const message = `METRIC: ${name}=${value}${unit}`;
    this.info(message, context);
  }

  /**
   * Format a message with context information.
   *
   * Precondition: `message` and every string in `context` have already
   * been run through their respective redaction helpers. This method is
   * purely responsible for layout.
   */
  private formatMessage(message: string, context?: LogContext): string {
    if (!context) {
      return message;
    }

    const parts: string[] = [message];

    if (context.component) {
      parts.push(`[${context.component}]`);
    }

    const otherKeys = Object.keys(context).filter((k) => k !== 'component');
    if (otherKeys.length > 0) {
      const contextStr = otherKeys
        .map((k) => `${k}=${stringifyForLog(context[k])}`)
        .join(', ');
      parts.push(`(${contextStr})`);
    }

    return parts.join(' ');
  }
}

function stringifyForLog(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '[Unserializable]';
  }
}

/**
 * Structured Horizon retry event (Issue #697).
 *
 * - `scheduled`: a retry will be attempted after `delayMs`.
 * - `exhausted`: no further retries will be attempted; the request fails.
 */
export interface HorizonRetryEvent {
  phase: 'scheduled' | 'exhausted';
  /** Zero-based index of the attempt that just failed. */
  attempt: number;
  /** Total attempts allowed (maxRetries + 1). */
  maxAttempts: number;
  /** HTTP status of the failed attempt; 0 for transport errors. */
  status: number;
  /** Wait before the next attempt (0 when exhausted). */
  delayMs: number;
  /** True when the wait was clamped by retry_max_delay_ms. */
  capped: boolean;
  /** What failed: an HTTP status, a timeout, or a network error. */
  kind: 'http' | 'timeout' | 'network';
  /** Which endpoint was used: the primary horizon_url or a fallback. */
  endpointKind: 'primary' | 'fallback';
  /** Horizon base URL; reduced to a query-free, redacted base before logging. */
  horizonUrl: string;
  /** Account being fetched; redacted to first-4/last-4 before logging. */
  stellarAddress?: string;
  /** True when the delay came from a Retry-After header. */
  retryAfterFromHeader?: boolean;
  /** Why retries stopped (exhausted phase only). */
  reason?: 'max_retries' | 'wait_budget';
}

export type HorizonRetryLogLevel = 'debug' | 'info' | 'warning';

/**
 * Fixed field names emitted with every Horizon retry log line. Documented in
 * docs/TROUBLESHOOTING.md — keep both in sync.
 */
export const HORIZON_RETRY_LOG_FIELDS = [
  'event',
  'phase',
  'endpointKind',
  'horizonUrl',
  'stellarAddress',
  'attempt',
  'maxAttempts',
  'nextAttempt',
  'status',
  'kind',
  'delayMs',
  'capped',
  'retryAfterFromHeader',
  'reasonCode',
] as const;

/** reason_code-style tag for a Horizon retry event. */
export const HORIZON_RETRY_REASON_CODES = {
  scheduled: 'HORIZON_RETRY_SCHEDULED',
  max_retries: 'HORIZON_RETRIES_EXHAUSTED',
  wait_budget: 'HORIZON_WAIT_BUDGET_EXHAUSTED',
} as const;

/**
 * Choose the log level for a retry event: scheduled retries are debug noise,
 * final exhaustion is a warning.
 */
export function horizonRetryLogLevel(event: HorizonRetryEvent): HorizonRetryLogLevel {
  return event.phase === 'exhausted' ? 'warning' : 'debug';
}

/**
 * Reduce a Horizon URL to its redacted base: credentials, query string and
 * fragment are dropped so failover logs can say which host was used without
 * leaking query params, and any account path segment is masked.
 */
export function redactHorizonBaseUrl(url: string): string {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return redactHorizonUrl(parsed.toString().replace(/\/$/, ''));
  } catch {
    return redactHorizonUrl(url.split(/[?#]/)[0]);
  }
}

function horizonRetryReasonCode(event: HorizonRetryEvent): string {
  if (event.phase === 'scheduled') return HORIZON_RETRY_REASON_CODES.scheduled;
  return HORIZON_RETRY_REASON_CODES[event.reason ?? 'max_retries'];
}

/**
 * Build the fixed-schema, redacted log context for a retry event. Only the
 * keys in {@link HORIZON_RETRY_LOG_FIELDS} are emitted, so no response body
 * or extra field can reach the log line.
 */
export function buildHorizonRetryLogContext(event: HorizonRetryEvent): LogContext {
  const context: LogContext = {
    component: 'horizon',
    event: 'horizon_retry',
    phase: event.phase,
    endpointKind: event.endpointKind,
    horizonUrl: redactHorizonBaseUrl(event.horizonUrl),
    stellarAddress: event.stellarAddress,
    attempt: event.attempt,
    maxAttempts: event.maxAttempts,
    nextAttempt: event.phase === 'scheduled' ? event.attempt + 1 : null,
    status: event.status,
    kind: event.kind,
    delayMs: event.phase === 'scheduled' ? Math.max(0, Math.round(event.delayMs)) : 0,
    capped: event.capped,
    retryAfterFromHeader: event.retryAfterFromHeader ?? false,
    reasonCode: horizonRetryReasonCode(event),
  };
  return redactContext(context) as LogContext;
}

/**
 * Human-readable summary line for a retry event. Contains no URL or address;
 * those live (redacted) in the structured context.
 */
export function formatHorizonRetryMessage(event: HorizonRetryEvent): string {
  if (event.phase === 'scheduled') {
    return event.kind === 'http' ? 'Horizon retry scheduled' : 'Horizon transport retry scheduled';
  }
  const what = event.kind === 'http' ? `HTTP ${event.status}` : event.kind;
  const reasonCode = horizonRetryReasonCode(event);
  return `Horizon retries exhausted (${reasonCode}): ${what} on ${event.endpointKind} endpoint after ${event.attempt + 1}/${event.maxAttempts} attempt(s)`;
}

export const logger = new StructuredLogger();

/**
 * Logs an informational message. Context values are redacted before output.
 */
export function log(message: string, context?: LogContext): void {
  const safeMessage = redactString(message);
  if (context && Object.keys(context).length > 0) {
    core.info(`${safeMessage} ${JSON.stringify(redactContext(context))}`);
  } else {
    core.info(safeMessage);
  }
}

/**
 * Logs a debug message. Only emitted when the `debug` input is enabled, but
 * the redaction pass runs unconditionally so enabling debug can never leak a
 * raw address or token into public Actions logs.
 */
export function debug(message: string, context?: LogContext): void {
  const safeMessage = redactString(message);
  if (context && Object.keys(context).length > 0) {
    core.debug(`${safeMessage} ${JSON.stringify(redactContext(context))}`);
  } else {
    core.debug(safeMessage);
  }
}

/**
 * Logs a warning message. Context values are redacted before output.
 */
export function warning(message: string, context?: LogContext): void {
  const safeMessage = redactString(message);
  if (context && Object.keys(context).length > 0) {
    core.warning(`${safeMessage} ${JSON.stringify(redactContext(context))}`);
  } else {
    core.warning(safeMessage);
  }
}

/**
 * Logs an error message. Context values are redacted before output.
 */
export function error(message: string, context?: LogContext): void {
  const safeMessage = redactString(message);
  if (context && Object.keys(context).length > 0) {
    core.error(`${safeMessage} ${JSON.stringify(redactContext(context))}`);
  } else {
    core.error(safeMessage);
  }
}

// ---------------------------------------------------------------------------
// Action inputs structured log record (log_inputs, Issue #771)
// ---------------------------------------------------------------------------

/**
 * Represents the full set of resolved action inputs that may be logged
 * as a structured JSON artifact when `log_inputs` is enabled.
 *
 * Every field that could carry a Stellar address or sensitive URL is typed
 * as `string` so the redaction helpers can process it uniformly before the
 * record reaches any log output.
 */
export interface ActionInputsLogRecord {
  horizonUrl: string;
  horizonUrlFallback: string;
  rpcFallbackUrl: string;
  assetCode: string;
  assetIssuer: string;
  minXlmReserve: string;
  /** Optional minimum trustline limit (Issue #140). */
  minTrustlineLimit?: string;
  stellarAddress: string;
  failOnMissing: boolean;
  debugMode: boolean;
  horizonTimeoutMs: number;
  stickyComment: boolean;
  waitUntilFunded: boolean;
  waitUntilFundedTimeoutMs: number;
  waitUntilFundedIntervalMs: number;
  horizonCacheTtlMs: number;
  useCache: boolean;
  horizonMaxRequests: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs: number;
  logInputs: boolean;
  allowCrossNetworkFallback?: boolean;
}

/**
 * Build a redacted copy of the resolved action inputs suitable for writing
 * to structured log output.  All Stellar addresses and Horizon/RPC URLs are
 * masked before the record is returned; no value is emitted verbatim.
 *
 * The returned object is plain JSON-serialisable — every value is a
 * primitive (string, number, boolean) so `JSON.stringify` produces a
 * deterministic, machine-readable artifact.
 */
export function buildInputsLogRecord(inputs: ActionInputsLogRecord): ActionInputsLogRecord {
  return {
    horizonUrl: redactHorizonUrl(inputs.horizonUrl),
    horizonUrlFallback: inputs.horizonUrlFallback ? redactHorizonUrl(inputs.horizonUrlFallback) : '',
    rpcFallbackUrl: inputs.rpcFallbackUrl ? redactString(inputs.rpcFallbackUrl) : '',
    assetCode: inputs.assetCode,
    assetIssuer: redactStellarAddress(inputs.assetIssuer) || redactString(inputs.assetIssuer),
    minXlmReserve: inputs.minXlmReserve,
    minTrustlineLimit: inputs.minTrustlineLimit ?? '',
    stellarAddress: redactStellarAddress(inputs.stellarAddress),
    failOnMissing: inputs.failOnMissing,
    debugMode: inputs.debugMode,
    horizonTimeoutMs: inputs.horizonTimeoutMs,
    stickyComment: inputs.stickyComment,
    waitUntilFunded: inputs.waitUntilFunded,
    waitUntilFundedTimeoutMs: inputs.waitUntilFundedTimeoutMs,
    waitUntilFundedIntervalMs: inputs.waitUntilFundedIntervalMs,
    horizonCacheTtlMs: inputs.horizonCacheTtlMs,
    useCache: inputs.useCache,
    horizonMaxRequests: inputs.horizonMaxRequests,
    maxRetries: inputs.maxRetries ?? 3,
    retryBaseDelayMs: inputs.retryBaseDelayMs ?? 1000,
    retryMaxDelayMs: inputs.retryMaxDelayMs ?? 30000,
    logInputs: inputs.logInputs,
    allowCrossNetworkFallback: inputs.allowCrossNetworkFallback ?? false,
  };
}

/**
 * Emit a structured JSON log record of all resolved action inputs to GitHub
 * Actions log output.  The record is built via `buildInputsLogRecord` so
 * every address/URL field is already redacted before it is written.
 *
 * The record is emitted with `core.info` so it is always visible (not gated
 * on debug mode) whenever the caller opts in via `log_inputs: true`.
 *
 * @param inputs  The raw resolved inputs from `src/index.ts`.
 */
export function emitInputsLogRecord(inputs: ActionInputsLogRecord): void {
  const redacted = buildInputsLogRecord(inputs);
  core.info(`[TrustBridge] action inputs: ${JSON.stringify(redacted)}`);
}
