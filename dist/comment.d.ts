import * as github from '@actions/github';
import { CheckConfig, ValidationResult } from './checks';
import { MetricsCollector } from './metrics';
/**
 * Semantic schema version embedded in every TrustBridge issue comment.
 * Bump when the comment body structure (sections, markers, remediation
 * shape, etc.) changes in a way that downstream consumers or future
 * versions of this action need to detect.
 */
export declare const COMMENT_SCHEMA_VERSION = "1.0.0";
export interface CommentConfig extends CheckConfig {
    stellarAddress: string;
    horizonUrl: string;
    failOnMissing?: boolean;
    waitUntilFunded?: boolean;
    waitUntilFundedTimeoutMs?: number;
    waitUntilFundedIntervalMs?: number;
    stickyComment?: boolean;
    /** Emit SEP-0007 wallet deep links (web+stellar:pay) in the comment. */
    sep0007DeepLinks?: boolean;
    /** Optional origin domain for SEP-0007 URIs (§3.4). */
    sep0007OriginDomain?: string;
    /**
     * When provided, a hardened metrics JSON block is appended to the comment
     * as a fenced code block. Callers should pass a fresh `MetricsCollector`
     * snapshot so the comment reflects the run that generated it.
     */
    metricsSnapshot?: MetricsCollector;
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
export declare const STICKY_COMMENT_MARKER = "<!-- trustbridge-action:sticky-comment:schema-v1.0.0 -->";
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
export interface UpsertCommentOptions {
    /**
     * When true (default), find and update TrustBridge's previous comment on
     * the issue instead of posting a new one every run. Falls back to
     * creating a new comment when no prior comment is found, or when the
     * lookup itself fails (e.g. transient GitHub API error).
     */
    sticky?: boolean;
}
type Octokit = ReturnType<typeof github.getOctokit>;
/**
 * Returns true when a comment body matches any of the TrustBridge
 * identifiers: the current versioned sticky marker, the legacy marker
 * (pre-schema-version), or the TrustBridge footer. Matching on any of
 * these provides defense-in-depth across upgrades and accidental
 * marker drift.
 */
export declare function isTrustBridgeComment(body: string | undefined | null): boolean;
/**
 * Find TrustBridge's previous sticky comment on the issue, if any.
 * Paginates through every comment so the marker is found even on
 * high-traffic issues with 100+ comments.
 *
 * Matches on the current versioned marker, the legacy marker, and the
 * action footer so comments posted by older releases are still eligible
 * for upsert.
 */
export declare function findStickyComment(octokit: Octokit, owner: string, repo: string, issueNumber: number): Promise<number | undefined>;
export declare function postIssueComment(token: string, body: string, options?: UpsertCommentOptions): Promise<string | undefined>;
export {};
