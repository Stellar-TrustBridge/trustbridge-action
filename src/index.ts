import * as core from '@actions/core';
import {
  CheckConfig,
  horizonFailureResult,
  parseMinXlmReserve,
  runAccountChecks,
  runMultiAssetChecks,
  unfundedAccountResult,
  validateStellarAddress,
} from './checks';
import { fetchAccount, getAssetBalance, HorizonError, waitForFundedAccount } from './horizon';
import { formatCommentBody, postIssueComment } from './comment';
import { normalizeAssetConfig, parseAssetsJson, dedupeAssets } from './assets';
import { getErrorMessage, parseBooleanInput, parseNumberInput } from './inputs';
import { formatFailureSummary } from './summary';
import { setValidationOutputs, AssetTrustlineStatus } from './outputs';
import { logger, emitInputsLogRecord } from './logger';
import { globalMetrics } from './metrics';
import { validateContractAddress, clearSpans, getSpans } from './validation';
import { readTrustbridgeConfig } from './configReader';

async function run(): Promise<void> {
  const horizonUrl = core.getInput('horizon_url') || 'https://horizon.stellar.org';
  const assetCode = core.getInput('asset_code') || 'USDC';
  const assetIssuer =
    core.getInput('asset_issuer') ||
    'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  const minXlmReserveRaw = core.getInput('min_xlm_reserve') || '1.5';
  const stellarAddress = core.getInput('stellar_address_input').trim();
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

  // Extra trustlines from assets_json (Issue #536).
  // Parse up front so a malformed JSON string fails fast before hitting Horizon.
  const assetsJsonRaw = core.getInput('assets_json') || '';
  let extraAssets: ReturnType<typeof parseAssetsJson> = [];
  if (assetsJsonRaw.trim()) {
    try {
      extraAssets = dedupeAssets(parseAssetsJson(assetsJsonRaw));
    } catch (parseErr) {
      core.setFailed(`assets_json parse error: ${getErrorMessage(parseErr)}`);
      return;
    }
  }

  // Clear validation spans from any prior run in the same process (safety).
  clearSpans();

  // Load optional consumer .trustbridge.yml config file (Issue #45).
  // readTrustbridgeConfig is non-throwing: a missing file returns found=false,
  // validation errors surface via result.validation.errors so we fail fast
  // with a clear message rather than silently ignoring bad configuration.
  const consumerConfig = readTrustbridgeConfig(trustbridgeConfigPath);
  if (consumerConfig.found && !consumerConfig.validation.valid) {
    core.setFailed(
      `trustbridge_config_path validation failed:\n  ${consumerConfig.validation.errors.join('\n  ')}`,
    );
    return;
  }

  logger.setDebugMode(debugMode);
  logger.debug('Action inputs loaded', {
    component: 'index',
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

  validateStellarAddress(stellarAddress);
  const minXlmReserve = parseMinXlmReserve(minXlmReserveRaw);

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
  };

  core.info(`Checking Stellar account ${stellarAddress} via ${horizonUrl}`);

  if (waitUntilFunded) {
    core.info(
      `wait_until_funded is enabled — polling every ${waitUntilFundedIntervalMs}ms for up to ${waitUntilFundedTimeoutMs}ms.`,
    );
  }

  let result;

  // Populated inside the try block when assets_json is provided (Issue #536).
  let assetsTrustlineStatusExtras: AssetTrustlineStatus[] = [];

  const horizonOptions = {
    timeoutMs: horizonTimeoutMs,
    horizonUrlFallback: horizonUrlFallback || undefined,
    fallbackUrls,
    cacheTtlMs: useCache ? horizonCacheTtlMs : 0,
    useCache,
  };

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

    // Issue #536 — extra trustlines from assets_json gate the ready output.
    // runAccountChecks only validates the single primary asset_code/asset_issuer
    // pair. When assets_json is provided we run a multi-asset trustline check
    // and append a failing check item for every extra asset whose trustline is
    // absent. The combined valid flag is then re-derived so `ready` reflects
    // all required trustlines, not just the primary one.
    if (extraAssets.length > 0) {
      const { results: extraResults } = runMultiAssetChecks(account, extraAssets);
      for (const assetResult of extraResults) {
        if (!assetResult.trustlineExists) {
          result.checks.push({
            passed: false,
            label: `${assetResult.assetCode} trustline (extra)`,
            detail: `Extra trustline for **${assetResult.assetCode}** (issuer: \`${assetResult.assetIssuer}\`) is missing — add it before this account can receive the asset.`,
          });
        }
      }
      // Recompute valid from the full (now-extended) checks array so every
      // caller that reads result.valid (outputs, comment, fail_on_missing) sees
      // the correct gated value without needing to know about assets_json.
      result.valid = result.checks.every((c) => c.passed);
      if (!result.valid && result.reasonCode === 'SUCCESS') {
        result.reasonCode = 'EXTRA_TRUSTLINE_MISSING';
      }

      // Populate the assetsTrustlineStatus extras so the assets_trustline_status
      // and trustlines_summary outputs are set correctly.
      assetsTrustlineStatusExtras = extraResults.map((r) => ({
        assetCode: r.assetCode,
        assetIssuer: r.assetIssuer,
        trustlineExists: r.trustlineExists,
        balance: getAssetBalance(account, r.assetCode, r.assetIssuer),
      }));
    }
  } catch (error) {
    if (error instanceof HorizonError && error.statusCode === 404) {
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

  setValidationOutputs(result, undefined, undefined, {
    horizonUrl,
    assetCode: normalizedAsset.assetCode,
    assetIssuer: normalizedAsset.assetIssuer,
    assetsTrustlineStatus: assetsTrustlineStatusExtras,
  });

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
    assets: assetsTrustlineStatusExtras,
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

  setValidationOutputs(result, commentUrl, undefined, {
    horizonUrl,
    assetCode: normalizedAsset.assetCode,
    assetIssuer: normalizedAsset.assetIssuer,
    assetsTrustlineStatus: assetsTrustlineStatusExtras,
  });

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
