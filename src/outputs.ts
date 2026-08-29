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
  /**
   * #319 — Conflict report to embed in outputs. When present,
   * `conflict_report` and `has_conflicts` outputs are set accordingly.
   */
  conflictReport?: ConflictReport | null;
}

// ---------------------------------------------------------------------------
// #319 — Merge-resolution conflict report
// ---------------------------------------------------------------------------

/**
 * A single source that provided a value for a given field.
 */
export interface ConflictSource {
  /** Symbolic source name: 'workflow_input' | 'assignee_map' | 'contract' | 'config_file'. */
  source: string;
  /** The raw value provided by this source (redacted if privacyMode). */
  value: string;
}

/**
 * A detected conflict — two or more sources disagree on the same field.
 */
export interface ConflictEntry {
  /** The field that has conflicting values (e.g. 'stellar_address', 'asset_issuer'). */
  field: string;
  /** The value that was ultimately used (winning source according to precedence). */
  resolvedValue: string;
  /** All sources that provided a value, including the winner. */
  sources: ConflictSource[];
}

/**
 * Complete conflict report for a single run.
 */
export interface ConflictReport {
  /** True when at least one conflict was found. */
  hasConflicts: boolean;
  /** List of individual field conflicts. Empty when `hasConflicts` is false. */
  conflicts: ConflictEntry[];
  /** ISO-8601 timestamp. */
  generatedAt: string;
}

/**
 * Build a `ConflictReport` from a map of field → sources.
 * A conflict exists when a field has values from ≥ 2 sources that disagree.
 *
 * @param fieldSources  Map from field name to an array of `ConflictSource` items.
 * @param privacyMode   When true, address values are masked to first4…last4.
 * @param now           ISO-8601 timestamp override for testing.
 */
export function buildConflictReport(
  fieldSources: Record<string, ConflictSource[]>,
  options: { privacyMode?: boolean; now?: string } = {},
): ConflictReport {
  const privacyMode = Boolean(options.privacyMode);
  const generatedAt = options.now ?? new Date().toISOString();
  const conflicts: ConflictEntry[] = [];

  for (const [field, sources] of Object.entries(fieldSources)) {
    if (!sources || sources.length < 2) continue;

    // Mask values if privacy mode — redact G/C addresses to first4…last4.
    const maskedSources: ConflictSource[] = sources.map((s) => ({
      source: s.source,
      value: privacyMode ? maskConflictValue(s.value) : s.value,
    }));

    const uniqueValues = new Set(maskedSources.map((s) => s.value));
    if (uniqueValues.size <= 1) continue; // All sources agree — no conflict.

    // The first source in the array is the winner (caller must supply in
    // precedence order: workflow_input > assignee_map > contract > config_file).
    const resolvedValue = maskedSources[0]!.value;
    conflicts.push({ field, resolvedValue, sources: maskedSources });
  }

  return {
    hasConflicts: conflicts.length > 0,
    conflicts,
    generatedAt,
  };
}

/**
 * Mask a value for privacy mode.
 * Redacts G/C Stellar addresses to first4…last4; leaves other values intact.
 */
function maskConflictValue(value: string): string {
  return value.replace(/\b([GC][A-Z2-7]{55})\b/g, (addr) => {
    return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
  });
}

/**
 * Format a `ConflictReport` as a Markdown section for embedding in an issue
 * comment.
 *
 * Returns an empty string when there are no conflicts so callers can
 * unconditionally append the result.
 */
export function formatConflictReportMarkdown(report: ConflictReport | null | undefined): string {
  if (!report || !report.hasConflicts) return '';

  const lines: string[] = [
    '### ⚠️ Input source conflicts detected',
    '',
    '> Two or more sources provided different values for the same input field.',
    '> The value with the highest precedence (`workflow_input` > `assignee_map` > `contract` > `config_file`) was used.',
    '',
    '| Field | Resolved value | Sources |',
    '| --- | --- | --- |',
  ];

  for (const conflict of report.conflicts) {
    const sourceSummary = conflict.sources
      .map((s) => `\`${s.source}\`: \`${s.value}\``)
      .join(', ');
    lines.push(`| \`${conflict.field}\` | \`${conflict.resolvedValue}\` | ${sourceSummary} |`);
  }

  lines.push('');
  return lines.join('\n');
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
  // Split balances (Issue #246) — native vs trustline
  // All balance strings are 7-decimal Horizon strings ("0", "unknown", or "1.0000000")
  asset_balance: string;
  native_balance: string;
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
  /**
   * #319 — Merge-resolution conflict report.
   * JSON string listing sources that disagree on the Stellar address or
   * validation inputs (e.g. workflow input vs assignee-map vs contract).
   * Empty string (`""`) when there are no conflicts.
   */
  conflict_report: string;
  /**
   * #319 — True when at least one source conflict was detected this run.
   * Allows downstream steps to gate on `steps.trustbridge.outputs.has_conflicts == 'true'`.
   */
  has_conflicts: string;
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
    // Split balances — native vs asset (Issue #246). 7-decimal strings; legacy xlm_balance retained
    asset_balance: result.assetBalance ?? '0',
    native_balance: result.xlmBalance,
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
    // #319 — conflict report
    conflict_report: extras.conflictReport
      ? JSON.stringify(extras.conflictReport)
      : '',
    has_conflicts: String(extras.conflictReport?.hasConflicts ?? false),
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
