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
 *   }
 * }
 * ```
 */

import * as crypto from 'crypto';
import * as core from '@actions/core';
import { redactStellarAddress, redactHorizonUrl } from './logger';
import type { ValidationResult } from './checks';
import { traceWebhookDeliver } from './tracing';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WebhookAuthMode = 'hmac' | 'oidc';

export interface WebhookConfig {
  /** Full HTTPS URL of the receiver endpoint. */
  webhookUrl: string;
  /**
   * Shared HMAC-SHA256 secret. When empty and authMode is 'hmac', the webhook is sent **unsigned**
   * (X-TrustBridge-Signature header is omitted). Callers should always set
   * this for production HMAC use.
   */
  webhookSecret?: string;
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
// Payload builder
// ---------------------------------------------------------------------------

/**
 * Build a sanitised webhook payload from a `ValidationResult`.
 *
 * All sensitive values (stellar address) are redacted using the same policy
 * as structured log output — the webhook receiver sees a first-4/last-4
 * masked address, never the full public key.
 */
export function buildWebhookPayload(
  result: ValidationResult,
  stellarAddress: string,
  repository: string,
  issueNumber: number | null,
): WebhookPayload {
  return {
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
      checks: result.checks.map((c) => ({ label: c.label, passed: c.passed })),
    },
  };
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
export const WEBHOOK_REPOSITORY_PATTERN = '^[^/]+/[^/]+$';
export const WEBHOOK_STELLAR_ADDRESS_PATTERN = '^[GC][A-Z2-7]{3}\\.{3}[A-Z2-7]{4}$';

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function checkObjectKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  at: string,
  errors: string[],
): void {
  for (const field of allowed) {
    if (!(field in obj)) errors.push(`${at}: missing required property "${field}"`);
  }
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${at}: unexpected property "${key}"`);
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

  checkObjectKeys(payload, WEBHOOK_PAYLOAD_REQUIRED_FIELDS, 'payload', errors);

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

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/**
 * Deliver a signed webhook notification to the configured endpoint.
 *
 * - Validates the payload against `schemas/webhook-payload.schema.json` and
 *   refuses to send (fail closed) when it does not conform.
 * - Signs the JSON payload with HMAC-SHA256 when a secret is provided.
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

  if (config.authMode === 'oidc' || config.oidcToken) {
    if (config.oidcToken) {
      headers['Authorization'] = `Bearer ${config.oidcToken}`;
    }
  } else if (config.webhookSecret) {
    headers['X-TrustBridge-Signature'] = computeWebhookSignature(body, config.webhookSecret);
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
 * High-level entry point called from `src/index.ts` after validation
 * completes. Builds the payload, delivers the webhook, and logs the outcome
 * — all without throwing so the rest of the action run is unaffected.
 *
 * @param result        The completed `ValidationResult`.
 * @param stellarAddress  Raw (unredacted) Stellar address — redaction happens
 *                      inside this function before it leaves the process.
 * @param config        Resolved webhook configuration.
 * @param repository    `owner/repo` string from the GitHub context.
 * @param issueNumber   Current issue number, or `null` when not in an issue context.
 */
export async function sendWebhookNotification(
  result: ValidationResult,
  stellarAddress: string,
  config: WebhookConfig,
  repository: string,
  issueNumber: number | null,
): Promise<void> {
  if (!config.webhookUrl) return;

  return traceWebhookDeliver(config.webhookUrl, config.authMode || 'hmac', async () => {
    // Redact the URL for log output so any embedded credentials are masked.
    const safeUrl = redactHorizonUrl(config.webhookUrl);

    const effectiveConfig: WebhookConfig = { ...config };
    if (config.authMode === 'oidc' && !config.oidcToken) {
      const audience = config.oidcAudience || 'trustbridge-dashboard';
      try {
        const token = await core.getIDToken(audience);
        if (token) {
          core.setSecret(token);
          effectiveConfig.oidcToken = token;
        }
      } catch (oidcError) {
        const msg = oidcError instanceof Error ? oidcError.message : String(oidcError);
        core.warning(
          `[TrustBridge] OIDC token minting failed for audience "${audience}": ${msg}. Ensure the workflow has 'permissions: id-token: write'.`,
        );
      }
    }

    const payload = buildWebhookPayload(result, stellarAddress, repository, issueNumber);
    const delivery = await deliverWebhook(payload, effectiveConfig);

    if (delivery.sent) {
      core.info(
        `[TrustBridge] Webhook delivered to ${safeUrl} (${config.authMode === 'oidc' ? 'OIDC' : 'HMAC'}) — HTTP ${delivery.statusCode ?? 'unknown'}.`,
      );
    } else {
      core.warning(
        `[TrustBridge] Webhook delivery to ${safeUrl} failed (non-fatal): ${delivery.error ?? 'unknown error'}. Comment posting continues.`,
      );
    }
  });
}
