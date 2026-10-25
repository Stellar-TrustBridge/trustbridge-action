export declare function parseBooleanInput(value: string, defaultValue: boolean): boolean;
/**
 * Canonical list of input names declared in `action.yml`.
 *
 * Kept in sync with `action.yml` by the schema parity test
 * (`__tests__/inputs-schema-parity.test.ts`), which fails CI when an input is
 * added to one side only (Issue #769).
 */
export declare const DECLARED_INPUTS: readonly ["skip_for_maintainers", "skip_if_maintainer", "assignee_address_map"];
export type DeclaredInput = (typeof DECLARED_INPUTS)[number];
/**
 * Result of {@link resolveMaintainerSkipInput}, carrying the resolved value
 * plus provenance so the action can emit a precise warning instead of
 * guessing which input the user meant.
 */
export interface MaintainerSkipResolution {
    /** Effective value used for the maintainer skip gate. */
    enabled: boolean;
    /** Which input supplied the effective value. */
    source: 'skip_for_maintainers' | 'skip_if_maintainer' | 'default';
    /** True when both inputs were supplied with conflicting boolean values. */
    conflict: boolean;
    /** True when the deprecated alias was used and the canonical input was not. */
    usedDeprecatedAlias: boolean;
}
/**
 * Resolve the maintainer-skip input, honouring the canonical
 * `skip_for_maintainers` name and the deprecated `skip_if_maintainer` alias
 * (Issue #448).
 *
 * Precedence rules, in order:
 *
 * 1. `skip_for_maintainers` wins whenever it carries an explicit boolean.
 *    A caller who writes `skip_for_maintainers: false` alongside a stale
 *    `skip_if_maintainer: true` gets the explicit `false` — the canonical
 *    input is never silently overridden.
 * 2. The alias is consulted only when the canonical input is unset/empty.
 *    This is what makes the alias usable at all: `action.yml` gives the
 *    canonical input a `false` default, so "canonical is unset" is detected
 *    from the raw (pre-default) input string rather than from the parsed
 *    value.
 * 3. If neither is supplied, the value is `false` (opt-in only).
 *
 * When both are supplied with conflicting values, `conflict` is set so the
 * caller can warn; the canonical value is still the one used.
 *
 * @param canonicalValue Raw `skip_for_maintainers` input.
 * @param aliasValue     Raw `skip_if_maintainer` input.
 * @returns              Resolved value plus provenance.
 */
export declare function resolveMaintainerSkipInput(canonicalValue: string | undefined, aliasValue: string | undefined): MaintainerSkipResolution;
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
/** Raw (untrimmed) values for the ready-label input alias chains. */
export interface ReadyLabelInputOptions {
    passLabel?: string;
    readyPassLabel?: string;
    readyLabelPass?: string;
    failLabel?: string;
    readyFailLabel?: string;
    readyLabelFail?: string;
}
export interface ResolvedReadyLabels {
    passLabel: string;
    failLabel: string;
    /** True when either chain resolved from a deprecated alias. */
    usedDeprecatedAlias: boolean;
}
/**
 * Resolve the ready-state label pair from the documented alias chains.
 *
 * action.yml declares four deprecated aliases alongside the canonical
 * `pass_label` / `fail_label`:
 *
 *   pass_label → ready_pass_label → ready_label_pass
 *   fail_label → ready_fail_label → ready_label_fail
 *
 * Only the canonical names were read at runtime, so a workflow still using a
 * deprecated name silently lost its label automation after upgrading instead
 * of erroring. (Issue #669)
 *
 * A whitespace-only value counts as unset, matching `core.getInput` semantics
 * where an omitted input yields ''. Trimming means a value such as
 * `' wallet-ready '` resolves to `'wallet-ready'` rather than creating a
 * differently-spaced label that GitHub would treat as distinct.
 *
 * Both chains resolve independently: a workflow may set a pass label through
 * the canonical name and a fail label through a deprecated one.
 */
export declare function resolveReadyLabelInputs(options: ReadyLabelInputOptions): ResolvedReadyLabels;
/**
 * Every input declared in `action.yml`, keyed by its exact snake_case name.
 *
 * `inputs-schema-parity.test.ts` locks this list to `action.yml`: adding,
 * removing or renaming an action input without updating this interface
 * fails CI. All inputs arrive as strings via `core.getInput`; only
 * `github_token` is required.
 */
