import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';

import { ValidationResult } from './checks';
import { generateBadgeSnippets } from './badge';
import {
  ValidationDelta,
  ValidationArtifact,
  BuildValidationArtifactOptions,
  buildValidationArtifact,
} from './delta';

export interface ActionTimings {
  input_parse_ms?: number;
  horizon_fetch_ms?: number;
  checks_ms?: number;
  comment_post_ms?: number;
  total_ms?: number;
}

export interface ActionOutputExtras {
  horizonUrl?: string;
  assetCode?: string;
  assetIssuer?: string;
  timings?: ActionTimings;
  validatedAt?: string;
  /** Optional assignee login for matrix-friendly outputs (Issue #3). */
  assigneeLogin?: string;
  /** Optional stellar address for matrix-friendly outputs (Issue #3). */
  stellarAddress?: string;
  /** Friendbot call information (Issue #4). */
  friendbotCalled?: boolean;
  friendbotSuccess?: boolean;
  friendbotTransactionHash?: string;
}

export interface ActionOutputs {
  // Legacy outputs — kept for backward compatibility
  trustline_exists: string;
  xlm_balance: string;
  account_funded: string;
  comment_url: string;
  full_report_path: string;
  // Extended audit / timing outputs
  ready: string;
  validated_at: string;
  reason_code: string;
  horizon_url: string;
  asset_code: string;
  asset_issuer: string;
  checks_json: string;
  // Badge outputs for README/dashboard embeds
  badge_markdown: string;
  badge_url: string;
  // Timing breakdown outputs
  timings_json: string;
  timing_input_parse_ms: string;
  timing_horizon_fetch_ms: string;
  timing_checks_ms: string;
  timing_comment_post_ms: string;
  timing_total_ms: string;
  num_sponsoring: string;
  num_sponsored: string;
  // Network passphrase mismatch (Issue #2)
  network_passphrase_mismatch: string;
  expected_network_passphrase: string;
  actual_network_passphrase: string;
  // Matrix-friendly outputs (Issue #3)
  assignee_results_json: string;
  matrix_ready_map: string;
  // Friendbot outputs (Issue #4)
  friendbot_called: string;
  friendbot_success: string;
  friendbot_transaction_hash: string;
}

export function toActionOutputs(
  result: ValidationResult,
  commentUrl?: string,
  fullReportPath?: string,
  extras: ActionOutputExtras = {},
): ActionOutputs {
  const timings = extras.timings ?? {};
  const validatedAt = extras.validatedAt ?? new Date().toISOString();
  const { markdown: badgeMarkdown, url: badgeUrl } = generateBadgeSnippets(result);
  
  const mismatch = result.networkPassphraseMismatch;
  
  // Matrix-friendly outputs (Issue #3)
  const assigneeResultsJson = extras.assigneeLogin && extras.stellarAddress
    ? JSON.stringify({
        [extras.assigneeLogin]: {
          ready: result.valid,
          stellar_address: extras.stellarAddress,
          xlm_balance: result.xlmBalance,
          account_funded: result.accountFunded,
          trustline_exists: result.trustlineExists,
          reason_code: result.reasonCode ?? (result.valid ? 'SUCCESS' : 'FAILED'),
          validated_at: validatedAt,
        },
      })
    : '{}';

  const matrixReadyMap = extras.assigneeLogin
    ? JSON.stringify({
        [extras.assigneeLogin]: result.valid,
      })
    : '{}';
  
  return {
    trustline_exists: String(result.trustlineExists),
    xlm_balance: result.xlmBalance,
    account_funded: String(result.accountFunded),
    comment_url: commentUrl ?? '',
    full_report_path: fullReportPath ?? '',
    ready: String(result.valid),
    validated_at: validatedAt,
    reason_code: result.reasonCode ?? (result.valid ? 'SUCCESS' : 'FAILED'),
    horizon_url: extras.horizonUrl ?? '',
    asset_code: extras.assetCode ?? '',
    asset_issuer: extras.assetIssuer ?? '',
    checks_json: JSON.stringify(
      result.checks.map((check) => ({
        label: check.label,
        passed: check.passed,
        detail: check.detail,
      })),
    ),
    badge_markdown: badgeMarkdown,
    badge_url: badgeUrl,
    timings_json: JSON.stringify({
      input_parse_ms: timings.input_parse_ms ?? 0,
      horizon_fetch_ms: timings.horizon_fetch_ms ?? 0,
      checks_ms: timings.checks_ms ?? 0,
      comment_post_ms: timings.comment_post_ms ?? 0,
      total_ms: timings.total_ms ?? 0,
    }),
    timing_input_parse_ms: String(timings.input_parse_ms ?? 0),
    timing_horizon_fetch_ms: String(timings.horizon_fetch_ms ?? 0),
    timing_checks_ms: String(timings.checks_ms ?? 0),
    timing_comment_post_ms: String(timings.comment_post_ms ?? 0),
    timing_total_ms: String(timings.total_ms ?? 0),
    num_sponsoring: String(result.sponsorshipInfo?.numSponsoring ?? 0),
    num_sponsored: String(result.sponsorshipInfo?.numSponsored ?? 0),
    network_passphrase_mismatch: mismatch ? 'true' : 'false',
    expected_network_passphrase: mismatch?.expectedPassphrase ?? '',
    actual_network_passphrase: mismatch?.actualPassphrase ?? '',
    assignee_results_json: assigneeResultsJson,
    matrix_ready_map: matrixReadyMap,
    friendbot_called: String(extras.friendbotCalled ?? false),
    friendbot_success: String(extras.friendbotSuccess ?? false),
    friendbot_transaction_hash: extras.friendbotTransactionHash ?? '',
  };
}

