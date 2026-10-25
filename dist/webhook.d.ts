/**
 * Signed dashboard webhook support for TrustBridge Action (Issue #101).
 *
 * Provides optional HMAC-SHA256 signed webhook notifications to a consumer
 * dashboard or external endpoint after every validation run. The feature is
 * fully opt-in: when `webhook_url` is not configured the call path is never
 * entered and comment posting is unaffected.
 *
 * ## Security design
 * - Payloads are signed with HMAC-SHA256 using a shared secret supplied via
 *   `webhook_secret`. The signature is included as the
 *   `X-TrustBridge-Signature` HTTP header in the format
 *   `sha256=<hex-digest>`.
 * - The secret is **never** logged or embedded in comments. Log lines that
 *   reference the webhook only emit the URL (host-only, path redacted) and
 *   structural payload fields.
 * - Webhook failures are isolated: errors are caught, logged as warnings,
 *   and never propagate to the comment-posting or validation-result paths.
 * - A configurable timeout (`webhook_timeout_ms`, default 5 000 ms) prevents
 *   a slow receiver from stalling the action.
 *
 * ## Payload schema
 * ```json
 * {
 *   "schema_version": "1",
 *   "event": "validation_complete",
 *   "timestamp": "<ISO-8601>",
 *   "repository": "<owner/repo>",
 *   "issue_number": <number | null>,
 *   "stellar_address": "<redacted first-4…last-4>",
 *   "result": {
 *     "valid": <boolean>,
 *     "account_funded": <boolean>,
 *     "trustline_exists": <boolean>,
 *     "xlm_balance": "<string>",
 *     "checks": [{ "label": "<string>", "passed": <boolean> }]
 *   },
 *   "assets": [                                  // optional, additive (Issue #676)
 *     {
 *       "asset_code": "<string>",
 *       "asset_issuer": "<redacted first-4…last-4>",
 *       "primary": <boolean>,
 *       "trustline_exists": <boolean>,
 *       "clawback_enabled": <boolean>,
 *       "reason_code": "SUCCESS" | "TRUSTLINE_MISSING" | "CLAWBACK_BLOCKED"
 *     }
 *   ]
 * }
 * ```
 *
 * ## OIDC mode (Issue #674)
 * When `authMode` is `'oidc'` the webhook is **never** sent without an
 * `Authorization: Bearer` header. A failed or empty ID-token mint fails the
 * step via `core.setFailed` and skips delivery — there is no HMAC or unsigned
 * fallback.
 */
import type { ValidationResult } from './checks';
import type { AssetReasonCode, AssetReasonEvaluation } from './assets';
export type WebhookAuthMode = 'hmac' | 'oidc';
/** Default `webhook_oidc_audience` (the `aud` claim of the minted token). */
export declare const DEFAULT_OIDC_AUDIENCE = "trustbridge-dashboard";
/** Workflow permission required for `core.getIDToken`. */
export declare const OIDC_REQUIRED_PERMISSION = "id-token: write";
/** `iss` claim of Actions OIDC tokens minted on github.com. */
export declare const GITHUB_COM_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
/** Path appended to the GHES host to form its OIDC issuer (`https://HOSTNAME/_services/token`). */
export declare const GHES_OIDC_ISSUER_PATH = "/_services/token";
/** Oldest GHES release TrustBridge documents as supporting `webhook_auth_mode: oidc`. */
export declare const OIDC_MIN_GHES_VERSION = "3.8";
/**
 * Runner environment variables `core.getIDToken` reads. They are only present
 * when the job has `id-token: write`; their absence is what produces the
 * "OIDC token minting failed" warning.
 */
