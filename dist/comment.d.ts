import * as github from '@actions/github';
import { CheckConfig, ValidationResult } from './checks';
import { MetricsCollector } from './metrics';
import { CommentReaction } from './snooze';
import { DiagnosticsConfig } from './diagnostics';
import { Locale } from './i18n';
import { ValidationDelta } from './delta';
/**
 * Semantic schema version embedded in every TrustBridge issue comment.
 * Bump when the comment body structure (sections, markers, remediation
 * shape, etc.) changes in a way that downstream consumers or future
 * versions of this action need to detect.
 */
export declare const COMMENT_SCHEMA_VERSION = "1.1.0";
export interface CommentConfig extends CheckConfig {
    stellarAddress: string;
    horizonUrl: string;
    failOnMissing?: boolean;
    waitUntilFunded?: boolean;
    waitUntilFundedTimeoutMs?: number;
    waitUntilFundedIntervalMs?: number;
    stickyComment?: boolean;
    /**
     * When true (default), append an onboarding checklist task list whose
     * checkboxes reflect live ValidationResult state (fund → trustline →
     * verify balance). Set false to omit the block.
     */
    onboardingChecklist?: boolean;
    /** Emit SEP-0007 wallet deep links (web+stellar:pay) in the comment. */
    sep0007DeepLinks?: boolean;
    /** Optional origin domain for SEP-0007 URIs (§3.4). */
    sep0007OriginDomain?: string;
    /**
     * When true, the comment reveals the full `horizon_url` host (still
     * address-redacted). When false/omitted, only the URL scheme is shown —
     * a private Horizon mirror's hostname can itself be sensitive
     * infrastructure information and should not be posted to a (potentially
     * public) issue by default.
     */
    debugMode?: boolean;
    /**
     * When provided, a hardened metrics JSON block is appended to the comment
     * as a fenced code block. Callers should pass a fresh `MetricsCollector`
     * snapshot so the comment reflects the run that generated it.
     */
    metricsSnapshot?: MetricsCollector;
    /**
     * Locale for comment strings (e.g., 'en', 'es', 'pt').
     * Falls back to English if unset or invalid.
     */
    locale?: Locale;
    /**
     * When provided and `debugMode` is true, appends an expert diagnostics
     * collapsible block with Horizon request details and normalized inputs.
     * Never includes secrets. (Issue #102)
     */
    diagnosticsConfig?: DiagnosticsConfig;
    /**
     * Optional base URL for FAQ/docs deep links. When set, failing check
     * bullets link to anchor-level FAQ entries in docs/FAQ.md.
     * Defaults to the repo's docs/FAQ.md. Invalid values fall back to the
     * default silently so comment posting is never blocked. (Issue #104)
     */
    docsBaseUrl?: string;
    /**
     * Delta vs previous validation run (Issue #148). When present, a delta
     * section is appended to the comment showing newly-passed/failed checks.
     */
    delta?: ValidationDelta | null;
    /**
     * SEP-0010 challenge proof (Issue #252). Optional — when either field is set,
     * a "Proof of wallet control" snippet is appended to the comment. Does not
     * block `ready` unless the caller explicitly gates on it. Prefer
     * `sep0010DashboardUrl` over raw `sep0010ChallengeXdr` to avoid leaking
     * nonces in public issues.
     */
    sep0010ChallengeXdr?: string;
    sep0010DashboardUrl?: string;
    /**
     * Raw body of the existing TrustBridge sticky comment, if one was found
     * (Issue #311).  When provided, `formatCommentBody` extracts the prior
     * checklist state via `extractChecklistState` and preserves any boxes that
     * were manually checked by a contributor — even if the live Horizon result
     * has not yet caught up.  Ignored when `onboardingChecklist` is `false`.
     */
    existingCommentBody?: string;
}
export declare const TRUSTBRIDGE_FOOTER = "_Posted by [trustbridge-action](https://github.com/Stellar-TrustBridge/trustbridge-action)_";
/**
 * Legacy hidden marker (pre-schema-version). Kept for backward
 * compatibility in `findStickyComment` so comments posted by older
 * releases of the action are still eligible for upsert.
 */
