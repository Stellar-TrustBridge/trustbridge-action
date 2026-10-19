import { ValidationResult } from './checks';
export type PostingMode = 'post' | 'dry-run' | 'off';
export declare const VALID_POSTING_MODES: PostingMode[];
export type CommentThreadingMode = 'sticky' | 'new' | 'reply';
export declare function resolveCommentModes(postingModeInput: string, commentModeInput: string): {
    postingMode: PostingMode;
    commentThreadingMode?: CommentThreadingMode;
};
/**
 * Options for `handleAutoUnassign` (Issue #228).
 */
export interface AutoUnassignOptions {
    octokit: {
        rest: {
            issues: {
                removeAssignees: (params: {
                    owner: string;
                    repo: string;
                    issue_number: number;
                    assignees: string[];
                }) => Promise<unknown>;
            };
        };
    };
    owner: string;
    repo: string;
    issueNumber?: number;
    payload: unknown;
    result: ValidationResult;
    unassignOnNotReady: boolean;
}
/**
 * Automatically unassigns the assignee(s) from the GitHub issue when
 * readiness checks fail (ready is false) and the policy input is enabled.
 *
 * Safe guards:
 * - Default off (requires opt-in via unassign_on_not_ready: true).
 * - Only runs when ready is false (result.valid === false).
 * - Never unassigns on transient Horizon infrastructure/connectivity errors
 *   (HORIZON_ERROR, HORIZON_TIMEOUT, TLS_ERROR).
 * - Filters out bot assignees (e.g. app/bot accounts).
 * - Non-fatal: permission errors or GitHub API failures are logged as warnings.
 * - Safely skips when there is no issue context (e.g. workflow_dispatch).
 */
export declare function handleAutoUnassign(options: AutoUnassignOptions): Promise<string[] | undefined>;
/**
 * Result of evaluating the milestone gate (Issue #230).
 */
export interface MilestoneGateDecision {
    /** True when the issue/PR should be skipped because of the milestone gate. */
    shouldSkip: boolean;
    /** Human-readable reason for the skip (empty when shouldSkip is false). */
    reason: string;
    /** Full message including the "Skipping validation." suffix. */
    fullMessage: string;
    /** The raw milestone title from the event payload (empty if none). */
    milestoneTitle: string;
}
/**
 * Evaluate the milestone gate for the given event payload.
 *
 * When `milestone_allowlist` is set and non-empty, the issue/PR's milestone
 * is checked against the allowlist. If the milestone is missing or not in the
 * list, the result indicates the step should be skipped (with the reason).
 *
 * This function is side-effect-free so it can be unit-tested without mocking
 * `@actions/core`.
 */
export declare function evaluateMilestoneGate(milestoneAllowlistRaw: string, _milestoneFailOnSkip: boolean, payload: Record<string, unknown>): MilestoneGateDecision;
declare function run(): Promise<void>;
export { run };
