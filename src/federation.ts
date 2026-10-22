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
  | 'INVALID_ACCOUNT_ID';

/**
 * Result of a federation address resolution.
 */
export interface FederationResolution {
  /** The resolved Stellar G-address. */
  gAddress: string;
  /** Optional memo type (text, id, hash). */
  memoType?: string;
  /** Optional memo value. */
  memo?: string;
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

    const memoType =
      json && typeof json === 'object' && 'memo_type' in json
        ? (json as { memo_type?: unknown }).memo_type
        : undefined;
    const memo =
      json && typeof json === 'object' && 'memo' in json
        ? (json as { memo?: unknown }).memo
        : undefined;

    const resolution: FederationResolution = { gAddress: accountId };
    if (typeof memoType === 'string') {
      resolution.memoType = memoType;
    }
    if (typeof memo === 'string') {
      resolution.memo = memo;
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
