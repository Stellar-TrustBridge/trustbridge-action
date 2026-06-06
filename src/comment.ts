import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  CheckConfig,
  STELLAR_BASE_RESERVE_XLM,
  STELLAR_MIN_ACCOUNT_BALANCE_XLM,
  ValidationResult,
} from './checks';

export interface CommentConfig extends CheckConfig {
  stellarAddress: string;
  horizonUrl: string;
}

function statusIcon(passed: boolean): string {
  return passed ? '✅' : '❌';
}

function buildStellarLabLink(stellarAddress: string): string {
  const params = new URLSearchParams({
    network: 'public',
  });
  return `https://laboratory.stellar.org/#account-viewer?${params.toString()}&account=${stellarAddress}`;
}

function buildTxBuilderLink(): string {
  return 'https://laboratory.stellar.org/#txbuilder?network=public';
}

export function formatCommentBody(
  result: ValidationResult,
  config: CommentConfig,
): string {
  const lines: string[] = [
    '## TrustBridge — Stellar Account Check',
    '',
    `Checked account: \`${config.stellarAddress}\``,
    `Horizon: \`${config.horizonUrl}\``,
    `Asset: **${config.assetCode}** · Issuer: \`${config.assetIssuer}\``,
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
    `- Typical minimum to fund account + one trustline: **~${STELLAR_MIN_ACCOUNT_BALANCE_XLM + STELLAR_BASE_RESERVE_XLM} XLM**`,
    '',
    '### Add a trustline',
    '',
    `- [View account on Stellar Laboratory](${buildStellarLabLink(config.stellarAddress)})`,
    `- [Open Transaction Builder (Change Trust)](${buildTxBuilderLink()})`,
    `- [LOBSTR wallet](https://lobstr.co/) — add asset **${config.assetCode}** from issuer \`${config.assetIssuer}\``,
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

export async function postIssueComment(
  token: string,
  body: string,
): Promise<void> {
  const context = github.context;
  const issueNumber = context.payload.issue?.number;

  if (!issueNumber) {
    core.warning(
      'No issue context found — skipping comment. This action posts comments on `issues` events.',
    );
    return;
  }

  const octokit = github.getOctokit(token);
  const { owner, repo } = context.repo;

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });

  core.info(`Posted TrustBridge comment on issue #${issueNumber}.`);
}