export function setValidationOutputs(
  result: ValidationResult,
  commentUrl?: string,
  fullReportPath?: string,
  extras: ActionOutputExtras = {},
): void {
  const outputs = toActionOutputs(result, commentUrl, fullReportPath, extras);
  for (const [name, value] of Object.entries(outputs)) {
    core.setOutput(name, value);
  }
}

export interface WriteValidationJsonOptions {
  result: ValidationResult;
  stellarAddress: string;
  assetCode: string;
  assetIssuer: string;
  horizonUrl?: string;
  outputPath: string;
  delta?: ValidationDelta | null;
  privacyMode?: boolean;
  workspaceRoot?: string;
}

/**
 * Write a structured `validation.json` artifact for security review and
 * cross-run delta comparison. Never includes `github_token` or auth headers.
 */
export function writeValidationJson(options: WriteValidationJsonOptions): ValidationArtifact {
  const buildOpts: BuildValidationArtifactOptions = {
    result: options.result,
    stellarAddress: options.stellarAddress,
    assetCode: options.assetCode,
    assetIssuer: options.assetIssuer,
    horizonUrl: options.horizonUrl,
    delta: options.delta,
    privacyMode: options.privacyMode,
  };

  const payload = buildValidationArtifact(buildOpts);
  const root = options.workspaceRoot || process.env.GITHUB_WORKSPACE || process.cwd();
  const absolutePath = path.isAbsolute(options.outputPath)
    ? options.outputPath
    : path.resolve(root, options.outputPath);

  const dir = path.dirname(absolutePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(absolutePath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

// ---------------------------------------------------------------------------
// Matrix-friendly output helpers (Issue #3)
// ---------------------------------------------------------------------------

export interface AssigneeResult {
  ready: boolean;
  stellar_address: string;
  xlm_balance: string;
  account_funded: boolean;
  trustline_exists: boolean;
  reason_code: string;
  validated_at: string;
}

export type AssigneeResultsMap = Record<string, AssigneeResult>;
export type MatrixReadyMap = Record<string, boolean>;

/**
 * Build matrix-friendly JSON outputs from multiple validation results.
 * This enables GitHub matrix workflows to access per-assignee results via
 * `fromJSON(steps.trustbridge.outputs.matrix_ready_map)`.
 *
 * Example usage in a matrix workflow:
 * ```yaml
 * strategy:
 *   matrix:
 *     assignee: [alice, bob, charlie]
 * steps:
 *   - id: check
 *     run: |
 *       READY=$(echo '${{ steps.trustbridge.outputs.matrix_ready_map }}' | jq -r '.["${{ matrix.assignee }}"]')
 *       echo "ready=$READY" >> $GITHUB_OUTPUT
 * ```
 *
 * @param results Array of validation results with assignee metadata
 * @returns JSON string maps for assignee_results_json and matrix_ready_map
 */
export function buildMatrixOutputs(
  results: Array<{
    assigneeLogin: string;
    stellarAddress: string;
    validationResult: ValidationResult;
    validatedAt?: string;
  }>,
): { assigneeResultsJson: string; matrixReadyMap: string } {
  const assigneeResults: AssigneeResultsMap = {};
  const readyMap: MatrixReadyMap = {};

  for (const { assigneeLogin, stellarAddress, validationResult, validatedAt } of results) {
    const validated = validatedAt ?? new Date().toISOString();
    
    assigneeResults[assigneeLogin] = {
      ready: validationResult.valid,
      stellar_address: stellarAddress,
      xlm_balance: validationResult.xlmBalance,
      account_funded: validationResult.accountFunded,
      trustline_exists: validationResult.trustlineExists,
      reason_code: validationResult.reasonCode ?? (validationResult.valid ? 'SUCCESS' : 'FAILED'),
      validated_at: validated,
    };

    readyMap[assigneeLogin] = validationResult.valid;
  }

  return {
    assigneeResultsJson: JSON.stringify(assigneeResults),
    matrixReadyMap: JSON.stringify(readyMap),
  };
}

/**
 * Sanitize a GitHub username for use as a matrix dimension or output key.
 * Replaces characters that could cause issues in GitHub Actions expressions
 * with safe alternatives.
 *
 * Rules:
 * - Hyphens and underscores preserved
 * - Other special characters replaced with underscore
 * - Leading digits prefixed with underscore
 * - Empty string becomes "unknown"
 *
 * @param username GitHub username (e.g., from assignee.login)
 * @returns Sanitized key safe for GitHub Actions output names
 */
export function sanitizeUsernameForMatrix(username: string): string {
  if (!username || username.trim().length === 0) {
    return 'unknown';
  }

  let sanitized = username
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_');

  // Prefix with underscore if starts with digit
  if (/^\d/.test(sanitized)) {
    sanitized = '_' + sanitized;
  }

  return sanitized || 'unknown';
}
