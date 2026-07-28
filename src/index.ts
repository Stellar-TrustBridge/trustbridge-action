import * as core from '@actions/core';
import {
  CheckConfig,
  detectNetworkMismatch,
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
import { getErrorMessage, parseBooleanInput, parseNumberInput, resolveInput } from './inputs';
import { formatFailureSummary } from './summary';
import { setValidationOutputs } from './outputs';
import { logger, emitInputsLogRecord } from './logger';
import { globalMetrics } from './metrics';
import { validateContractAddress, clearSpans, getSpans } from './validation';
import { runIssuesPreflight, PreflightError } from './preflight';

async function run(): Promise<void> {
  // #147 — helper to resolve each input with TRUSTBRIDGE_* env fallback
  const getInput = (name: string, opts?: Parameters<typeof core.getInput>[1]) =>
    resolveInput(name, core.getInput(name, opts));

  const horizonUrl = getInput('horizon_url') || 'https://horizon.stellar.org';
  const assetCode = getInput('asset_code') || 'USDC';
  const assetIssuer =
    getInput('asset_issuer') ||
    'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  const minXlmReserveRaw = getInput('min_xlm_reserve') || '1.5';
  const stellarAddress = getInput('stellar_address_input').trim();
  const failOnMissing = parseBooleanInput(getInput('fail_on_missing'), true);
  const debugMode = parseBooleanInput(getInput('debug_mode'), false);
  const horizonTimeoutMs = parseNumberInput(getInput('horizon_timeout_ms'), 15000, {
    min: 1000,
    max: 60000,
  });
  const stickyComment = parseBooleanInput(getInput('sticky_comment'), true);
  const waitUntilFunded = parseBooleanInput(getInput('wait_until_funded'), false);
  const waitUntilFundedTimeoutMs = parseNumberInput(
    getInput('wait_until_funded_timeout_ms'),
    120000,
    { min: 0, max: 600000 },
  );
  const waitUntilFundedIntervalMs = parseNumberInput(
    getInput('wait_until_funded_interval_ms'),
    5000,
    { min: 1000, max: 60000 },
  );
  const horizonUrlFallback = getInput('horizon_url_fallback') || '';
  const rpcFallbackUrlRaw = getInput('rpc_fallback_url') || '';
  const fallbackUrls = rpcFallbackUrlRaw
    ? rpcFallbackUrlRaw.split(',').map((u) => u.trim()).filter(Boolean)
    : horizonUrlFallback
      ? [horizonUrlFallback]
      : [];
  const horizonCacheTtlMs = parseNumberInput(getInput('horizon_cache_ttl_ms'), 60000, {
    min: 0,
    max: 3_600_000,
  });
  const useCache = parseBooleanInput(getInput('use_cache'), false);
  const logInputs = parseBooleanInput(getInput('log_inputs'), false);
  const trustbridgeConfigPath = getInput('trustbridge_config_path') || '.trustbridge.yml';
  const githubToken = core.getInput('github_token', { required: true });

  // SEP-0007 wallet deep links (Issue #44)
  const sep0007DeepLinks = parseBooleanInput(getInput('sep0007_deep_links'), false);
  const sep0007OriginDomain = getInput('sep0007_origin_domain') || '';

  // #145 — issues:write preflight
  const preflightOnly = parseBooleanInput(getInput('preflight_only'), false);

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

  validateStellarAddress(stellarAddress);
  const minXlmReserve = parseMinXlmReserve(minXlmReserveRaw);

  // ── #145: issues:write preflight ──────────────────────────────────────────
  // Run before any Horizon call so consumers get a clear error when the token
  // lacks comment-posting permission, rather than a confusing 403 after all
  // the heavy lifting is done.
  let preflightSkipComment = false;
  try {
    const preflight = await runIssuesPreflight(githubToken);
    preflightSkipComment = preflight.skip;
    if (preflight.skip) {
      core.info(`[TrustBridge] ${preflight.message}`);
    } else {
      logger.debug('issues:write preflight passed', {
        component: 'preflight',
        issueNumber: preflight.issueNumber,
      });
    }
  } catch (preflightError) {
    if (preflightError instanceof PreflightError) {
      // Hard fail: token demonstrably cannot post comments
      core.setFailed(preflightError.message);
      return;
    }
    // Unexpected error — warn and continue (don't block Horizon work)
    core.warning(`issues:write preflight encountered an unexpected error: ${getErrorMessage(preflightError)}`);
  }

  if (preflightOnly) {
    core.info('[TrustBridge] preflight_only=true — exiting after preflight without running Horizon checks.');
    return;
  }
  // ─────────────────────────────────────────────────────────────────────────

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

  core.info(`Checking Stellar account ${stellarAddress} via ${horizonUrl}`);

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
    if (error instanceof HorizonError && error.statusCode === 404) {
      // #144: attempt cross-network detection before building the result so
      // the comment surfaces a clear mismatch error when the address is active
      // on the opposite network. Fire-and-forget with a short timeout so a
      // slow alt-network Horizon never blocks the primary run.
      const mismatchHint = await detectNetworkMismatch(horizonUrl, stellarAddress).catch(
        () => undefined,
      );
      if (mismatchHint) {
        core.warning(
          `Cross-network mismatch detected: address is active on ${mismatchHint.activeOnNetwork} ` +
          `but horizon_url points at ${mismatchHint.configuredNetwork}.`,
        );
      }
      result = unfundedAccountResult(stellarAddress, checkConfig, mismatchHint);
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