export declare const OIDC_RUNTIME_ENV_VARS: readonly ["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
/**
 * Resolve the `iss` claim a receiver must trust for tokens minted by this
 * workflow run.
 *
 * `serverUrl` is `GITHUB_SERVER_URL` (`https://github.com` on github.com,
 * `https://HOSTNAME` on GHES). GHES instances issue tokens from
 * `https://HOSTNAME/_services/token` instead of the github.com issuer.
 */
export declare function resolveOidcIssuer(serverUrl?: string): string;
export interface WebhookConfig {
    /** Full HTTPS URL of the receiver endpoint. */
    webhookUrl: string;
    /**
     * Shared HMAC-SHA256 secret. When empty and authMode is 'hmac', the webhook is sent **unsigned**
     * (X-TrustBridge-Signature header is omitted). Callers should always set
     * this for production HMAC use.
     */
    webhookSecret?: string;
    /**
     * Previous HMAC secret, set only during a secret rotation (Issue #795).
     *
     * While set, every request carries a second signature computed with this
     * key in `X-TrustBridge-Signature-Previous`, so receivers that have not yet
     * switched to the new `webhookSecret` keep verifying without downtime.
     * Remove it once every receiver accepts the new key.
     */
    webhookSecretPrevious?: string;
    /** Request timeout in milliseconds. Default 5 000. */
    timeoutMs?: number;
    /** Parent cancellation signal, such as an Actions runner job-abort signal. */
    signal?: AbortSignal;
    /**
     * Authentication mode: 'hmac' (default) or 'oidc'.
     */
    authMode?: WebhookAuthMode;
    /**
     * OIDC audience for the minted GitHub ID token. Defaults to 'trustbridge-dashboard'.
     */
    oidcAudience?: string;
    /**
     * Pre-minted OIDC token if already obtained, or passed for testing.
     */
    oidcToken?: string;
}
type RunnerSignalSource = Pick<NodeJS.Process, 'on' | 'removeListener'> & {
    exitCode?: number | string | null;
};
/** Bridge Actions runner termination signals to the in-flight webhook request. */
export declare function listenForRunnerCancellation(controller: AbortController, signalSource?: RunnerSignalSource): () => void;
/**
 * Optional per-asset entry (Issue #676). Additive under `schema_version: "1"`:
 * receivers that ignore unknown fields keep working unchanged.
 */
export interface WebhookAssetEntry {
    asset_code: string;
    /** Redacted issuer (first-4…last-4), G-account or Soroban C-contract. */
    asset_issuer: string;
    primary: boolean;
    trustline_exists: boolean;
    clawback_enabled: boolean;
    reason_code: AssetReasonCode;
}
export interface WebhookPayload {
    schema_version: '1';
    event: 'validation_complete';
    timestamp: string;
    repository: string;
    issue_number: number | null;
    stellar_address: string;
    result: {
        valid: boolean;
        account_funded: boolean;
        trustline_exists: boolean;
        xlm_balance: string;
        checks: Array<{
            label: string;
            passed: boolean;
        }>;
    };
    /** Per-asset trustline / clawback reason codes (Issue #676). Omitted when not supplied. */
    assets?: WebhookAssetEntry[];
}
export interface WebhookDeliveryResult {
    sent: boolean;
    statusCode?: number;
    error?: string;
}
/**
 * Compute the HMAC-SHA256 signature for a raw payload body.
 *
 * Returns the signature as `sha256=<hex-digest>` — the same format used by
 * GitHub's own webhook signatures, making receiver verification
 * straightforward with any standard HMAC library.
 *
 * @param body    The raw UTF-8 JSON string that will be sent as the request body.
 * @param secret  The shared secret. Must not be empty.
 */
export declare function computeWebhookSignature(body: string, secret: string): string;
/**
 * Verify a webhook signature using a constant-time comparison.
 *
 * Receivers should pass the raw request body so verification covers the exact
 * bytes that were signed rather than a re-serialised JSON representation.
 */
export declare function verifyWebhookSignature(body: string, signature: string, secret: string): boolean;
/** Header carrying the signature made with the *current* `webhook_secret`. */
export declare const WEBHOOK_SIGNATURE_HEADER = "X-TrustBridge-Signature";
/** Header carrying the signature made with `webhook_secret_previous` during a rotation. */
export declare const WEBHOOK_PREVIOUS_SIGNATURE_HEADER = "X-TrustBridge-Signature-Previous";
export interface WebhookSignatureVerification {
    /** True when any supplied signature matches any accepted secret. */
    valid: boolean;
    /**
     * Index into `secrets` of the key that verified (0 = newest), or `null`.
     * Receivers can watch this to see when old-key matches stop.
     */
    matchedKeyIndex: number | null;
    /** Stable reason when `valid` is false. */
    reason?: 'NO_SIGNATURE' | 'MALFORMED_SIGNATURE' | 'NO_SECRETS' | 'SIGNATURE_MISMATCH';
}
/**
 * Receiver-side verification across a rotation window (Issue #795).
 *
 * Accepts the request when any supplied signature header value
 * (`X-TrustBridge-Signature`, `X-TrustBridge-Signature-Previous`) matches any
 * of the receiver's accepted secrets. Order `secrets` newest first so
 * `matchedKeyIndex` tells you which key matched. Empty secrets are ignored and
 * every comparison is constant-time.
 */
export declare function verifyWebhookSignatureWithRotation(body: string, signatures: Array<string | null | undefined>, secrets: Array<string | null | undefined>): WebhookSignatureVerification;
/**
 * Signature headers for a request body. Signs with `webhookSecret` and, during
 * a rotation, also with `webhookSecretPrevious`. A previous secret equal to
 * the current one is ignored. Returns `{}` when no current secret is set —
 * the previous key never signs on its own.
 */
export declare function buildWebhookSignatureHeaders(body: string, webhookSecret?: string, webhookSecretPrevious?: string): Record<string, string>;
/**
 * Upper bound on `assets` entries in one payload (Issue #676). Mirrors
 * `maxItems` in `schemas/webhook-payload.schema.json`; larger `assets_json`
 * lists are truncated so the body stays small.
 */
export declare const WEBHOOK_MAX_ASSETS = 100;
/**
 * Current webhook payload schema version. Bumped only for breaking payload
 * changes; see the versioning policy in docs/SCHEMA.md (Issue #784).
 */
export declare const WEBHOOK_SCHEMA_VERSION: "1";
/**
 * Build a sanitised webhook payload from a `ValidationResult`.
 *
 * All sensitive values are redacted using the same policy as structured log
 * output — the webhook receiver sees a first-4/last-4 masked address, never
 * the full G-account or Soroban C-contract id (Issue #675). That covers
 * `stellar_address`, every `assets[].asset_issuer`, and any address embedded
 * in a check label.
 *
 * @param assets  Optional per-asset evaluations (Issue #676). When omitted or
 *                empty the `assets` key is left out and the payload is
 *                byte-for-byte the frozen v1 shape.
 */
export declare function buildWebhookPayload(result: ValidationResult, stellarAddress: string, repository: string, issueNumber: number | null, assets?: AssetReasonEvaluation[]): WebhookPayload;
/** Mirrors `schemas/webhook-payload.schema.json`; kept in sync by webhook-contract tests. */
export declare const WEBHOOK_PAYLOAD_REQUIRED_FIELDS: readonly ["schema_version", "event", "timestamp", "repository", "issue_number", "stellar_address", "result"];
export declare const WEBHOOK_RESULT_REQUIRED_FIELDS: readonly ["valid", "account_funded", "trustline_exists", "xlm_balance", "checks"];
export declare const WEBHOOK_CHECK_REQUIRED_FIELDS: readonly ["label", "passed"];
/** Optional additive top-level fields (Issue #676). */
export declare const WEBHOOK_PAYLOAD_OPTIONAL_FIELDS: readonly ["assets"];
export declare const WEBHOOK_ASSET_REQUIRED_FIELDS: readonly ["asset_code", "asset_issuer", "primary", "trustline_exists", "clawback_enabled", "reason_code"];
export declare const WEBHOOK_ASSET_REASON_CODES: readonly ["SUCCESS", "TRUSTLINE_MISSING", "CLAWBACK_BLOCKED"];
export declare const WEBHOOK_REPOSITORY_PATTERN = "^[^/]+/[^/]+$";
export declare const WEBHOOK_STELLAR_ADDRESS_PATTERN = "^[GC][A-Z2-7]{3}\\.{3}[A-Z2-7]{4}$";
/**
 * Validate an outbound webhook payload against
 * `schemas/webhook-payload.schema.json`.
 *
 * @returns A list of violations; empty when the payload is conformant.
 */
export declare function validateWebhookPayload(payload: unknown): string[];
/**
 * Deliver a signed webhook notification to the configured endpoint.
 *
 * - Validates the payload against `schemas/webhook-payload.schema.json` and
 *   refuses to send (fail closed) when it does not conform.
 * - Signs the JSON payload with HMAC-SHA256 when a secret is provided.
 * - In OIDC mode, refuses to send (fail closed) when no bearer token is
 *   available — never falls back to HMAC or an unsigned request (Issue #674).
 * - Respects `timeoutMs` via `AbortController`.
 * - **Never throws** — all errors are swallowed and returned in the result
 *   object so the caller's comment-posting path is not affected.
 *
 * @internal Exported for unit testing; callers should prefer
 *           `sendWebhookNotification`.
 */
export declare function deliverWebhook(payload: WebhookPayload, config: WebhookConfig, fetchFn?: typeof fetch): Promise<WebhookDeliveryResult>;
/**
 * Build a redacted, actionable message for an OIDC mint failure (Issue #674).
 * The raw provider message is passed through `redactString` so no JWT or
 * request token can leak into the runner log.
 */
export declare function describeOidcMintFailure(audience: string, error: unknown): string;
/**
 * High-level entry point called after validation completes. Builds the
 * payload, delivers the webhook, and logs the outcome.
 *
 * Delivery/network failures are non-fatal and only logged as warnings. The
 * one exception is OIDC mode (Issue #674): if the ID token cannot be minted
 * the step is failed via `core.setFailed` and nothing is sent.
 *
 * @param result        The completed `ValidationResult`.
 * @param stellarAddress  Raw (unredacted) Stellar address — redaction happens
 *                      inside this function before it leaves the process.
 * @param config        Resolved webhook configuration.
 * @param repository    `owner/repo` string from the GitHub context.
 * @param issueNumber   Current issue number, or `null` when not in an issue context.
 * @param assets        Optional per-asset evaluations for the `assets` section (Issue #676).
 */
export declare function sendWebhookNotification(result: ValidationResult, stellarAddress: string, config: WebhookConfig, repository: string, issueNumber: number | null, assets?: AssetReasonEvaluation[]): Promise<void>;
export {};
