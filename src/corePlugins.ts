/**
 * @file corePlugins.ts
 * The three built-in TrustBridge checks expressed as CheckPlugins.
 *
 * These serve two purposes:
 *   1. Reference implementations that plugin authors can study to
 *      understand the expected shape of a plugin.
 *   2. Drop-in replacements for the equivalent logic inside
 *      `runAccountChecks` when projects want a fully plugin-driven
 *      pipeline.
 *
 * The existing `runAccountChecks` monolith in `checks.ts` is **not**
 * changed in this PR — these plugins coexist alongside it. A future
 * major release may elect to replace `runAccountChecks` entirely with
 * `runPlugins([...corePlugins])`.
 *
 * SECURITY: All detail strings that embed data from `ctx` use the same
 * `escapeMarkdownInline` / `inlineCode` helpers as `runAccountChecks`
 * so no untrusted value can inject Markdown formatting.
 */

import { CheckPlugin, CheckPluginContext, CheckPluginResult, defaultRegistry } from './plugin';
import {
  STELLAR_MIN_ACCOUNT_BALANCE_XLM,
  estimateTrustlineSetupCost,
  buildReserveRequirement,
  evaluateHomeDomain,
} from './checks';
import { getNativeBalance, hasTrustline, parseHorizonBalance } from './horizon';
import { escapeMarkdownInline, inlineCode } from './markdown';
import { buildChangeTrustLink, buildLobstrLink, inferStellarNetwork } from './links';
import { globalMetrics } from './metrics';

// ---------------------------------------------------------------------------
// 1. Account funded
// ---------------------------------------------------------------------------

/**
 * Checks that the Stellar account exists and is activated on the network.
 *
 * Passes  — `ctx.account` is not null (Horizon returned a 200).
 * Fails   — `ctx.account` is null (Horizon returned 404 / account unfunded).
 *
 * Plugin id: `'trustbridge/account-funded'`
 */
export const accountFundedPlugin: CheckPlugin = {
  id: 'trustbridge/account-funded',
  label: 'Account funded',

  run(ctx: CheckPluginContext): CheckPluginResult {
    if (ctx.account !== null) {
      return {
        passed: true,
        detail: `Account ${inlineCode(ctx.stellarAddress)} is active on the Stellar network.`,
      };
    }

    const safeAddress = inlineCode(ctx.stellarAddress);
    return {
      passed: false,
      detail: `Account ${safeAddress} was **not found** on Horizon — it may not be funded or activated yet.`,
      remediation: [
        `Activate ${safeAddress} by sending at least **${STELLAR_MIN_ACCOUNT_BALANCE_XLM} XLM** (Stellar minimum account balance).`,
        `Estimated setup cost: ~**${estimateTrustlineSetupCost()} XLM** (1 XLM base + 0.5 XLM per trustline reserve).`,
      ].join('\n\n'),
    };
  },
};

// ---------------------------------------------------------------------------
// 2. Trustline
// ---------------------------------------------------------------------------

/**
 * Checks that the account holds a trustline for the configured asset.
 *
 * Passes  — account has a trustline for `config.assetCode` / `config.assetIssuer`.
 * Fails   — trustline is absent or account is not funded.
 *
 * Plugin id: `'trustbridge/trustline'`
 */
export const trustlinePlugin: CheckPlugin = {
  id: 'trustbridge/trustline',
  label: 'Trustline',

  run(ctx: CheckPluginContext): CheckPluginResult {
    const safeAssetCode = escapeMarkdownInline(ctx.config.assetCode);
    const safeIssuer = inlineCode(ctx.config.assetIssuer);
    const network = inferStellarNetwork(ctx.config.horizonUrl ?? '');

    if (ctx.account === null) {
      return {
        passed: false,
        detail: 'Cannot verify trustline until the account exists.',
      };
    }

    const exists = hasTrustline(ctx.account, ctx.config.assetCode, ctx.config.assetIssuer);
    const hasAnyTrustlines = ctx.account.balances.some((b) => b.asset_type !== 'native');

    if (exists) {
      return {
        passed: true,
        detail: `Trustline for **${safeAssetCode}** (${safeIssuer}) is configured.`,
      };
    }

    const detail = hasAnyTrustlines
      ? `Account has trustlines, but not for **${safeAssetCode}** issued by ${safeIssuer}.`
      : 'Account has **zero trustlines** — add a trustline before receiving this asset.';

    return {
      passed: false,
      detail,
      remediation: `Add a **${safeAssetCode}** trustline using [Stellar Laboratory](${buildChangeTrustLink(network)}) (Change Trust operation) or a wallet such as [LOBSTR](${buildLobstrLink()}).`,
    };
  },
};

// ---------------------------------------------------------------------------
// 3. XLM reserve
// ---------------------------------------------------------------------------

/**
 * Checks that the account's native XLM balance meets the configured minimum.
 *
 * Passes  — balance ≥ `config.minXlmReserve`.
 * Fails   — balance is below the minimum, or account is not funded.
 *
 * Plugin id: `'trustbridge/xlm-reserve'`
 */
