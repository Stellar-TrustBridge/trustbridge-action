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
      });
      return null;
    }

    // Step 3: Validate domain
    const domainValidation = validateFederationDomain(domain);
    if (!domainValidation.valid) {
      logger.warn(`Invalid federation domain: ${domainValidation.errors.join('; ')}`, {
        component: 'federation',
        domain,
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
      logger.warn(`Failed to fetch stellar.toml from ${domain}: ${tomlResult.error}`, {
        component: 'federation',
        domain,
        error: tomlResult.error,
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
      logger.warn(`Federation server request failed: ${federationResult.error}`, {
        component: 'federation',
        domain,
        error: federationResult.error,
      });
      return null;
    }

    const federationText = await federationResult.text();

    // Step 7: Parse JSON response
    let federationData: Record<string, unknown>;
    try {
      federationData = JSON.parse(federationText);
    } catch {
      logger.warn(`Invalid JSON from federation server for ${input}`, {
        component: 'federation',
        domain,
      });
      return null;
    }

    const accountId = federationData['account_id'];
    if (typeof accountId !== 'string') {
      logger.warn(`Missing or invalid account_id in federation response for ${input}`, {
        component: 'federation',
        domain,
      });
      return null;
    }

    // Step 8: Validate G-address
    if (!isValidStellarAddress(accountId)) {
      logger.warn(`Federation server returned invalid G-address: ${accountId}`, {
        component: 'federation',
        domain,
      });
      return null;
    }

    const result: FederationResolution = {
      gAddress: accountId,
    };

    // Extract optional memo
    const memoType = federationData['memo_type'];
    const memo = federationData['memo'];
    if (typeof memoType === 'string' && memo !== undefined && memo !== null) {
      result.memoType = memoType;
      result.memo = String(memo);
    }

    const durationMs = Date.now() - startTime;
    logger.info(`Federation resolved: ${input} -> ${accountId} (${durationMs}ms)`, {
      component: 'federation',
      domain,
      durationMs,
    });

    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`Federation resolution failed for ${input}: ${msg}`, {
      component: 'federation',
      error: msg,
    });
    return null;
  }
}

/**
 * Parsed federation server entry from stellar.toml.
 */
interface FederationServerEntry {
  forward_url: string;
  auth_domain?: string;
}

/**
 * Parses a [[FEDERATION_SERVER]] entry from stellar.toml content.
 *
 * This is a minimal TOML parser that only extracts [[FEDERATION_SERVER]]
 * entries. It does not implement full TOML parsing.
 *
 * @param tomlContent The stellar.toml content
 * @returns The first federation server entry, or null if not found
 */
function parseFederationServerFromToml(
  tomlContent: string,
): FederationServerEntry | null {
  const lines = tomlContent.split('\n');
  let inFederationServer = false;
  let forwardUrl: string | null = null;
  let authDomain: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Check for [[FEDERATION_SERVER]] section
    if (trimmed === '[[FEDERATION_SERVER]]') {
      inFederationServer = true;
      continue;
    }

    // Check for other section (exit federation server block)
    if (trimmed.startsWith('[') && !trimmed.startsWith('[[FEDERATION_SERVER]]')) {
      if (inFederationServer && forwardUrl) {
        return { forward_url: forwardUrl, auth_domain: authDomain };
      }
      inFederationServer = false;
      forwardUrl = null;
      authDomain = undefined;
      continue;
    }

    // Parse key-value pairs within [[FEDERATION_SERVER]]
    if (inFederationServer) {
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;

      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();

      // Remove quotes from value
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      if (key === 'forward_url') {
        forwardUrl = value;
      } else if (key === 'auth_domain') {
        authDomain = value;
      }
    }
  }

  // Return last found federation server
  if (inFederationServer && forwardUrl) {
    return { forward_url: forwardUrl, auth_domain: authDomain };
  }

  return null;
}
