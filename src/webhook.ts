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
// Delivery
// ---------------------------------------------------------------------------

/**
 * Deliver a signed webhook notification to the configured endpoint.
 *
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
  };

  if (config.authMode === 'oidc' || config.oidcToken) {
    if (config.oidcToken) {
      headers['Authorization'] = `Bearer ${config.oidcToken}`;
    }
  } else if (config.webhookSecret) {
    headers['X-TrustBridge-Signature'] = computeWebhookSignature(body, config.webhookSecret);
  }

  const controller = new AbortController();
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

  // Redact the URL for log output so any embedded credentials are masked.
  const safeUrl = redactHorizonUrl(config.webhookUrl);

  let effectiveConfig = { ...config };
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
}
