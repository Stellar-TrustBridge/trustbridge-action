/**
 * @file federation.ts
 * Stellar federation address resolution with SSRF-safe TOML fetch.
 *
 * Implements optional federation (`user*domain`) resolution using
 * HTTPS stellar.toml with full SSRF protection.
 *
 * Security:
 *  - HTTPS-only enforcement (via fetchSSRFSafe)
 *  - No private/internal IP ranges (SSRF blocklist)
 *  - Safe redirects (same-origin only)
 *  - Timeout and body size limits
 *  - Username validation (alphanumeric + limited special chars)
 *  - Domain validation (not private/loopback)
 *
 * Policy:
 *  - Federation resolution is OFF by default (federation_resolution_enabled: false)
 *  - Full SEP-0002 client functionality is explicitly out of scope
 */

import { fetchSSRFSafe } from './ssrf';
import { isValidStellarAddress } from './checks';
import { logger } from './logger';

/** Maximum username length for federation addresses. */
const MAX_USERNAME_LENGTH = 32;

/** Allowed characters in federation usernames (alphanumeric, hyphens, underscores, periods). */
const USERNAME_REGEX = /^[a-zA-Z0-9._-]+$/;

/** Maximum federation response body size (64 KB). */
const MAX_FEDERATION_BODY_BYTES = 64 * 1024;

/** Federation response timeout (10 seconds). */
const FEDERATION_TIMEOUT_MS = 10_000;

/**
 * Stable error codes surfaced by federation resolution failures.
 *
 * These are intentionally stable strings so callers and tests can assert on
 * them without depending on human-readable message wording.
 *
 * | Code | Meaning |
 * |---|---|
 * | `INVALID_ADDRESS` | Input is not a `user*domain` federation address. |
 * | `INVALID_USERNAME` | Username part fails length or character validation. |
 * | `INVALID_DOMAIN` | Domain part is blocked (private IP, loopback, metadata). |
 * | `TOML_FETCH_FAILED` | Fetching `stellar.toml` failed for an unclassified reason. |
 * | `TOML_NXDOMAIN` | `stellar.toml` host DNS lookup failed. |
 * | `TOML_TRUNCATED` | `stellar.toml` response body exceeded the size limit. |
 * | `TOML_TIMEOUT` | `stellar.toml` fetch timed out. |
 * | `NO_FEDERATION_SERVER` | `stellar.toml` exists but has no `FEDERATION_SERVER`. |
 * | `FEDERATION_FETCH_FAILED` | Federation server request failed for an unclassified reason. |
 * | `FEDERATION_NXDOMAIN` | Federation server host DNS lookup failed. |
 * | `FEDERATION_TRUNCATED` | Federation server response body exceeded the size limit. |
 * | `FEDERATION_TIMEOUT` | Federation server request timed out. |
 * | `INVALID_ACCOUNT_ID` | Federation response contained no valid Stellar G-address. |
 * | `MEMO_REQUIRED` | Federation response includes `memo_type` but omits the `memo` value. |
 * | `MEMO_TYPE_MISMATCH` | `memo_type` is unrecognized or the `memo` value is incompatible with the declared type (e.g. non-numeric `id`, non-hex `hash`). |
 */
export type FederationErrorCode =
  | 'INVALID_ADDRESS'
  | 'INVALID_USERNAME'
  | 'INVALID_DOMAIN'
  | 'TOML_FETCH_FAILED'
  | 'TOML_NXDOMAIN'
  | 'TOML_TRUNCATED'
  | 'TOML_TIMEOUT'
  | 'NO_FEDERATION_SERVER'
  | 'FEDERATION_FETCH_FAILED'
  | 'FEDERATION_NXDOMAIN'
  | 'FEDERATION_TRUNCATED'
  | 'FEDERATION_TIMEOUT'
  | 'INVALID_ACCOUNT_ID'
  | 'MEMO_REQUIRED'
  | 'MEMO_TYPE_MISMATCH';

/**
 * The three memo types defined by the Stellar protocol.
 *
 * - `text`  — a UTF-8 string up to 28 bytes.
 * - `id`    — an unsigned 64-bit integer (sent as a decimal string by federation servers).
 * - `hash`  — a 32-byte value encoded as a 64-character lowercase hex string.
 *
 * These values match the strings returned by SEP-0002 federation servers in
 * the `memo_type` field of a federation response.
 */
export type MemoType = 'text' | 'id' | 'hash';

