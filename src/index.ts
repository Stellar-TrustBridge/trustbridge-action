import * as core from '@actions/core';
import {
  CheckConfig,
  horizonFailureResult,
  parseMinXlmReserve,
  runAccountChecks,
  unfundedAccountResult,
  validateStellarAddress,
  getFailedCheckLabels,
} from './checks';
import { fetchAccount, HorizonError } from './horizon';
import { formatCommentBody, postIssueComment } from './comment';
import { parseBooleanInput } from './inputs';

async function run(): Promise<void> {
  const horizonUrl = core.getInput('horizon_url') || 'https://horizon.stellar.org';
  const assetCode = core.getInput('asset_code') || 'USDC';
  const assetIssuer =
    core.getInput('asset_issuer') ||
    'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  const minXlmReserveRaw = core.getInput('min_xlm_reserve') || '1.5';
  const stellarAddress = core.getInput('stellar_address_input').trim();
  const failOnMissing = parseBooleanInput(core.getInput('fail_on_missing'), true);
  const githubToken = core.getInput('github_token', { required: true });

  validateStellarAddress(stellarAddress);
  const minXlmReserve = parseMinXlmReserve(minXlmReserveRaw);

  const checkConfig: CheckConfig = {
    assetCode,
    assetIssuer,
    minXlmReserve,
  };

  core.info(`Checking Stellar account ${stellarAddress} via ${horizonUrl}`);

  let result;

  try {
    const account = await fetchAccount(horizonUrl, stellarAddress);
    result = runAccountChecks(account, checkConfig);
  } catch (error) {
    if (error instanceof HorizonError && error.statusCode === 404) {
      result = unfundedAccountResult(stellarAddress, checkConfig);
    } else if (error instanceof HorizonError) {
      core.error(error.message);
      result = horizonFailureResult(error.message, checkConfig);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      core.error(message);
      result = horizonFailureResult(message, checkConfig);
    }
  }

  core.setOutput('trustline_exists', String(result.trustlineExists));
  core.setOutput('xlm_balance', result.xlmBalance);
  core.setOutput('account_funded', String(result.accountFunded));

  const commentBody = formatCommentBody(result, {
    ...checkConfig,
    stellarAddress,
    horizonUrl,
  });

  try {
    await postIssueComment(githubToken, commentBody);
  } catch (commentError) {
    const message =
      commentError instanceof Error ? commentError.message : String(commentError);
    core.warning(`Failed to post issue comment: ${message}`);
  }

  if (result.valid) {
    core.info('All TrustBridge checks passed.');
    return;
  }

  const summary = getFailedCheckLabels(result).join(', ');

  const failureMessage = `TrustBridge checks failed: ${summary}`;

  if (failOnMissing) {
    core.setFailed(failureMessage);
  } else {
    core.warning(failureMessage);
  }
}

run().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