export declare const STICKY_COMMENT_MARKER_LEGACY = "<!-- trustbridge-action:sticky-comment -->";
/**
 * Hidden marker embedded in every TrustBridge comment body. Includes the
 * comment schema version so future releases can detect the format of a
 * prior comment and decide whether to update it in place or post a new
 * one.
 */
export declare const STICKY_COMMENT_MARKER = "<!-- trustbridge-action:sticky-comment:schema-v1.1.0 -->";
export declare const MAX_COMMENT_LENGTH = 64000;
export declare function formatCommentBody(result: ValidationResult, config: CommentConfig): string;
/**
 * Build a hardened metrics JSON string safe for embedding in a GitHub issue
 * comment.
 *
 * "Hardened" means:
 *   1. Only structural/aggregate fields are included (no raw balances, no
 *      account addresses, no Horizon URLs).
 *   2. The JSON is produced via `JSON.stringify` with a replacer so
 *      unintended fields cannot sneak in via future `MetricsCollector`
 *      additions.
 *   3. The output is size-capped at `MAX_METRICS_JSON_BYTES`; if exceeded,
 *      a truncation notice replaces the body so the comment never exceeds
 *      GitHub's comment size limit.
 *
 * @internal Exported for testing.
 */
export declare const MAX_METRICS_JSON_BYTES = 4096;
export declare function buildHardenedMetricsJson(metrics: MetricsCollector): string;
/**
 * GitHub's documented maximum body size for issue comments is 65,536
 * characters. We keep a small safety margin so the truncation notice and
 * surrounding HTML markers always fit within the limit.
 */
export declare const COMMENT_SIZE_LIMIT_BYTES = 65536;
/**
 * Number of bytes reserved for the truncation notice appended to the
 * shortened comment. Sized to comfortably hold the notice text plus the
 * footer.
 */
export declare const COMMENT_TRUNCATION_NOTICE_BYTES = 512;
/**
 * Build a truncated comment body that fits within `COMMENT_SIZE_LIMIT_BYTES`.
 *
 * The full body is cut at a safe byte offset, a truncation notice is
 * appended, and the TrustBridge footer is preserved so the sticky-comment
 * marker remains present.  The cut always happens on a line boundary so the
 * resulting markdown is clean.
 *
 * @param fullBody  The full comment body produced by `formatCommentBody`.
 * @param reportPath  Workspace-relative path where the full report was written.
 * @returns A comment body that fits within the GitHub size limit.
 *
 * @internal Exported for testing.
 */
export declare function buildTruncatedCommentBody(fullBody: string, reportPath: string): string;
/**
 * Write the full comment body to a workspace file so it can be uploaded as
 * a GitHub Actions artifact by a subsequent `actions/upload-artifact` step.
 *
 * Directories are created recursively if they don't exist.  Any write
 * failure is surfaced as a warning (not an error) so the action can still
 * post the truncated comment.
 *
 * @param fullBody  Full comment body to persist.
 * @param outputPath  Absolute or workspace-relative path for the output file.
 * @returns The resolved absolute path on success, `undefined` on failure.
 *
 * @internal Exported for testing.
 */
export declare function writeFullReport(fullBody: string, outputPath: string): string | undefined;
/**
 * Explicit comment threading strategy.
 *
 * - `'sticky'` — update the existing TrustBridge comment in place (default).
 * - `'new'`    — always post a fresh top-level comment (full audit trail).
 * - `'reply'`  — post a reply to the *first* TrustBridge comment in the
 *                thread, building a chronological chain without overwriting
 *                the original summary comment.
 */
export type CommentMode = 'sticky' | 'new' | 'reply';
/**
 * Valid `CommentMode` values — used for input validation.
 */
