import * as core from '@actions/core';
import * as github from '@actions/github';
import * as fs from 'fs';
import * as path from 'path';
import {
  CheckConfig,
  detectNetworkMismatch,
  horizonFailureResult,
  parseMinAssetBalance,
  parseMinXlmReserve,
  runAccountChecks,
  unfundedAccountResult,
  validateStellarAddress,
  HomeDomainCheckMode,
  LedgerFreshnessCheckResult,
  ValidationResult,
} from './checks';
import { fetchAccount, HorizonError, waitForFundedAccount, applyWalletLabels } from './horizon';
import type { HorizonAccount, HorizonBalance } from './horizon';
import { checkLedgerFreshness } from './freshness';
import {
  formatCommentBody,
  postIssueComment,
  postDiscussionComment,
  resolveDiscussionNodeId,
  COMMENT_SIZE_LIMIT_BYTES,
  buildTruncatedCommentBody,
  writeFullReport,
} from './comment';
import {
  normalizeAssetConfig,
  parseAssetsJson,
  getCampaignPreset,
  validateNetworkAssetCompatibility,
} from './assets';
import {
  getErrorMessage,
  parseAssigneeAddressMap,
  parseBooleanInput,
  parseNumberInput,
  parsePresetInput,
  resolveAddressFromAssigneeMap,
  resolveGitHubAuthToken,
  resolveInput,
} from './inputs';
import { formatFailureSummary } from './summary';
import { setValidationOutputs, writeValidationJson } from './outputs';
import {
  computeValidationDelta,
  loadPreviousValidationArtifact,
  discoverPreviousValidationArtifact,
} from './delta';
import { logger, emitInputsLogRecord } from './logger';
import { globalMetrics, writeJobSummary } from './metrics';
import { RateBudgetTracker, CircuitBreaker } from './resilience';
import { validateContractAddress, clearSpans, getSpans } from './validation';
import { parseLocaleInput } from './i18n';
import { sendWebhookNotification } from './webhook';
import { runIssuesPreflight } from './preflight';
import { lookupAddressFromContract, ContractLookupError } from './soroban';
import { registerCorePlugins } from './corePlugins';
import { defaultRegistry } from './plugin';
import { loadPluginsFromAllowlist } from './pluginLoader';
import { readTrustbridgeConfig, mergeConsumerConfig } from './configReader';
import {
  parseBatchAddresses,
  runBatchValidation,
  buildBatchSummary,
  formatBatchSummaryMarkdown,
} from './batch';
import { buildSarifOutput, validateSarifSchema, serializeSarif } from './sarif';
import { DiagnosticsConfig } from './diagnostics';

/**
 * Resolve the GitHub assignee login from the current Actions event payload.
 * Prefers `payload.assignee` (issues.assigned), then the first issue assignee.
 */
function resolveAssigneeLoginFromContext(): string | undefined {
  const payload = github.context.payload as {
    assignee?: { login?: string };
    issue?: { assignees?: Array<{ login?: string }> };
  };

  const fromEvent = payload.assignee?.login?.trim();
  if (fromEvent) {
    return fromEvent;
  }

  const assignees = payload.issue?.assignees;
  if (Array.isArray(assignees)) {
    for (const entry of assignees) {
      const login = entry?.login?.trim();
      if (login) {
        return login;
      }
    }
  }

  return undefined;
}

/**
 * Resolve the Stellar G-address to validate.
 *
 * Issue #219 — Precedence order (winner documented + logged):
 * 1. Soroban contract registry lookup (when soroban_rpc_url + contract_id are set)
 * 2. Assignee address map (when assignee_address_map is set)
 * 3. Direct stellar_address_input
 *
 * Each source is tried in order; the first non-empty result wins.
 * Conflicts are logged as warnings so maintainers know which source won.
 */
function resolveStellarAddressInput(
  stellarAddressInput: string,
  assigneeAddressMapRaw: string,
  contractAddress?: string,
): string {
  const resolvedFrom: string[] = [];

  // Source 1: Contract registry lookup
  if (contractAddress) {
    resolvedFrom.push('contract');
    logger.info('Address resolved from contract registry', {
      component: 'index',
      source: 'contract',
    });
    return contractAddress;
  }

  // Source 2: Assignee address map
  const mapRaw = assigneeAddressMapRaw.trim();
  if (mapRaw) {
    const map = parseAssigneeAddressMap(mapRaw, {
      workspaceRoot: process.env.GITHUB_WORKSPACE || process.cwd(),
    });
    const assigneeLogin = resolveAssigneeLoginFromContext();
    const address = resolveAddressFromAssigneeMap(map, assigneeLogin);
    resolvedFrom.push('assignee_map');
    logger.info('Address resolved from assignee address map', {
      component: 'index',
      source: 'assignee_map',
      assigneeLogin,
    });
    return address;
  }

  // Source 3: Direct input
  const direct = stellarAddressInput.trim();
  if (direct) {
    resolvedFrom.push('direct_input');
    logger.debug('Address resolved from direct input', {
      component: 'index',
      source: 'direct_input',
    });
    return direct;
  }

  throw new Error(
    'Provide stellar_address_input (a Stellar G-address), assignee_address_map ' +
      '(JSON / file path mapping GitHub usernames to G-addresses), or configure ' +
      'soroban_rpc_url + contract_id for on-chain registry lookup.',
  );
}

/**
 * Options for `handleAutoUnassign` (Issue #228).
 */
export interface AutoUnassignOptions {
  octokit: {
    rest: {
      issues: {
        removeAssignees: (params: {
          owner: string;
          repo: string;
          issue_number: number;
          assignees: string[];
        }) => Promise<unknown>;
      };
    };
  };
  owner: string;
  repo: string;
  issueNumber?: number;
  payload: unknown;
  result: ValidationResult;
  unassignOnNotReady: boolean;
}

/**
 * Automatically unassigns the assignee(s) from the GitHub issue when
 * readiness checks fail (ready is false) and the policy input is enabled.
 *
 * Safe guards:
 * - Default off (requires opt-in via unassign_on_not_ready: true).
 * - Only runs when ready is false (result.valid === false).
 * - Never unassigns on transient Horizon infrastructure/connectivity errors
 *   (HORIZON_ERROR, HORIZON_TIMEOUT, TLS_ERROR).
 * - Filters out bot assignees (e.g. app/bot accounts).
 * - Non-fatal: permission errors or GitHub API failures are logged as warnings.
 * - Safely skips when there is no issue context (e.g. workflow_dispatch).
 */
