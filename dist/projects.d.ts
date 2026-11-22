/** One allowlist entry as configured by an operator (see {@link matchesRepoAllowlist}). */
export type RepoAllowlistPattern = string;
/** Why a pattern was never considered during matching. */
export type RejectedRepoAllowlistPatternReason = 'empty' | 'ambiguous_glob' | 'multiple_slashes';
/** A configured pattern that was excluded from matching, and why. */
export interface RejectedRepoAllowlistPattern {
    pattern: RepoAllowlistPattern;
    reason: RejectedRepoAllowlistPatternReason;
}
export interface RepoAllowlistMatchResult {
    /** True when `repository` is covered by at least one valid pattern. */
    allowed: boolean;
    /** Human-readable, stable explanation — safe to log or surface in a dry-run message. */
    reason: string;
    /** The pattern that matched, when `allowed` is true. */
    matchedPattern?: RepoAllowlistPattern;
    /**
     * Configured patterns that were never evaluated because they look like an
     * ambiguous glob or are otherwise malformed. Fail-closed: a rejected
     * pattern can never grant access, even accidentally.
     */
    rejectedPatterns: RejectedRepoAllowlistPattern[];
}
/**
 * Decide whether `repository` (a `"owner/repo"` string, as reported by
 * `github.context.repo` / `${{ github.repository }}`) is covered by
 * `patterns`.
 *
 * Supported pattern forms (one per allowlist entry):
 * - `"owner/repo"` — exact match.
 * - `"owner"` or `"owner/*"` — matches every repository under that org.
 *
 * Matching is **case-insensitive** on both the owner and repo segments
 * (GitHub treats `owner/repo` names as case-insensitive for routing), and
 * leading/trailing whitespace on each configured pattern is ignored.
 *
 * **Fail-closed design** (Issue #855 — "must not validate arbitrary forks
 * or unrelated private repos"):
 * - An **empty allowlist denies every repository**. This is the opposite of
 *   `filterRosterAddressMap`'s "empty allowlist means allow all" — that
 *   function is a defense-in-depth filter layered on an already-trusted
 *   roster, while this function is the *primary* boundary deciding whether
 *   org-wide automation may touch a repository at all. An operator who
 *   wants "allow everything" must say so explicitly (e.g. `"owner/*"` per
 *   org, or `"*"` is intentionally NOT a supported shortcut — see below).
 * - A pattern this function cannot interpret safely (see
 *   `classifyInvalidRepoAllowlistPattern`) is collected into
 *   `rejectedPatterns` and never matches — a malformed or overly broad
 *   pattern can only ever narrow access, never accidentally widen it.
 * - `repository` itself must be an exact `"owner/repo"` string; anything
 *   else (missing slash, extra slash, empty) never matches any pattern.
 *
 * **What this function does not do** (by design — it is a pure string
 * match, not a GitHub API call): it has no way to detect that a repository
 * was renamed (an allowlist entry for the old name simply fails closed,
 * exactly like any other non-matching name — there is no fuzzy or
 * historical matching) or that a repository is archived (archival status
 * is not encoded in `owner/repo`; a caller that needs to exclude archived
 * repos must check `github.context.payload.repository.archived` itself
 * before or after calling this function).
 */
export declare function matchesRepoAllowlist(repository: string, patterns: readonly RepoAllowlistPattern[]): RepoAllowlistMatchResult;
export interface ProjectV2FieldOption {
    id: string;
    name: string;
}
export interface ProjectV2Field {
    id: string;
    name: string;
    options?: ProjectV2FieldOption[];
}
export interface ProjectV2Node {
    id: string;
    fields?: {
        nodes: ProjectV2Field[];
    };
}
export interface UpdateProjectV2StatusOptions {
    octokit: {
        graphql: <T = unknown>(query: string, parameters?: Record<string, unknown>) => Promise<T>;
    };
    projectId: string;
    contentNodeId: string;
    statusFieldName?: string;
    targetStatusValue: string;
}
export interface UpdateProjectV2Result {
    updated: boolean;
    itemId?: string;
    error?: string;
}
/**
 * Update the status field of an item in a GitHub Projects v2 board.
 *
 * Opt-in only: when projectId or targetStatusValue is empty, does nothing.
 * Automatically adds the issue/PR to the project if not already present (idempotent).
 * Handles missing token scopes or rate limits with descriptive warnings without failing the workflow.
 */
export declare function updateProjectV2Status(options: UpdateProjectV2StatusOptions): Promise<UpdateProjectV2Result>;
