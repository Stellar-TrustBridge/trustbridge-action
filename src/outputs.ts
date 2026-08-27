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
