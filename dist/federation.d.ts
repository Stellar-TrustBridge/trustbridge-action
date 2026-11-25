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
export type FederationErrorCode = 'INVALID_ADDRESS' | 'INVALID_USERNAME' | 'INVALID_DOMAIN' | 'TOML_FETCH_FAILED' | 'TOML_NXDOMAIN' | 'TOML_TRUNCATED' | 'TOML_TIMEOUT' | 'NO_FEDERATION_SERVER' | 'FEDERATION_FETCH_FAILED' | 'FEDERATION_NXDOMAIN' | 'FEDERATION_TRUNCATED' | 'FEDERATION_TIMEOUT' | 'INVALID_ACCOUNT_ID' | 'MEMO_REQUIRED' | 'MEMO_TYPE_MISMATCH';
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
/** Maximum length (bytes) of a `text` memo per the Stellar protocol. */
export declare const MEMO_TEXT_MAX_BYTES = 28;
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
export declare function validateMemo(memoType: unknown, memo: unknown): {
    valid: true;
    memoType: MemoType;
    memo: string;
} | {
    valid: false;
    code: 'MEMO_REQUIRED' | 'MEMO_TYPE_MISMATCH';
    reason: string;
};
/**
 * Parses the [[FEDERATION_SERVER]] forward_url from stellar.toml content.
 *
 * @param tomlContent Raw stellar.toml text
 * @returns The federation server descriptor or null if not found
 */
export declare function parseFederationServerFromToml(tomlContent: string): {
    forward_url: string;
} | null;
