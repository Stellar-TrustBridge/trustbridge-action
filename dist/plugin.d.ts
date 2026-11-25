/**
 * @file plugin.ts
 * CheckPlugin interface and registry for the TrustBridge extensible
 * validation architecture.
 *
 * SECURITY CONTRACT
 * -----------------
 * Plugins are TypeScript modules reviewed and merged by maintainers.
 * They MUST NOT evaluate or execute content sourced from issue bodies,
 * comment text, environment variables, or any other runtime-supplied
 * string as code (no `eval`, `new Function`, dynamic `import()` of
 * user-supplied paths, or shell execution of untrusted strings).
 * All plugin inputs arrive through the typed `CheckPluginContext` and
 * outputs are constrained to `CheckPluginResult` — no escape hatches.
 */
import { HorizonAccount } from './horizon';
import { CheckConfig } from './checks';
/**
 * Read-only snapshot of everything a plugin needs to perform its check.
 * Plugins receive this object and MUST NOT mutate it.
 *
 * All values originate from the action's typed inputs or the Horizon API
 * response — never from issue body text or any other untrusted source.
 */
export interface CheckPluginContext {
    /** The Stellar account returned by Horizon, or `null` when unfunded. */
    readonly account: HorizonAccount | null;
    /** Resolved action inputs (asset, reserve, network). */
    readonly config: Readonly<CheckConfig>;
    /** The raw Stellar G-address being validated. */
    readonly stellarAddress: string;
}
/**
 * Result produced by one plugin's `run()` call.
 *
 * - `passed`      — whether this check succeeded.
 * - `detail`      — human-readable Markdown sentence shown in the comment
 *                   row. MUST be sanitised before returning (escape backticks,
 *                   brackets, asterisks from untrusted data).
 * - `remediation` — optional Markdown guidance shown in the Remediation
 *                   section when `passed` is false. May be omitted for
 *                   informational failures.
 */
export interface CheckPluginResult {
    readonly passed: boolean;
    readonly detail: string;
    readonly remediation?: string;
}
/**
 * A single, self-contained validation check.
 *
 * ```ts
 * import { CheckPlugin, CheckPluginContext, CheckPluginResult } from './plugin';
 *
 * export const myPlugin: CheckPlugin = {
 *   id: 'my-org/kyc-check',
 *   label: 'KYC verified',
 *   run(ctx: CheckPluginContext): CheckPluginResult {
 *     const verified = ctx.config.assetCode === 'USDC'; // example logic
 *     return {
 *       passed: verified,
 *       detail: verified ? 'KYC verified.' : 'KYC check failed.',
 *       remediation: verified ? undefined : 'Complete KYC at https://example.com',
 *     };
 *   },
 * };
 * ```
 *
 * SECURITY: `run()` receives only the typed `CheckPluginContext`. It must
 * not read process environment variables, spawn child processes, make
 * network requests, or execute strings from issue bodies.
 */
export interface CheckPlugin {
    /**
     * Unique, stable identifier in reverse-domain or slug form.
     * Used for deduplication and ordering.
     * Example: `'trustbridge/account-funded'`, `'my-org/kyc-check'`
     */
    readonly id: string;
    /**
     * Short human-readable label shown in the comment results table.
     * Keep it under ~40 characters. Must not contain raw Markdown that
     * could break the table row (no `|`, no unescaped backticks).
     */
    readonly label: string;
    /**
     * Optional per-plugin timeout in milliseconds.
     *
     * When set, `runPlugins()` enforces this budget for the plugin's `run()`
     * call. A plugin that exceeds its budget fails closed with a stable
     * timeout error and does not affect unrelated plugins. When omitted, the
     * runner's default timeout applies.
     */
    readonly timeoutMs?: number;
    /**
     * Execute the check synchronously.
     *
     * Plugins are intentionally synchronous in v1 to keep composition
     * simple and to prevent async plugins from making unbounded network
     * calls. If async support is needed in a future version, the runner
     * will be updated to `Promise.all` over `runAsync()` instead.
     *
     * SECURITY: must not evaluate untrusted strings as code.
     */
    run(ctx: CheckPluginContext): CheckPluginResult;
}
/**
 * Ordered, deduplication-safe registry of `CheckPlugin` instances.
 *
 * Usage:
 * ```ts
 * const registry = new PluginRegistry();
 * registry.register(accountFundedPlugin);
 * registry.register(trustlinePlugin);
 * const plugins = registry.list();
 * ```
 *
 * Plugins are stored in insertion order. Registering a plugin whose `id`
 * already exists is a no-op (first registration wins), so consumers can
 * safely call `register()` multiple times without duplicating checks.
 */
export declare class PluginRegistry {
    private readonly _plugins;
    /**
     * Register a plugin. If a plugin with the same `id` is already
     * registered, this call is silently ignored (first-wins semantics).
     */
    register(plugin: CheckPlugin): void;
    /**
     * Remove a plugin by id. Returns `true` if it was present.
     * Useful in tests to reset state between runs.
     */
    unregister(id: string): boolean;
    /**
     * Returns all registered plugins in insertion order.
     */
    list(): CheckPlugin[];
    /**
     * Returns the number of registered plugins.
     */
    get size(): number;
    /**
     * Remove all plugins. Primarily useful in tests.
     */
    clear(): void;
}
/**
 * The default shared registry used by `runPlugins()` and `corePlugins.ts`.
 *
 * Consumers that need isolation (e.g. tests) should create their own
 * `new PluginRegistry()` and pass it explicitly to `runPlugins()`.
 */
export declare const defaultRegistry: PluginRegistry;
