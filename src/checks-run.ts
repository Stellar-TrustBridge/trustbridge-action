/**
 * GitHub Checks API integration for TrustBridge action results.
 *
 * Wave #26: When enabled via `use_check_runs: true`, this module creates a
 * GitHub Check Run with individual validation checks as annotations and a
 * conclusion (pass/fail) reflecting the overall validation result.
 *
 * Permissions required: `checks: write`
 *
 * Fail-open behavior: if Checks API returns a 403 (permission denied) or
 * other error, the action logs a warning and continues — Check Run creation
 * is never allowed to fail the validation itself. See docs/USAGE.md for
 * GitHub App / token configuration guidance.
 */

import * as core from '@actions/core';
import * as github from '@actions/github';
import { ValidationResult } from './checks';
import { globalMetrics } from './metrics';
import { logger } from './logger';
import { getOctokitProxyOptions } from './proxy';

/** Label of the SEP-0001 home domain row emitted by `runAccountChecks`. */
export const HOME_DOMAIN_CHECK_LABEL = 'SEP-0001 home domain';

/**
 * Maximum annotations accepted by one Checks API create/update request, on
 * github.com and GHES. See docs/GHES_COMPATIBILITY.md.
 */
export const CHECK_RUN_ANNOTATIONS_PER_REQUEST = 50;

/** Share of requests since the last change that must be throttled to back off. */
export const ADAPTIVE_THROTTLE_RATE = 0.2;
/** Consecutive unthrottled successes needed to regain one slot. */
export const ADAPTIVE_RECOVERY_SUCCESSES = 10;

/**
 * Concurrency limit for batch Horizon work (Issue #946): halves when the
 * throttle rate reaches {@link ADAPTIVE_THROTTLE_RATE}, regains one slot per
 * {@link ADAPTIVE_RECOVERY_SUCCESSES} successes. Always within `[1, max]`.
 * Requests started before the last decrease are ignored, so one burst of
 * 429s causes one decrease.
 */
