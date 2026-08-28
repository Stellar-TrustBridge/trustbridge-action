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
import { ValidationResult } from './checks';
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
export declare function determineCheckConclusion(result: ValidationResult): CheckConclusion;
/**
 * Build annotation objects from individual checks in a ValidationResult.
 *
 * Each check becomes one annotation in the Check Run, allowing operators to
 * see per-check results directly in the Actions UI without requiring debug logs.
 */
export declare function buildCheckAnnotations(result: ValidationResult, options?: {
    stellarAddress: string;
}): Array<{
    path: string;
    start_line: number;
    end_line: number;
    annotation_level: 'notice' | 'warning' | 'failure';
    title: string;
    message: string;
}>;
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
export declare function createCheckRun(result: ValidationResult, token: string, options?: {
    stellarAddress?: string;
}): Promise<CheckRunResult>;