export const xlmReservePlugin: CheckPlugin = {
  id: 'trustbridge/xlm-reserve',
  label: 'XLM reserve',

  run(ctx: CheckPluginContext): CheckPluginResult {
    if (ctx.account === null) {
      return {
        passed: false,
        detail: `Cannot verify XLM balance. Fund the account with at least **${ctx.config.minXlmReserve} XLM**.`,
      };
    }

    const xlmBalance = getNativeBalance(ctx.account);
    const xlmNumeric = parseHorizonBalance(xlmBalance);
    const reserve = buildReserveRequirement(ctx.config.minXlmReserve, xlmNumeric);

    if (reserve.met) {
      return {
        passed: true,
        detail: `Balance **${inlineCode(xlmBalance)} XLM** meets the minimum of **${ctx.config.minXlmReserve} XLM**.`,
      };
    }

    return {
      passed: false,
      detail: `Balance **${inlineCode(xlmBalance)} XLM** is below the required **${ctx.config.minXlmReserve} XLM**.`,
      remediation: `Send at least **${reserve.missing} XLM** to ${inlineCode(ctx.account.account_id)} to meet the reserve requirement.`,
    };
  },
};

// ---------------------------------------------------------------------------
// 4. SEP-0001 home domain (optional — skips when not configured)
// ---------------------------------------------------------------------------

/**
 * Checks that the issuer account's on-chain `home_domain` field aligns with
 * the configured expectation (SEP-0001).
 *
 * The check is **opt-in**: when `config.homeDomainCheckEnabled` is false
 * (or absent) the plugin returns a passing no-op result and emits a
 * `home_domain_skipped` counter so dashboards can distinguish "not
 * configured" from a real outcome.
 *
 * Modes
 * -----
 * - `warn`   (default) — the check row is informational; a missing or
 *   mismatched domain does NOT block `valid`.
 * - `strict` — a non-`valid` outcome sets `passed = false`, which causes
 *   `runPlugins` to set `valid = false` for the overall result.
 *
 * Metric tags emitted (via `globalMetrics`):
 * - `home_domain_valid`    — domain present and matches expectation.
 * - `home_domain_missing`  — issuer has no `home_domain` on-chain.
 * - `home_domain_mismatch` — domain present but does not match expected.
 * - `home_domain_skipped`  — check not enabled.
 *
 * Plugin id: `'trustbridge/home-domain'`
 */
export const homeDomainPlugin: CheckPlugin = {
  id: 'trustbridge/home-domain',
  label: 'SEP-0001 home domain',

  run(ctx: CheckPluginContext): CheckPluginResult {
    if (!ctx.config.homeDomainCheckEnabled) {
      globalMetrics.incrementCounter('home_domain_skipped');
      return {
        passed: true,
        detail: 'SEP-0001 home domain check is disabled (set `home_domain_check_enabled: true` to enable).',
      };
    }

    const checkResult = evaluateHomeDomain(ctx.account, ctx.config);

    // Emit metrics regardless of mode so dashboards always get a data point.
    globalMetrics.incrementCounter(`home_domain_${checkResult.outcome}`);
    globalMetrics.recordMetric('home_domain_check', 1, 'count', {
      outcome: checkResult.outcome,
      mode: ctx.config.homeDomainCheckMode ?? 'warn',
    });

    const passed = !checkResult.blocksValid || checkResult.outcome === 'valid';

    if (passed) {
      return { passed: true, detail: checkResult.detail };
    }

    // Build remediation guidance for strict-mode failures.
    const mode = ctx.config.homeDomainCheckMode ?? 'warn';
    const remediation =
      checkResult.outcome === 'missing'
        ? `The asset issuer (${inlineCode(ctx.config.assetIssuer)}) has not set a \`home_domain\` on their Stellar account. ` +
          'Contact the issuer to publish SEP-0001 metadata, or disable this check if the issuer is exempt.'
        : `The issuer \`home_domain\` does not match the expected value. ` +
          `Expected: \`${escapeMarkdownInline(ctx.config.expectedHomeDomain ?? '')}\`. ` +
          `Actual: \`${escapeMarkdownInline(checkResult.actualHomeDomain ?? '(none)')}\`. ` +
          'Update `expected_home_domain` or contact the asset issuer.';

    return {
      passed: false,
      detail: checkResult.detail,
      remediation: mode === 'strict' ? remediation : undefined,
    };
  },
};

// ---------------------------------------------------------------------------
// Convenience export — all four core plugins in canonical order
// ---------------------------------------------------------------------------

/**
 * The four built-in checks in the order they appear in the comment table.
 * Pass this array to `runPlugins()` to get a fully plugin-driven result
 * equivalent to `runAccountChecks()`.
 *
 * Note: `homeDomainPlugin` is included but is a no-op when
 * `config.homeDomainCheckEnabled` is false (the default), so existing
 * workflows are unaffected.
 *
 * ```ts
 * import { runPlugins } from './pluginRunner';
 * import { corePlugins } from './corePlugins';
 * import { PluginRegistry } from './plugin';
 *
 * const registry = new PluginRegistry();
 * corePlugins.forEach(p => registry.register(p));
 * const result = runPlugins(ctx, registry);
 * ```
 */
export const corePlugins: CheckPlugin[] = [
  accountFundedPlugin,
  trustlinePlugin,
  xlmReservePlugin,
  homeDomainPlugin,
];

/**
 * Frozen list of built-in plugin ids, in canonical order. Must match the
 * "Built-in plugins" table in `docs/PLUGIN_ARCHITECTURE.md`; enforced by
 * `__tests__/core-plugins-freeze.test.ts`.
 */
export const CORE_PLUGIN_IDS: readonly string[] = Object.freeze(corePlugins.map((p) => p.id));

/**
 * Register all core plugins with the default registry.
 * Called once at action startup before any user plugins are loaded.
 */
export function registerCorePlugins(): void {
  corePlugins.forEach((p) => defaultRegistry.register(p));
}
