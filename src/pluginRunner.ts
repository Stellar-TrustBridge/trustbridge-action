/**
 * @file pluginRunner.ts
 * Runs a set of CheckPlugins and composes their results into a
 * ValidationResult that is fully compatible with the existing comment,
 * output, and gate logic.
 *
 * The runner is intentionally decoupled from `runAccountChecks` so both
 * can coexist during a gradual migration: the monolith still handles
 * unfunded / Horizon-error paths, while the plugin system is the
 * forward-looking extension point for new checks.
 */

import { ValidationResult, CheckResultItem } from './checks';
import { CheckPlugin, CheckPluginContext, PluginRegistry, defaultRegistry } from './plugin';
import { escapeMarkdownInline } from './markdown';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run every plugin registered in `registry` against `ctx`, then
 * compose their `CheckPluginResult`s into a `ValidationResult`.
 *
 * Composition rules
 * -----------------
 * - `valid`           — true only when every plugin passes.
 * - `accountFunded`   — derived from the plugin whose id ends with
 *                       `'account-funded'`, otherwise falls back to
 *                       `ctx.account !== null`.
 * - `trustlineExists` — derived from the plugin whose id ends with
 *                       `'trustline'`, otherwise `false`.
 * - `xlmBalance`      — taken from the native balance on `ctx.account`,
 *                       or `'unknown'` when `ctx.account` is null.
 * - `xlmReserveMet`   — derived from the plugin whose id ends with
 *                       `'xlm-reserve'`, otherwise `false`.
 * - `checks`          — one `CheckResultItem` per plugin, in
 *                       registration order.
 * - `remediation`     — all non-empty plugin `remediation` strings
 *                       joined with `'\n\n'`, or `undefined` when all
 *                       checks pass.
 *
 * @param ctx       Context object shared across all plugins.
 * @param registry  Optional registry; defaults to `defaultRegistry`.
 */
export function runPlugins(
  ctx: CheckPluginContext,
  registry: PluginRegistry = defaultRegistry,
): ValidationResult {
  const plugins = registry.list();

  // Run each plugin, wrapping any unexpected throw so one bad plugin
  // cannot silently kill the whole action.
  const pluginOutputs = plugins.map((plugin) => {
    try {
      return { plugin, result: plugin.run(ctx) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        plugin,
        result: {
          passed: false,
          detail: `Plugin \`${plugin.id}\` threw an unexpected error: ${message}`,
          remediation: `Contact the plugin author to fix \`${plugin.id}\`.`,
        },
      };
    }
  });

  // Build the checks array from plugin results.
  const checks: CheckResultItem[] = pluginOutputs.map(({ plugin, result }) => {
    const isCore = plugin.id.startsWith('trustbridge/');
    return {
      passed: result.passed,
      label: isCore ? plugin.label : escapeMarkdownInline(plugin.label),
      detail: isCore ? result.detail : escapeMarkdownInline(result.detail),
    };
  });

  const valid = checks.every((c) => c.passed);

  // Derive top-level ValidationResult fields from well-known plugin ids
  // or from the context when the corresponding plugin is absent.
  const accountFunded = deriveFlag(pluginOutputs, 'account-funded', ctx.account !== null);
  const trustlineExists = deriveFlag(pluginOutputs, 'trustline', false);
  const xlmReserveMet = deriveFlag(pluginOutputs, 'xlm-reserve', false);

  const xlmBalance = ctx.account
    ? (ctx.account.balances.find((b) => b.asset_type === 'native')?.balance ?? 'unknown')
    : 'unknown';

  // Collect remediation strings from failed plugins.
  const remediationParts = pluginOutputs
    .filter(({ result }) => !result.passed && result.remediation)
    .map(({ plugin, result }) => {
      const isCore = plugin.id.startsWith('trustbridge/');
      return isCore ? result.remediation as string : escapeMarkdownInline(result.remediation as string);
    });

  const remediation = remediationParts.length > 0 ? remediationParts.join('\n\n') : undefined;

  return {
    valid,
    accountFunded,
    trustlineExists,
    xlmBalance,
    xlmReserveMet,
    assetBalance: 'unknown',
    assetBalanceMet: false,
    checks,
    remediation,
    failedCheckLabels: checks.filter((c) => !c.passed).map((c) => {
      const label = c.label.toLowerCase();
      if (label.includes('horizon')) return 'horizon_available';
      if (label.includes('account funded') || label.includes('account-funded')) return 'account_funded';
      if (label.includes('trustline')) return 'trustline';
      if (label.includes('xlm') || label.includes('reserve')) return 'xlm_reserve';
      if (label.includes('kyc')) return 'kyc';
      if (label.includes('home domain')) return 'home_domain';
      return label.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    }),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Derive a boolean flag from the first plugin whose id ends with `suffix`.
 * Falls back to `defaultValue` when no matching plugin is registered.
 */
function deriveFlag(
  outputs: Array<{ plugin: CheckPlugin; result: { passed: boolean } }>,
  suffix: string,
  defaultValue: boolean,
): boolean {
  const match = outputs.find(({ plugin }) => plugin.id.endsWith(suffix));
  return match !== undefined ? match.result.passed : defaultValue;
}
