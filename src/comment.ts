import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  CheckConfig,
  STELLAR_BASE_RESERVE_XLM,
  STELLAR_MIN_ACCOUNT_BALANCE_XLM,
  buildValidationGate,
  ValidationResult,
  estimateTrustlineSetupCost,
} from './checks';
import { buildAccountViewerLink, buildChangeTrustLink, buildLobstrLink, inferStellarNetwork } from './links';
import { inlineCode, wrapMarkdownTableCell } from './markdown';

/**
 * Semantic schema version embedded in every TrustBridge issue comment.
 * Bump when the comment body structure (sections, markers, remediation
 * shape, etc.) changes in a way that downstream consumers or future
 * versions of this action need to detect.
 */
export const COMMENT_SCHEMA_VERSION = '1.1.0';

export interface CommentConfig extends CheckConfig {
  stellarAddress: string;
  horizonUrl: string;
  failOnMissing?: boolean;
  waitUntilFunded?: boolean;
  waitUntilFundedTimeoutMs?: number;
  waitUntilFundedIntervalMs?: number;
  stickyComment?: boolean;
}

export const TRUSTBRIDGE_FOOTER = '_Posted by [trustbridge-action](https://github.com/Stellar-TrustBridge/trustbridge-action)_';

/**
 * Legacy hidden marker (pre-schema-version). Kept for backward
 * compatibility in `findStickyComment` so comments posted by older
 * releases of the action are still eligible for upsert.
 */
export const STICKY_COMMENT_MARKER_LEGACY = '<!-- trustbridge-action:sticky-comment -->';

/**
 * Hidden marker embedded in every TrustBridge comment body. Includes the
 * comment schema version so future releases can detect the format of a
 * prior comment and decide whether to update it in place or post a new
 * one.
 */
export const STICKY_COMMENT_MARKER = `<!-- trustbridge-action:sticky-comment:schema-v${COMMENT_SCHEMA_VERSION} -->`;

function statusIcon(passed: boolean): string {
  return passed ? '✅' : '❌';
}