/** Issue #957 — exact hex length of a `hash` memo (32 bytes). */
export const MEMO_HASH_HEX_LENGTH = 64;

/** Maximum length (bytes) of a `text` memo per the Stellar protocol. */
export const MEMO_TEXT_MAX_BYTES = 28;

/**
 * Result of a federation address resolution.
 *
 * When a federation response includes a `memo_type`, the receiving payment
 * **must** attach the corresponding `memo` to the transaction or the funds
 * will be unroutable. The `memoRequired` flag is `true` whenever `memoType`
 * is set, so callers can gate on a single boolean instead of re-checking
 * `memoType !== undefined`.
 *
 * Example — checking memo before building a payment:
 * ```ts
 * const resolution = await resolveFederationAddress('alice*example.com');
 * if (resolution && resolution.memoRequired) {
 *   // attach resolution.memo (of type resolution.memoType) to the transaction
 * }
 * ```
 */
export interface FederationResolution {
  /** The resolved Stellar G-address. */
  gAddress: string;
  /**
   * Memo type required by the destination account (`text`, `id`, or `hash`).
   * Present when the federation server returned a `memo_type` field.
   * Absent when no memo is required.
   */
  memoType?: MemoType;
  /**
   * Memo value to attach to the payment transaction.
   * Always present when `memoType` is set.
   * For `id` memos this is a decimal string representation of the numeric id.
   * For `hash` memos this is a 64-character lowercase hex string.
   */
  memo?: string;
  /**
   * `true` when the destination requires a memo (`memoType` is set).
   * Payout tools should check this flag before building a payment transaction.
   */
  memoRequired: boolean;
}

/**
 * Classifies a fetchSSRFSafe failure into a stable federation error code.
 *
 * NXDOMAIN, truncated responses, and timeouts are surfaced distinctly so
 * operators can distinguish a missing federation record from a hung lookup.
 *
 * @param error The error string returned by fetchSSRFSafe
 * @param prefix The stage prefix (TOML or FEDERATION)
 * @returns A stable error code
 */
function classifyFetchError(
  error: string,
  prefix: 'TOML' | 'FEDERATION',
): FederationErrorCode {
  const lower = (error || '').toLowerCase();
  if (
    lower.includes('nxdomain') ||
    lower.includes('enotfound') ||
    lower.includes('not found') ||
    lower.includes('no such host')
  ) {
    return `${prefix}_NXDOMAIN` as FederationErrorCode;
  }
  if (
    lower.includes('truncat') ||
    lower.includes('body too large') ||
    lower.includes('max body') ||
    lower.includes('exceeded')
  ) {
    return `${prefix}_TRUNCATED` as FederationErrorCode;
  }
  if (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('etimedout') ||
    lower.includes('aborted')
  ) {
    return `${prefix}_TIMEOUT` as FederationErrorCode;
  }
  return `${prefix}_FETCH_FAILED` as FederationErrorCode;
}

/**
 * Checks if a string looks like a federation address (user*domain format).
 *
 * @param input The string to check
 * @returns true if the input matches the federation address pattern
 */
export function isFederationAddress(input: string): boolean {
  if (!input || typeof input !== 'string') {
    return false;
  }
  const trimmed = input.trim();
  const starIndex = trimmed.indexOf('*');
  if (starIndex <= 0 || starIndex >= trimmed.length - 1) {
    return false;
  }
  // Only one * allowed
  if (trimmed.indexOf('*', starIndex + 1) !== -1) {
    return false;
  }
  return true;
}

/**
 * Parses a federation address into username and domain.
 *
 * @param input The federation address (e.g., "user*domain.com")
 * @returns Parsed components or null if invalid
 */
export function parseFederationAddress(
  input: string,
): { username: string; domain: string } | null {
  if (!input || typeof input !== 'string') {
    return null;
  }
  const trimmed = input.trim();
  const starIndex = trimmed.indexOf('*');
  if (starIndex <= 0 || starIndex >= trimmed.length - 1) {
    return null;
  }
  // Only one * allowed
  if (trimmed.indexOf('*', starIndex + 1) !== -1) {
    return null;
  }

  const username = trimmed.slice(0, starIndex).trim();
  const domain = trimmed.slice(starIndex + 1).trim();

  if (!username || !domain) {
    return null;
  }

  return { username, domain };
}

/**
 * Validates a federation username.
 *
 * @param username The username to validate
 * @returns Validation result with errors if any
 */
