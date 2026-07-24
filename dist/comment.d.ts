import * as github from '@actions/github';
import { CheckConfig, ValidationResult } from './checks';
export interface CommentConfig extends CheckConfig {
    stellarAddress: string;
    horizonUrl: string;
}
export declare const TRUSTBRIDGE_FOOTER = "_Posted by [trustbridge-action](https://github.com/Stellar-TrustBridge/trustbridge-action)_";
/**
 * Hidden marker embedded in every TrustBridge comment body. Used to find a
 * prior comment to update in place instead of posting a new one each run.
 */
export declare const STICKY_COMMENT_MARKER = "<!-- trustbridge-action:sticky-comment -->";
export declare function formatCommentBody(result: ValidationResult, config: CommentConfig): string;
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
 * Find TrustBridge's previous sticky comment on the issue, if any.
 * Paginates through every comment so the marker is found even on
 * high-traffic issues with 100+ comments.
 */
export declare function findStickyComment(octokit: Octokit, owner: string, repo: string, issueNumber: number): Promise<number | undefined>;
export declare function postIssueComment(token: string, body: string, options?: UpsertCommentOptions): Promise<string | undefined>;
export {};
