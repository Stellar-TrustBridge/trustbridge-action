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
import { ValidationResult } from './checks';
import { CheckPluginContext, PluginRegistry } from './plugin';
/**
 * Default per-plugin timeout (ms). Plugins that exceed this budget are
 * treated as failed (fail closed) so a hung third-party check cannot
 * stall the whole Actions job.
 */
export declare const DEFAULT_PLUGIN_TIMEOUT_MS = 5000;
/**
 * Options for {@link runPlugins}.
 */
export interface RunPluginsOptions {
    /** Per-plugin timeout in milliseconds. Defaults to {@link DEFAULT_PLUGIN_TIMEOUT_MS}. */
    timeoutMs?: number;
}
/**
 * Run every plugin registered in `registry` against `ctx`, then
 * compose their `CheckPluginResult`s into a `ValidationResult`.
 *
 * Discovery / load order
 * ----------------------
 * Plugins are executed in the deterministic order returned by
 * `registry.list()` (see `pluginLoader` / `PluginRegistry`), which is
 * stable across runs so CI gates do not flip on ordering. The composed
 * `checks` array preserves that same order.
 *
 * Failure isolation
 * -----------------
 * Each plugin runs inside its own try/catch. A plugin that throws is
 * recorded as a failed check with a stable, actionable message and the
 * remaining plugins (including core Horizon checks) still run. A bad
 * custom plugin therefore fails the gate but never prevents core checks
 * from executing or reporting.
 *
 * Timeout boundary
 * ----------------
 * Each plugin is also bounded by `options.timeoutMs` (default
 * {@link DEFAULT_PLUGIN_TIMEOUT_MS}). A plugin that exceeds the budget is
 * recorded as a failed check with a stable `timed out after Nms` message
 * and the remaining plugins still run. This keeps a hung plugin from
 * stalling the job while preserving isolation between plugins.
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
 * @param options   Optional runner options (e.g. per-plugin timeout).
 */
export declare function runPlugins(ctx: CheckPluginContext, registry?: PluginRegistry, options?: RunPluginsOptions): ValidationResult;
