import * as core from '@actions/core';

/**
 * Enhanced logging with context and structured output.
 * Useful for debugging TrustBridge Action execution.
 *
 * Every user-identifying or account-identifying value that could reach a
 * log line is run through a redaction step before it is written to GitHub
 * Actions log output. See `redactStellarAddress`, `redactHorizonUrl`, and
 * `redactContext` for the exact policies.
 */

export interface LogContext {
  component?: string;
  stellarAddress?: string;
  horizonUrl?: string;
  [key: string]: unknown;
}

/**
 * Well-known context keys whose string values always carry a Stellar
 * address (G-address or C-address) and must be redacted.
 */
const ADDRESS_CONTEXT_KEYS = new Set<string>([
  'stellarAddress',
  'assetIssuer',
  'accountId',
  'account_id',
  'contractAddress',
]);

/**
 * Pattern matching Stellar account identifiers that may appear in logs:
 * classic G-addresses, C-addresses (Soroban contracts), and muxed M-addresses.
 * All are 56 characters long and begin with G, C, or M.
 */
const STELLAR_ADDRESS_REGEX = /\b([GCM][A-Z2-7]{55})\b/g;

const PEM_PRIVATE_KEY_REGEX =
  /-----BEGIN[ A-Z0-9_-]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z0-9_-]*PRIVATE KEY-----/gi;

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
 * Redacts a single Stellar address (G- or C-address) to its first 4 and
 * last 4 characters, separated by `...`. Non-address strings are returned
 * unchanged so non-address log values never collide with the redaction
 * pass.
 *
 * Examples:
 *   redactStellarAddress('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')
 *     => 'GA5Z...KZVN'
 */
export function redactStellarAddress(address: string): string {
  if (!address) return address;
  const trimmed = address.trim();
  if (trimmed.length !== 56) return address;
  const first = trimmed.charAt(0);
  if (first !== 'G' && first !== 'C' && first !== 'M') return address;
  if (!STELLAR_ADDRESS_REGEX.test(trimmed)) {
    // Reset regex state (global flag); bail out if it's not a clean match.
    STELLAR_ADDRESS_REGEX.lastIndex = 0;
    return address;
  }
  STELLAR_ADDRESS_REGEX.lastIndex = 0;
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

/**
 * Redacts every Stellar address and PEM private key embedded in an arbitrary free-form
 * string — error messages, Horizon URLs, JSON snippets, stack traces, etc.
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
  STELLAR_ADDRESS_REGEX.lastIndex = 0;
  return masked.replace(STELLAR_ADDRESS_REGEX, (match) => redactStellarAddress(match));
}

/**
 * Redacts a Horizon endpoint URL so any embedded account address in the
 * path (e.g. `/accounts/G...`) is masked and any query-string values
 * matching an address shape are masked before the URL reaches a log line.
 * The base hostname / protocol is preserved so operators can still verify
 * which Horizon instance was called.
 */
export function redactHorizonUrl(url: string): string {
  if (!url) return url;
  const hadTrailingSlash = /\/(?:\?|#|$)/.test(url);
  let masked = url.replace(
    /\/accounts\/([GCM][A-Z2-7]{55})([^A-Z2-7]|$)/g,
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
    if (!hadTrailingSlash) {
      masked = masked.replace(/\/(?=\?|#|$)/, '');
    }
  } catch {
    // If URL parsing fails (e.g. malformed URL), fall back to string redaction
  }
  return redactString(masked);
}

/**
 * Redacts a `LogContext` record in place (returns a new object, no
 * mutation) for safe logging. Policy per key type:
 *
 * - Keys in `SENSITIVE_SECRET_KEYS` → redact to '[REDACTED]'.
 * - Keys in `ADDRESS_CONTEXT_KEYS`  → run `redactStellarAddress` on the
 *   raw string value.
 * - Key == `horizonUrl`             → run `redactHorizonUrl`.
 * - Unknown string values           → scan and mask embedded addresses
 *   and PEM keys via `redactString`.
 */
export function redactContext(context: LogContext | undefined): LogContext | undefined {
  if (!context) return context;
  const safe: LogContext = {};
  for (const key of Object.keys(context)) {
    const raw = context[key];
    if (isSensitiveSecretKey(key)) {
      safe[key] = '[REDACTED]';
      continue;
    }
    if (key === 'component') {
      safe.component = raw as string | undefined;
      continue;
    }
    if (key === 'horizonUrl' && typeof raw === 'string') {
      safe.horizonUrl = redactHorizonUrl(raw);
      continue;
    }
    if (ADDRESS_CONTEXT_KEYS.has(key) && typeof raw === 'string') {
      safe[key] = redactStellarAddress(raw);
      continue;
    }
    safe[key] = redactValue(raw);
  }
  return safe;
}

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

export const logger = new StructuredLogger();

/**
 * Create a timing helper for performance measurement.
 */
export class Timer {
  private startTime: number;
  private name: string;

  constructor(name: string) {
    this.name = name;
    this.startTime = Date.now();
  }

  /**
   * Get elapsed time since timer creation.
   */
  elapsed(): number {
    return Date.now() - this.startTime;
  }

  /**
   * Log the elapsed time and reset the timer.
   */
  logAndReset(): number {
    const elapsed = this.elapsed();
    logger.logMetric(this.name, elapsed, 'ms');
    this.startTime = Date.now();
    return elapsed;
  }

  /**
   * Return a formatted elapsed time string.
   */
  toString(): string {
    const elapsed = this.elapsed();
    return `${elapsed}ms`;
  }
}

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
  minTrustlineLimit: string; // Issue #140
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
    minTrustlineLimit: inputs.minTrustlineLimit,
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
