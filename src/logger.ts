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
    // Not a parseable URL — fall back to string-level redaction so an
    // address embedded in a malformed URL still never leaks.
    return redactString(masked);
  }
}

/**
 * Redacts a single context value based on its key and shape. Address-typed
 * keys are masked via {@link redactStellarAddress}; secret-typed keys are
 * replaced wholesale; everything else is passed through {@link redactString}
 * so embedded addresses/secrets in free-form values are still masked.
 */
function redactContextValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (isSensitiveSecretKey(key)) return '[REDACTED]';
    if (ADDRESS_CONTEXT_KEYS.has(key)) return redactStellarAddress(value);
    return redactString(value);
  }
  if (typeof value === 'object') {
    return redactContext(value as Record<string, unknown>);
  }
  return value;
}

/**
 * Redacts every value in a structured log context. Used by {@link log} and
 * {@link debug} so structured output never carries a raw address or token.
 */
export function redactContext(context: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    safe[key] = redactContextValue(key, value);
  }
  return safe;
}

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