export async function handleAutoUnassign(
  options: AutoUnassignOptions,
): Promise<string[] | undefined> {
  if (!options.unassignOnNotReady) {
    return undefined;
  }

  if (options.result.valid) {
    logger.debug('Skipping auto-unassign: readiness checks passed (valid is true)', {
      component: 'index',
    });
    return undefined;
  }

  // Horizon outage guard: do not unassign contributors when failure is due to Horizon network/connectivity outage
  if (
    options.result.reasonCode === 'HORIZON_ERROR' ||
    options.result.reasonCode === 'HORIZON_TIMEOUT' ||
    options.result.reasonCode === 'TLS_ERROR'
  ) {
    core.info(
      'Skipping auto-unassign on not-ready: failure was caused by Horizon connectivity/outage rather than an invalid account.',
    );
    return undefined;
  }

  const payload = options.payload as {
    assignee?: { login?: string; type?: string };
    issue?: { number?: number; assignees?: Array<{ login?: string; type?: string }> };
  } | null | undefined;

  const issueNumber = options.issueNumber ?? payload?.issue?.number;
  if (!issueNumber) {
    logger.debug(
      'Skipping auto-unassign: no issue context found (e.g. workflow_dispatch without issue)',
      {
        component: 'index',
      },
    );
    return undefined;
  }

  const isBot = (login?: string, type?: string): boolean => {
    if (!login) return false;
    return type === 'Bot' || login.endsWith('[bot]');
  };

  const targetAssignees: string[] = [];

  // Case 1: Specific assignee from issues.assigned event
  const eventAssignee = payload?.assignee;
  if (eventAssignee?.login && !isBot(eventAssignee.login, eventAssignee.type)) {
    targetAssignees.push(eventAssignee.login);
  } else if (Array.isArray(payload?.issue?.assignees)) {
    // Case 2: All non-bot assignees on the issue
    for (const assignee of payload.issue.assignees) {
      if (assignee?.login && !isBot(assignee.login, assignee.type)) {
        if (!targetAssignees.includes(assignee.login)) {
          targetAssignees.push(assignee.login);
        }
      }
    }
  }

  if (targetAssignees.length === 0) {
    logger.debug('Skipping auto-unassign: no eligible human assignees found on issue', {
      component: 'index',
    });
    return undefined;
  }

  try {
    await options.octokit.rest.issues.removeAssignees({
      owner: options.owner,
      repo: options.repo,
      issue_number: issueNumber,
      assignees: targetAssignees,
    });
    core.info(
      `Auto-unassigned ${targetAssignees.join(', ')} from issue #${issueNumber} because readiness checks failed.`,
    );
    return targetAssignees;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    core.warning(
      `Failed to unassign ${targetAssignees.join(', ')} from issue #${issueNumber} (non-fatal): ${msg}`,
    );
    return undefined;
  }
}

