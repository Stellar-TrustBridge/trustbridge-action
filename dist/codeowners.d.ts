import * as github from '@actions/github';
/** Standard locations where CODEOWNERS can reside in a repository. */
export declare const CODEOWNERS_STANDARD_PATHS: string[];
/**
 * Parse the contents of a CODEOWNERS file into a normalized Set of owner handles.
 * Handles `@username`, `@org/team`, emails, and raw usernames.
 * Comments (`#`) and empty lines are ignored.
 */
export declare function parseCodeowners(content: string): Set<string>;
/**
 * Normalize an owner handle from CODEOWNERS or allowlist (lowercase, strip leading @).
 */
export declare function normalizeOwnerHandle(handle: string): string;
export interface LoadCodeownersOptions {
    workspaceRoot?: string;
    customPath?: string;
    githubToken?: string;
    octokit?: ReturnType<typeof github.getOctokit>;
    isForkPr?: boolean;
    baseRef?: string;
    owner?: string;
    repo?: string;
}
/**
 * Load CODEOWNERS content with strict Branch Safety guarantees:
 * - On pull requests from forks (or untrusted PR heads), NEVER reads from the local PR workspace.
 * - Instead, fetches the trusted CODEOWNERS file from the base branch / default branch via GitHub API.
 * - When running in a trusted context (push, default branch, or workflow_dispatch), reads from local workspace.
 */
export declare function loadCodeowners(options?: LoadCodeownersOptions): Promise<Set<string>>;
/**
 * Check if the given actor is a maintainer according to CODEOWNERS or an explicit maintainers list.
 */
export declare function isMaintainerActor(actor: string, codeowners: Set<string>, maintainersAllowlist?: string[]): boolean;
