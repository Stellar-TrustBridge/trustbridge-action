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

import * as crypto from 'crypto';
import * as core from '@actions/core';
import { logger, redactStellarAddress, redactHorizonUrl, redactString } from './logger';
import type { ValidationResult } from './checks';
import type { AssetReasonCode, AssetReasonEvaluation } from './assets';
import { traceWebhookDeliver } from './tracing';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WebhookAuthMode = 'hmac' | 'oidc';

// ---------------------------------------------------------------------------
// OIDC constants (Issue #677)
//
// docs/GHES_COMPATIBILITY.md renders these values in its OIDC webhook matrix,
// and __tests__/ghes-oidc-matrix.test.ts locks the doc against them, so a
// change here fails CI until the documentation is updated too.
// ---------------------------------------------------------------------------

/** Default `webhook_oidc_audience` (the `aud` claim of the minted token). */
export const DEFAULT_OIDC_AUDIENCE = 'trustbridge-dashboard';
/** Workflow permission required for `core.getIDToken`. */
export const OIDC_REQUIRED_PERMISSION = 'id-token: write';
/** `iss` claim of Actions OIDC tokens minted on github.com. */
export const GITHUB_COM_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
/** Path appended to the GHES host to form its OIDC issuer (`https://HOSTNAME/_services/token`). */
export const GHES_OIDC_ISSUER_PATH = '/_services/token';
/** Oldest GHES release TrustBridge documents as supporting `webhook_auth_mode: oidc`. */
export const OIDC_MIN_GHES_VERSION = '3.8';
/**
 * Runner environment variables `core.getIDToken` reads. They are only present
 * when the job has `id-token: write`; their absence is what produces the
 * "OIDC token minting failed" warning.
 */
export const OIDC_RUNTIME_ENV_VARS = [
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
] as const;

/**
 * Resolve the `iss` claim a receiver must trust for tokens minted by this
 * workflow run.
 *
 * `serverUrl` is `GITHUB_SERVER_URL` (`https://github.com` on github.com,
 * `https://HOSTNAME` on GHES). GHES instances issue tokens from
 * `https://HOSTNAME/_services/token` instead of the github.com issuer.
 */
export function resolveOidcIssuer(
  serverUrl: string = process.env.GITHUB_SERVER_URL || 'https://github.com',
): string {
  const trimmed = serverUrl.trim().replace(/\/+$/, '');
  let host = '';
  try {
    host = new URL(trimmed).hostname.toLowerCase();
  } catch {
    return GITHUB_COM_OIDC_ISSUER;
  }
  if (host === 'github.com' || host === 'www.github.com') {
    return GITHUB_COM_OIDC_ISSUER;
  }
  return `${trimmed}${GHES_OIDC_ISSUER_PATH}`;
}

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
export function listenForRunnerCancellation(
  controller: AbortController,
  signalSource: RunnerSignalSource = process,
): () => void {
  const onSigint = (): void => {
    signalSource.exitCode = 130;
    controller.abort(new Error('Actions runner cancelled the job (SIGINT).'));
  };
  const onSigterm = (): void => {
    signalSource.exitCode = 143;
    controller.abort(new Error('Actions runner cancelled the job (SIGTERM).'));
  };

  signalSource.on('SIGINT', onSigint);
  signalSource.on('SIGTERM', onSigterm);

  return () => {
    signalSource.removeListener('SIGINT', onSigint);
    signalSource.removeListener('SIGTERM', onSigterm);
  };
}

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
    checks: Array<{ label: string; passed: boolean }>;
  };
  /** Per-asset trustline / clawback reason codes (Issue #676). Omitted when not supplied. */
  assets?: WebhookAssetEntry[];
}

