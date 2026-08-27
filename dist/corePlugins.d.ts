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
import { CheckPlugin } from './plugin';
/**
 * Checks that the Stellar account exists and is activated on the network.
 *
 * Passes  — `ctx.account` is not null (Horizon returned a 200).
 * Fails   — `ctx.account` is null (Horizon returned 404 / account unfunded).
 *
 * Plugin id: `'trustbridge/account-funded'`
 */
export declare const accountFundedPlugin: CheckPlugin;
/**
 * Checks that the account holds a trustline for the configured asset.
 *
 * Passes  — account has a trustline for `config.assetCode` / `config.assetIssuer`.
 * Fails   — trustline is absent or account is not funded.
 *
 * Plugin id: `'trustbridge/trustline'`
 */
export declare const trustlinePlugin: CheckPlugin;
/**
 * Checks that the account's native XLM balance meets the configured minimum.
 *
 * Passes  — balance ≥ `config.minXlmReserve`.
 * Fails   — balance is below the minimum, or account is not funded.
 *
 * Plugin id: `'trustbridge/xlm-reserve'`
 */
export declare const xlmReservePlugin: CheckPlugin;
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
export declare const homeDomainPlugin: CheckPlugin;
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
export declare const corePlugins: CheckPlugin[];
/**
 * Register all core plugins with the default registry.
 * Called once at action startup before any user plugins are loaded.
 */
export declare function registerCorePlugins(): void;
