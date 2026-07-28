import * as core from '@actions/core';
import {
  CheckConfig,
  horizonFailureResult,
  parseMinXlmReserve,
  runAccountChecks,
  unfundedAccountResult,
  validateStellarAddress,
  buildValidationGate,
  ValidationResult,
} from './checks';
import { fetchAccount, HorizonError, waitForFundedAccount } from './horizon';
import { formatCommentBody, postIssueComment } from './comment';
import { normalizeAssetConfig } from './assets';
import { getErrorMessage, parseBooleanInput, parseNumberInput } from './inputs';
import { formatFailureSummary } from './summary';
import { setValidationOutputs } from './outputs';
import { logger, emitInputsLogRecord, redactHorizonUrl } from './logger';
import { globalMetrics } from './metrics';
import { validateContractAddress, clearSpans, getSpans } from './validation';

// ---------------------------------------------------------------------------
// Wave #38: Dashboard webhook payload (dist e2e harness)
// ---------------------------------------------------------------------------

interface DashboardWebhookPayload {
  /** Validation result summary (gate, checks, balances). */
  validation: {
    ready: boolean;
    accountFunded: boolean;
    trustlineExists: boolean;
    xlmBalance: string;
    xlmReserveMet: boolean;
    failedChecks: number;
    passedChecks: number;
    totalChecks: number;
    failedLabels: string[];
  };
  /** Asset and reserve configuration. */
  config: {
    assetCode: string;
    assetIssuer: string;
    minXlmReserve: number;
  };
  /** Redacted Stellar address (first4…last4). */
  stellarAddressRedacted: string;
  /** Comment mode for this run. */
  commentMode: string;
  /** Comment URL if posted, undefined if dry-run/off. */
  commentUrl?: string;
  /** ISO 8601 timestamp of the validation run. */
  timestamp: string;
}

function redactStellarAddress(address: string): string {
  if (address.length === 56 && (address.startsWith('G') || address.startsWith('C'))) {
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
  }
  return address;
}

async function postDashboardWebhook(
  webhookUrl: string,
  context: {
    result: ValidationResult;
    config: CheckConfig;
    stellarAddress: string;
    commentMode: string;
    commentUrl?: string;
  },
): Promise<void> {
  const gate = buildValidationGate(context.result);

  const payload: DashboardWebhookPayload = {
    validation: {
      ready: gate.ready,
      accountFunded: context.result.accountFunded,
      trustlineExists: context.result.trustlineExists,
      xlmBalance: context.result.xlmBalance,
      xlmReserveMet: context.result.xlmReserveMet,
      failedChecks: gate.failedChecks,
      passedChecks: gate.passedChecks,
      totalChecks: gate.totalChecks,
      failedLabels: gate.failedLabels,
    },
    config: {
      assetCode: context.config.assetCode,
      assetIssuer: context.config.assetIssuer,
      minXlmReserve: context.config.minXlmReserve,
    },
    stellarAddressRedacted: redactStellarAddress(context.stellarAddress),
    commentMode: context.commentMode,
    commentUrl: context.commentUrl,
    timestamp: new Date().toISOString(),
  };

  const fetch = (await import('node-fetch')).default;
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'TrustBridge-Action/1.0',
    },
    body: JSON.stringify(payload),
    timeout: 10000,
  });

  if (!response.ok) {
    throw new Error(
      `Dashboard webhook returned ${response.status}: ${response.statusText}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main run function
// ---------------------------------------------------------------------------

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

  // Wave #30: comment_mode (dry-run support)
  const commentMode = (core.getInput('comment_mode') || 'post').trim().toLowerCase();
  if (!['post', 'dry-run', 'off'].includes(commentMode)) {
    throw new Error(
      `comment_mode must be one of: "post", "dry-run", "off". Received: "${commentMode}"`,
    );
  }

  // Wave #38: dashboard webhook URL
  const dashboardWebhookUrl = core.getInput('dashboard_webhook_url') || '';

  // Clear validation spans from any prior run in the same process (safety).
  clearSpans();

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
    commentMode,
    hasDashboardWebhook: Boolean(dashboardWebhookUrl),
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
  });

  let commentUrl: string | undefined;

  // Wave #30: skip comment posting in dry-run and off modes
  const shouldPostComment = commentMode === 'post';

  if (shouldPostComment) {
    try {
      commentUrl = await postIssueComment(githubToken, commentBody, { sticky: stickyComment });
      if (commentUrl) {
        logger.info('Issue comment created', { component: 'index', commentUrl });
      }
    } catch (commentError) {
      const message = getErrorMessage(commentError);
      core.warning(`Failed to post issue comment: ${message}`);
    }
  } else {
    logger.info(`Comment posting skipped (comment_mode=${commentMode})`, {
      component: 'index',
      commentMode,
    });
  }

  setValidationOutputs(result, commentUrl);

  // Wave #38: POST validation summary to dashboard webhook (if configured)
  if (dashboardWebhookUrl) {
    try {
      await postDashboardWebhook(dashboardWebhookUrl, {
        result,
        config: checkConfig,
        stellarAddress,
        commentMode,
        commentUrl,
      });
      logger.info('Dashboard webhook delivered', {
        component: 'index',
        webhookUrl: redactHorizonUrl(dashboardWebhookUrl),
      });
    } catch (webhookError) {
      const message = getErrorMessage(webhookError);
      core.warning(`Failed to POST dashboard webhook: ${message}`);
    }
  }

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