async function run(): Promise<void> {
  // Milestone gating (Issue #230)
  const milestoneAllowlistRaw = core.getInput('milestone_allowlist') || '';
  const milestoneFailOnSkip = parseBooleanInput(core.getInput('milestone_fail_on_skip'), false);

  if (milestoneAllowlistRaw.trim()) {
    const allowedMilestones = milestoneAllowlistRaw
      .split(',')
      .map((m) => m.trim().toLowerCase())
      .filter(Boolean);
    const payload = github.context.payload;
    const isIssueContext = payload.issue !== undefined;
    const isPullRequest = payload.pull_request !== undefined;

    let currentMilestone = '';
    let currentMilestoneRaw = '';
    if (isIssueContext && payload.issue?.milestone) {
      currentMilestoneRaw = payload.issue.milestone.title || '';
    } else if (isPullRequest && payload.pull_request?.milestone) {
      currentMilestoneRaw = payload.pull_request.milestone.title || '';
    }
    currentMilestone = currentMilestoneRaw.trim().toLowerCase();

    if (allowedMilestones.length > 0) {
      let skipReason = '';
      if (!currentMilestone) {
        skipReason = `Milestone gate: No milestone found on this event, but milestone_allowlist is active.`;
      } else if (!allowedMilestones.includes(currentMilestone)) {
        skipReason = `Milestone gate: Milestone "${currentMilestoneRaw}" is not in the allowlist.`;
      }

      if (skipReason) {
        const fullMessage = `${skipReason} Skipping validation.`;
        if (milestoneFailOnSkip) {
          core.setFailed(fullMessage);
        } else {
          core.info(fullMessage);
        }

        core.setOutput('ready', 'false');
        core.setOutput('reason_code', 'MILESTONE_GATE_SKIPPED');
        core.setOutput('checks_json', '[]');

        core.summary.addHeading('Milestone Gate Skipped', 3);
        core.summary.addRaw(fullMessage);
        await core.summary.write();

        return;
      }
    }
  }

  // Campaign presets (Issue #207) — resolved first so they can provide defaults.
  const networkInput = core.getInput('network') || '';
  const presetInput = core.getInput('preset') || '';
  const presetName = parsePresetInput(networkInput, presetInput);
  const campaignPreset = presetName ? getCampaignPreset(presetName) : undefined;
  if (presetName && !campaignPreset) {
    throw new Error(
      `Unknown campaign preset "${presetName}". Valid presets: testnet, testnet-usdc, public, mainnet.`,
    );
  }

  const horizonUrl =
    core.getInput('horizon_url') || campaignPreset?.horizonUrl || 'https://horizon.stellar.org';
  const assetCode = core.getInput('asset_code') || campaignPreset?.assetCode || 'USDC';
  const assetIssuer =
    core.getInput('asset_issuer') ||
    campaignPreset?.assetIssuer ||
    'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  const minXlmReserveRaw =
    core.getInput('min_xlm_reserve') || campaignPreset?.minXlmReserve || '1.5';
  const stellarAddressInput = core.getInput('stellar_address_input');
  const assigneeAddressMapRaw = core.getInput('assignee_address_map');

  // Issue #219: Contract registry lookup (source 1 of address resolution).
  const sorobanRpcUrl = core.getInput('soroban_rpc_url') || '';
  const contractId = core.getInput('contract_id') || '';
  let contractResolvedAddress: string | undefined;
  if (sorobanRpcUrl && contractId) {
    const assigneeLogin = resolveAssigneeLoginFromContext();
    if (assigneeLogin) {
      try {
        const lookup = await lookupAddressFromContract(assigneeLogin, {
          sorobanRpcUrl,
          contractId,
        });
        if (lookup.address) {
          contractResolvedAddress = lookup.address;
        }
      } catch (err) {
        const isRetryable = err instanceof ContractLookupError && err.retryable;
        logger.warn('Contract registry lookup failed, falling back', {
          component: 'index',
          error: err instanceof Error ? err.message : String(err),
          retryable: isRetryable,
        });
      }
    }
  }

  const stellarAddress = resolveStellarAddressInput(
    stellarAddressInput,
    assigneeAddressMapRaw,
    contractResolvedAddress,
  );
  const failOnMissing = parseBooleanInput(core.getInput('fail_on_missing'), true);
  const issueNumberInputRaw = core.getInput('issue_number') || '';
  const issueNumberInput = issueNumberInputRaw.trim()
    ? parseNumberInput(issueNumberInputRaw, 0, { min: 1 })
    : undefined;
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
  const allowCrossNetworkFallback = parseBooleanInput(
    core.getInput('allow_cross_network_fallback'),
    false,
  );
  const logInputs = parseBooleanInput(core.getInput('log_inputs'), false);
  const trustbridgeConfigPath = core.getInput('trustbridge_config_path') || '.trustbridge.yml';
  const githubAppToken = resolveInput('github_app_token', core.getInput('github_app_token'));
  const rawGithubToken = core.getInput('github_token');
  const githubToken = resolveGitHubAuthToken({
    githubToken: rawGithubToken,
    githubAppToken,
  });
  if (githubAppToken) core.setSecret(githubAppToken);
  if (rawGithubToken) core.setSecret(rawGithubToken);
  const autoWalletLabels = parseBooleanInput(core.getInput('auto_wallet_labels'), false);
  const unassignOnNotReady = parseBooleanInput(
    resolveInput('unassign_on_not_ready', core.getInput('unassign_on_not_ready')),
    false,
  );

  // SEP-0007 wallet deep links (Issue #44)
  const sep0007DeepLinks = parseBooleanInput(core.getInput('sep0007_deep_links'), false);
  const sep0007OriginDomain = core.getInput('sep0007_origin_domain') || '';

  // #145 — issues:write preflight
  const preflightOnly = parseBooleanInput(core.getInput('preflight_only'), false);

  // Multi-asset trustline validation (Issue #4)
  const assetsJsonRaw = core.getInput('assets_json') || '';

  // Soroban contract registry (Issue #7)
  const githubUsername = core.getInput('github_username') || '';

  // Plugin runner flag (Issue #198) — default off
  const usePluginRunner = parseBooleanInput(core.getInput('use_plugin_runner'), false);

  // Onboarding checklist in comments (Issue #154) — default on
  const onboardingChecklist = parseBooleanInput(core.getInput('onboarding_checklist'), true);

  // Security artifacts / delta vs previous run (Issue #148)
  const writeValidationJsonEnabled = parseBooleanInput(
    core.getInput('write_validation_json'),
    false,
  );
  const validationJsonPath = core.getInput('validation_json_path') || 'validation.json';
  const previousValidationPath = core.getInput('previous_validation_path') || '';
  const privacyMode = parseBooleanInput(core.getInput('privacy_mode'), false);

  // External plugins from workspace (allowlisted only)
  const trustbridgePluginsPathRaw = core.getInput('trustbridge_plugins_path') || '';
  const allowedPluginPaths = trustbridgePluginsPathRaw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  // Internationalization (Issue #59)
  const localeInput = core.getInput('locale') || 'en';
  const locale = parseLocaleInput(localeInput);

  // Batch validation (Issue #199)
  const stellarAddressesRaw = core.getInput('stellar_addresses') || '';

  // Full-report artifact path (used when comment exceeds size limit)
  const reportOutputPath = core.getInput('report_output_path') || 'trustbridge-report.md';

  // Failure snooze window (Issue #155)
  const snoozeWindowMinutes = parseNumberInput(core.getInput('snooze_window_minutes'), 30, {
    min: 0,
    max: 10080, // 7 days
  });
  const forceComment = parseBooleanInput(core.getInput('force_comment'), false);
  const snoozeWindowMs = snoozeWindowMinutes * 60 * 1000;

  // Wave #30 — comment posting mode: post | dry-run | off
  const VALID_COMMENT_MODES = new Set(['post', 'dry-run', 'off']);
  const commentModeRaw = (core.getInput('comment_mode') || 'post').trim().toLowerCase();
  if (!VALID_COMMENT_MODES.has(commentModeRaw)) {
    throw new Error(
      `Invalid comment_mode "${commentModeRaw}". Expected one of: post, dry-run, off.`,
    );
  }
  const commentMode = commentModeRaw as 'post' | 'dry-run' | 'off';
  const shouldPostComment = commentMode === 'post';

  // Signed dashboard webhook (Issue #101)
  // dashboard_webhook_url is a Wave #38 / dry-run harness alias for webhook_url.
  const webhookUrl =
    core.getInput('webhook_url') || core.getInput('dashboard_webhook_url') || '';
  const webhookSecret = core.getInput('webhook_secret') || '';
  const webhookTimeoutMs = parseNumberInput(core.getInput('webhook_timeout_ms'), 5000, {
    min: 100,
    max: 30000,
  });
  const webhookAuthModeRaw = (core.getInput('webhook_auth_mode') || 'hmac').trim().toLowerCase();
  const webhookAuthMode: 'hmac' | 'oidc' = webhookAuthModeRaw === 'oidc' ? 'oidc' : 'hmac';
  const webhookOidcAudience = core.getInput('webhook_oidc_audience') || 'trustbridge-dashboard';

  // GitHub Projects v2 integration (Issue #222)
  const projectId = core.getInput('project_id') || '';
  const projectStatusField = core.getInput('project_status_field') || 'Status';
  const projectStatusPass = core.getInput('project_status_pass') || '';
  const projectStatusFail = core.getInput('project_status_fail') || '';
  const projectToken = core.getInput('project_token') || githubToken;

  // Clear validation spans from any prior run in the same process (safety).
  clearSpans();

  globalMetrics.stopTimer('input_parse');

  // Register core plugins and load external plugins from allowlist
  registerCorePlugins();

  if (allowedPluginPaths.length > 0) {
    try {
      const externalPlugins = await loadPluginsFromAllowlist({
        workspaceRoot: process.env.GITHUB_WORKSPACE || process.cwd(),
        allowedPluginPaths,
        debugMode,
      });

      for (const plugin of externalPlugins) {
        defaultRegistry.register(plugin);
      }

      if (externalPlugins.length > 0) {
        core.info(`Loaded ${externalPlugins.length} external plugin(s)`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      core.warning(`Failed to load external plugins (proceeding with core plugins only): ${message}`);
    }
  }

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


  // ---------------------------------------------------------------------------
  // Config-file overlay (Issue #196)
  // Read the consumer .trustbridge.yml and merge values into action inputs.
  // Explicit non-empty action inputs always win over config-file values.
  // ---------------------------------------------------------------------------
  const configResult = readTrustbridgeConfig(
    trustbridgeConfigPath,
    process.env.GITHUB_WORKSPACE || process.cwd(),
  );

  if (!configResult.validation.valid) {
    const errMsg = configResult.validation.errors.join('; ');
    core.setFailed(`Trustbridge config file error: ${errMsg}`);
    return;
  }

  if (configResult.found) {
    core.info(`Loaded trustbridge config from ${configResult.resolvedPath}`);
    if (debugMode && configResult.redactedSnapshot) {
      logger.debug('Trustbridge config snapshot (redacted)', {
        component: 'index',
        config: configResult.redactedSnapshot,
      });
    }
  }

  // Build set of inputs that were explicitly provided by the workflow author
  const explicitInputs = new Set<string>();
  const checkInput = (name: string, raw: string) => {
    if (raw.trim()) explicitInputs.add(name);
  };
  checkInput('horizonUrl', horizonUrl);
  checkInput('horizonUrlFallback', horizonUrlFallback);
  checkInput('rpcFallbackUrl', rpcFallbackUrlRaw);
  checkInput('assetCode', assetCode);
  checkInput('assetIssuer', assetIssuer);
  checkInput('minXlmReserveRaw', minXlmReserveRaw);
  checkInput('failOnMissing', core.getInput('fail_on_missing'));

  // Merge config file values under action inputs
  const merged = mergeConsumerConfig(
    {
      horizonUrl,
      horizonUrlFallback,
      rpcFallbackUrl: rpcFallbackUrlRaw,
      assetCode,
      assetIssuer,
      minXlmReserveRaw,
      failOnMissing,
    },
    configResult.config,
    explicitInputs,
  );

  // Effective values (config-file overlays applied; explicit inputs win)
  const effectiveHorizonUrl = merged.horizonUrl as string;
  const effectiveHorizonUrlFallback = merged.horizonUrlFallback as string;
  const effectiveAssetCode = merged.assetCode as string;
  const effectiveAssetIssuer = merged.assetIssuer as string;
  const effectiveMinXlmReserveRaw = merged.minXlmReserveRaw as string;
  const effectiveRpcFallbackUrl = merged.rpcFallbackUrl as string;
  const effectiveFailOnMissing = merged.failOnMissing as boolean;
  const resolvedAddress = stellarAddress;
  const effectiveResolvedAddress = stellarAddress;
  const jobController = new AbortController();
  const horizonMaxRequests = parseNumberInput(
    core.getInput('horizon_max_requests') || '0',
    0,
    {
      min: 0, // 0 = unlimited (matches action.yml)
      max: 10000,
    },
  );
  const maxRetries = parseNumberInput(core.getInput('max_retries') || '3', 3, {
    min: 0,
    max: 20,
  });
  const retryBaseDelayMs = parseNumberInput(core.getInput('retry_base_delay_ms') || '1000', 1000, {
    min: 0,
    max: 60_000,
  });
  const retryMaxDelayMs = parseNumberInput(core.getInput('retry_max_delay_ms') || '30000', 30000, {
    min: 0,
    max: 600_000,
  });

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
    allowCrossNetworkFallback,
    sep0007DeepLinks,
    onboardingChecklist,
    trustbridgeConfigPath,
  });

  validateStellarAddress(stellarAddress);
  const minXlmReserve = parseMinXlmReserve(minXlmReserveRaw);
  const minTrustlineLimitRaw = core.getInput('min_trustline_limit') || '';
  const minTrustlineLimit = minTrustlineLimitRaw ? parseNumberInput(minTrustlineLimitRaw, 0, { min: 0 }) : undefined;
  const minAssetBalance = parseMinAssetBalance(core.getInput('min_asset_balance') || '');

  // Optional multi-asset JSON — validate early so bad input fails fast.
  if (assetsJsonRaw.trim()) {
    parseAssetsJson(assetsJsonRaw);
  }

  // #145 — issues:write preflight (optional early exit)
  // Skip when comment_mode won't post — dry-run/off don't need issues:write.
  // Skip for discussion events too: discussions use the GraphQL path which
  // requires `discussions: write`, not `issues: write` (Issue #221).
  const discussionNodeId = resolveDiscussionNodeId(github.context.payload);
  if (shouldPostComment && !discussionNodeId) {
    const preflight = await runIssuesPreflight(githubToken);
    if (preflight.skip) {
      core.info(preflight.message);
    }
  }
  if (preflightOnly) {
    core.info('preflight_only=true — exiting after issues:write preflight.');
    return;
  }

  // SEP-0001 home domain check inputs (optional, off by default)
  const homeDomainCheckEnabled = parseBooleanInput(core.getInput('home_domain_check_enabled'), false);
  const expectedHomeDomain = core.getInput('expected_home_domain').trim() || undefined;
  const homeDomainCheckModeRaw = core.getInput('home_domain_check_mode').trim().toLowerCase();
  const homeDomainCheckMode: HomeDomainCheckMode =
    homeDomainCheckModeRaw === 'strict' ? 'strict' : 'warn';

  // SEP-0001 stellar.toml fetch and caching inputs (optional, off by default)
  const stellarTomlFetchEnabled = parseBooleanInput(core.getInput('stellar_toml_fetch_enabled'), false);
  const stellarTomlCacheTtlMs = parseNumberInput(
    core.getInput('stellar_toml_cache_ttl_ms') || '3600000',
    3600000,
    { min: 0, max: 86400000 }, // 0 = no cache, 86400000 = 24 hours max
  );
  const stellarTomlHashPin = core.getInput('stellar_toml_hash_pin').trim() || undefined;

  // GitHub Checks API integration (Wave #26 — optional, off by default)
  const useCheckRuns = parseBooleanInput(core.getInput('use_check_runs'), false);

  // Ledger freshness / lag guard inputs (Issue #107 — optional, off by default)
  const checkLedgerFreshnessEnabled = parseBooleanInput(core.getInput('check_ledger_freshness'), false);
  const maxLedgerLagSeconds = parseNumberInput(core.getInput('max_ledger_lag_seconds') || '60', 60, { min: 1, max: 3600 });
  const ledgerFreshnessFailOnStale = parseBooleanInput(core.getInput('ledger_freshness_fail_on_stale'), false);

  if (logInputs) {
    emitInputsLogRecord({
      horizonUrl,
      horizonUrlFallback,
      rpcFallbackUrl: rpcFallbackUrlRaw,
      assetCode,
      assetIssuer,
      minXlmReserve: minXlmReserveRaw,
      minTrustlineLimit: minTrustlineLimitRaw,
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
      horizonMaxRequests,
      maxRetries,
      retryBaseDelayMs,
      retryMaxDelayMs,
      allowCrossNetworkFallback,
      logInputs,
    });
  }

  const normalizedAsset = normalizeAssetConfig({ assetCode, assetIssuer });

  // Validate network/asset compatibility using the campaign preset (Issue #207).
  // Catches testnet issuer on public Horizon (or vice versa) and preset conflicts.
  validateNetworkAssetCompatibility(
    horizonUrl,
    normalizedAsset.assetCode,
    normalizedAsset.assetIssuer,
    presetName || undefined,
  );

  // Soroban fungible token contracts (SEP-41) use a "C..." contract address
  // as their issuer instead of a classic "G..." account. Validate that
  // shape up front so a malformed contract address fails fast with a clear
  // error instead of silently reaching Horizon or the metrics/JSON output.
  if (normalizedAsset.assetIssuer.startsWith('C')) {
    validateContractAddress(normalizedAsset.assetIssuer);
    // If the contract address format is strictly invalid, normalizeAssetConfig
    // would have already failed fast above. We still call validateContractAddress
    // here to ensure validation spans are consistently recorded.
    globalMetrics.recordContractMetric(
      'asset_issuer_contract_validated',
      1,
      normalizedAsset.assetIssuer,
      'count',
    );
  }

  // Claimable-balance policy (Issue #260) — default ignore
  const claimablePolicyRaw = (core.getInput('claimable_balance_policy') || 'ignore').trim().toLowerCase();
  const claimableBalancePolicy = claimablePolicyRaw === 'count' ? 'count' as const : 'ignore' as const;

  // SEP-0010 challenge snippet inputs (Issue #252) — optional, does not block ready
  const sep0010ChallengeXdr = core.getInput('sep0010_challenge_xdr') || '';
  const sep0010DashboardUrl = core.getInput('sep0010_dashboard_url') || '';

  const checkConfig: CheckConfig = {
    ...normalizedAsset,
    minXlmReserve: Number(minXlmReserve),
    minAssetBalance,
    minTrustlineLimit,
    horizonUrl,
    homeDomainCheckEnabled,
    expectedHomeDomain,
    homeDomainCheckMode,
    stellarTomlFetchEnabled,
    stellarTomlCacheTtlMs,
    stellarTomlHashPin,
    checkLedgerFreshness: checkLedgerFreshnessEnabled,
    maxLedgerLagSeconds,
    ledgerFreshnessFailOnStale,
    claimableBalancePolicy,
  };

  // ---------------------------------------------------------------------------
  // Batch mode (Issue #199)
  // When stellar_addresses is set, validate all addresses and post a batch
  // summary comment instead of the single-address flow.
  // ---------------------------------------------------------------------------
  if (stellarAddressesRaw.trim()) {
    const batchAddresses = parseBatchAddresses(stellarAddressesRaw);
    core.info(`Batch mode: validating ${batchAddresses.length} address(es)…`);

    const batchCheckConfig: CheckConfig = {
      ...normalizedAsset,
      minXlmReserve: Number(effectiveMinXlmReserveRaw),
      horizonUrl: effectiveHorizonUrl,
    };

    const batchResults = await runBatchValidation(batchAddresses, batchCheckConfig, effectiveHorizonUrl, {
      fetchOptions: {
        timeoutMs: horizonTimeoutMs,
        maxRetries,
        retryBaseDelayMs,
        retryMaxDelayMs,
      },
    });

    const batchSummary = buildBatchSummary(batchResults);
    const batchMarkdown = formatBatchSummaryMarkdown(batchSummary, effectiveAssetCode);

    if (shouldPostComment) {
      try {
        const batchCommentUrl = await postIssueComment(githubToken, batchMarkdown, {
          sticky: stickyComment,
          forceComment,
          snoozeWindowMs,
        });
        if (batchCommentUrl) {
          logger.info('Batch comment created', { component: 'index', commentUrl: batchCommentUrl });
        }
      } catch (commentError) {
        const message = commentError instanceof Error ? commentError.message : String(commentError);
        core.warning(`Failed to post batch comment (non-fatal): ${message}`);
      }
    }

    // Set batch-specific outputs
    core.setOutput('batch_summary_json', JSON.stringify(batchSummary));
    core.setOutput('batch_passed_count', String(batchSummary.passed));
    core.setOutput('batch_failed_count', String(batchSummary.failed));

    if (batchSummary.failed > 0 && effectiveFailOnMissing) {
      core.setFailed(`Batch validation: ${batchSummary.failed} of ${batchSummary.total} addresses failed.`);
    } else if (batchSummary.failed > 0) {
      core.warning(`Batch validation: ${batchSummary.failed} of ${batchSummary.total} addresses failed.`);
    } else {
      core.info('Batch validation: all addresses passed.');
    }

    return;
  }

  core.info(`Checking Stellar account ${resolvedAddress} via ${horizonUrl}`);

  if (waitUntilFunded) {
    core.info(
      `wait_until_funded is enabled — polling every ${waitUntilFundedIntervalMs}ms for up to ${waitUntilFundedTimeoutMs}ms.`,
    );
  }

  // ---------------------------------------------------------------------------
  // Ledger freshness / lag guard (Issue #107)
  // Run before the account fetch so a stale Horizon is flagged before we trust
  // the balance/trustline data it returns.
  // ---------------------------------------------------------------------------
  let freshnessResult: LedgerFreshnessCheckResult | undefined;
  if (checkLedgerFreshnessEnabled) {
    core.info(`Checking ledger freshness (max lag: ${maxLedgerLagSeconds}s)…`);
    try {
      const raw = await checkLedgerFreshness(horizonUrl, {
        maxLagSeconds: maxLedgerLagSeconds,
        timeoutMs: Math.min(horizonTimeoutMs, 10_000),
      });

      freshnessResult = {
        status: raw.status,
        lagSeconds: raw.lagSeconds,
        latestLedger: raw.latestLedger,
        message: raw.message,
        blocksValid: raw.status === 'stale' && ledgerFreshnessFailOnStale,
      };

      if (raw.status === 'stale') {
        const logMsg = `Ledger freshness check: STALE — ${raw.message}`;
        if (ledgerFreshnessFailOnStale) {
          core.error(logMsg);
        } else {
          core.warning(logMsg);
        }
      } else if (raw.status === 'unknown') {
        core.warning(`Ledger freshness check: UNKNOWN — ${raw.message}`);
      } else {
        core.info(`Ledger freshness check: OK — ${raw.message}`);
      }
    } catch (freshnessError) {
      // Fail-open: a freshness check error never blocks the account check.
      const msg = getErrorMessage(freshnessError);
      core.warning(`Ledger freshness check failed (proceeding fail-open): ${msg}`);
      freshnessResult = {
        status: 'unknown',
        lagSeconds: null,
        latestLedger: null,
        message: `Freshness check error: ${msg}. Proceeding (fail-open).`,
        blocksValid: false,
      };
    }
  }

  let result;

  const rateBudgetTracker = new RateBudgetTracker(horizonMaxRequests);

  // Issue #209: Circuit breaker for Horizon fetches.
  // Trips after 5 consecutive failures; recovers after 30s.
  const horizonCircuitBreaker = new CircuitBreaker({
    failureThreshold: 5,
    recoveryTimeoutMs: 30_000,
    successThreshold: 2,
  });

  const horizonOptions = {
    timeoutMs: horizonTimeoutMs,
    maxRetries,
    retryBaseDelayMs,
    retryMaxDelayMs,
    horizonUrlFallback: horizonUrlFallback || undefined,
    fallbackUrls,
    cacheTtlMs: useCache ? horizonCacheTtlMs : 0,
    useCache,
    allowCrossNetworkFallback,
    rateBudgetTracker,
    horizonMaxRequests,
    circuitBreaker: horizonCircuitBreaker,
  };

  let account: HorizonAccount | null = null;
  let horizonFetchStartMs = Date.now();
  let horizonFetchLatencyMs = 0;
  let horizonFetchStatusCode: number | undefined;
  let horizonFetchError: string | undefined;

  try {
    account = waitUntilFunded
      ? await waitForFundedAccount(
          horizonUrl,
          effectiveResolvedAddress,
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
      : await fetchAccount(horizonUrl, resolvedAddress, horizonOptions);
    horizonFetchLatencyMs = Date.now() - horizonFetchStartMs;
    horizonFetchStatusCode = 200;
    globalMetrics.stopTimer('horizon_fetch');
    result = await runAccountChecks(account, checkConfig);
  } catch (error) {
    horizonFetchLatencyMs = Date.now() - horizonFetchStartMs;
    globalMetrics.stopTimer('horizon_fetch');
    if (error instanceof HorizonError && error.statusCode === 404) {
      horizonFetchStatusCode = 404;
      horizonFetchError = error.message;
      // #144/#266: deterministic cross-network detection — probes canonical opposite
      // with SSRF guard, 5s timeout; does not probe arbitrary fallback URLs.
      const mismatchHint = await detectNetworkMismatch(horizonUrl, stellarAddress).catch(
        () => undefined,
      );
      if (mismatchHint) {
        core.warning(
          `Cross-network mismatch detected: address is active on ${mismatchHint.activeOnNetwork} ` +
          `but horizon_url points at ${mismatchHint.configuredNetwork}.`,
        );
      }
      // #260: claimable-balance-aware funded definition — when policy is 'count',
      // fetch claimable_balances (bounded 5s, no throw). Default 'ignore' skips request.
      let claimableCount: number | undefined;
      if (claimableBalancePolicy === 'count') {
        try {
          const { fetchClaimableBalanceCount } = await import('./horizon');
          claimableCount = await fetchClaimableBalanceCount(horizonUrl, stellarAddress);
          if (claimableCount > 0) {
            core.info(`Found ${claimableCount} claimable balance(s) for ${stellarAddress} (policy=count).`);
          }
        } catch {
          claimableCount = 0;
        }
      }
      result = unfundedAccountResult(stellarAddress, checkConfig, mismatchHint, claimableCount);
    } else if (error instanceof HorizonError) {
      horizonFetchStatusCode = error.statusCode;
      horizonFetchError = error.message;
      core.error(error.message);
      globalMetrics.incrementCounter('errors');
      globalMetrics.recordMetric('horizon_error', error.statusCode, 'http_status');
      result = horizonFailureResult(error.message, checkConfig);
    } else {
      const message = getErrorMessage(error);
      horizonFetchError = message;
      core.error(message);
      globalMetrics.incrementCounter('errors');
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

  // Capture the validation timestamp once, used for validated_at output and delta.
  const validatedAt = new Date().toISOString();

  // Attach the freshness result to every result path so comment.ts can render it.
  if (freshnessResult !== undefined) {
    result = { ...result, ledgerFreshnessResult: freshnessResult };
    // When stale AND fail-on-stale is enabled, override valid so the gate fires.
    if (freshnessResult.blocksValid && result.valid) {
      result = { ...result, valid: false };
    }
  }

  // ---------------------------------------------------------------------------
  // Multi-asset trustline checks (Issue #201)
  // Run trustline checks for additional assets from assets_json.
  // ---------------------------------------------------------------------------
  interface MultiAssetResult {
    assetCode: string;
    assetIssuer: string;
    trustlineExists: boolean;
    balance: string;
  }
  let multiAssetResults: MultiAssetResult[] = [];
  if (assetsJsonRaw.trim()) {
    const extraAssets = parseAssetsJson(assetsJsonRaw);
    const dedupedAssets = extraAssets.filter(
      (a) => !(a.assetCode === normalizedAsset.assetCode && a.assetIssuer === normalizedAsset.assetIssuer),
    );
    if (dedupedAssets.length > 0 && account) {
      core.info(`Checking trustlines for ${dedupedAssets.length} additional asset(s)…`);
      for (const asset of dedupedAssets) {
        const hasTrustline = account.balances.some(
          (b: HorizonBalance) =>
            b.asset_type !== 'native' &&
            'asset_code' in b &&
            b.asset_code === asset.assetCode &&
            'asset_issuer' in b &&
            b.asset_issuer === asset.assetIssuer,
        );
        const balanceEntry = account.balances.find(
          (b: HorizonBalance) =>
            b.asset_type !== 'native' &&
            'asset_code' in b &&
            b.asset_code === asset.assetCode &&
            'asset_issuer' in b &&
            b.asset_issuer === asset.assetIssuer,
        );
        const balance = balanceEntry && 'balance' in balanceEntry ? balanceEntry.balance : '0';
        multiAssetResults.push({
          assetCode: asset.assetCode,
          assetIssuer: asset.assetIssuer,
          trustlineExists: hasTrustline,
          balance,
        });
        if (hasTrustline) {
          core.info(`  ✓ ${asset.assetCode} (${asset.assetIssuer}) — trustline exists`);
        } else {
          core.warning(`  ✗ ${asset.assetCode} (${asset.assetIssuer}) — trustline missing`);
        }
      }
    }
  }

  setValidationOutputs(result);

  if (writeValidationJsonEnabled) {
    writeValidationJson({
      result,
      stellarAddress: effectiveResolvedAddress,
      assetCode: effectiveAssetCode,
      assetIssuer: effectiveAssetIssuer,
      horizonUrl: effectiveHorizonUrl,
      outputPath: validationJsonPath,
      privacyMode,
    });
    core.info(`Wrote validation JSON artifact to ${validationJsonPath}`);
  }

  // ---------------------------------------------------------------------------
  // SARIF output (Issue #197)
  // Write SARIF 2.1.0 to disk when sarif_output_path is set.
  // ---------------------------------------------------------------------------
  const sarifOutputPath = core.getInput('sarif_output_path') || '';
  if (sarifOutputPath.trim()) {
    const workspaceRoot = process.env.GITHUB_WORKSPACE || process.cwd();
    const resolvedSarifPath = path.isAbsolute(sarifOutputPath)
      ? sarifOutputPath
      : path.join(workspaceRoot, sarifOutputPath.trim());

    // Path traversal guard
    const normalizedWorkspace = path.normalize(workspaceRoot);
    const normalizedSarif = path.normalize(resolvedSarifPath);
    if (!normalizedSarif.startsWith(normalizedWorkspace + path.sep) && normalizedSarif !== normalizedWorkspace) {
      core.warning(
        `sarif_output_path resolves outside GITHUB_WORKSPACE — SARIF output skipped.`,
      );
    } else {
      try {
        const sarif = buildSarifOutput(result, effectiveAssetCode, effectiveHorizonUrl, effectiveResolvedAddress);
        if (!validateSarifSchema(sarif)) {
          core.warning('Generated SARIF output failed schema validation — skipping SARIF write.');
        } else {
          const sarifJson = serializeSarif(sarif);
          const sarifDir = path.dirname(normalizedSarif);
          if (!fs.existsSync(sarifDir)) {
            fs.mkdirSync(sarifDir, { recursive: true });
          }
          fs.writeFileSync(normalizedSarif, sarifJson, 'utf8');
          core.info(`Wrote SARIF 2.1.0 output to ${normalizedSarif}`);
        }
      } catch (sarifError) {
        const msg = sarifError instanceof Error ? sarifError.message : String(sarifError);
        core.warning(`Failed to write SARIF output (non-fatal): ${msg}`);
      }
    }
  }

  // Reserved inputs kept for forward-compatible workflows / labels / Soroban.
  logger.debug('Optional feature flags', {
    component: 'index',
    autoWalletLabels,
    sorobanRpcUrl: sorobanRpcUrl || undefined,
    contractId: contractId || undefined,
    githubUsername: githubUsername || undefined,
    trustbridgeConfigPath,
  });

  // Issue #212: Load previous validation artifact for delta computation.
  // Try local path first; fall back to auto-discovery via Actions API.
  let previousArtifact = loadPreviousValidationArtifact(previousValidationPath);
  if (!previousArtifact && !previousValidationPath.trim()) {
    previousArtifact = await discoverPreviousValidationArtifact(githubToken);
    if (previousArtifact) {
      core.info('Auto-discovered previous validation artifact from prior workflow run.');
    }
  }
  const delta = computeValidationDelta(previousArtifact, result);
  if (!previousArtifact && previousValidationPath.trim()) {
    core.info(
      'No previous validation artifact found — omitting delta (first run or missing download).',
    );
  } else if (delta) {
    core.info(
      `Validation delta vs previous run: newlyPassed=${delta.newlyPassed.length}, newlyFailed=${delta.newlyFailed.length}, unchanged=${delta.unchanged.length}`,
    );
  }

  // Build diagnostics config when debug_mode is on (Issue #205).
  // Never includes secrets; addresses are redacted in the block builder.
  let diagnosticsConfig: DiagnosticsConfig | undefined;
  if (debugMode) {
    diagnosticsConfig = {
      inputs: {
        horizonUrl,
        horizonUrlFallback: horizonUrlFallback || undefined,
        assetCode: effectiveAssetCode,
        assetIssuer: effectiveAssetIssuer,
        minXlmReserve: effectiveMinXlmReserveRaw,
        horizonTimeoutMs,
        useCache,
        cacheTtlMs: horizonCacheTtlMs,
        allowCrossNetworkFallback,
        maxRetries,
        retryBaseDelayMs,
        retryMaxDelayMs,
        debugMode,
      },
      runInfo: {
        horizonStatusCode: horizonFetchStatusCode,
        horizonLatencyMs: horizonFetchLatencyMs,
        horizonError: horizonFetchError,
      },
    };
  }

  const commentBody = formatCommentBody(result, {
    ...checkConfig,
    stellarAddress: effectiveResolvedAddress,
    horizonUrl,
    failOnMissing,
    stickyComment,
    waitUntilFunded,
    waitUntilFundedTimeoutMs,
    waitUntilFundedIntervalMs,
    onboardingChecklist,
    sep0007DeepLinks,
    sep0007OriginDomain,
    sep0010ChallengeXdr,
    sep0010DashboardUrl,
    locale,
    debugMode,
    docsBaseUrl: core.getInput('docs_base_url') || undefined,
    delta,
    diagnosticsConfig,
  });

  // Detect oversize and write the full report to a workspace file when needed.
  const commentBodyBytes = Buffer.byteLength(commentBody, 'utf8');
  let fullReportPath: string | undefined;
  let effectiveCommentBody: string;

  if (commentBodyBytes > COMMENT_SIZE_LIMIT_BYTES) {
    core.warning(
      `Comment body is ${commentBodyBytes} bytes, which exceeds GitHub's ${COMMENT_SIZE_LIMIT_BYTES}-byte limit. ` +
        `Writing full report to ${reportOutputPath} and posting a truncated comment instead.`,
    );
    fullReportPath = writeFullReport(commentBody, reportOutputPath);
    effectiveCommentBody = buildTruncatedCommentBody(commentBody, reportOutputPath);
  } else {
    effectiveCommentBody = commentBody;
  }

  let commentUrl: string | undefined;
  if (!shouldPostComment) {
    core.info(
      `comment_mode=${commentMode} — skipping issue comment post (outputs still set).`,
    );
  } else if (discussionNodeId) {
    // Discussion events carry a GraphQL node id, not an issue number —
    // comment via GraphQL, never the REST issues API (Issue #221).
    try {
      commentUrl = await postDiscussionComment(githubToken, effectiveCommentBody, {
        sticky: stickyComment,
        forceComment,
        snoozeWindowMs,
      });
      if (commentUrl) {
        logger.info('Discussion comment created', { component: 'index', commentUrl });
      } else {
        logger.info('No discussion comment posted (no discussion context).', {
          component: 'index',
        });
      }
    } catch (commentError) {
      const message = commentError instanceof Error ? commentError.message : String(commentError);
      core.warning(`Failed to post discussion comment (non-fatal): ${message}`);
    }
  } else {
    globalMetrics.startTimer('comment_post');
    try {
      commentUrl = await postIssueComment(githubToken, effectiveCommentBody, {
        sticky: stickyComment,
        forceComment,
        snoozeWindowMs,
        issueNumber: issueNumberInput,
      });
      globalMetrics.stopTimer('comment_post');
      if (commentUrl) {
        logger.info('Issue comment created', { component: 'index', commentUrl });
      }
    } catch (commentError) {
      globalMetrics.stopTimer('comment_post');
      const message = commentError instanceof Error ? commentError.message : String(commentError);
      core.warning(`Failed to post issue comment (non-fatal): ${message}`);
    }
  }

  setValidationOutputs(result, commentUrl, fullReportPath, { validatedAt });

  // ---------------------------------------------------------------------------
  // Wallet labels (Issue #200)
  // When auto_wallet_labels is true and we're in an issue context, apply
  // the appropriate wallet state label to the issue.
  // ---------------------------------------------------------------------------
  if (autoWalletLabels && result) {
    const issueNumber = github.context.payload.issue?.number;
    if (issueNumber) {
      const { owner, repo } = github.context.repo;
      try {
        const octokit = github.getOctokit(githubToken);
        const labelResult = await applyWalletLabels(
          octokit,
          owner,
          repo,
          issueNumber,
          {
            accountFunded: result.accountFunded,
            trustlineExists: result.trustlineExists,
            xlmReserveMet: result.xlmReserveMet,
          },
          { removeStale: true },
        );
        if (labelResult.error) {
          core.warning(`Wallet label failed (non-fatal): ${labelResult.error}`);
        } else {
          core.info(`Applied wallet label: ${labelResult.applied}`);
        }
      } catch (labelError) {
        const msg = labelError instanceof Error ? labelError.message : String(labelError);
        core.warning(`Failed to apply wallet label (non-fatal): ${msg}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Auto-unassign on not-ready (Issue #228)
  // When unassign_on_not_ready is true and readiness checks fail, automatically
  // unassign the GitHub assignee(s) from the issue.
  // ---------------------------------------------------------------------------
  if (unassignOnNotReady && result && !result.valid) {
    const issueNumber = github.context.payload.issue?.number;
    const { owner, repo } = github.context.repo;
    const octokit = github.getOctokit(githubToken);
    await handleAutoUnassign({
      octokit,
      owner,
      repo,
      issueNumber: issueNumberInput ?? issueNumber,
      payload: github.context.payload,
      result,
      unassignOnNotReady,
    });
  }

  // Signed dashboard webhook notification (Issue #101)
  // Fires after comment posting; failures are isolated and never block the run.
  if (webhookUrl) {
    const { owner, repo } = github.context.repo;
    const issueNumber = github.context.payload.issue?.number ?? null;
    await sendWebhookNotification(
      result,
      effectiveResolvedAddress,
      {
        webhookUrl,
        webhookSecret,
        timeoutMs: webhookTimeoutMs,
        authMode: webhookAuthMode,
        oidcAudience: webhookOidcAudience,
      },
      `${owner}/${repo}`,
      issueNumber,
    );
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

  // Stop total timer and collect timing metrics
  globalMetrics.stopTimer('total');

  // Wave #27: write Job Summary with latency, failure codes, JSON artifact
  await writeJobSummary(globalMetrics.buildJobSummary());

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

// Skip auto-run under Jest so performance / integration tests can import `run`.
export { run };

if (process.env.JEST_WORKER_ID === undefined) {
  run().catch((error) => {
    core.setFailed(getErrorMessage(error));
  });
}
