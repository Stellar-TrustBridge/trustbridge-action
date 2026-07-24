import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  CheckConfig,
  STELLAR_BASE_RESERVE_XLM,
  STELLAR_MIN_ACCOUNT_BALANCE_XLM,
  ValidationResult,
  estimateTrustlineSetupCost,
} from './checks';
import { buildAccountViewerLink, buildChangeTrustLink, buildLobstrLink, inferStellarNetwork } from './links';
import { inlineCode } from './markdown';

export interface CommentConfig extends CheckConfig {
  stellarAddress: string;
  horizonUrl: string;
}

export const TRUSTBRIDGE_FOOTER = '_Posted by [trustbridge-action](https://github.com/Stellar-TrustBridge/trustbridge-action)_';

/**
 * Hidden marker embedded in every TrustBridge comment body. Used to find a
 * prior comment to update in place instead of posting a new one each run.
 */
export const STICKY_COMMENT_MARKER = '<!-- trustbridge-action:sticky-comment -->';

function statusIcon(passed: boolean): string {
  return passed ? '✅' : '❌';
}

export function formatCommentBody(
  result: ValidationResult,
  config: CommentConfig,
): string {
  const stellarLabNetwork = inferStellarNetwork(config.horizonUrl);
  const lines: string[] = [
    STICKY_COMMENT_MARKER,
    '## TrustBridge — Stellar Account Check',
    '',
    `Checked account: ${inlineCode(config.stellarAddress)}`,
    `Horizon: ${inlineCode(config.horizonUrl)}`,
    `Asset: **${config.assetCode}** · Issuer: ${inlineCode(config.assetIssuer)}`,
    '',
    '### Results',
    '',
  ];

  for (const check of result.checks) {
    lines.push(`- ${statusIcon(check.passed)} **${check.label}** — ${check.detail}`);
  }

  lines.push(
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
    '---',
    '_Posted by [trustbridge-action](https://github.com/Stellar-TrustBridge/trustbridge-action)_',
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
 * Find TrustBridge's previous sticky comment on the issue, if any.
 * Paginates through every comment so the marker is found even on
 * high-traffic issues with 100+ comments.
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

  const existing = comments.find((comment) => comment.body?.includes(STICKY_COMMENT_MARKER));
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