export function validateFederationUsername(
  username: string,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!username) {
    errors.push('Username cannot be empty');
    return { valid: false, errors };
  }

  if (username.length > MAX_USERNAME_LENGTH) {
    errors.push(`Username must be at most ${MAX_USERNAME_LENGTH} characters, got: ${username.length}`);
  }

  if (!USERNAME_REGEX.test(username)) {
    errors.push(
      `Username must contain only alphanumeric characters, hyphens, underscores, or periods`,
    );
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates a federation domain.
 *
 * @param domain The domain to validate
 * @returns Validation result with errors if any
 */
export function validateFederationDomain(
  domain: string,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!domain) {
    errors.push('Domain cannot be empty');
    return { valid: false, errors };
  }

  // Basic domain format check
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(domain)) {
    errors.push(`Invalid domain format: "${domain}"`);
  }

  // Check for private/loopback IPs embedded in domain
  const privatePatterns = [
    /^localhost$/i,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^::1$/,
    /^fe80:/i,
    /^metadata\.google\.internal$/i,
  ];

  for (const pattern of privatePatterns) {
    if (pattern.test(domain)) {
      errors.push(`Domain targets a blocked address (private IP, loopback, or metadata endpoint): "${domain}"`);
      break;
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Resolves a federation address to a Stellar G-address.
 *
 * Process:
 *  1. Parse the federation address (user*domain)
 *  2. Validate username and domain
 *  3. Fetch https://{domain}/.well-known/stellar.toml
 *  4. Parse TOML for [[FEDERATION_SERVER]]
 *  5. Fetch federation server URL with the address
 *  6. Parse JSON response for account_id
 *  7. Validate account_id is a valid G-address
 *
 * NXDOMAIN, truncated responses, and timeouts are surfaced as stable error
 * codes (see {@link FederationErrorCode}) and never hang the job.
 *
 * @param input The federation address (e.g., "user*domain.com")
 * @returns Resolution result or null on failure
 */
export async function resolveFederationAddress(
  input: string,
): Promise<FederationResolution | null> {
  const startTime = Date.now();

  try {
    // Step 1: Parse the federation address
    const parsed = parseFederationAddress(input);
    if (!parsed) {
      logger.warn(`Invalid federation address format: "${input}"`, {
        component: 'federation',
        code: 'INVALID_ADDRESS' satisfies FederationErrorCode,
      });
      return null;
    }

    const { username, domain } = parsed;

    // Step 2: Validate username
    const usernameValidation = validateFederationUsername(username);
    if (!usernameValidation.valid) {
      logger.warn(`Invalid federation username: ${usernameValidation.errors.join('; ')}`, {
        component: 'federation',
        username,
        code: 'INVALID_USERNAME' satisfies FederationErrorCode,
      });
      return null;
    }

    // Step 3: Validate domain
    const domainValidation = validateFederationDomain(domain);
    if (!domainValidation.valid) {
      logger.warn(`Invalid federation domain: ${domainValidation.errors.join('; ')}`, {
        component: 'federation',
        domain,
        code: 'INVALID_DOMAIN' satisfies FederationErrorCode,
      });
      return null;
    }

    // Step 4: Fetch stellar.toml
    const tomlUrl = `https://${domain}/.well-known/stellar.toml`;
    logger.debug(`Fetching stellar.toml for federation resolution: ${tomlUrl}`, {
      component: 'federation',
      domain,
    });

    const tomlResult = await fetchSSRFSafe(tomlUrl, {
      maxBodyBytes: 256 * 1024, // 256 KB
      timeoutMs: FEDERATION_TIMEOUT_MS,
      followRedirects: false,
    });

    if (!tomlResult.ok) {
      const error = 'error' in tomlResult ? tomlResult.error : 'unknown error';
      const code = classifyFetchError(error, 'TOML');
      logger.warn(`Failed to fetch stellar.toml from ${domain}: ${error}`, {
        component: 'federation',
        domain,
        error,
        code,
      });
      return null;
    }

    const tomlContent = await tomlResult.text();

    // Step 5: Parse TOML for federation server
    const federationServer = parseFederationServerFromToml(tomlContent);
    if (!federationServer) {
      logger.warn(`No [[FEDERATION_SERVER]] found in stellar.toml for ${domain}`, {
        component: 'federation',
        domain,
        code: 'NO_FEDERATION_SERVER' satisfies FederationErrorCode,
      });
      return null;
    }

    // Step 6: Fetch federation server
    const federationUrl = new URL(federationServer.forward_url);
    federationUrl.searchParams.set('type', 'name');
    federationUrl.searchParams.set('addr', input);

    const federationResult = await fetchSSRFSafe(federationUrl.toString(), {
      maxBodyBytes: MAX_FEDERATION_BODY_BYTES,
      timeoutMs: FEDERATION_TIMEOUT_MS,
      followRedirects: true,
      maxRedirects: 3,
    });

    if (!federationResult.ok) {
      const error = 'error' in federationResult ? federationResult.error : 'unknown error';
      const code = classifyFetchError(error, 'FEDERATION');
      logger.warn(`Federation fetch failed for ${input}: ${error}`, {
        component: 'federation',
        domain,
        error,
        code,
      });
      return null;
    }

    const body = await federationResult.text();
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      logger.warn(`Federation response for ${input} was not valid JSON`, {
        component: 'federation',
        domain,
        code: 'FEDERATION_FETCH_FAILED' satisfies FederationErrorCode,
      });
      return null;
    }

    const accountId =
      json && typeof json === 'object' && 'account_id' in json
        ? (json as { account_id?: unknown }).account_id
        : undefined;

    if (typeof accountId !== 'string' || !isValidStellarAddress(accountId)) {
      logger.warn(`Federation response for ${input} did not contain a valid account_id`, {
        component: 'federation',
        domain,
        code: 'INVALID_ACCOUNT_ID' satisfies FederationErrorCode,
      });
      return null;
    }

    const rawMemoType =
      json && typeof json === 'object' && 'memo_type' in json
        ? (json as { memo_type?: unknown }).memo_type
        : undefined;
    const rawMemo =
      json && typeof json === 'object' && 'memo' in json
        ? (json as { memo?: unknown }).memo
        : undefined;

    // Validate memo fields when the server returned a memo_type. A memo_type
    // without a compatible memo value is a non-conformant server response —
    // attaching a malformed memo to a Stellar transaction silently breaks
    // payment routing.
    if (rawMemoType !== undefined && rawMemoType !== null) {
      const memoValidation = validateMemo(rawMemoType, rawMemo);
      if (!memoValidation.valid) {
        logger.warn(
          `Federation response for ${input} has invalid memo: ${memoValidation.reason}`,
          {
            component: 'federation',
            domain,
            code: memoValidation.code satisfies FederationErrorCode,
          },
        );
        return null;
      }
    }

    const resolution: FederationResolution = { gAddress: accountId, memoRequired: false };
    if (
      typeof rawMemoType === 'string' &&
      (rawMemoType === 'text' || rawMemoType === 'id' || rawMemoType === 'hash')
    ) {
      resolution.memoType = rawMemoType as MemoType;
      resolution.memoRequired = true;
    }
    if (typeof rawMemo === 'string' && rawMemo.trim() !== '') {
      resolution.memo = rawMemo.trim();
    }

    logger.debug(`Resolved federation address ${input} in ${Date.now() - startTime}ms`, {
      component: 'federation',
      domain,
    });

    return resolution;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Federation resolution error for "${input}": ${message}`, {
      component: 'federation',
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Memo validation
// ---------------------------------------------------------------------------

/**
 * Validates the `memo_type` and `memo` fields returned by a federation server.
 *
 * SEP-0002 defines three memo types:
 * - `text`  — UTF-8 string, at most 28 bytes.
 * - `id`    — unsigned 64-bit integer sent as a decimal string.
 * - `hash`  — 32-byte value encoded as exactly 64 lowercase hex characters.
 *
 * Rules enforced here:
 * 1. `memo_type` must be one of `text`, `id`, or `hash` (case-sensitive).
 * 2. When `memo_type` is present, `memo` must also be present and non-empty
 *    (a federation server that returns a type but no value is non-conformant;
 *    attaching an empty memo to a transaction has no effect and breaks routing).
 * 3. `id` memos must be a string of decimal digits only, representable as a
 *    64-bit unsigned integer (0 – 18446744073709551615).
 * 4. `hash` memos must be exactly 64 lowercase hex characters.
 * 5. `text` memos must not exceed 28 bytes when encoded as UTF-8.
 *
 * Returns `{ valid: true, memoType, memo }` on success, or
 * `{ valid: false, code, reason }` on failure.
 */
export function validateMemo(
  memoType: unknown,
  memo: unknown,
): | { valid: true; memoType: MemoType; memo: string }
  | { valid: false; code: 'MEMO_REQUIRED' | 'MEMO_TYPE_MISMATCH'; reason: string } {
  // No memo at all — valid (memo is optional in federation responses).
  if (memoType === undefined || memoType === null) {
    // If memo is somehow present without a type, ignore it (non-standard server).
    return { valid: true, memoType: undefined as unknown as MemoType, memo: undefined as unknown as string };
  }

  if (typeof memoType !== 'string' || (memoType !== 'text' && memoType !== 'id' && memoType !== 'hash')) {
    return {
      valid: false,
      code: 'MEMO_TYPE_MISMATCH',
      reason: `Unrecognized memo_type "${String(memoType)}": must be "text", "id", or "hash".`,
    };
  }

  // memo_type is present — memo value is required.
  if (memo === undefined || memo === null || (typeof memo === 'string' && memo.trim() === '')) {
    return {
      valid: false,
      code: 'MEMO_REQUIRED',
      reason: `Federation response includes memo_type "${memoType}" but omits the memo value. The destination account requires a memo; attach memo_type "${memoType}" to your payment transaction.`,
    };
  }

  if (typeof memo !== 'string') {
    return {
      valid: false,
      code: 'MEMO_TYPE_MISMATCH',
      reason: `memo must be a string, got ${typeof memo}.`,
    };
  }

  const memoStr = memo.trim();

  if (memoType === 'id') {
    // Must be a non-negative integer string in [0, 2^64 - 1].
    if (!/^\d+$/.test(memoStr)) {
      return {
        valid: false,
        code: 'MEMO_TYPE_MISMATCH',
        reason: `memo_type is "id" but memo "${memoStr}" is not a decimal integer string.`,
      };
    }
    if (BigInt(memoStr) > 18446744073709551615n) {
      return {
        valid: false,
        code: 'MEMO_TYPE_MISMATCH',
        reason: `memo_type is "id" but memo value ${memoStr} exceeds the maximum unsigned 64-bit integer (18446744073709551615).`,
      };
    }
  }

  if (memoType === 'hash') {
    // Issue #957: distinguish encoding errors from length errors so operators
    // can tell a base64/garbled memo apart from a truncated or padded one.
    // Both map to the stable MEMO_TYPE_MISMATCH code. The memo value is not
    // echoed back (it may be a routing secret) — only its length.
    if (!/^[0-9a-f]+$/i.test(memoStr)) {
      return {
        valid: false,
        code: 'MEMO_TYPE_MISMATCH',
        reason: `memo_type is "hash" but memo is not hex-encoded (length ${memoStr.length}); expected exactly ${MEMO_HASH_HEX_LENGTH} hex characters (32 bytes).`,
      };
    }
    if (memoStr.length !== MEMO_HASH_HEX_LENGTH) {
      return {
        valid: false,
        code: 'MEMO_TYPE_MISMATCH',
        reason: `memo_type is "hash" but memo has invalid length ${memoStr.length}; expected exactly ${MEMO_HASH_HEX_LENGTH} hex characters (32 bytes).`,
      };
    }
  }

  if (memoType === 'text') {
    const byteLength = Buffer.byteLength(memoStr, 'utf8');
    if (byteLength > MEMO_TEXT_MAX_BYTES) {
      return {
        valid: false,
        code: 'MEMO_TYPE_MISMATCH',
        reason: `memo_type is "text" but memo is ${byteLength} bytes, exceeding the 28-byte UTF-8 limit.`,
      };
    }
  }

  return { valid: true, memoType, memo: memoStr };
}

/**
 * Parses the [[FEDERATION_SERVER]] forward_url from stellar.toml content.
 *
 * @param tomlContent Raw stellar.toml text
 * @returns The federation server descriptor or null if not found
 */
export function parseFederationServerFromToml(
  tomlContent: string,
): { forward_url: string } | null {
  if (!tomlContent || typeof tomlContent !== 'string') {
    return null;
  }

  const lines = tomlContent.split(/\r?\n/);
  let inFederationSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    if (line.startsWith('[')) {
      inFederationSection = /^\[\[?\s*FEDERATION_SERVER\s*\]?\]?$/i.test(line);
      continue;
    }

    if (!inFederationSection) {
      continue;
    }

    const match = /^forward_url\s*=\s*"([^"]+)"\s*$/i.exec(line);
    if (match) {
      return { forward_url: match[1] };
    }
  }

  return null;
}