export class AdaptiveConcurrency {
  private limitValue: number;
  private active = 0;
  private epochValue = 0;
  private successes = 0;
  private streak = 0;
  private throttles = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly max: number) {
    this.max = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : 1;
    this.limitValue = this.max;
    this.record();
  }

  get limit(): number {
    return this.limitValue;
  }

  get epoch(): number {
    return this.epochValue;
  }

  tryAcquire(): boolean {
    if (this.active >= this.limitValue) return false;
    this.active++;
    return true;
  }

  waitForRelease(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    this.active--;
    this.wake();
  }

  onThrottle(epoch: number): void {
    globalMetrics.incrementCounter('batch_horizon_throttled');
    if (epoch !== this.epochValue) return;
    this.throttles++;
    this.streak = 0;
    if (this.throttles / (this.throttles + this.successes) < ADAPTIVE_THROTTLE_RATE) return;
    this.epochValue++;
    this.resetWindow();
    if (this.limitValue === 1) return;
    this.limitValue = Math.max(1, Math.floor(this.limitValue / 2));
    globalMetrics.incrementCounter('batch_concurrency_decreased');
    this.record();
  }

  onSuccess(epoch: number): void {
    if (epoch !== this.epochValue) return;
    // Cap the history so a long healthy run cannot hide a new throttle burst.
    this.successes = Math.min(this.successes + 1, ADAPTIVE_RECOVERY_SUCCESSES);
    if (++this.streak < ADAPTIVE_RECOVERY_SUCCESSES) return;
    this.resetWindow();
    if (this.limitValue >= this.max) return;
    this.limitValue++;
    globalMetrics.incrementCounter('batch_concurrency_increased');
    this.record();
    this.wake();
  }

  private resetWindow(): void {
    this.successes = 0;
    this.streak = 0;
    this.throttles = 0;
  }

  private record(): void {
    globalMetrics.recordMetric('batch_concurrency_limit', this.limitValue, 'count');
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

export type CheckConclusion = 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'action_required';

/**
 * Result of attempting to create a Check Run.
 */
export interface CheckRunResult {
  /**
   * True if the Check Run was successfully created.
   */
  success: boolean;

  /**
   * The Check Run ID if created, or null if creation failed or was skipped.
   */
  checkRunId?: number;

  /**
   * Human-readable message describing the outcome.
   */
  message: string;

  /**
   * Optional error message if creation failed.
   */
  error?: string;

  /**
   * True when the run was cancelled (via `options.signal`) before the Check
   * Run was written. No Check Run exists in that case — never a partial one.
   */
  cancelled?: boolean;
}

function cancelledResult(): CheckRunResult {
  const message = 'Check Run creation cancelled before completion; no Check Run was written.';
  logger.warn(message, { component: 'checks-run' });
  return { success: false, cancelled: true, message };
}

/**
 * Determine the Check Run conclusion from a ValidationResult.
 *
 * - `success`: All checks passed (result.valid === true)
 * - `failure`: One or more checks failed (result.valid === false)
 * - `neutral`: Result status is unclear or pending
 */
export function determineCheckConclusion(result: ValidationResult): CheckConclusion {
  if (result.valid) {
    return 'success';
  }
  return 'failure';
}

/**
 * Build annotation objects from individual checks in a ValidationResult.
 *
 * Each check becomes one annotation in the Check Run, allowing operators to
 * see per-check results directly in the Actions UI without requiring debug logs.
 */
export function buildCheckAnnotations(
  result: ValidationResult,
  _options: { stellarAddress: string } = { stellarAddress: '' },
): Array<{
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'notice' | 'warning' | 'failure';
  title: string;
  message: string;
}> {
  const annotations = [];
  // Issue #708: a warn-mode home domain problem keeps its row passing, but it
  // should still stand out in the Check Run instead of rendering as a notice.
  const homeDomainWarning =
    result.homeDomainCheck !== undefined &&
    result.homeDomainCheck.outcome !== 'valid' &&
    result.homeDomainCheck.outcome !== 'skipped' &&
    !result.homeDomainCheck.blocksValid;

  for (const check of result.checks) {
    const level: 'notice' | 'warning' | 'failure' = !check.passed
      ? 'failure'
      : homeDomainWarning && check.label === HOME_DOMAIN_CHECK_LABEL
        ? 'warning'
        : 'notice';
    annotations.push({
      path: 'trustbridge-validation',
      start_line: 1,
      end_line: 1,
      annotation_level: level,
      title: check.label,
      message: check.detail,
    });
  }

  return annotations;
}

/**
 * Summary text for the Check Run. Failing runs include the `reason_code` so
 * the Checks UI matches the action output (e.g. `HOME_DOMAIN_MISMATCH`).
 */
export function buildCheckRunSummary(result: ValidationResult): string {
  if (result.valid) {
    return 'All TrustBridge validation checks passed.';
  }
  const failed = result.checks.filter((c) => !c.passed).length;
  const reason = result.reasonCode ? ` reason_code: ${result.reasonCode}.` : '';
  return `TrustBridge validation failed. ${failed} of ${result.checks.length} checks did not pass.${reason}`;
}

/**
 * Create a GitHub Check Run for the validation result.
 *
 * Wraps the Octokit Checks API with:
 *  - Error handling for permission denied (403) and other transient errors
 *  - Structured logging for debugging
 *  - Fail-open behavior so Check Run failures never block the validation
 *
 * @param result        The ValidationResult from running checks.
 * @param token         GitHub API token (requires checks: write permission).
 * @param options       Additional options (e.g. stellar address for annotation context).
 *                      `signal` cancels the run: if it is aborted before or
 *                      during the API call, no Check Run is written and the
 *                      result has `cancelled: true` (Issue #783).
 * @returns             CheckRunResult with success flag and details.
 */
export async function createCheckRun(
  result: ValidationResult,
  token: string,
  options: { stellarAddress?: string; signal?: AbortSignal } = {},
): Promise<CheckRunResult> {
  if (options.signal?.aborted) return cancelledResult();
  try {
    // Fail gracefully if we're not in a GitHub Actions context.
    if (!github.context.runId || !github.context.repo.owner || !github.context.repo.repo) {
      return {
        success: false,
        message: 'Check Run creation requires a GitHub Actions context (issue comment trigger). Skipping.',
      };
    }

    const octokit = github.getOctokit(token, getOctokitProxyOptions());
    const { owner, repo } = github.context.repo;
    const conclusion = determineCheckConclusion(result);
    const annotations = buildCheckAnnotations(result, { stellarAddress: options.stellarAddress || '' });

    // Octokit Checks API supports up to 50 annotations per request on
    // github.com and GHES. For simplicity, we truncate to the first 50 checks.
    const annotationsSlice = annotations.slice(0, CHECK_RUN_ANNOTATIONS_PER_REQUEST);

    // Annotations are built synchronously, but re-check so a cancel that
    // landed while preparing never reaches the API.
    if (options.signal?.aborted) return cancelledResult();

    core.info(`Creating Check Run with conclusion="${conclusion}", ${annotationsSlice.length} annotations`);

    const response = await octokit.rest.checks.create({
      owner,
      repo,
      name: 'TrustBridge Validation',
      head_sha: github.context.sha,
      status: 'completed',
      conclusion,
      output: {
        title: 'Stellar Account Validation',
        summary: buildCheckRunSummary(result),
        annotations: annotationsSlice,
      },
      ...(options.signal ? { request: { signal: options.signal } } : {}),
    });

    const checkRunId = response.data.id;
    logger.info('Check Run created', {
      component: 'checks-run',
      checkRunId,
      conclusion,
      annotationCount: annotationsSlice.length,
    });

    return {
      success: true,
      checkRunId,
      message: `Check Run #${checkRunId} created with conclusion=${conclusion}`,
    };
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) return cancelledResult();
    const httpError = error as { status?: unknown };
    const status = httpError?.status;
    const message = error instanceof Error ? error.message : String(error);

    // Specific handling for permission denied.
    if (status === 403) {
      const msg =
        `Checks API permission denied (403). Ensure the GitHub token has 'checks: write' permission. ` +
        `For GitHub Apps, verify the 'Checks' permission is set to 'Read & write'. ` +
        `Skipping Check Run creation (fail-open). Error: ${message}`;
      logger.warn(msg, { component: 'checks-run', status });
      core.warning(`[TrustBridge Checks] ${msg}`);
      return {
        success: false,
        message: msg,
        error: message,
      };
    }

    // Generic error handling.
    const errorMsg =
      `Failed to create Check Run (${status || 'unknown error'}): ${message}. ` +
      `Check Run creation is non-critical; validation will continue. ` +
      `See logs for details.`;
    logger.warn(errorMsg, {
      component: 'checks-run',
      status,
      errorMessage: message,
    });
    core.warning(`[TrustBridge Checks] ${errorMsg}`);

    return {
      success: false,
      message: errorMsg,
      error: message,
    };
  }
}
