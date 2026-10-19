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
import { logger } from './logger';
import { getOctokitProxyOptions } from './proxy';

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
  options: { stellarAddress: string } = { stellarAddress: '' },
): Array<{
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'notice' | 'warning' | 'failure';
  title: string;
  message: string;
}> {
  const annotations = [];

  for (const check of result.checks) {
    const level: 'notice' | 'warning' | 'failure' = check.passed ? 'notice' : 'failure';
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
 * @returns             CheckRunResult with success flag and details.
 */
export async function createCheckRun(
  result: ValidationResult,
  token: string,
  options: { stellarAddress?: string } = {},
): Promise<CheckRunResult> {
  try {
    // Fail gracefully if we're not in a GitHub Actions context.
    if (!github.context.runId || !github.context.repo.owner || !github.context.repo.repo) {
      return {
        success: false,
        message: 'Check Run creation requires a GitHub Actions context (issue comment trigger). Skipping.',
      };
    }

    const octokit = github.getOctokit(token, getOctokitProxyOptions());    const { owner, repo } = github.context.repo;
    const conclusion = determineCheckConclusion(result);
    const annotations = buildCheckAnnotations(result, { stellarAddress: options.stellarAddress || '' });

    // Octokit Checks API supports up to 50 annotations per request.
    // For simplicity, we truncate to the first 50 checks.
    const annotationsSlice = annotations.slice(0, 50);

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
        summary: result.valid
          ? 'All TrustBridge validation checks passed.'
          : `TrustBridge validation failed. ${result.checks.filter((c) => !c.passed).length} of ${result.checks.length} checks did not pass.`,
        annotations: annotationsSlice,
      },
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
    const httpError = error as any;
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
