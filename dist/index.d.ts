import { ValidationResult } from './checks';
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
declare function run(): Promise<void>;
export { run };
