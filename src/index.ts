import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import {
  CheckConfig,
  HomeDomainCheckMode,
  horizonFailureResult,
  parseMinXlmReserve,
  runAccountChecks,
  runMultiAssetChecks,
  unfundedAccountResult,
  validateStellarAddress,
  rateBudgetExhaustedResult,
} from './checks';
import {
  callFriendbot,
  fetchAccount,
  fetchHomeDomainIssuerAccount,
  getAssetBalance,
  HorizonError,
  isTestnetHorizon,
  waitForFundedAccount,
} from './horizon';
import { formatCommentBody, resolvePostingMode, upsertIssueComment } from './comment';
import { normalizeAssetConfig, parseAssetsJson, dedupeAssets } from './assets';
import { getErrorMessage, parseBooleanInput, parseNumberInput } from './inputs';
import { formatFailureSummary } from './summary';
import { setValidationOutputs, AssetTrustlineStatus } from './outputs';
import { logger, emitInputsLogRecord } from './logger';
import { buildSarifDocument, sarifOutcomeFromResult, serialiseSarif } from './sarif';
import { globalMetrics, writeJobSummary, globalHorizonHistogram } from './metrics';
import { validateContractAddress, clearSpans, getSpans } from './validation';
import { readTrustbridgeConfig } from './configReader';
import { RateBudgetTracker, RateBudgetExhaustedError } from './resilience';
import { runStellarTomlCheck, DEFAULT_STELLAR_TOML_CACHE_TTL_MS, MAX_STELLAR_TOML_CACHE_TTL_MS } from './toml';

