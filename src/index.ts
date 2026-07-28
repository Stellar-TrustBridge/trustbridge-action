import * as core from '@actions/core';
import {
  CheckConfig,
  horizonFailureResult,
  parseMinXlmReserve,
  runAccountChecks,
  tlsFailureResult,
  unfundedAccountResult,
  validateStellarAddress,
} from './checks';
import { fetchAccount, HorizonError, HorizonTlsError, waitForFundedAccount } from './horizon';
import { formatCommentBody, postIssueComment } from './comment';
import { normalizeAssetConfig } from './assets';
import {
  getErrorMessage,
  parseBooleanInput,
  parseNumberInput,
  parseUnauthorizedTrustlinePolicy,
} from './inputs';
import { formatFailureSummary } from './summary';
import { setValidationOutputs } from './outputs';
import { logger, emitInputsLogRecord } from './logger';
import { globalMetrics } from './metrics';
import { validateContractAddress, clearSpans, getSpans } from './validation';
import { parseBatchAddresses, runBatchValidation, buildBatchSummary, formatBatchSummaryMarkdown } from './batch';

async function run(): Promise<void> {
  const horizonUrl = core.getInput('horizon_url') || 'https://horizon.stellar.org';
  const assetCode = core.getInput('asset_code') || 'USDC';
  const assetIssuer =
    core.getInput('asset_issuer') ||
    'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  const minXlmReserveRaw = core.getInput('min_xlm_reserve') || '1.5';
  const stellarAddress = core.getInput('stellar_address_input').trim();
  const stellarAddressesRaw = core.getInput('stellar_addresses').trim();
  const batchRequestDelayMs = parseNumberInput(core.getInput('batch_request_delay_ms'), 200, {
    min: 0,
    max: 60000,
  });
  const failOnMissing = parseBooleanInput(core.getInput('fail_on_missing'), true);
  const debugMode = parseBooleanInput(core.getInput('debug_mode'), false);
  const horizonTimeoutMs = parseNumberInput(core.getInput('horizon_timeout_ms'), 15000, {
    min: 1000,
    max: 60000,
  });
  const stickyComment = parseBooleanInput(core.getInput('sticky_comment'), true);
  const waitUntilFunded = parseBooleanInput(core.getInput('wait_until_funded'), false);
  const waitUntilFundedTimeoutMs = parseNumberInput(
    core.getInput('wait_until_funded_timeout_ms'),
    120000,
    { min: 0, max: 600000 },
  );
  const waitUntilFundedIntervalMs = parseNumberInput(
    core.getInput('wait_until_funded_interval_ms'),
    5000,
    { min: 1000, max: 60000 },
  );
  const horizonUrlFallback = core.getInput('horizon_url_fallback') || '';
  const rpcFallbackUrlRaw = core.getInput('rpc_fallback_url') || '';
  const fallbackUrls = rpcFallbackUrlRaw
    ? rpcFallbackUrlRaw.split(',').map((u) => u.trim()).filter(Boolean)
    : horizonUrlFallback
      ? [horizonUrlFallback]
      : [];
  const horizonCacheTtlMs = parseNumberInput(core.getInput('horizon_cache_ttl_ms'), 60000, {
    min: 0,
    max: 3_600_000,
  });
  const useCache = parseBooleanInput(core.getInput('use_cache'), false);
  const logInputs = parseBooleanInput(core.getInput('log_inputs'), false);
  const trustbridgeConfigPath = core.getInput('trustbridge_config_path') || '.trustbridge.yml';
  const githubToken = core.getInput('github_token', { required: true });

  // SEP-0007 wallet deep links (Issue #44)
  const sep0007DeepLinks = parseBooleanInput(core.getInput('sep0007_deep_links'), false);
  const sep0007OriginDomain = core.getInput('sep0007_origin_domain') || '';

  // Unauthorized trustline policy (Issue #72)
  const unauthorizedTrustlinePolicy = parseUnauthorizedTrustlinePolicy(
    core.getInput('unauthorized_trustline_policy'),
  );

  // Clawback warning strict mode (Issue #73)
  const clawbackStrictMode = parseBooleanInput(core.getInput('clawback_strict_mode'), false);

  // Clear validation spans from any prior run in the same process (safety).
  clearSpans();

  // Never weaken TLS verification by default (Issue #71). TrustBridge does
  // not set NODE_TLS_REJECT_UNAUTHORIZED itself; if something else in the
  // environment has disabled it, surface that loudly rather than silently
  // trusting an unverified Horizon endpoint.
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    logger.warn(
      'NODE_TLS_REJECT_UNAUTHORIZED=0 is set in this environment — TLS certificate verification is disabled process-wide. TrustBridge does not set this itself; see docs/USAGE.md for private-mirror TLS guidance.',
      { component: 'index' },
    );
  }

  logger.setDebugMode(debugMode);
  logger.debug('Action inputs loaded', {
    component: 'index',
    trustbridgeConfigPath,
    horizonUrl,
    horizonUrlFallback,
    horizonCacheTtlMs,
    assetCode,
    assetIssuer,
    minXlmReserveRaw,
    debugMode,
    horizonTimeoutMs,
    stickyComment,
    waitUntilFunded,
    waitUntilFundedTimeoutMs,
    waitUntilFundedIntervalMs,
    rpcFallbackUrl: rpcFallbackUrlRaw,
    useCache,
    sep0007DeepLinks,
  });

  if (logInputs) {
    emitInputsLogRecord({
      horizonUrl,
      horizonUrlFallback,
      rpcFallbackUrl: rpcFallbackUrlRaw,
      assetCode,
      assetIssuer,
      minXlmReserve: minXlmReserveRaw,
      stellarAddress,
      failOnMissing,
      debugMode,
      horizonTimeoutMs,
      stickyComment,
      waitUntilFunded,
      waitUntilFundedTimeoutMs,
      waitUntilFundedIntervalMs,
      horizonCacheTtlMs,
      useCache,
      logInputs,
    });
  }

  const minXlmReserve = parseMinXlmReserve(minXlmReserveRaw);

  // Reject clearly unsafe Horizon/RPC endpoints before ever attempting a
  // connection (Issue #71): private IPs, loopback, link-local, cloud
  // metadata endpoints, and file:// are all blocked. HTTPS is required —
  // plain HTTP Horizon endpoints are not supported in production defaults,
  // so TLS verification can never be silently bypassed by pointing at an
  // unencrypted mirror.
  const horizonUrlInputs: Array<[string, string]> = [['horizon_url', horizonUrl]];
  if (horizonUrlFallback) horizonUrlInputs.push(['horizon_url_fallback', horizonUrlFallback]);
  for (const fallbackUrl of fallbackUrls) {
    horizonUrlInputs.push(['rpc_fallback_url', fallbackUrl]);
  }
  for (const [fieldName, urlValue] of horizonUrlInputs) {
    const urlCheck = validateSsrfSafeUrl(urlValue, fieldName);
    if (!urlCheck.valid) {
      throw new Error(`Invalid ${fieldName}: ${urlCheck.errors.join('; ')}`);
    }
  }

  const normalizedAsset = normalizeAssetConfig({ assetCode, assetIssuer });

  // Soroban fungible token contracts (SEP-41) use a "C..." contract address
  // as their issuer instead of a classic "G..." account. Validate that
  // shape up front so a malformed contract address fails fast with a clear
  // error instead of silently reaching Horizon or the metrics/JSON output.
  if (normalizedAsset.assetIssuer.startsWith('C')) {
    const contractCheck = validateContractAddress(normalizedAsset.assetIssuer);
    if (!contractCheck.valid) {
      throw new Error(`Invalid asset_issuer contract address: ${contractCheck.errors.join('; ')}`);
    }
    globalMetrics.recordContractMetric(
      'asset_issuer_contract_validated',
      1,
      normalizedAsset.assetIssuer,
      'count',
    );
  }

  const checkConfig: CheckConfig = {
    ...normalizedAsset,
    minXlmReserve,
    horizonUrl,
    unauthorizedTrustlinePolicy,
    clawbackStrictMode,
  };

  const horizonOptions = {
    timeoutMs: horizonTimeoutMs,
    horizonUrlFallback: horizonUrlFallback || undefined,
    fallbackUrls,
    cacheTtlMs: useCache ? horizonCacheTtlMs : 0,
    useCache,
  };

  // ── Batch mode (stellar_addresses set) ──────────────────────────────────
  if (stellarAddressesRaw) {
    const addresses = parseBatchAddresses(stellarAddressesRaw);
    core.info(`[TrustBridge] Batch mode: validating ${addresses.length} addresses via ${horizonUrl}`);

    const batchResults = await runBatchValidation(addresses, checkConfig, horizonUrl, {
      requestDelayMs: batchRequestDelayMs,
      fetchOptions: horizonOptions,
    });

    const batchSummary = buildBatchSummary(batchResults);
    core.info(`[TrustBridge] Batch complete: ${batchSummary.passed}/${batchSummary.total} passed`);

    core.setOutput('batch_results', JSON.stringify(batchResults));
    core.setOutput('batch_summary', JSON.stringify(batchSummary));
    // Clear single-address outputs
    core.setOutput('trustline_exists', '');
    core.setOutput('xlm_balance', '');
    core.setOutput('account_funded', '');
    core.setOutput('comment_url', '');

    // Post a single summary comment if in issue context
    const batchCommentBody = formatBatchSummaryMarkdown(batchSummary, assetCode);
    let batchCommentUrl: string | undefined;
    try {
      batchCommentUrl = await postIssueComment(githubToken, batchCommentBody, { sticky: stickyComment });
      if (batchCommentUrl) {
        core.setOutput('comment_url', batchCommentUrl);
        logger.info('Batch summary comment posted', { component: 'index', commentUrl: batchCommentUrl });
      }
    } catch (commentError) {
      const message = getErrorMessage(commentError);
      core.warning(`Failed to post batch summary comment: ${message}`);
    }

    if (debugMode) {
      logger.debug('Batch metrics (JSON artifact)', { component: 'metrics' });
      core.debug(globalMetrics.toJSON());
    }

    if (batchSummary.failed > 0 && failOnMissing) {
      core.setFailed(`TrustBridge batch: ${batchSummary.failed} of ${batchSummary.total} addresses failed validation`);
    } else if (batchSummary.failed > 0) {
      core.warning(`TrustBridge batch: ${batchSummary.failed} of ${batchSummary.total} addresses failed validation`);
    }
    return;
  }

  // ── Single-address mode ─────────────────────────────────────────────────
  validateStellarAddress(stellarAddress);

  core.info(`Checking Stellar account ${stellarAddress} via ${horizonUrl}`);

  if (waitUntilFunded) {
    core.info(
      `wait_until_funded is enabled — polling every ${waitUntilFundedIntervalMs}ms for up to ${waitUntilFundedTimeoutMs}ms.`,
    );
  }

  let result;

  try {
    const account = waitUntilFunded
      ? await waitForFundedAccount(
          horizonUrl,
          stellarAddress,
          {
            timeoutMs: waitUntilFundedTimeoutMs,
            pollIntervalMs: waitUntilFundedIntervalMs,
            requestTimeoutMs: horizonTimeoutMs,
            onPoll: (attempt, elapsedMs) =>
              logger.debug(`Account not yet funded — polling again`, {
                component: 'index',
                attempt,
                elapsedMs,
              }),
          },
          (hUrl, sAddr, opts) => fetchAccount(hUrl, sAddr, { ...horizonOptions, ...opts }),
        )
      : await fetchAccount(horizonUrl, stellarAddress, horizonOptions);
    result = runAccountChecks(account, checkConfig);
  } catch (error) {
    if (error instanceof HorizonTlsError) {
      core.error(error.message);
      result = tlsFailureResult(error.message, checkConfig);
    } else if (error instanceof HorizonError && error.statusCode === 404) {
      result = unfundedAccountResult(stellarAddress, checkConfig);
    } else if (error instanceof HorizonError) {
      core.error(error.message);
      result = horizonFailureResult(error.message, checkConfig);
    } else {
      const message = getErrorMessage(error);
      core.error(message);
      result = horizonFailureResult(message, checkConfig);
    }
  }

  setValidationOutputs(result);

  const commentBody = formatCommentBody(result, {
    ...checkConfig,
    stellarAddress,
    horizonUrl,
    failOnMissing,
    stickyComment,
    waitUntilFunded,
    waitUntilFundedTimeoutMs,
    waitUntilFundedIntervalMs,
    sep0007DeepLinks,
    sep0007OriginDomain,
    debugMode,
  });

  let commentUrl: string | undefined;
  try {
    commentUrl = await postIssueComment(githubToken, commentBody, { sticky: stickyComment });
    if (commentUrl) {
      logger.info('Issue comment created', { component: 'index', commentUrl });
    }
  } catch (commentError) {
    const message = getErrorMessage(commentError);
    core.warning(`Failed to post issue comment: ${message}`);
  }

  setValidationOutputs(result, commentUrl);

  if (debugMode) {
    logger.debug('Metrics summary (JSON artifact)', { component: 'metrics' });
    core.debug(globalMetrics.toJSON());

    // Emit validation spans for observability (Issue #35)
    const spans = getSpans();
    if (spans.length > 0) {
      logger.debug('Validation spans', { component: 'validation', spanCount: spans.length });
      core.debug(JSON.stringify(spans, null, 2));
    }
  }

  if (result.valid) {
    core.info('All TrustBridge checks passed.');
    return;
  }

  const summary = formatFailureSummary(result);

  const failureMessage = `TrustBridge checks failed: ${summary}`;

  if (failOnMissing) {
    core.setFailed(failureMessage);
  } else {
    core.warning(failureMessage);
  }
}

run().catch((error) => {
  core.setFailed(getErrorMessage(error));
});