export declare const VALID_COMMENT_MODES: CommentMode[];
/**
 * Resolve the effective `CommentMode` from action inputs.
 *
 * Priority: `commentMode` input > derive from `sticky` boolean > default `'sticky'`.
 * Invalid values fall back to `'sticky'` with a warning so the action
 * never hard-fails due to a misconfigured `comment_mode`.
 */
export declare function resolveCommentMode(commentMode: string | undefined, sticky: boolean | undefined): CommentMode;
export interface UpsertCommentOptions {
    /**
     * When true (default), find and update TrustBridge's previous comment on
     * the issue instead of posting a new one every run. Falls back to
     * creating a new comment when no prior comment is found, or when the
     * lookup itself fails (e.g. transient GitHub API error).
     *
     * @deprecated Prefer `commentMode` for explicit control.
     */
    sticky?: boolean;
    /**
     * Comment threading strategy (#322).
     *
     * - `'sticky'` (default): update the previous TrustBridge comment in place.
     *   Equivalent to `sticky: true`.
     * - `'new'`: always post a fresh comment for a full audit trail.
     *   Equivalent to `sticky: false`.
     * - `'reply'`: post a reply to the first TrustBridge comment in the thread
     *   (using `in_reply_to` if the API supports it, else a top-level comment
     *   that references the parent). Useful when orgs want a chronological
     *   thread without overwriting the original.
     *
     * When set, `commentMode` takes precedence over `sticky`.
     */
    commentMode?: CommentMode;
    /**
     * When true, post the comment normally even if snoozed.
     * Useful for maintainers forcing an immediate re-alert.
     */
    forceComment?: boolean;
    /**
     * Snooze window in milliseconds for suppressing duplicate failure comments.
     * When result failed and last check failed within this window, skip the
     * comment post (unless forceComment is true). Always update outputs.
     */
    snoozeWindowMs?: number;
    /**
     * Explicit issue/PR number override (e.g. from workflow_dispatch input).
     * When omitted, falls back to `resolveIssueOrPullRequestNumber(github.context.payload)`.
     */
    issueNumber?: number;
    /**
     * Optional body factory called with the existing comment body (Issue #311).
     *
     * When provided alongside `sticky: true`, `postIssueComment` fetches the
     * existing comment body (if a sticky comment is found) and passes it to
     * this factory *before* building the final comment body.  The returned
     * string is posted as the new comment body.
     *
     * Use this instead of the top-level `body` argument when the comment
     * content depends on the previous comment body — for example, to preserve
     * manually-checked onboarding checklist boxes (Issue #311) without making
     * two separate round-trips to locate the comment.
     *
     * When the factory is provided, the `body` argument to `postIssueComment`
     * is used only as a fallback (when there is no existing comment, or when
     * the factory is not called due to `sticky: false`).
     */
    bodyFactory?: (existingBody: string | undefined) => string;
}
type Octokit = ReturnType<typeof github.getOctokit>;
/**
 * Resolve the issue or pull-request number a comment should be posted to.
 *
 * `pull_request` (and `pull_request_target`) events carry the number under
 * `payload.pull_request.number`, not `payload.issue.number` — `payload.issue`
 * is only populated for `issues`/`issue_comment` events. GitHub treats every
 * PR as an issue under the hood, so the REST issues API (`createComment`,
 * `updateComment`, `listComments`) works identically for both once the
 * correct number is resolved (Issue #220).
 *
 * Only the numeric identifier is read from the payload here — never the PR
 * title/body — so this cannot leak untrusted fork-PR content into anything
 * built from the result (e.g. Horizon request URLs).
 *
 * Checks `issue` first so that `issue_comment` events on a PR (which set
 * *both* `payload.issue` and `payload.issue.pull_request`) keep resolving
 * the same way they always have.
 *
 * @internal Exported for testing.
 */
