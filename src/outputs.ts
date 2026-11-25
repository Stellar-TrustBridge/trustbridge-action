import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import Ajv, { ErrorObject, ValidateFunction } from 'ajv';

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

export interface AssetTrustlineStatus {
  assetCode: string;
  assetIssuer: string;
  trustlineExists: boolean;
  balance: string;
}

export interface ActionOutputExtras {
  horizonUrl?: string;
  assetCode?: string;
  assetIssuer?: string;
  assetsTrustlineStatus?: AssetTrustlineStatus[];
  timings?: ActionTimings;
  validatedAt?: string;
  assigneeLogin?: string;
  stellarAddress?: string;
  /**
   * #319 — Conflict report to embed in outputs. When present,
   * `conflict_report` and `has_conflicts` outputs are set accordingly.
   */
  conflictReport?: ConflictReport | null;
  /** #459 — Friendbot outputs */
  friendbotCalled?: boolean;
  friendbotSuccess?: boolean;
  friendbotTransactionHash?: string;
  /**
   * #550 — GitHub Check Run outputs. When `use_check_runs` is enabled,
   * index.ts passes the created run's id and conclusion here so
   * `setValidationOutputs` stays the single publisher of every action.yml
   * output. Absent values publish as empty strings, matching the
   * "empty otherwise" contract documented in action.yml.
   */
  checkRunId?: string;
  checkRunConclusion?: string;
  /**
   * #696 — Numeric REST id of the issue comment TrustBridge created or
   * updated this run, as a string. Absent when no comment was posted
   * (`posting_mode: dry-run` / `off`, no issue context, or a failed post),
   * which publishes `comment_id` as an empty string.
   */
  commentId?: string;
  /**
   * #799 — True when the comment posted/updated this run happened
   * specifically because an active snooze window just lapsed (see
   * `PostedIssueComment.snoozeExpired` in `src/comment.ts`). Defaults to
   * `false`, publishing `snooze_expired` as `"false"` when absent.
   */
  snoozeExpired?: boolean;
}

// ---------------------------------------------------------------------------
// #919 — Boolean output normalization for workflow `if:` conditions
// ---------------------------------------------------------------------------

/** The only two values a boolean action output may ever carry. */
export type BooleanOutputString = 'true' | 'false';

/**
 * Every action output that carries a boolean. Each one is always published
 * as exactly `"true"` or `"false"` — lower-case, no whitespace, never empty,
 * never `"1"`/`"0"`/`"undefined"` — so a workflow can gate with
 * `if: steps.trustbridge.outputs.<name> == 'true'` and get a stable answer.
 */
export const BOOLEAN_OUTPUT_NAMES = Object.freeze([
  'ready',
  'trustline_exists',
  'account_funded',
  'snooze_expired',
  'has_conflicts',
  'network_passphrase_mismatch',
  'friendbot_called',
  'friendbot_success',
  'outputs_truncated',
] as const);

export type BooleanOutputName = (typeof BOOLEAN_OUTPUT_NAMES)[number];

/**
 * Thrown by {@link parseBooleanOutput} for a value that is not a recognised
 * boolean. `received` is a short type/shape description, never the raw
 * value, so an unexpected object cannot leak into logs.
 */
export class BooleanOutputError extends TypeError {
  constructor(
    public readonly outputName: string,
    public readonly received: string,
  ) {
    super(
      `Output "${outputName}" expects a boolean (true/false, or legacy 1/0); received ${received}.`,
    );
    this.name = 'BooleanOutputError';
  }
}

const TRUE_STRINGS = new Set(['true', '1']);
const FALSE_STRINGS = new Set(['false', '0', '']);

function describeReceived(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 32 ? `a ${value.length}-character string` : `string ${JSON.stringify(value)}`;
  }
  if (typeof value === 'number') return `number ${String(value)}`;
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

/**
 * Strictly parse a boolean-like value into a real boolean.
 *
 * Accepted (case-insensitive, surrounding whitespace ignored for strings):
 * - `true` / `false` (boolean or string)
 * - legacy `1` / `0` (number or string)
 * - `null`, `undefined`, and `""` → `false` (an absent flag is off)
 *
 * Anything else — `"yes"`, `2`, `NaN`, objects, arrays — throws a
 * {@link BooleanOutputError}. Outputs are a machine contract; guessing at
 * `"yes"` here would hide a producer bug.
 */