export async function run(): Promise<void> {
  const jobController = new AbortController();
  try {
    process.on('SIGINT', () => jobController.abort());
    process.on('SIGTERM', () => jobController.abort());
  } catch {
    // Runner without signal handlers (e.g. non-Node test harness) — continue without them.
  }

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
  const postingMode = resolvePostingMode(
    core.getInput('posting_mode'),
    core.getInput('comment_mode'),
  );
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
  const allowCrossNetworkFallback = parseBooleanInput(core.getInput('allow_cross_network_fallback'), false);
  const fallbackUrls = rpcFallbackUrlRaw
    ? rpcFallbackUrlRaw.split(',').map((u) => u.trim()).filter(Boolean)
    : horizonUrlFallback
      ? [horizonUrlFallback]
      : [];
  const horizonCacheTtlMs = parseNumberInput(core.getInput('horizon_cache_ttl_ms'), 60000, {
    min: 0,
    max: 3_600_000,
  });
  const horizonMaxRequests = parseNumberInput(core.getInput('horizon_max_requests'), 0, {
    min: 0,
  });
  // Retry / Retry-After caps (Issue #705). Every sleep is min(Retry-After or
  // backoff, retry_max_delay_ms); the cumulative sleep per endpoint is bounded
  // by retry_max_total_wait_ms. See docs/ERROR_HANDLING.md.
  const maxRetries = parseNumberInput(core.getInput('max_retries'), 3, { min: 0, max: 10 });
  const retryBaseDelayMs = parseNumberInput(core.getInput('retry_base_delay_ms'), 1000, {
    min: 0,
    max: 60000,
  });
  const retryMaxDelayMs = parseNumberInput(core.getInput('retry_max_delay_ms'), 30000, {
    min: 0,
    max: 300000,
  });
  const retryMaxTotalWaitMs = parseNumberInput(core.getInput('retry_max_total_wait_ms'), 120000, {
    min: 0,
    max: 600000,
  });

  // SEP-0001 optional stellar.toml fetch (Issue #709).
  const stellarTomlFetchEnabled = parseBooleanInput(core.getInput('stellar_toml_fetch_enabled'), false);
  const stellarTomlCacheTtlMs = parseNumberInput(
    core.getInput('stellar_toml_cache_ttl_ms'),
    DEFAULT_STELLAR_TOML_CACHE_TTL_MS,
    { min: 0, max: MAX_STELLAR_TOML_CACHE_TTL_MS },
  );
  const stellarTomlHashPin = (core.getInput('stellar_toml_hash_pin') || '').trim();

  const useCache = parseBooleanInput(core.getInput('use_cache'), false);
  const logInputs = parseBooleanInput(core.getInput('log_inputs'), false);
  const trustbridgeConfigPath = core.getInput('trustbridge_config_path') || '.trustbridge.yml';

  // Friendbot testnet onboarding (Issue #4 / #699). See docs/USAGE.md#friendbot-testnet-funding.
  const useFriendbot = parseBooleanInput(core.getInput('use_friendbot'), false);
  const friendbotUrl = core.getInput('friendbot_url') || 'https://friendbot.stellar.org';
  const friendbotTimeoutMs = parseNumberInput(core.getInput('friendbot_timeout_ms'), 15000, {
    min: 1000,
    max: 60000,
  });
  let friendbotCalled = false;
  let friendbotSuccess = false;
  let friendbotTransactionHash = '';

  // SEP-0001 home domain check (Issue #708). See docs/SEP0001_HOME_DOMAIN.md.
  const homeDomainCheckEnabled = parseBooleanInput(core.getInput('home_domain_check_enabled'), false);
  const expectedHomeDomain = (core.getInput('expected_home_domain') || '').trim() || undefined;
  const homeDomainCheckMode: HomeDomainCheckMode =
    (core.getInput('home_domain_check_mode') || '').trim().toLowerCase() === 'strict' ? 'strict' : 'warn';
  const sarifOutputPath = (core.getInput('sarif_output_path') || '').trim();

  // Create RateBudgetTracker if horizon_max_requests > 0
  const rateBudgetTracker = horizonMaxRequests > 0 ? new RateBudgetTracker(horizonMaxRequests) : undefined;
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
    maxRetries,
    retryBaseDelayMs,
    retryMaxDelayMs,
    retryMaxTotalWaitMs,
    homeDomainCheckEnabled,
    stellarTomlFetchEnabled,
    stellarTomlCacheTtlMs,
    stellarTomlHashPinSet: Boolean(stellarTomlHashPin),
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
      horizonMaxRequests,
      retryMaxDelayMs,
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
    minXlmReserve: Number(minXlmReserve),
    horizonUrl,
    homeDomainCheckEnabled,
    expectedHomeDomain: expectedHomeDomain || undefined,
    homeDomainCheckMode,
    stellarTomlFetchEnabled,
    stellarTomlCacheTtlMs,
    stellarTomlHashPin: stellarTomlHashPin || undefined,
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
    allowCrossNetworkFallback,
    cacheTtlMs: useCache ? horizonCacheTtlMs : 0,
    useCache,
    rateBudgetTracker,
    maxRetries,
    retryBaseDelayMs,
    retryMaxDelayMs,
    retryMaxTotalWaitMs,
    signal: jobController.signal,
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
      : await fetchAccount(horizonUrl, stellarAddress, horizonOptions);
    // The home domain lives on the issuer account, not the contributor's.
    const issuerAccount = homeDomainCheckEnabled
      ? await fetchHomeDomainIssuerAccount(horizonUrl, normalizedAsset.assetIssuer, horizonOptions)
      : undefined;
    result = runAccountChecks(account, checkConfig, issuerAccount);

    // Issue #709 — optional stellar.toml fetch layered on top of the on-chain
    // home_domain check. When stellar_toml_fetch_enabled is false the
    // SSRF-guarded HTTP client is never called.
    if (homeDomainCheckEnabled && stellarTomlFetchEnabled) {
      const tomlDomain = expectedHomeDomain || result.homeDomainCheck?.actualHomeDomain;
      const tomlOutcome = await runStellarTomlCheck(tomlDomain, {
        enabled: stellarTomlFetchEnabled,
        cacheTtlMs: stellarTomlCacheTtlMs,
        hashPin: stellarTomlHashPin || undefined,
      });
      if (tomlOutcome.status !== 'skipped') {
        // A pinned hash always fails closed; otherwise fetch errors only block
        // in strict home_domain_check_mode.
        const blocks =
          tomlOutcome.status === 'failed' && (Boolean(stellarTomlHashPin) || homeDomainCheckMode === 'strict');
        result.checks.push({
          passed: !blocks,
          label: 'SEP-0001 stellar.toml',
          detail: tomlOutcome.detail,
        });
        result.valid = result.checks.every((c) => c.passed);
        if (!result.valid && result.reasonCode === 'SUCCESS') {
          result.reasonCode = 'FAILED';
        }
      }
    }

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
    if (error instanceof RateBudgetExhaustedError) {
      globalMetrics.incrementCounter('rate_budget_exhausted');
      result = rateBudgetExhaustedResult(error.message, checkConfig);
    } else if (
      jobController.signal.aborted ||
      (error instanceof HorizonError && error.statusCode === 499) ||
      (error instanceof Error && error.name === 'AbortError') ||
      (error instanceof Error && error.message.toLowerCase().includes('aborted')) ||
      (error instanceof Error && error.message.toLowerCase().includes('cancelled'))
    ) {
      logger.info('Funding poll stopped due to cancellation');
      core.info('Funding poll stopped due to cancellation');
      result = horizonFailureResult('Funding poll cancelled', checkConfig);
    } else if (error instanceof HorizonError && error.statusCode === 404) {
      result = unfundedAccountResult(stellarAddress, checkConfig);
      if (useFriendbot && !isTestnetHorizon(horizonUrl)) {
        // Pubnet guard: never request Friendbot funding against a public
        // network Horizon, so friendbot_called stays false.
        core.warning('use_friendbot is enabled but horizon_url is not a test network — Friendbot was not called.');
      } else if (useFriendbot && !friendbotCalled) {
        // Guarded so a single run never issues more than one funding request.
        friendbotCalled = true;
        logger.info('Account 404 encountered and use_friendbot enabled — calling Friendbot', {
          component: 'index',
          stellarAddress,
          friendbotUrl,
        });
        const fbResult = await callFriendbot(
          stellarAddress,
          { friendbotUrl, timeoutMs: friendbotTimeoutMs },
          horizonUrl,
        );
        friendbotSuccess = fbResult.success;
        friendbotTransactionHash = fbResult.transactionHash ?? '';
        if (fbResult.success) {
          logger.info('Friendbot funding succeeded — re-fetching account', {
            component: 'index',
            transactionHash: friendbotTransactionHash,
          });
          try {
            const fundedAccount = await fetchAccount(horizonUrl, stellarAddress, horizonOptions);
            const issuerAccount = homeDomainCheckEnabled
              ? await fetchHomeDomainIssuerAccount(horizonUrl, normalizedAsset.assetIssuer, horizonOptions)
              : undefined;
            result = runAccountChecks(fundedAccount, checkConfig, issuerAccount);
          } catch (refetchErr) {
            logger.warn('Failed to re-fetch account after Friendbot funding', {
              component: 'index',
              error: getErrorMessage(refetchErr),
            });
          }
        } else {
          logger.warn(`Friendbot funding failed: ${fbResult.message}`, { component: 'index' });
        }
      }
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
    friendbotCalled,
    friendbotSuccess,
    friendbotTransactionHash,
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

  // Issue #696 — comment_id is only published from a successful
  // createComment/updateComment response. dry-run, off, a missing issue
  // context, or a failed post all leave it (and comment_url) empty.
  let commentUrl: string | undefined;
  let commentId: string | undefined;
  if (postingMode === 'post') {
    try {
      const posted = await upsertIssueComment(githubToken, commentBody, { sticky: stickyComment });
      if (posted) {
        commentUrl = posted.url;
        commentId = posted.id !== undefined ? String(posted.id) : undefined;
        logger.info('Issue comment created', { component: 'index', commentUrl, commentId });
      }
    } catch (commentError) {
      const message = getErrorMessage(commentError);
      core.warning(`Failed to post issue comment: ${message}`);
    }
  } else {
    core.info(`posting_mode is "${postingMode}" — skipping issue comment.`);
  }

  setValidationOutputs(result, commentUrl, undefined, {
    horizonUrl,
    assetCode: normalizedAsset.assetCode,
    assetIssuer: normalizedAsset.assetIssuer,
    assetsTrustlineStatus: assetsTrustlineStatusExtras,
    friendbotCalled,
    friendbotSuccess,
    friendbotTransactionHash,
  });

  // SARIF 2.1.0 output (Issue #197). Includes rule TB004 for the home domain
  // check when home_domain_check_enabled is true (Issue #708).
  if (sarifOutputPath) {
    writeSarifOutput(sarifOutputPath, result, {
      horizonUrl,
      stellarAddress,
      assetCode: normalizedAsset.assetCode,
      homeDomainCheckMode,
    });
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

  await writeJobSummary(globalMetrics.buildJobSummary(globalHorizonHistogram));

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

function writeSarifOutput(
  sarifOutputPath: string,
  result: Parameters<typeof sarifOutcomeFromResult>[0],
  context: Parameters<typeof sarifOutcomeFromResult>[1],
): void {
  const workspaceRoot = path.normalize(process.env.GITHUB_WORKSPACE || process.cwd());
  const resolved = path.normalize(
    path.isAbsolute(sarifOutputPath) ? sarifOutputPath : path.join(workspaceRoot, sarifOutputPath),
  );
  // Path traversal guard: SARIF is only ever written inside the workspace.
  if (!resolved.startsWith(workspaceRoot + path.sep)) {
    core.warning('sarif_output_path resolves outside GITHUB_WORKSPACE — SARIF output skipped.');
    return;
  }
  try {
    const sarifJson = serialiseSarif(buildSarifDocument(sarifOutcomeFromResult(result, context)));
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, sarifJson, 'utf8');
    core.info(`Wrote SARIF 2.1.0 output to ${resolved}`);
  } catch (sarifError) {
    core.warning(`Failed to write SARIF output (non-fatal): ${getErrorMessage(sarifError)}`);
  }
}

run().catch((error) => {
  core.setFailed(getErrorMessage(error));
});
