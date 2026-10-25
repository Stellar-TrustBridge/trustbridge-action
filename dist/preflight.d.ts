/**
 * src/preflight.ts
 *
 * #145 — issues:write preflight check
 * #220 — extended to `pull_request` / `pull_request_target` events
 * #443 — optional Horizon fallback health probe
 * #732 — cataloged reason_code for missing issues:write
 *
 * Verifies that the supplied GitHub token has sufficient permission to post
 * issue/PR comments **before** any expensive Horizon calls are made.  Failing
 * fast here gives workflow authors a clear, actionable error instead of a
 * generic GitHub 403 that appears only after Horizon work has completed.
 *
 * ## Preflight sequence
 *
 * 1. **Issue/PR context check** — verify an issue or PR number can be
 *    resolved from the event payload (`payload.issue.number` for `issues`
 *    events, `payload.pull_request.number` for `pull_request`/
 *    `pull_request_target`). Comment posting is only possible in one of
 *    these contexts; `workflow_dispatch` and other events skip comment
 *    posting and therefore skip the preflight.
 * 2. **Permission probe** — call `GET /repos/{owner}/{repo}/issues/{number}/comments`
 *    with `per_page=1`.  A 403/401 response means the token lacks `issues: read`
 *    and certainly cannot write.  This is less aggressive than a dry-run
 *    `createComment` because it is read-only and will not clutter the issue.
 *    A 404 on the issue/PR itself is surfaced separately (closed/deleted).
 *    Note: this probe only proves *read* access — a `pull_request` (not
 *    `pull_request_target`) run on a **fork** PR gets a read-only
 *    `GITHUB_TOKEN` by default, so the probe can pass here and the later
 *    `createComment`/`updateComment` call can still 403. That failure is
 *    caught separately and logged as a non-fatal warning by the caller.
 * 3. **Optional Horizon health probe** (#443) — when enabled, HEAD (falling
 *    back to GET) the Horizon root on both the primary and fallback URLs so
 *    operators discover a bad secondary before a run fails mid-flight.
 *    Soft-warns by default; `horizon_probe_hard_fail: true` turns a failed
 *    probe into a hard failure.
 *
 * ## Failure modes
 *
 * | Situation | Code | `PreflightResult.skip` | Horizon called? |
 * |-----------|------|----------------------|-----------------|
 * | No issue/PR context | — | `true` | Yes (outputs still set) |
 * | Token lacks issues:read/write | 403/401 | `false` | No (run fails) |
 * | Issue/PR not found (404) | 404 | `false` | No (run fails) |
 * | Transient error (5xx) | 5xx | `false` | No (run fails fast) |
 * | Permission check passes | 200 | `false` | Yes |
 *
 * ## Design notes
 *
 * - When there is no issue/PR context the preflight returns `{ skip: true }`
 *   so the caller can proceed without posting a comment (same behaviour as
 *   today for `workflow_dispatch`).
 * - `preflight_only` input: when `true`, the action runs the preflight and
 *   exits immediately without calling Horizon.  Useful for diagnosing
 *   permission issues in new repositories without spending API quota.
 * - The Horizon health probe is opt-in (`horizon_probe: true`) and bounded by
 *   `horizon_probe_timeout_ms` (default 5000ms) per URL.  Worst case it adds
 *   `2 × timeout` to the preflight; keep the budget small on latency-sensitive
 *   workflows.
 * - #732 — a 403 on the permission probe is tagged with the cataloged
 *   `reason_code` `issues_write_missing` so `index.ts` can emit it as an
 *   output before `core.setFailed`.
 */
/**
 * #732 — cataloged reason code emitted when the token lacks `issues: write`.
 * Must match the entry in `schemas/reason-codes.json`.
 */
export declare const REASON_CODE_ISSUES_WRITE_MISSING = "issues_write_missing";
export interface PreflightResult {
    /**
     * `true` when there is no issue context and comment posting should simply
     * be skipped.  Horizon checks proceed normally; `postIssueComment` will
     * emit its existing "no issue context" warning.
     */
    skip: boolean;
    /** Human-readable summary of the preflight outcome for logging. */
    message: string;
    /** The resolved issue number, populated when `skip` is false. */
    issueNumber?: number;
}
export interface PreflightOptions {
    /**
     * When `true`, verify that an issue or PR context is present *and* that
     * the token has at minimum `issues:read`.  When `false` (an event with no
     * issue/PR context), return `{ skip: true }` immediately.
     */
    requireIssueContext?: boolean;
    /**
     * #443 — when `true`, run the optional Horizon health probe against the
     * primary and fallback URLs.  Defaults to `false` (opt-in).
     */
    horizonProbe?: boolean;
    /** Primary Horizon URL to probe (e.g. `horizon_url`). */
    horizonUrl?: string;
    /** Optional fallback Horizon URL to probe (e.g. `horizon_url_fallback`). */
    horizonUrlFallback?: string;
    /**
     * #443 — when `true`, a failed Horizon probe throws instead of warning.
     * Defaults to `false` (soft-warn).
     */
    horizonProbeHardFail?: boolean;
    /** Per-URL probe timeout in milliseconds.  Defaults to 5000. */
    horizonProbeTimeoutMs?: number;
    /** Injectable fetch for tests.  Defaults to the global `fetch`. */
    fetchImpl?: typeof fetch;
    /** Injectable logger for tests.  Defaults to `console.warn`. */
    warn?: (message: string) => void;
}
/**
 * #732 — error thrown by the preflight when the token demonstrably lacks the
 * required permission.  Carries a cataloged `reasonCode` so callers can emit
 * it as an output before failing the job.
 */
export declare class PreflightError extends Error {
    readonly status: number;
    /** Alias of `status`, kept for callers that read `statusCode`. */
    readonly statusCode: number;
    readonly reasonCode?: string;
    constructor(message: string, status: number, reasonCode?: string);
}
/**
 * Run the issues:write preflight sequence.
 *
 * @param token   The `github_token` input value (used to build Octokit).
 * @param options Optional flags controlling preflight behaviour.
 * @returns       A `PreflightResult` — inspect `.skip` to decide whether to
 *                skip comment posting, or throw on hard failures.
 *
 * @throws When the token demonstrably lacks the required permission (401/403)
 *         or the issue is not found (404).  Callers should let these propagate
 *         to `core.setFailed`.
 */
export declare function runIssuesPreflight(token: string, options?: PreflightOptions): Promise<PreflightResult>;
/** Workflow permissions the preflight can report as missing. */
export type PreflightPermission = 'issues: write' | 'id-token: write';
/**
 * Build the exact log/comment text a dry-run preflight emits when the job is
 * missing `issues: write` and/or `id-token: write`. Output is deterministic
 * (permissions are de-duplicated and sorted) so it can be snapshot-tested and
 * copy-pasted into a workflow. Returns an empty string when nothing is missing.
 *
 * @throws When an unknown permission name is supplied.
 */
export declare function formatMissingPermissionsDryRun(missing: readonly string[]): string;
/**
 * Probe the Horizon root on the primary and (when set) fallback URLs.
 *
 * Uses `HEAD` first and falls back to `GET` when the server rejects HEAD
 * (some Horizon deployments return 405).  A probe is considered healthy when
 * the response status is `< 400`.
 *
 * By default a failed probe only emits a warning; set
 * `options.horizonProbeHardFail` to throw a `PreflightError` instead.
 */
export declare function runHorizonHealthProbe(options: PreflightOptions): Promise<void>;
export interface ProbeResult {
    ok: boolean;
    reason: string;
    status?: number;
}
export declare function probeHorizonUrl(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<ProbeResult>;
