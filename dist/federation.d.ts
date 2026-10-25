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
/**
 * Stable error codes surfaced by federation resolution failures.
 *
 * These are intentionally stable strings so callers and tests can assert on
 * them without depending on human-readable message wording.
 */
export type FederationErrorCode = 'INVALID_ADDRESS' | 'INVALID_USERNAME' | 'INVALID_DOMAIN' | 'TOML_FETCH_FAILED' | 'TOML_NXDOMAIN' | 'TOML_TRUNCATED' | 'TOML_TIMEOUT' | 'NO_FEDERATION_SERVER' | 'FEDERATION_FETCH_FAILED' | 'FEDERATION_NXDOMAIN' | 'FEDERATION_TRUNCATED' | 'FEDERATION_TIMEOUT' | 'INVALID_ACCOUNT_ID';
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
export declare function isFederationAddress(input: string): boolean;
/**
 * Parses a federation address into username and domain.
 *
 * @param input The federation address (e.g., "user*domain.com")
 * @returns Parsed components or null if invalid
 */
export declare function parseFederationAddress(input: string): {
    username: string;
    domain: string;
} | null;
/**
 * Validates a federation username.
 *
 * @param username The username to validate
 * @returns Validation result with errors if any
 */
export declare function validateFederationUsername(username: string): {
    valid: boolean;
    errors: string[];
};
/**
 * Validates a federation domain.
 *
 * @param domain The domain to validate
 * @returns Validation result with errors if any
 */
export declare function validateFederationDomain(domain: string): {
    valid: boolean;
    errors: string[];
};
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
export declare function resolveFederationAddress(input: string): Promise<FederationResolution | null>;
/**
 * Parses the [[FEDERATION_SERVER]] forward_url from stellar.toml content.
 *
 * @param tomlContent Raw stellar.toml text
 * @returns The federation server descriptor or null if not found
 */
export declare function parseFederationServerFromToml(tomlContent: string): {
    forward_url: string;
} | null;
