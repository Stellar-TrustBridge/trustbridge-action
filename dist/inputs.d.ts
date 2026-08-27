export declare function parseBooleanInput(value: string, defaultValue: boolean): boolean;
export declare function parseNumberInput(value: string, defaultValue: number, options?: {
    min?: number;
    max?: number;
}): number;
export declare function getErrorMessage(error: unknown): string;
/**
 * Maintainer-provided roster: GitHub username (assignee login) → Stellar G-address.
 * Keys are stored lowercased for case-insensitive GitHub username matching.
 */
export type AssigneeAddressMap = Record<string, string>;
export interface ParseAssigneeAddressMapOptions {
    /** Workspace root used when `raw` is a relative file path. Defaults to cwd. */
    workspaceRoot?: string;
}
/**
 * Parse `assignee_address_map` from either inline JSON or a path to a JSON file.
 *
 * Inline JSON must start with `{`. Anything else is treated as a file path
 * relative to `workspaceRoot` (or absolute).
 */
export declare function parseAssigneeAddressMap(raw: string, options?: ParseAssigneeAddressMapOptions): AssigneeAddressMap;
/**
 * Look up a Stellar address for an assignee login in a parsed roster map.
 * Throws an actionable error when the login is missing or not in the map.
 */
export declare function resolveAddressFromAssigneeMap(map: AssigneeAddressMap, assigneeLogin: string | undefined | null): string;
export type UnauthorizedTrustlinePolicy = 'fail' | 'warn' | 'ignore';
/**
 * Parses the `unauthorized_trustline_policy` input, which controls how a
 * trustline that exists but is not yet authorized by the issuer
 * (AUTHORIZATION_REQUIRED) is treated:
 *   - "fail"   — the trustline check does not pass; readiness outputs
 *                reflect the stricter meaning.
 *   - "warn"   — the trustline check still passes, but a warning is added
 *                to the comment. This is the safe default: it surfaces the
 *                risk without breaking existing green workflows.
 *   - "ignore" — no additional check or warning (pre-#72 behavior).
 */
export declare function parseUnauthorizedTrustlinePolicy(value: string): UnauthorizedTrustlinePolicy;
/**
 * Mapping of TRUSTBRIDGE_* environment variable names to action input names.
 * Explicit `with:` values always win; env is only used when with: is empty.
 */
export declare const TRUSTBRIDGE_ENV_MAP: Record<string, string>;
/**
 * Resolve an action input with TRUSTBRIDGE_* env fallback.
 */
export declare function resolveInput(inputName: string, withValue: string, env?: Record<string, string | undefined>): string;
/**
 * Resolve campaign preset name from network/preset inputs.
 * Empty string means "no preset".
 */
export declare function parsePresetInput(networkInput?: string, presetInput?: string): string;
export interface GitHubAuthTokenOptions {
    githubToken?: string;
    githubAppToken?: string;
}
/**
 * Resolves the effective GitHub authentication token from either `github_app_token`
 * (for GitHub App installation auth) or standard `github_token`.
 *
 * When `github_app_token` is provided (e.g. from actions/create-github-app-token),
 * it takes precedence over `github_token`.
 * (Issue #225)
 */
export declare function resolveGitHubAuthToken(options: GitHubAuthTokenOptions): string;