export interface Inputs {
    max_retries?: string;
    retry_base_delay_ms?: string;
    horizon_url?: string;
    asset_code?: string;
    asset_issuer?: string;
    min_xlm_reserve?: string;
    min_trustline_limit?: string;
    min_asset_balance?: string;
    stellar_address_input?: string;
    assignee_address_map?: string;
    fail_on_missing?: string;
    preflight_only?: string;
    issue_number?: string;
    debug_mode?: string;
    horizon_timeout_ms?: string;
    sticky_comment?: string;
    comment_mode?: string;
    wait_until_funded?: string;
    wait_until_funded_timeout_ms?: string;
    wait_until_funded_interval_ms?: string;
    horizon_url_fallback?: string;
    horizon_cache_ttl_ms?: string;
    rpc_fallback_url?: string;
    horizon_max_requests?: string;
    retry_max_delay_ms?: string;
    retry_max_total_wait_ms?: string;
    use_cache?: string;
    use_actions_cache_backend?: string;
    allow_cross_network_fallback?: string;
    log_inputs?: string;
    trustbridge_config_path?: string;
    milestone_allowlist?: string;
    milestone_fail_on_skip?: string;
    github_token: string;
    github_app_token?: string;
    assets_json?: string;
    sep0007_deep_links?: string;
    auto_wallet_labels?: string;
    pass_label?: string;
    fail_label?: string;
    sep0007_origin_domain?: string;
    snooze_window_minutes?: string;
    force_comment?: string;
    webhook_url?: string;
    webhook_secret?: string;
    webhook_secret_previous?: string;
    webhook_timeout_ms?: string;
    webhook_auth_mode?: string;
    webhook_oidc_audience?: string;
    docs_base_url?: string;
    network?: string;
    preset?: string;
    posting_mode?: string;
    use_check_runs?: string;
    use_friendbot?: string;
    friendbot_url?: string;
    friendbot_timeout_ms?: string;
    fixture_mode?: string;
    fixture_path?: string;
    dashboard_webhook_url?: string;
    onboarding_checklist?: string;
    check_ledger_freshness?: string;
    max_ledger_lag_seconds?: string;
    ledger_freshness_fail_on_stale?: string;
    network_passphrase?: string;
    home_domain_check_enabled?: string;
    expected_home_domain?: string;
    home_domain_check_mode?: string;
    stellar_toml_fetch_enabled?: string;
    stellar_toml_cache_ttl_ms?: string;
    stellar_toml_hash_pin?: string;
    write_validation_json?: string;
    validation_json_path?: string;
    trustbridge_plugins_path?: string;
    sarif_output_path?: string;
    use_plugin_runner?: string;
    locale?: string;
    stellar_addresses?: string;
    unassign_on_not_ready?: string;
    project_id?: string;
    project_status_field?: string;
    project_status_pass?: string;
    project_status_fail?: string;
    project_token?: string;
    claimable_balance_policy?: string;
    sep0010_challenge_xdr?: string;
    sep0010_dashboard_url?: string;
    unauthorized_trustline_policy?: string;
    clawback_strict_mode?: string;
    skip_for_maintainers?: string;
    skip_if_maintainer?: string;
    maintainers_allowlist?: string;
    horizon_pin_fingerprint?: string;
    federation_resolution_enabled?: string;
    horizon_url_allowlist?: string;
    dashboard_roster_url?: string;
    dashboard_roster_secret?: string;
    dashboard_roster_timeout_ms?: string;
    dashboard_roster_allow_http?: string;
    soroban_full_roster?: string;
    soroban_roster_page_limit?: string;
    custom_comment_template_path?: string;
    ready_pass_label?: string;
    ready_label_pass?: string;
    ready_fail_label?: string;
    ready_label_fail?: string;
    codeowners_path?: string;
    github_username?: string;
    previous_validation_path?: string;
    report_output_path?: string;
    privacy_mode?: string;
    soroban_rpc_url?: string;
    contract_id?: string;
}