export interface WebhookDeliveryResult {
  sent: boolean;
  statusCode?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// HMAC signing
// ---------------------------------------------------------------------------

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
export function computeWebhookSignature(body: string, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(body, 'utf8');
  return `sha256=${hmac.digest('hex')}`;
}

/**
 * Verify a webhook signature using a constant-time comparison.
 *
 * Receivers should pass the raw request body so verification covers the exact
 * bytes that were signed rather than a re-serialised JSON representation.
 */
export function verifyWebhookSignature(body: string, signature: string, secret: string): boolean {
  const expected = computeWebhookSignature(body, secret);
  const received = Buffer.from(signature, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');

  return received.length === expectedBytes.length && crypto.timingSafeEqual(received, expectedBytes);
}

// ---------------------------------------------------------------------------
// Secret rotation — dual-key accept window (Issue #795)
// ---------------------------------------------------------------------------

/** Header carrying the signature made with the *current* `webhook_secret`. */
export const WEBHOOK_SIGNATURE_HEADER = 'X-TrustBridge-Signature';
/** Header carrying the signature made with `webhook_secret_previous` during a rotation. */
export const WEBHOOK_PREVIOUS_SIGNATURE_HEADER = 'X-TrustBridge-Signature-Previous';

const SIGNATURE_FORMAT = /^sha256=[0-9a-f]{64}$/;

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
export function verifyWebhookSignatureWithRotation(
  body: string,
  signatures: Array<string | null | undefined>,
  secrets: Array<string | null | undefined>,
): WebhookSignatureVerification {
  const presented = signatures
    .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
    .map((s) => s.trim());
  if (presented.length === 0) return { valid: false, matchedKeyIndex: null, reason: 'NO_SIGNATURE' };
  const wellFormed = presented.filter((s) => SIGNATURE_FORMAT.test(s));
  if (wellFormed.length === 0) return { valid: false, matchedKeyIndex: null, reason: 'MALFORMED_SIGNATURE' };
  const accepted = secrets
    .map((s, i) => ({ s, i }))
    .filter((k): k is { s: string; i: number } => typeof k.s === 'string' && k.s !== '');
  if (accepted.length === 0) return { valid: false, matchedKeyIndex: null, reason: 'NO_SECRETS' };

  for (const { s, i } of accepted) {
    for (const sig of wellFormed) {
      if (verifyWebhookSignature(body, sig, s)) return { valid: true, matchedKeyIndex: i };
    }
  }
  return { valid: false, matchedKeyIndex: null, reason: 'SIGNATURE_MISMATCH' };
}

/**
 * Signature headers for a request body. Signs with `webhookSecret` and, during
 * a rotation, also with `webhookSecretPrevious`. A previous secret equal to
 * the current one is ignored. Returns `{}` when no current secret is set —
 * the previous key never signs on its own.
 */
export function buildWebhookSignatureHeaders(
  body: string,
  webhookSecret?: string,
  webhookSecretPrevious?: string,
): Record<string, string> {
  if (!webhookSecret) return {};
  const headers: Record<string, string> = {
    [WEBHOOK_SIGNATURE_HEADER]: computeWebhookSignature(body, webhookSecret),
  };
  if (webhookSecretPrevious && webhookSecretPrevious !== webhookSecret) {
    headers[WEBHOOK_PREVIOUS_SIGNATURE_HEADER] = computeWebhookSignature(body, webhookSecretPrevious);
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Payload builder
// ---------------------------------------------------------------------------

/**
 * Upper bound on `assets` entries in one payload (Issue #676). Mirrors
 * `maxItems` in `schemas/webhook-payload.schema.json`; larger `assets_json`
 * lists are truncated so the body stays small.
 */
export const WEBHOOK_MAX_ASSETS = 100;

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
export function buildWebhookPayload(
  result: ValidationResult,
  stellarAddress: string,
  repository: string,
  issueNumber: number | null,
  assets?: AssetReasonEvaluation[],
): WebhookPayload {
  const payload: WebhookPayload = {
    schema_version: '1',
    event: 'validation_complete',
    timestamp: new Date().toISOString(),
    repository,
    issue_number: issueNumber,
    stellar_address: redactStellarAddress(stellarAddress),
    result: {
      valid: result.valid,
      account_funded: result.accountFunded,
      trustline_exists: result.trustlineExists,
      xlm_balance: result.xlmBalance ?? '0',
      checks: result.checks.map((c) => ({ label: redactString(c.label), passed: c.passed })),
    },
  };

  if (assets && assets.length > 0) {
    payload.assets = assets.slice(0, WEBHOOK_MAX_ASSETS).map((a) => ({
      asset_code: a.assetCode,
      asset_issuer: redactStellarAddress(a.assetIssuer),
      primary: a.primary,
      trustline_exists: a.trustlineExists,
      clawback_enabled: a.clawbackEnabled,
      reason_code: a.reasonCode,
    }));
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Schema validation (Issue #471)
// ---------------------------------------------------------------------------

/** Mirrors `schemas/webhook-payload.schema.json`; kept in sync by webhook-contract tests. */
export const WEBHOOK_PAYLOAD_REQUIRED_FIELDS = [
  'schema_version',
  'event',
  'timestamp',
  'repository',
  'issue_number',
  'stellar_address',
  'result',
] as const;
export const WEBHOOK_RESULT_REQUIRED_FIELDS = [
  'valid',
  'account_funded',
  'trustline_exists',
  'xlm_balance',
  'checks',
] as const;
export const WEBHOOK_CHECK_REQUIRED_FIELDS = ['label', 'passed'] as const;
/** Optional additive top-level fields (Issue #676). */
export const WEBHOOK_PAYLOAD_OPTIONAL_FIELDS = ['assets'] as const;
export const WEBHOOK_ASSET_REQUIRED_FIELDS = [
  'asset_code',
  'asset_issuer',
  'primary',
  'trustline_exists',
  'clawback_enabled',
  'reason_code',
] as const;
export const WEBHOOK_ASSET_REASON_CODES = ['SUCCESS', 'TRUSTLINE_MISSING', 'CLAWBACK_BLOCKED'] as const;
export const WEBHOOK_REPOSITORY_PATTERN = '^[^/]+/[^/]+$';
export const WEBHOOK_STELLAR_ADDRESS_PATTERN = '^[GC][A-Z2-7]{3}\\.{3}[A-Z2-7]{4}$';

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function checkObjectKeys(
  obj: Record<string, unknown>,
  required: readonly string[],
  at: string,
  errors: string[],
  optional: readonly string[] = [],
): void {
  for (const field of required) {
    if (!(field in obj)) errors.push(`${at}: missing required property "${field}"`);
  }
  for (const key of Object.keys(obj)) {
    if (!required.includes(key) && !optional.includes(key)) errors.push(`${at}: unexpected property "${key}"`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate an outbound webhook payload against
 * `schemas/webhook-payload.schema.json`.
 *
 * @returns A list of violations; empty when the payload is conformant.
 */
export function validateWebhookPayload(payload: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(payload)) return ['payload: must be an object'];

  checkObjectKeys(payload, WEBHOOK_PAYLOAD_REQUIRED_FIELDS, 'payload', errors, WEBHOOK_PAYLOAD_OPTIONAL_FIELDS);

  if (payload.schema_version !== '1') errors.push('schema_version: must be "1"');
  if (payload.event !== 'validation_complete') errors.push('event: must be "validation_complete"');
  if (typeof payload.timestamp !== 'string' || !ISO_DATE_TIME.test(payload.timestamp) || isNaN(Date.parse(payload.timestamp))) {
    errors.push('timestamp: must be an ISO-8601 date-time string');
  }
  if (typeof payload.repository !== 'string' || !new RegExp(WEBHOOK_REPOSITORY_PATTERN).test(payload.repository)) {
    errors.push('repository: must be in "owner/repo" format');
  }
  const issue = payload.issue_number;
  if (issue !== null && (typeof issue !== 'number' || !Number.isInteger(issue) || issue < 1)) {
    errors.push('issue_number: must be an integer >= 1 or null');
  }
  if (typeof payload.stellar_address !== 'string' || !new RegExp(WEBHOOK_STELLAR_ADDRESS_PATTERN).test(payload.stellar_address)) {
    errors.push('stellar_address: must be a redacted address (first-4...last-4)');
  }
  if ('assets' in payload) validateAssetEntries(payload.assets, errors);

  const result = payload.result;
  if (!isPlainObject(result)) {
    if ('result' in payload) errors.push('result: must be an object');
    return errors;
  }
  checkObjectKeys(result, WEBHOOK_RESULT_REQUIRED_FIELDS, 'result', errors);
  for (const field of ['valid', 'account_funded', 'trustline_exists'] as const) {
    if (field in result && typeof result[field] !== 'boolean') errors.push(`result.${field}: must be a boolean`);
  }
  if ('xlm_balance' in result && typeof result.xlm_balance !== 'string') {
    errors.push('result.xlm_balance: must be a string');
  }
  if ('checks' in result) {
    if (!Array.isArray(result.checks)) {
      errors.push('result.checks: must be an array');
    } else {
      result.checks.forEach((check, i) => {
        const at = `result.checks[${i}]`;
        if (!isPlainObject(check)) {
          errors.push(`${at}: must be an object`);
          return;
        }
        checkObjectKeys(check, WEBHOOK_CHECK_REQUIRED_FIELDS, at, errors);
        if ('label' in check && typeof check.label !== 'string') errors.push(`${at}.label: must be a string`);
        if ('passed' in check && typeof check.passed !== 'boolean') errors.push(`${at}.passed: must be a boolean`);
      });
    }
  }

  return errors;
}

function validateAssetEntries(assets: unknown, errors: string[]): void {
  if (!Array.isArray(assets)) {
    errors.push('assets: must be an array');
    return;
  }
  if (assets.length > WEBHOOK_MAX_ASSETS) errors.push(`assets: must contain at most ${WEBHOOK_MAX_ASSETS} items`);
  const addressPattern = new RegExp(WEBHOOK_STELLAR_ADDRESS_PATTERN);
  assets.forEach((asset, i) => {
    const at = `assets[${i}]`;
    if (!isPlainObject(asset)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    checkObjectKeys(asset, WEBHOOK_ASSET_REQUIRED_FIELDS, at, errors);
    if ('asset_code' in asset && typeof asset.asset_code !== 'string') errors.push(`${at}.asset_code: must be a string`);
    if ('asset_issuer' in asset && (typeof asset.asset_issuer !== 'string' || !addressPattern.test(asset.asset_issuer))) {
      errors.push(`${at}.asset_issuer: must be a redacted address (first-4...last-4)`);
    }
    for (const field of ['primary', 'trustline_exists', 'clawback_enabled'] as const) {
      if (field in asset && typeof asset[field] !== 'boolean') errors.push(`${at}.${field}: must be a boolean`);
    }
    if ('reason_code' in asset && !(WEBHOOK_ASSET_REASON_CODES as readonly unknown[]).includes(asset.reason_code)) {
      errors.push(`${at}.reason_code: must be one of ${WEBHOOK_ASSET_REASON_CODES.join(', ')}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

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
export async function deliverWebhook(
  payload: WebhookPayload,
  config: WebhookConfig,
  fetchFn: typeof fetch = fetch,
): Promise<WebhookDeliveryResult> {
  const timeoutMs = config.timeoutMs ?? 5_000;

  // Fail closed: never send a body that breaks the published receiver contract.
  const violations = validateWebhookPayload(payload);
  if (violations.length > 0) {
    return {
      sent: false,
      error: `payload failed webhook-payload.schema.json validation: ${violations.join('; ')}`,
    };
  }

  // Fail closed (Issue #674): an OIDC-mode receiver trusts the bearer token,
  // so an unauthenticated (or HMAC-only) request must never be sent.
  if (config.authMode === 'oidc' && !config.oidcToken) {
    return {
      sent: false,
      error: 'webhook_auth_mode is "oidc" but no OIDC token is available; refusing to send an unauthenticated webhook',
    };
  }

  let body: string;
  try {
    body = JSON.stringify(payload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { sent: false, error: `payload serialisation failed: ${msg}` };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'trustbridge-action/1',
    // Schema version header allows receivers to route/validate without parsing the body first.
    // Updated whenever schema_version in the payload changes (Issue #296).
    'X-TrustBridge-Schema-Version': payload.schema_version,
  };

  if (config.oidcToken) {
    headers['Authorization'] = `Bearer ${config.oidcToken}`;
  } else {
    Object.assign(headers, buildWebhookSignatureHeaders(body, config.webhookSecret, config.webhookSecretPrevious));
  }

  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(config.signal?.reason);
  if (config.signal?.aborted) {
    abortFromParent();
  } else {
    config.signal?.addEventListener('abort', abortFromParent, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(config.webhookUrl, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal as AbortSignal,
    });

    return { sent: true, statusCode: response.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { sent: false, error: msg };
  } finally {
    clearTimeout(timer);
    config.signal?.removeEventListener('abort', abortFromParent);
  }
}

/**
 * Build a redacted, actionable message for an OIDC mint failure (Issue #674).
 * The raw provider message is passed through `redactString` so no JWT or
 * request token can leak into the runner log.
 */
export function describeOidcMintFailure(audience: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const detail = redactString(raw) || 'empty token returned';
  // @actions/core throws this when the job lacks `id-token: write` — which is
  // always the case for `pull_request` runs triggered from forks.
  const missingPermission = /ACTIONS_ID_TOKEN_REQUEST_(URL|TOKEN)/.test(raw);
  const hint = missingPermission
    ? "The job has no 'permissions: id-token: write' (fork pull_request runs never receive an ID token). Grant the permission, or use webhook_auth_mode: hmac for fork-triggered runs."
    : "The GitHub OIDC provider returned an error. Ensure the workflow has 'permissions: id-token: write' and retry.";
  return `[TrustBridge] OIDC token minting failed for audience "${audience}": ${detail}. ${hint} Webhook not sent (webhook_auth_mode is "oidc"; no HMAC or unsigned fallback).`;
}

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
export async function sendWebhookNotification(
  result: ValidationResult,
  stellarAddress: string,
  config: WebhookConfig,
  repository: string,
  issueNumber: number | null,
  assets?: AssetReasonEvaluation[],
): Promise<void> {
  // No URL → never mint an OIDC token or build a payload.
  if (!config.webhookUrl) return;

  return traceWebhookDeliver(config.webhookUrl, config.authMode || 'hmac', async () => {
    // Redact the URL for log output so any embedded credentials are masked.
    const safeUrl = redactHorizonUrl(config.webhookUrl);

    const effectiveConfig: WebhookConfig = { ...config };
    if (config.authMode === 'oidc' && !config.oidcToken) {
      const audience = config.oidcAudience || 'trustbridge-dashboard';
      let mintError: unknown;
      try {
        const token = await core.getIDToken(audience);
        if (token) {
          core.setSecret(token);
          effectiveConfig.oidcToken = token;
        }
      } catch (oidcError) {
        mintError = oidcError;
      }
      if (!effectiveConfig.oidcToken) {
        core.setFailed(describeOidcMintFailure(audience, mintError));
        return;
      }
    }

    const payload = buildWebhookPayload(result, stellarAddress, repository, issueNumber, assets);
    // Debug-only payload dump; the logger redacts any G/C-address it contains.
    logger.debug(`Webhook payload: ${JSON.stringify(payload)}`, { component: 'webhook' });
    const delivery = await deliverWebhook(payload, effectiveConfig);

    if (delivery.sent) {
      core.info(
        `[TrustBridge] Webhook delivered to ${safeUrl} (${config.authMode === 'oidc' ? 'OIDC' : 'HMAC'}) — HTTP ${delivery.statusCode ?? 'unknown'}.`,
      );
    } else {
      core.warning(
        `[TrustBridge] Webhook delivery to ${safeUrl} failed (non-fatal): ${redactString(delivery.error ?? 'unknown error')}. Comment posting continues.`,
      );
    }
  });
}