export declare function resolveIssueOrPullRequestNumber(payload: unknown): number | undefined;
/**
 * Returns true when a comment body matches any of the TrustBridge
 * identifiers: the current versioned sticky marker, the legacy marker
 * (pre-schema-version), or the TrustBridge footer. Matching on any of
 * these provides defense-in-depth across upgrades and accidental
 * marker drift.
 */
export declare function isTrustBridgeComment(body: string | undefined | null): boolean;
/**
 * Maximum number of comment pages (100 comments per page) to search for sticky
 * comments on high-traffic issues or discussions before capping.
 * Capping at 10 pages (1,000 comments) prevents rate limit exhaustion and
 * infinite pagination on busy threads. (Issue #226)
 */
export declare const MAX_STICKY_COMMENT_SEARCH_PAGES = 10;
export interface FindStickyCommentOptions {
    /** Maximum number of comment pages (100 comments per page) to search before stopping. Defaults to 10. */
    maxPages?: number;
}
/**
 * Find TrustBridge's previous sticky comment on the issue, if any.
 *
 * Uses GraphQL pagination (100 comments per page, up to MAX_STICKY_COMMENT_SEARCH_PAGES = 10 pages)
 * to locate the marker efficiently even on busy Wave issues with hundreds of comments.
 * Falls back to REST pagination if GraphQL is unavailable or fails.
 *
 * Matches on the current versioned marker, the legacy marker, and the
 * action footer so comments posted by older releases are still eligible
 * for upsert.
 */
export declare function findStickyComment(octokit: Octokit, owner: string, repo: string, issueNumber: number, options?: FindStickyCommentOptions): Promise<number | undefined>;
export declare function postIssueComment(token: string, body: string, options?: UpsertCommentOptions): Promise<string | undefined>;
/**
 * Extract the GitHub Discussion node id from an event payload, if present.
 *
 * Discussion webhook events (`discussion`, `discussion_comment`) embed the
 * discussion under `payload.discussion.node_id`. Returns `undefined` for
 * non-discussion events so callers can route between the issue (REST) and
 * discussion (GraphQL) comment paths.
 *
 * @internal Exported for testing.
 */
export declare function resolveDiscussionNodeId(payload: unknown): string | undefined;
export interface UpsertDiscussionCommentOptions extends UpsertCommentOptions {
    /**
     * Explicit discussion node id (e.g. "DIC_kw..."). When omitted, the id is
     * resolved from `github.context.payload.discussion.node_id`.
     */
    discussionId?: string;
}
interface DiscussionCommentNode {
    id: string;
    body: string;
    reactions?: {
        nodes?: CommentReaction[];
    };
}
/**
 * Find TrustBridge's previous sticky comment on a discussion, if any.
 *
 * Paginates through every discussion comment (100 per page) so the marker is
 * found even on high-traffic threads — same semantics as `findStickyComment`
 * for issues. Matches on the current versioned marker, the legacy marker, and
 * the action footer so comments posted by older releases are still eligible
 * for upsert.
 */
export declare function findStickyDiscussionComment(octokit: Octokit, discussionId: string, options?: FindStickyCommentOptions): Promise<DiscussionCommentNode | undefined>;
/**
 * Post (or sticky-upsert) a TrustBridge comment on a GitHub Discussion via
 * the GraphQL API.
 *
 * Discussion events have a node id, not an issue number, so this path never
 * touches the REST issues API. When `sticky` is enabled the previous
 * TrustBridge comment on the discussion is updated in place via
 * `updateDiscussionComment`; otherwise a new comment is created via
 * `addDiscussionComment`.
 *
 * Requires `discussions: write` permission on the workflow token (documented
 * in docs/USAGE.md). A missing permission surfaces as a GraphQL mutation
 * error, which the caller is expected to catch and downgrade to a warning —
 * comment posting must never fail the run.
 *
 * @returns The URL of the created/updated discussion comment, or `undefined`
 *          when there is no discussion context in the event payload.
 */
export declare function postDiscussionComment(token: string, body: string, options?: UpsertDiscussionCommentOptions): Promise<string | undefined>;
export {};
