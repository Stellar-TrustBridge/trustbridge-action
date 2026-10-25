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
export interface CodeownersRule {
    /** Raw pattern token from the CODEOWNERS line (e.g. `src/payments/**`). */
    pattern: string;
    /** Normalized owner handles for this rule. */
    owners: string[];
}
/**
 * Parse CODEOWNERS content into ordered rules (pattern + owners).
 * Comments and empty lines are ignored. Rules with no owners are skipped.
 */
export declare function parseCodeownersRules(content: string): CodeownersRule[];
/**
 * Determine whether a given file path is covered by any CODEOWNERS rule.
 * Returns the matching rule (last match wins, per GitHub semantics) or null.
 */
export declare function findCoveringRule(filePath: string, rules: CodeownersRule[]): CodeownersRule | null;
export interface CodeownersCoverageResult {
    /** Paths that have at least one owner. */
    covered: string[];
    /** Paths with no matching CODEOWNERS rule (or a rule with no owners). */
    uncovered: string[];
    /** True when no CODEOWNERS rules were loaded at all. */
    missingCodeowners: boolean;
}
/**
 * Check reviewer coverage for a set of TrustBridge-touched paths against parsed
 * CODEOWNERS rules. Used by preflight to surface missing reviewer coverage.
 */
export declare function checkCodeownersCoverage(touchedPaths: string[], rules: CodeownersRule[]): CodeownersCoverageResult;
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
 * Load CODEOWNERS rules (pattern + owners) using the same branch-safety guarantees
 * as {@link loadCodeowners}. Returns an empty array when no CODEOWNERS file is found.
 */
export declare function loadCodeownersRules(options?: LoadCodeownersOptions): Promise<CodeownersRule[]>;
/**
 * Check if the given actor is a maintainer according to CODEOWNERS or an explicit maintainers list.
 */
export declare function isMaintainerActor(actor: string, codeowners: Set<string>, maintainersAllowlist?: string[]): boolean;
