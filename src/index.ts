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
import { readTrustbridgeConfig, mergeConsumerConfig } from './configReader';

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

  // Load and apply optional consumer config file (Issue #45).
  // readTrustbridgeConfig fails fast (throws) if the file exists but is invalid.
  // When the file is absent it returns config:null and found:false — no-op.
  const { config: consumerConfig, validation: configValidation, found: configFound, resolvedPath: configResolvedPath } =
    readTrustbridgeConfig(trustbridgeConfigPath);
  if (!configValidation.valid) {
    // Surface every error so the workflow author can fix them all in one pass.
    throw new Error(
      `trustbridge_config_path "${configResolvedPath}" failed validation:\n${configValidation.errors.join('\n')}`,
    );
  }
  if (configFound && consumerConfig) {
    logger.debug('Consumer config loaded', {
      component: 'index',
      configPath: configResolvedPath,
      keys: Object.keys(consumerConfig),
    });
  }

  // Build the set of inputs that were explicitly provided by the workflow
  // author so mergeConsumerConfig knows which action inputs take precedence.
  const explicitInputs = new Set<string>(
    [
      core.getInput('horizon_url') ? 'horizonUrl' : null,
      core.getInput('horizon_url_fallback') ? 'horizonUrlFallback' : null,
      core.getInput('rpc_fallback_url') ? 'rpcFallbackUrl' : null,
      core.getInput('asset_code') ? 'assetCode' : null,
      core.getInput('asset_issuer') ? 'assetIssuer' : null,
      core.getInput('min_xlm_reserve') ? 'minXlmReserveRaw' : null,
      core.getInput('fail_on_missing') ? 'failOnMissing' : null,
    ].filter((v): v is string => v !== null),
  );

  // Merge consumer config defaults under explicit action inputs.
  const mergedInputs = mergeConsumerConfig(
    { horizonUrl, horizonUrlFallback, rpcFallbackUrl: rpcFallbackUrlRaw, assetCode, assetIssuer, minXlmReserveRaw, failOnMissing },
    consumerConfig,
    explicitInputs,
  );

  // Re-bind the merged values so the rest of the run uses them.
  const effectiveHorizonUrl: string = typeof mergedInputs.horizonUrl === 'string' ? mergedInputs.horizonUrl : horizonUrl;
  const effectiveHorizonUrlFallback: string = typeof mergedInputs.horizonUrlFallback === 'string' ? mergedInputs.horizonUrlFallback : horizonUrlFallback;
  const effectiveRpcFallbackUrl: string = typeof mergedInputs.rpcFallbackUrl === 'string' ? mergedInputs.rpcFallbackUrl : rpcFallbackUrlRaw;
  const effectiveAssetCode: string = typeof mergedInputs.assetCode === 'string' ? mergedInputs.assetCode : assetCode;
  const effectiveAssetIssuer: string = typeof mergedInputs.assetIssuer === 'string' ? mergedInputs.assetIssuer : assetIssuer;
  const effectiveMinXlmReserveRaw: string = typeof mergedInputs.minXlmReserveRaw === 'string' ? mergedInputs.minXlmReserveRaw : minXlmReserveRaw;
  const effectiveFailOnMissing: boolean = typeof mergedInputs.failOnMissing === 'boolean' ? mergedInputs.failOnMissing : failOnMissing;

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
    horizonUrl: effectiveHorizonUrl,
    horizonUrlFallback: effectiveHorizonUrlFallback,
    horizonCacheTtlMs,
    assetCode: effectiveAssetCode,
    assetIssuer: effectiveAssetIssuer,
    minXlmReserveRaw: effectiveMinXlmReserveRaw,
    debugMode,
    horizonTimeoutMs,
    stickyComment,
    waitUntilFunded,
    waitUntilFundedTimeoutMs,
    waitUntilFundedIntervalMs,
    rpcFallbackUrl: effectiveRpcFallbackUrl,
    useCache,
    sep0007DeepLinks,
  });

  if (logInputs) {
    emitInputsLogRecord({
      horizonUrl: effectiveHorizonUrl,
      horizonUrlFallback: effectiveHorizonUrlFallback,
      rpcFallbackUrl: effectiveRpcFallbackUrl,
      assetCode: effectiveAssetCode,
      assetIssuer: effectiveAssetIssuer,
      minXlmReserve: effectiveMinXlmReserveRaw,
      stellarAddress,
      failOnMissing: effectiveFailOnMissing,
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
  const minXlmReserve = parseMinXlmReserve(effectiveMinXlmReserveRaw);

  const normalizedAsset = normalizeAssetConfig({
    assetCode: effectiveAssetCode,
    assetIssuer: effectiveAssetIssuer,
  });

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
    horizonUrl: effectiveHorizonUrl,
  };

  core.info(`Checking Stellar account ${stellarAddress} via ${effectiveHorizonUrl}`);

  if (waitUntilFunded) {
    core.info(
      `wait_until_funded is enabled — polling every ${waitUntilFundedIntervalMs}ms for up to ${waitUntilFundedTimeoutMs}ms.`,
    );
  }

  let result;

  // Create a job-level AbortController so Horizon fetches and polling loops
  // stop promptly when the GitHub Actions runner cancels the workflow.
  const jobController = new AbortController();

  // Rebuild fallbackUrls from the effective (possibly config-merged) values.
  const effectiveFallbackUrls = effectiveRpcFallbackUrl
    ? effectiveRpcFallbackUrl.split(',').map((u) => u.trim()).filter(Boolean)
    : effectiveHorizonUrlFallback
      ? [effectiveHorizonUrlFallback]
      : fallbackUrls;

  const horizonOptions = {
    timeoutMs: horizonTimeoutMs,
    horizonUrlFallback: effectiveHorizonUrlFallback || undefined,
    fallbackUrls: effectiveFallbackUrls,
    cacheTtlMs: useCache ? horizonCacheTtlMs : 0,
    useCache,
    signal: jobController.signal,
  };

  try {
    const account = waitUntilFunded
      ? await waitForFundedAccount(
          effectiveHorizonUrl,
          stellarAddress,
          {
            timeoutMs: waitUntilFundedTimeoutMs,
            pollIntervalMs: waitUntilFundedIntervalMs,
            requestTimeoutMs: horizonTimeoutMs,
            signal: jobController.signal,
            onPoll: (attempt, elapsedMs) =>
              logger.debug(`Account not yet funded — polling again`, {
                component: 'index',
                attempt,
                elapsedMs,
              }),
          },
          (hUrl, sAddr, opts) => fetchAccount(hUrl, sAddr, { ...horizonOptions, ...opts }),
        )
      : await fetchAccount(effectiveHorizonUrl, stellarAddress, horizonOptions);
    result = runAccountChecks(account, checkConfig);
  } catch (error) {
    if (error instanceof HorizonTlsError) {
      core.error(error.message);
      result = tlsFailureResult(error.message, checkConfig);
    } else if (error instanceof HorizonError && error.statusCode === 404) {
      result = unfundedAccountResult(stellarAddress, checkConfig);
    } else if (error instanceof HorizonError && error.statusCode === 0 && !error.retryable) {
      // Cancelled by job signal — exit cleanly without a misleading comment.
      core.warning(`TrustBridge run was cancelled: ${error.message}`);
      // result stays undefined; the null guard below returns cleanly.
    } else if (error instanceof HorizonError) {
      core.error(error.message);
      result = horizonFailureResult(error.message, checkConfig);
    } else {
      const message = getErrorMessage(error);
      core.error(message);
      result = horizonFailureResult(message, checkConfig);
    }
  } finally {
    // Ensure the controller is not leaked if the function returns early.
    jobController.abort();
  }

  // result is undefined only when the run was cancelled and we returned early above.
  if (result == null) {
    return;
  }

  setValidationOutputs(result);

  const commentBody = formatCommentBody(result, {
    ...checkConfig,
    stellarAddress,
    horizonUrl: effectiveHorizonUrl,
    failOnMissing: effectiveFailOnMissing,
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

  if (effectiveFailOnMissing) {
    core.setFailed(failureMessage);
  } else {
    core.warning(failureMessage);
  }
}

run().catch((error) => {
  core.setFailed(getErrorMessage(error));
});
