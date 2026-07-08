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

export interface CommentConfig extends CheckConfig {
  stellarAddress: string;
  horizonUrl: string;
}

export const TRUSTBRIDGE_FOOTER = '_Posted by [trustbridge-action](https://github.com/Stellar-TrustBridge/trustbridge-action)_';

function statusIcon(passed: boolean): string {
  return passed ? '✅' : '❌';
}

export function formatCommentBody(
  result: ValidationResult,
  config: CommentConfig,
): string {
  const stellarLabNetwork = inferStellarNetwork(config.horizonUrl);
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