export function parseBooleanOutput(value: unknown, outputName = 'value'): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    throw new BooleanOutputError(outputName, describeReceived(value));
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (TRUE_STRINGS.has(normalized)) return true;
    if (FALSE_STRINGS.has(normalized)) return false;
  }
  throw new BooleanOutputError(outputName, describeReceived(value));
}

/**
 * Normalize a boolean-like value to the `"true"` / `"false"` string contract.
 *
 * Fails closed: a malformed value publishes `"false"` (so a payout gate
 * never opens on garbage) and emits a `core.warning` naming the output.
 */
export function toBooleanOutput(value: unknown, outputName = 'value'): BooleanOutputString {
  try {
    return parseBooleanOutput(value, outputName) ? 'true' : 'false';
  } catch (error) {
    core.warning(
      `${error instanceof Error ? error.message : String(error)} Publishing "false" (fail closed).`,
    );
    return 'false';
  }
}

/**
 * Re-normalize every {@link BOOLEAN_OUTPUT_NAMES} entry of an outputs map in
 * place-safe fashion (returns a new object). Non-boolean outputs pass
 * through untouched. Used as the last step before `core.setOutput` so no
 * code path can publish `"True"`, `"1"`, or `"undefined"`.
 */
export function normalizeBooleanOutputs<T extends Partial<Record<BooleanOutputName, string>>>(outputs: T): T {
  const normalized: Record<string, unknown> = { ...outputs };
  for (const name of BOOLEAN_OUTPUT_NAMES) {
    if (name in normalized) {
      normalized[name] = toBooleanOutput(normalized[name], name);
    }
  }
  return normalized as T;
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

// ---------------------------------------------------------------------------
// Output size cap (Issue #854)
//
// GitHub Actions enforces a per-output size limit (documented here, and in
// docs/USAGE.md#output-size-limits, as 1MB). A JSON array/map output built
// from an unbounded source — assets_json entries, batch addresses, matrix
// assignees — can exceed that limit on a large Wave run. GitHub's own
// behavior when that happens is not a clean, catchable error the workflow
// can branch on, so TrustBridge truncates deterministically *before*
// `core.setOutput` is ever called and reports the fact via `outputs_truncated`,
// rather than letting a Wave matrix workflow silently see an incomplete (or
// entirely missing) payout list and make the wrong branch decision.
// ---------------------------------------------------------------------------

/**
 * Budget for a single JSON output value, in UTF-8 bytes. Set below GitHub
 * Actions' documented 1MB per-output limit to leave headroom for the output
 * name, the `GITHUB_OUTPUT` file's own delimiter syntax, and any other
 * output written in the same step.
 */
export const MAX_OUTPUT_VALUE_BYTES = 900_000;

/**
 * GitHub's documented limit for one step output value: 1 MiB, the same on
 * github.com and GHES. `MAX_OUTPUT_VALUE_BYTES` stays below it. See
 * docs/GHES_COMPATIBILITY.md#actions-outputs-summaries-and-annotations-issue-897.
 */
export const GITHUB_OUTPUT_VALUE_LIMIT_BYTES = 1024 * 1024;

/**
 * GitHub's documented limits on workflow-command annotations
 * (`core.warning` / `core.error` / `core.notice`). Annotations past these
 * caps are dropped from the run UI but still printed to the log.
 */
export const WORKFLOW_ANNOTATION_LIMITS = Object.freeze({
  errorsPerStep: 10,
  warningsPerStep: 10,
  perJob: 50,
});

/**
 * How `core.setOutput()` delivers outputs on this runner.
 *
 * - `file-command`: the runner sets `GITHUB_OUTPUT` (current github.com
 *   runners and up-to-date GHES runners).
 * - `workflow-command`: `GITHUB_OUTPUT` is missing (older GHES runners), so
 *   `@actions/core` falls back to the deprecated `::set-output` command.
 *   Outputs still work, but the runner logs a deprecation warning, and
 *   multi-line values are less reliable.
 *
 * Mirrors `@actions/core`, which only checks that the variable is non-empty.
 */
export type OutputTransport = 'file-command' | 'workflow-command';

export function resolveOutputTransport(
  env: Record<string, string | undefined> = process.env,
): OutputTransport {
  return env && typeof env.GITHUB_OUTPUT === 'string' && env.GITHUB_OUTPUT !== ''
    ? 'file-command'
    : 'workflow-command';
}

/** UTF-8 byte length of a string — never its UTF-16 `.length` (wrong for multibyte characters). */
function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Result of truncating an array-shaped JSON output to fit a byte budget. */
export interface TruncatedJsonResult {
  /** The (possibly truncated) JSON string, always within `maxBytes`. */
  json: string;
  /** True when one or more entries were dropped to fit the budget. */
  truncated: boolean;
  /** Number of entries included in `json`. */
  includedCount: number;
  /** Number of entries in the original input. */
  totalCount: number;
}

/**
 * Serialize `items` to JSON via `toJson`, truncating deterministically from
 * the end until the result fits within `maxBytes`.
 *
 * Deterministic and order-preserving: for a given `items` array, the
 * included prefix is always the same — earlier entries are kept, later ones
 * are dropped — so two runs over the same (even differently-ordered-by-
 * network-timing) input never disagree about which entries survive, as
 * long as the caller passes `items` in a stable order.
 *
 * Correct on multibyte input: size is measured with `Buffer.byteLength`
 * (UTF-8 bytes), not `String.length` (UTF-16 code units), so an array of
 * entries containing emoji, CJK text, or other multibyte characters is
 * capped by actual output size, not character count.
 *
 * @param items    Entries to serialize, in the order they should be kept.
 * @param toJson   Serializes a prefix of `items` (e.g. `(xs) => JSON.stringify(xs)`).
 * @param maxBytes Byte budget; defaults to {@link MAX_OUTPUT_VALUE_BYTES}.
 */
export function truncateJsonArray<T>(
  items: readonly T[],
  toJson: (subset: T[]) => string,
  maxBytes: number = MAX_OUTPUT_VALUE_BYTES,
): TruncatedJsonResult {
  const full = toJson([...items]);
  if (byteLength(full) <= maxBytes || items.length === 0) {
    return { json: full, truncated: false, includedCount: items.length, totalCount: items.length };
  }

  // Binary search for the largest prefix whose serialization fits. Correct
  // even when entries vary wildly in size (e.g. one giant failure reason
  // string among many short ones) because it re-serializes the real
  // candidate prefix on every probe instead of assuming uniform entry size.
  let lo = 0;
  let hi = items.length - 1;
  let best = 0;
  let bestJson = toJson([]);
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = toJson(items.slice(0, mid + 1) as T[]);
    if (byteLength(candidate) <= maxBytes) {
      best = mid + 1;
      bestJson = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return { json: bestJson, truncated: true, includedCount: best, totalCount: items.length };
}

export interface ActionOutputs {
  // Legacy outputs — kept for backward compatibility
  trustline_exists: string;
  xlm_balance: string;
  account_funded: string;
  comment_url: string;
  /**
   * #696 — Numeric REST id of the created or updated issue comment, as a
   * string. Empty when no comment was posted.
   */
  comment_id: string;
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
  badge_etag: string;
  // Snooze expiry (Issue #799)
  snooze_expired: string;
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
  network_passphrase_mismatch: string;
  expected_network_passphrase: string;
  actual_network_passphrase: string;
  assignee_results_json: string;
  matrix_ready_map: string;
  /**
   * GitHub Checks API integration (Wave #26 / Issue #421). ID of the created
   * Check Run when `use_check_runs` is true, empty otherwise.
   */
  check_run_id: string;
  /** Conclusion of the created Check Run (success/failure), empty when skipped. */
  check_run_conclusion: string;
  // #459 Friendbot outputs
  friendbot_called: string;
  friendbot_success: string;
  friendbot_transaction_hash: string;
  assets_trustline_status: string;
  trustlines_summary: string;
  /**
   * Batch-mode outputs (Issue #670).
   *
   * Published on the batch code path in index.ts, which returns before
   * `setValidationOutputs` runs. Single-address runs publish empty strings here
   * so the action.yml output contract stays total: every declared output has a
   * value in every mode, and a consumer never has to distinguish "unset" from
   * "empty string".
   */
  batch_summary_json: string;
  batch_passed_count: string;
  batch_failed_count: string;
  /**
   * Issue #854 — `"true"` when any JSON/array output this run produced
   * (currently `assets_trustline_status`; batch mode also sets this via
   * `batch_summary_json`'s own truncation in `src/index.ts`) was truncated
   * to stay within `MAX_OUTPUT_VALUE_BYTES`. `"false"` otherwise. Always
   * set — never empty — so a consumer can gate on it unconditionally:
   * `if: steps.trustbridge.outputs.outputs_truncated == 'true'`.
   */
  outputs_truncated: string;
  /**
   * Issue #965 — absolute path of the optional diagnostics bundle when one was
   * written this run, empty otherwise. index.ts publishes the real value after
   * the run; this default keeps the output contract total.
   */
  diagnostics_zip_path: string;
  /** Issue #965 — outcome code of the diagnostics bundle (default `disabled`). */
  diagnostics_zip_status: string;
}

export function toActionOutputs(
  result: ValidationResult,
  commentUrl?: string,
  fullReportPath?: string,
  extras: ActionOutputExtras = {},
): ActionOutputs {
  const timings = extras.timings ?? {};
  const validatedAt = extras.validatedAt ?? new Date().toISOString();
  const { markdown: badgeMarkdown, url: badgeUrl, etag: badgeEtag } = generateBadgeSnippets(result);
  
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

  const assetsTrustlineStatus = (extras.assetsTrustlineStatus ?? []).map(
    (status) => ({
      asset_code: status.assetCode,
      asset_issuer: status.assetIssuer,
      trustline_exists: status.trustlineExists,
      balance: status.balance,
    }),
  );
  const presentTrustlines = assetsTrustlineStatus.filter(
    (status) => status.trustline_exists,
  ).length;
  // Issue #854: a run with hundreds of assets_json entries could otherwise
  // produce an assets_trustline_status output over GitHub's per-output size
  // limit. trustlines_summary still reports the true, untruncated totals —
  // only the JSON array itself is capped.
  const assetsTrustlineStatusTruncation = truncateJsonArray(
    assetsTrustlineStatus,
    (subset) => JSON.stringify(subset),
  );
  
  return {
    trustline_exists: toBooleanOutput(result.trustlineExists, 'trustline_exists'),
    xlm_balance: result.xlmBalance,
    account_funded: toBooleanOutput(result.accountFunded, 'account_funded'),
    comment_url: commentUrl ?? '',
    comment_id: extras.commentId ?? '',
    full_report_path: fullReportPath ?? '',
    ready: toBooleanOutput(result.valid, 'ready'),
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
    badge_etag: badgeEtag,
    snooze_expired: toBooleanOutput(extras.snoozeExpired, 'snooze_expired'),
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
    has_conflicts: toBooleanOutput(extras.conflictReport?.hasConflicts, 'has_conflicts'),
    network_passphrase_mismatch: toBooleanOutput(Boolean(mismatch), 'network_passphrase_mismatch'),
    expected_network_passphrase: mismatch?.expectedPassphrase ?? '',
    actual_network_passphrase: mismatch?.actualPassphrase ?? '',
    assignee_results_json: assigneeResultsJson,
    matrix_ready_map: matrixReadyMap,
    // #550 — Check Run outputs published through the single output publisher.
    // Empty strings when no Check Run was created, per the action.yml contract.
    check_run_id: extras.checkRunId ?? '',
    check_run_conclusion: extras.checkRunConclusion ?? '',
    friendbot_called: toBooleanOutput(extras.friendbotCalled, 'friendbot_called'),
    friendbot_success: toBooleanOutput(extras.friendbotSuccess, 'friendbot_success'),
    friendbot_transaction_hash: extras.friendbotTransactionHash ?? '',
    assets_trustline_status: assetsTrustlineStatusTruncation.json,
    trustlines_summary: `${presentTrustlines} of ${assetsTrustlineStatus.length} additional trustlines present`,
    // Batch-mode outputs. Empty in single-address mode; index.ts overwrites
    // these on the batch path before returning. (Issue #670)
    batch_summary_json: '',
    batch_passed_count: '',
    batch_failed_count: '',
    // Issue #854 — index.ts's batch path overwrites this with its own
    // truncation result (batch_summary_json can be far larger than
    // assets_trustline_status); single-address mode reports whether
    // assets_trustline_status itself was truncated.
    outputs_truncated: String(assetsTrustlineStatusTruncation.truncated),
    // Issue #965 — overwritten by index.ts when diagnostics_zip_path is set.
    diagnostics_zip_path: '',
    diagnostics_zip_status: 'disabled',

    outputs_truncated: toBooleanOutput(assetsTrustlineStatusTruncation.truncated, 'outputs_truncated'),
  };
}

// ---------------------------------------------------------------------------
// Structured output schema validation (Issue #969)
// ---------------------------------------------------------------------------

/** One path-aware schema violation found in a structured action output. */
export interface ActionOutputViolation {
  output: string;
  path: string;
  message: string;
}

/** Thrown before any `core.setOutput` call when a structured output is invalid. */
export class ActionOutputSchemaError extends Error {
  readonly violations: ActionOutputViolation[];

  constructor(violations: ActionOutputViolation[]) {
    const summary = violations
      .map((violation) => `${violation.path}: ${violation.message}`)
      .join('; ');
    super(`Invalid action output — ${summary}`);
    this.name = 'ActionOutputSchemaError';
    this.violations = violations;
    Object.setPrototypeOf(this, ActionOutputSchemaError.prototype);
  }
}

type OutputSchema = Record<string, unknown>;

const TIMING_FIELDS = [
  'input_parse_ms',
  'horizon_fetch_ms',
  'checks_ms',
  'comment_post_ms',
  'total_ms',
] as const;

const ASSIGNEE_RESULT_FIELDS = [
  'ready',
  'stellar_address',
  'xlm_balance',
  'account_funded',
  'trustline_exists',
  'reason_code',
  'validated_at',
] as const;

function propertiesOf(
  fields: readonly string[],
  schema: OutputSchema,
): Record<string, OutputSchema> {
  return Object.fromEntries(fields.map((field) => [field, schema]));
}

/**
 * Schemas for every JSON-encoded output published by this action. Scalar
 * outputs are already strings by construction and are covered by the
 * `action.yml` output contract; these schemas protect the structured values
 * downstream Wave workflows parse with `fromJSON()`.
 */
export const STRUCTURED_OUTPUT_SCHEMAS: Record<string, OutputSchema> = {
  checks_json: {
    type: 'array',
    items: {
      type: 'object',
      required: ['label', 'passed', 'detail'],
      additionalProperties: false,
      properties: {
        label: { type: 'string' },
        passed: { type: 'boolean' },
        detail: { type: 'string' },
      },
    },
  },
  timings_json: {
    type: 'object',
    required: [...TIMING_FIELDS],
    additionalProperties: false,
    properties: propertiesOf(TIMING_FIELDS, { type: 'number' }),
  },
  assignee_results_json: {
    type: 'object',
    additionalProperties: {
      type: 'object',
      required: [...ASSIGNEE_RESULT_FIELDS],
      additionalProperties: false,
      properties: {
        ready: { type: 'boolean' },
        stellar_address: { type: 'string' },
        xlm_balance: { type: 'string' },
        account_funded: { type: 'boolean' },
        trustline_exists: { type: 'boolean' },
        reason_code: { type: 'string' },
        validated_at: { type: 'string' },
      },
    },
  },
  matrix_ready_map: {
    type: 'object',
    additionalProperties: { type: 'boolean' },
  },
  conflict_report: {
    type: 'object',
    required: ['hasConflicts', 'conflicts', 'generatedAt'],
    additionalProperties: false,
    properties: {
      hasConflicts: { type: 'boolean' },
      generatedAt: { type: 'string' },
      conflicts: {
        type: 'array',
        items: {
          type: 'object',
          required: ['field', 'resolvedValue', 'sources'],
          additionalProperties: false,
          properties: {
            field: { type: 'string' },
            resolvedValue: { type: 'string' },
            sources: {
              type: 'array',
              items: {
                type: 'object',
                required: ['source', 'value'],
                additionalProperties: false,
                properties: {
                  source: { type: 'string' },
                  value: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  },
  assets_trustline_status: {
    type: 'array',
    items: {
      type: 'object',
      required: ['asset_code', 'asset_issuer', 'trustline_exists', 'balance'],
      additionalProperties: false,
      properties: {
        asset_code: { type: 'string' },
        asset_issuer: { type: 'string' },
        trustline_exists: { type: 'boolean' },
        balance: { type: 'string' },
      },
    },
  },
  batch_summary_json: {
    type: 'object',
    required: [
      'total',
      'passed',
      'failed',
      'failures',
      'failureTaxonomy',
      'clawbackStrictFailures',
      'clawbackStrictMode',
    ],
    additionalProperties: false,
    properties: {
      total: { type: 'number' },
      passed: { type: 'number' },
      failed: { type: 'number' },
      clawbackStrictFailures: { type: 'number' },
      clawbackStrictMode: { type: 'boolean' },
      fatal: { type: 'boolean' },
      fatalReasonCodes: { type: 'array', items: { type: 'string' } },
      failures: {
        type: 'array',
        items: {
          type: 'object',
          required: ['address', 'reason', 'reasonCode', 'clawbackStrict'],
          additionalProperties: false,
          properties: {
            address: { type: 'string' },
            reason: { type: 'string' },
            reasonCode: { type: 'string' },
            clawbackStrict: { type: 'boolean' },
          },
        },
      },
      failureTaxonomy: {
        type: 'object',
        required: [
          'accountNotFunded',
          'trustlineMissing',
          'reserveInsufficient',
          'horizonError',
          'invalidAddress',
          'clawbackStrict',
        ],
        additionalProperties: false,
        properties: propertiesOf(
          [
            'accountNotFunded',
            'trustlineMissing',
            'reserveInsufficient',
            'horizonError',
            'invalidAddress',
            'clawbackStrict',
          ],
          { type: 'number' },
        ),
      },
    },
  },
};

/** Empty string is the documented "not present" sentinel for these outputs. */
const EMPTY_OUTPUT_SENTINELS = new Set(['conflict_report', 'batch_summary_json']);

const ajv = new Ajv({ allErrors: true, strict: false });
const outputValidators = new Map<string, ValidateFunction>();

function getOutputValidator(name: string): ValidateFunction {
  const cached = outputValidators.get(name);
  if (cached) return cached;

  const schema = STRUCTURED_OUTPUT_SCHEMAS[name];
  if (!schema) {
    throw new Error(`No output schema is registered for "${name}".`);
  }
  const compiled = ajv.compile(schema);
  outputValidators.set(name, compiled);
  return compiled;
}

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function appendProperty(path: string, property: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(property)
    ? `${path}.${property}`
    : `${path}[${JSON.stringify(property)}]`;
}

/** Render an AJV error as a readable `$.output[0].field` path. */
export function formatOutputErrorPath(output: string, error: ErrorObject): string {
  let result = `$.${output}`;
  for (const rawSegment of (error.instancePath ?? '').split('/').filter(Boolean)) {
    const segment = decodePointerSegment(rawSegment);
    result = /^\d+$/.test(segment) ? `${result}[${segment}]` : appendProperty(result, segment);
  }
  const params = error.params as Record<string, unknown>;
  if (error.keyword === 'required' && typeof params['missingProperty'] === 'string') {
    result = appendProperty(result, params['missingProperty']);
  }
  if (error.keyword === 'additionalProperties' && typeof params['additionalProperty'] === 'string') {
    result = appendProperty(result, params['additionalProperty']);
  }
  return result;
}

/** Validate one structured output value before it is published. */
export function validateActionOutput(name: string, value: string): void {
  if (!Object.prototype.hasOwnProperty.call(STRUCTURED_OUTPUT_SCHEMAS, name)) return;
  if (value === '' && EMPTY_OUTPUT_SENTINELS.has(name)) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ActionOutputSchemaError([
      {
        output: name,
        path: `$.${name}`,
        message: 'must be valid JSON',
      },
    ]);
  }

  const validate = getOutputValidator(name);
  if (validate(parsed)) return;

  const violations = (validate.errors ?? []).map((error) => ({
    output: name,
    path: formatOutputErrorPath(name, error),
    message: error.message ?? 'is invalid',
  }));
  throw new ActionOutputSchemaError(
    violations.length > 0
      ? violations
      : [{ output: name, path: `$.${name}`, message: 'is invalid' }],
  );
}

/**
 * Validate every structured output in an `ActionOutputs` object. Validation is
 * all-or-nothing: callers must finish this successfully before publishing any
 * output so a failure cannot leave a partially populated step output set.
 */
export function validateActionOutputs(outputs: ActionOutputs): void {
  const violations: ActionOutputViolation[] = [];
  for (const [name, value] of Object.entries(outputs)) {
    try {
      validateActionOutput(name, value);
    } catch (error) {
      if (error instanceof ActionOutputSchemaError) {
        violations.push(...error.violations);
      } else {
        throw error;
      }
    }
  }
  if (violations.length > 0) {
    throw new ActionOutputSchemaError(violations);
  }
}

export function setValidationOutputs(
  result: ValidationResult,
  commentUrl?: string,
  fullReportPath?: string,
  extras: ActionOutputExtras = {},
): void {
  // #919: final normalization pass so every boolean output is exactly
  // "true" or "false", whatever path produced it.
  const outputs = normalizeBooleanOutputs(toActionOutputs(result, commentUrl, fullReportPath, extras));
  // Issue #969 — validate the complete set first so a malformed structured
  // output can never leave half of the step outputs published.
  validateActionOutputs(outputs);
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
/** Return shape of {@link buildMatrixOutputs}, including the Issue #854 truncation report. */
export interface MatrixOutputsResult {
  assigneeResultsJson: string;
  matrixReadyMap: string;
  /** True when one or more assignees were dropped to stay within {@link MAX_OUTPUT_VALUE_BYTES}. */
  truncated: boolean;
  /** Number of assignees included in the (possibly truncated) outputs. */
  includedCount: number;
  /** Number of assignees in the input, before any truncation. */
  totalCount: number;
}

/**
 * Serialize an ordered map as a JSON object, keys in map (input) order.
 *
 * A plain object cannot do this: JavaScript hoists integer-like keys ("123")
 * ahead of the others and silently drops a `__proto__` key, so
 * `JSON.stringify(obj)` would not list assignees in input order. A `Map`
 * keeps first-insertion order (a later duplicate overwrites the value but
 * keeps the original position), and this writes it out without reordering
 * (Issue #964).
 */
function stringifyOrderedMap<V>(entries: ReadonlyMap<string, V>): string {
  const parts: string[] = [];
  for (const [key, value] of entries) {
    parts.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
  }
  return `{${parts.join(',')}}`;
}

function buildAssigneeResultsMap(
  subset: Array<{
    assigneeLogin: string;
    stellarAddress: string;
    validationResult: ValidationResult;
    validatedAt?: string;
  }>,
): Map<string, AssigneeResult> {
  const assigneeResults = new Map<string, AssigneeResult>();
  for (const { assigneeLogin, stellarAddress, validationResult, validatedAt } of subset) {
    assigneeResults.set(assigneeLogin, {
      ready: validationResult.valid,
      stellar_address: stellarAddress,
      xlm_balance: validationResult.xlmBalance,
      account_funded: validationResult.accountFunded,
      trustline_exists: validationResult.trustlineExists,
      reason_code: validationResult.reasonCode ?? (validationResult.valid ? 'SUCCESS' : 'FAILED'),
      validated_at: validatedAt ?? new Date().toISOString(),
    });
  }
  return assigneeResults;
}

export function buildMatrixOutputs(
  results: Array<{
    assigneeLogin: string;
    stellarAddress: string;
    validationResult: ValidationResult;
    validatedAt?: string;
  }>,
): MatrixOutputsResult {
  // Issue #854: a matrix job validating hundreds of assignees can otherwise
  // produce an assignee_results_json output over GitHub's per-output size
  // limit, silently truncated (or rejected outright) by the runner itself —
  // exactly the "incomplete payout list, wrong branch decision" failure
  // mode this guards against. assigneeResultsJson is the larger of the two
  // payloads, so the included-assignee count is bounded against *its*
  // budget, then matrixReadyMap is built from that exact same subset so the
  // two maps never disagree about which assignees are present.
  const { json: assigneeResultsJson, truncated, includedCount, totalCount } = truncateJsonArray(
    results,
    (subset) => stringifyOrderedMap(buildAssigneeResultsMap(subset)),
  );

  const readyMap = new Map<string, boolean>();
  for (const { assigneeLogin, validationResult } of results.slice(0, includedCount)) {
    readyMap.set(assigneeLogin, validationResult.valid);
  }

  return {
    assigneeResultsJson,
    matrixReadyMap: stringifyOrderedMap(readyMap),
    truncated,
    includedCount,
    totalCount,
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