export function formatCommentBody(
  result: ValidationResult,
  config: CommentConfig,
): string {
  const stellarLabNetwork = inferStellarNetwork(config.horizonUrl);
  const gate = buildValidationGate(result);
  const lines: string[] = [
    STICKY_COMMENT_MARKER,
    `<!-- trustbridge-action:schema-version:${COMMENT_SCHEMA_VERSION} -->`,
    '## TrustBridge — Stellar Account Check',
    '',
    `Checked account: ${inlineCode(config.stellarAddress)}`,
    `Horizon: ${inlineCode(config.horizonUrl)}`,
    `Asset: **${config.assetCode}** · Issuer: ${inlineCode(config.assetIssuer)}`,
    '',
    '### Results',
    '',
  ];

  lines.push('| Status | Check | Reason |', '| --- | --- | --- |');
  for (const check of result.checks) {
    lines.push(`| ${statusIcon(check.passed)} | **${wrapMarkdownTableCell(check.label)}** | ${wrapMarkdownTableCell(check.detail)} |`);
  }

  lines.push(
    '',
    '### Validation gate',
    '',
    gate.ready
      ? '- Ready to proceed: all checks passed.'
      : `- Blocked by: ${gate.failedLabels.join(', ')}`,
    `- Passed checks: ${gate.passedChecks}/${gate.totalChecks}`,
    `- Failed checks: ${gate.failedChecks}`,
    '',
    '### Balances',
    '',
    `- **XLM balance:** ${result.xlmBalance === 'unknown' ? '_unknown_' : `\`${result.xlmBalance} XLM\``}`,
    `- **Minimum required:** \`${config.minXlmReserve} XLM\``,
    '',
    '### Setup cost estimate',
    '',
    `- Stellar minimum account balance: **${STELLAR_MIN_ACCOUNT_BALANCE_XLM} XLM**`,
    `- Base reserve per trustline (ledger entry): **${STELLAR_BASE_RESERVE_XLM} XLM**`,
    `- Typical minimum to fund account + one trustline: **~${estimateTrustlineSetupCost()} XLM**`,
    '',
    '### Add a trustline',
    '',
    `- [View account on Stellar Laboratory](${buildAccountViewerLink(config.stellarAddress, stellarLabNetwork)})`,
    `- [Open Transaction Builder (Change Trust)](${buildChangeTrustLink(stellarLabNetwork)})`,
    `- [LOBSTR wallet](${buildLobstrLink()}) — add asset **${config.assetCode}** from issuer \`${config.assetIssuer}\``,
  );

  if (result.remediation) {
    lines.push('', '### Remediation', '', result.remediation);
  }

  lines.push(
    '',
    '### Configuration summary',
    '',
    `| Input | Value |`,
    `| --- | --- |`,
    `| \`fail_on_missing\` | ${config.failOnMissing === undefined ? '_default (true)_' : config.failOnMissing ? '`true` — step fails on missing checks' : '`false` — only warns'} |`,
    `| \`sticky_comment\` | ${config.stickyComment === undefined ? '_default (true)_' : config.stickyComment ? '`true` — upserts prior comment' : '`false` — always posts new'} |`,
    `| \`wait_until_funded\` | ${config.waitUntilFunded ? '`true`' : '`false` (default)'} |`,
  );

  if (config.waitUntilFunded) {
    const timeout = config.waitUntilFundedTimeoutMs ?? 120000;
    const interval = config.waitUntilFundedIntervalMs ?? 5000;
    lines.push(
      `| \`wait_until_funded_timeout_ms\` | \`${timeout}\` |`,
      `| \`wait_until_funded_interval_ms\` | \`${interval}\` |`,
    );
  }

  lines.push(
    '',
    '### Action outputs reference',
    '',
    '_Use these output names in downstream workflow steps via `steps.<id>.outputs.<name>`._',
    '',
    `| Output | Value in this run | Description |`,
    `| --- | --- | --- |`,
    `| \`account_funded\` | \`${String(result.accountFunded)}\` | Whether the account exists on the Stellar network (from \`action.yml\`) |`,
    `| \`trustline_exists\` | \`${String(result.trustlineExists)}\` | Whether the **${config.assetCode}** trustline is configured (from \`action.yml\`) |`,
    `| \`xlm_balance\` | \`${result.xlmBalance}\` | Native XLM balance reported by Horizon (from \`action.yml\`) |`,
    `| \`comment_url\` | _set after posting_ | URL of this issue comment (from \`action.yml\`) |`,
    '',
    '---',
    TRUSTBRIDGE_FOOTER,
  );

  return lines.join('\n');
}

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
export function isTrustBridgeComment(body: string | undefined | null): boolean {
  if (!body) return false;
  return (
    body.includes(STICKY_COMMENT_MARKER) ||
    body.includes(STICKY_COMMENT_MARKER_LEGACY) ||
    body.includes(TRUSTBRIDGE_FOOTER)
  );
}

/**
 * Find TrustBridge's previous sticky comment on the issue, if any.
 * Paginates through every comment so the marker is found even on
 * high-traffic issues with 100+ comments.
 *
 * Matches on the current versioned marker, the legacy marker, and the
 * action footer so comments posted by older releases are still eligible
 * for upsert.
 */
export async function findStickyComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<number | undefined> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });

  const existing = comments.find((comment) => isTrustBridgeComment(comment.body));
  return existing?.id;
}

export async function postIssueComment(
  token: string,
  body: string,
  options: UpsertCommentOptions = {},
): Promise<string | undefined> {
  const sticky = options.sticky ?? true;
  const context = github.context;
  const issueNumber = context.payload.issue?.number;

  if (!issueNumber) {
    core.warning(
      'No issue context found — skipping comment. This action posts comments on `issues` events.',
    );
    return undefined;
  }

  const octokit = github.getOctokit(token);
  const { owner, repo } = context.repo;

  let existingCommentId: number | undefined;
  if (sticky) {
    try {
      existingCommentId = await findStickyComment(octokit, owner, repo, issueNumber);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      core.warning(
        `Could not look up existing TrustBridge comment, falling back to a new comment: ${message}`,
      );
    }
  }

  if (existingCommentId) {
    const response = await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existingCommentId,
      body,
    });

    const commentUrl = response.data.html_url;
    core.info(`Updated existing TrustBridge comment on issue #${issueNumber}.`);
    return commentUrl;
  }

  const response = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });

  const commentUrl = response.data.html_url;
  core.info(`Posted TrustBridge comment on issue #${issueNumber}.`);
  return commentUrl;
}
