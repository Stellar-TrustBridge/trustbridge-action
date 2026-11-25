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
import { redactString } from './logger';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Default per-plugin timeout (ms). Plugins that exceed this budget are
 * treated as failed (fail closed) so a hung third-party check cannot
 * stall the whole Actions job.
 */
export const DEFAULT_PLUGIN_TIMEOUT_MS = 5000;

/**
 * Options for {@link runPlugins}.
 */
export interface RunPluginsOptions {
  /** Per-plugin timeout in milliseconds. Defaults to {@link DEFAULT_PLUGIN_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * Maximum bytes of stderr kept per plugin (Issue #954). Output beyond the
   * cap is dropped and the capture is flagged `truncated`. Defaults to
   * {@link DEFAULT_PLUGIN_STDERR_MAX_BYTES}.
   */
  stderrMaxBytes?: number;
  /**
   * Receives each plugin's captured, capped and redacted stderr. When
   * omitted, non-empty captures are re-emitted to the real stderr (still
   * capped and redacted) so diagnostics are never silently lost.
   */
  onPluginStderr?: (capture: PluginStderrCapture) => void;
}

/** Default per-plugin stderr capture cap: 8 KiB (Issue #954). */
export const DEFAULT_PLUGIN_STDERR_MAX_BYTES = 8 * 1024;

/** Marker appended to a capture that hit the byte cap. */
export const PLUGIN_STDERR_TRUNCATION_MARKER = '…[stderr truncated]';

/** Captured stderr for one plugin run (Issue #954). */
export interface PluginStderrCapture {
  pluginId: string;
  /** Redacted text, at most `stderrMaxBytes` bytes plus the truncation marker. */
  text: string;
  /** Total bytes the plugin attempted to write. */
  totalBytes: number;
  /** True when output exceeded the cap and was cut. */
  truncated: boolean;
}

/**
 * Run `fn` while intercepting `process.stderr.write`, keeping at most
 * `maxBytes` bytes and redacting secrets/addresses with `redactString`
 * (the same policy as the logger). The original writer is always restored,
 * even when `fn` throws.
 *
 * Redaction runs on the capped buffer *before* the marker is appended; a
 * secret straddling the cap boundary is cut, so only a partial prefix can
 * survive, and the redaction regexes still mask complete matches.
 */
