import * as core from '@actions/core';
import {
  CheckConfig,
  horizonFailureResult,
  parseMinXlmReserve,
  runAccountChecks,
  runMultiAssetChecks,
  AssetTrustlineResult,
  unfundedAccountResult,
  validateStellarAddress,
} from './checks';
import { fetchAccount, HorizonError, HorizonTlsError, waitForFundedAccount } from './horizon';
import { formatCommentBody, postIssueComment } from './comment';
import { normalizeAssetConfig, parseAssetsJson, dedupeAssets } from './assets';
import { getErrorMessage, parseBooleanInput, parseNumberInput } from './inputs';
import { formatFailureSummary } from './summary';
import { setValidationOutputs } from './outputs';
import { logger, emitInputsLogRecord } from './logger';
import { globalMetrics } from './metrics';
import { validateContractAddress, clearSpans, getSpans } from './validation';
import { lookupAddressFromContract, ContractLookupError } from './soroban';

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
  void core.getInput('trustbridge_config_path'); // reserved for future config-file integration
  const githubToken = core.getInput('github_token', { required: true });

  // SEP-0007 wallet deep links (Issue #44)
  const sep0007DeepLinks = parseBooleanInput(core.getInput('sep0007_deep_links'), false);
  const sep0007OriginDomain = core.getInput('sep0007_origin_domain') || '';

  // Multi-asset trustline validation (Issue #4)
  const assetsJsonRaw = core.getInput('assets_json') || '';

  // Soroban contract registry (Issue #7)
  const sorobanRpcUrl = core.getInput('soroban_rpc_url') || '';
  const contractId = core.getInput('contract_id') || '';
  const githubUsername = core.getInput('github_username') || '';

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

  // Soroban contract registry lookup — resolve GitHub username → G-address
  // before running Horizon checks. Falls back to stellar_address_input on
  // any error so existing non-contract workflows are unaffected.
  let resolvedAddress = stellarAddress;
  if (sorobanRpcUrl && contractId && githubUsername) {
    try {
      const lookupResult = await lookupAddressFromContract(githubUsername, {
        sorobanRpcUrl,
        contractId,
        timeoutMs: horizonTimeoutMs,
      });
      if (lookupResult.fromRegistry && lookupResult.address) {
        core.info(
          `[TrustBridge] Registry resolved @${githubUsername} → ${lookupResult.address}`,
        );
        resolvedAddress = lookupResult.address;
      } else {
        core.info(
          `[TrustBridge] @${githubUsername} not found in registry — using stellar_address_input`,
        );
      }
    } catch (err) {
      const msg = getErrorMessage(err);
      const retryable = err instanceof ContractLookupError && err.retryable;
      core.warning(
        `[TrustBridge] Contract registry lookup failed (${retryable ? 'retryable' : 'non-retryable'}): ${msg}. Falling back to stellar_address_input.`,
      );
    }
  }

  validateStellarAddress(resolvedAddress);
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

  core.info(`Checking Stellar account ${resolvedAddress} via ${horizonUrl}`);

  if (waitUntilFunded) {
    core.info(
      `wait_until_funded is enabled — polling every ${waitUntilFundedIntervalMs}ms for up to ${waitUntilFundedTimeoutMs}ms.`,
    );
  }

  let result;

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
          resolvedAddress,
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
      : await fetchAccount(horizonUrl, resolvedAddress, horizonOptions);
    result = runAccountChecks(account, checkConfig);
  } catch (error) {
    if (error instanceof HorizonError && error.statusCode === 404) {
      result = unfundedAccountResult(resolvedAddress, checkConfig);
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

  // Multi-asset checks (Issue #4)
  let multiAssetResults: AssetTrustlineResult[] | undefined;
  if (assetsJsonRaw.trim()) {
    const parsedAssets = dedupeAssets(parseAssetsJson(assetsJsonRaw));
    if (result.accountFunded) {
      // We need the account object — re-use the result path by fetching again
      // only if we have a funded account. Since we already have the account
      // data embedded in the result path, we run checks against the same
      // account by fetching once more (cached if use_cache is on).
      try {
        const accountForMulti = await fetchAccount(horizonUrl, resolvedAddress, horizonOptions);
        ({ results: multiAssetResults } = runMultiAssetChecks(accountForMulti, parsedAssets));
      } catch {
        // If re-fetch fails, fall back to running checks with what we know
        multiAssetResults = parsedAssets.map((a) => ({
          assetCode: a.assetCode,
          assetIssuer: a.assetIssuer,
          trustlineExists: false,
        }));
      }
    } else {
      multiAssetResults = parsedAssets.map((a) => ({
        assetCode: a.assetCode,
        assetIssuer: a.assetIssuer,
        trustlineExists: false,
      }));
    }
  }

  const commentBody = formatCommentBody(result, {
    ...checkConfig,
    stellarAddress: resolvedAddress,
    horizonUrl,
    failOnMissing,
    stickyComment,
    waitUntilFunded,
    waitUntilFundedTimeoutMs,
    waitUntilFundedIntervalMs,
    sep0007DeepLinks,
    sep0007OriginDomain,
    multiAssetResults,
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

  setValidationOutputs(result, commentUrl, multiAssetResults);

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