export function captureStderr<T>(
  fn: () => T,
  maxBytes: number = DEFAULT_PLUGIN_STDERR_MAX_BYTES,
): { value: T; capture: Omit<PluginStderrCapture, 'pluginId'> } {
  const cap = Math.max(0, Math.floor(maxBytes));
  const chunks: Buffer[] = [];
  let kept = 0;
  let totalBytes = 0;
  const original = process.stderr.write;
  const intercept = (chunk: unknown, encodingOrCb?: unknown, cb?: unknown): boolean => {
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(String(chunk), typeof encodingOrCb === 'string' ? (encodingOrCb as BufferEncoding) : 'utf8');
    totalBytes += buf.length;
    if (kept < cap) {
      const slice = buf.subarray(0, cap - kept);
      chunks.push(slice);
      kept += slice.length;
    }
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    if (typeof callback === 'function') (callback as () => void)();
    return true;
  };
  process.stderr.write = intercept as typeof process.stderr.write;
  const finish = () => {
    const truncated = totalBytes > cap;
    // Drop a trailing partial UTF-8 sequence produced by the byte cut.
    let text = Buffer.concat(chunks).toString('utf8').replace(/\uFFFD+$/, '');
    text = redactString(text);
    return { text: truncated ? text + PLUGIN_STDERR_TRUNCATION_MARKER : text, totalBytes, truncated };
  };
  try {
    const value = fn();
    process.stderr.write = original;
    return { value, capture: finish() };
  } catch (err) {
    process.stderr.write = original;
    const capture = finish();
    if (err && typeof err === 'object') {
      (err as { pluginStderr?: typeof capture }).pluginStderr = capture;
    }
    throw err;
  }
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

 Clarify whether plugins may perform network I/O, which hosts are allowlisted, and how SSRF controls apply. Add a negative test if enforcement exists.
 *
 * Timeout boundary
 * ----------------
 * Each plugin is bounded by its own `plugin.timeoutMs` when set, or
 * `options.timeoutMs` (default {@link DEFAULT_PLUGIN_TIMEOUT_MS}) otherwise.
 * A plugin that exceeds its budget is recorded as a failed check with a
 * stable `timed out after Nms` message and the remaining plugins still run.
 *
 * This boundary is a post-hoc wall-clock measurement around a synchronous
 * `run()` call, not preemptive cancellation: the runner cannot interrupt a
 * plugin that is still executing (plugins are synchronous by contract, see
 * `CheckPlugin.run` in `src/plugin.ts`), so it fails the *check* closed as
 * soon as the call returns late, rather than stalling the job indefinitely
 * on a plugin that genuinely hangs forever. There is no separate CPU or
 * memory limit — plugins run in the same process and share the Actions
 * runner's own resource ceiling. See "Resource limits" in
 * `docs/PLUGIN_ARCHITECTURE.md` for the full operator-facing explanation.
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
export function runPlugins(
  ctx: CheckPluginContext,
  registry: PluginRegistry = defaultRegistry,
  options: RunPluginsOptions = {},
): ValidationResult {
  const plugins = registry.list();
  const timeoutMs = options.timeoutMs ?? DEFAULT_PLUGIN_TIMEOUT_MS;
  const stderrMaxBytes = options.stderrMaxBytes ?? DEFAULT_PLUGIN_STDERR_MAX_BYTES;
  const emitStderr = (pluginId: string, capture: Omit<PluginStderrCapture, 'pluginId'> | undefined) => {
    if (!capture || capture.totalBytes === 0) return;
    const entry: PluginStderrCapture = { pluginId, ...capture };
    if (options.onPluginStderr) {
      options.onPluginStderr(entry);
    } else {
      process.stderr.write(`[plugin ${pluginId} stderr] ${entry.text}\n`);
    }
  };

  // Run each plugin, wrapping any unexpected throw so one bad plugin
  // cannot silently kill the whole action.
  const pluginOutputs = plugins.map((plugin) => {
    try {
      // A plugin's own `timeoutMs` (see `CheckPlugin.timeoutMs` in
      // `src/plugin.ts`) overrides the runner-wide default so a plugin
      // that's known to be slower or faster than average can declare its
      // own budget without changing the default for every other plugin.
      const { value, capture } = captureStderr(
        () => runWithTimeout(plugin, ctx, plugin.timeoutMs ?? timeoutMs),
        stderrMaxBytes,
      );
      emitStderr(plugin.id, capture);
      return { plugin, result: value };
    } catch (err) {
      emitStderr(plugin.id, (err as { pluginStderr?: Omit<PluginStderrCapture, 'pluginId'> } | null)?.pluginStderr);
      const message = redactString(err instanceof Error ? err.message : String(err));
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
 * Run a single plugin, enforcing a synchronous timeout boundary.
 *
 * Plugins are synchronous by contract, so we measure elapsed wall-clock
 * time around `plugin.run(ctx)` and fail closed when the budget is
 * exceeded. This keeps the runner deterministic and testable without
 * introducing async plumbing into the plugin ABI.
 */
function runWithTimeout(
  plugin: CheckPlugin,
  ctx: CheckPluginContext,
  timeoutMs: number,
): ReturnType<CheckPlugin['run']> {
  const startedAt = Date.now();
  const result = plugin.run(ctx);
  const elapsed = Date.now() - startedAt;

  if (elapsed > timeoutMs) {
    return {
      passed: false,
      detail: `Plugin \`${plugin.id}\` timed out after ${timeoutMs}ms.`,
      remediation: `Contact the plugin author to fix \`${plugin.id}\`.`,
    };
  }

  return result;
}

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
