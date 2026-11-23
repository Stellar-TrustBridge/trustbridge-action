/**
 * @file pluginLoader.ts
 * Load CheckPlugin modules from workspace-local paths with SSRF/path-traversal
 * hardening and allowlisting.
 *
 * SECURITY MODEL
 * ---------------
 * Plugins are loaded from the workspace only (not from npm, URLs, or node_modules).
 * The loader validates:
 * - Path does not escape the workspace root (no `../../../etc/passwd`)
 * - Path resolves to a regular file (not a directory, symlink, or dev)
 * - File exists and is readable
 * - Module exports a valid `CheckPlugin` interface
 *
 * Plugins are matched against an allowlist before loading. By default, no
 * external plugins are loaded — workflows must opt-in explicitly.
 *
 * DISCOVERY ORDER
 * ---------------
 * Plugins are loaded in a deterministic order: the allowlist is sorted by
 * normalized plugin path (lexicographic, ascending) before loading. This
 * guarantees a stable load order regardless of how the workflow author
 * ordered `allowedPluginPaths`, so CI gates do not silently flip when the
 * allowlist is reordered. The returned array preserves this sorted order.
 *
 * FAILURE ISOLATION
 * -----------------
 * A single bad plugin (missing file, invalid export, malformed id, import
 * error) is logged as a warning and skipped; it never aborts loading of the
 * remaining plugins and never blocks core Horizon checks. Only the offending
 * plugin is dropped.
 *
 * ID COLLISIONS FAIL CLOSED (Issue #918)
 * --------------------------------------
 * Id collisions are the exception: a plugin whose id would shadow another
 * check is never skipped silently, because the shadowed check would simply
 * vanish from the Wave readiness gate. Loading throws a `PluginLoadError`:
 * - `duplicate_id` — two allowlisted plugins export the same id (compared
 *   case-insensitively), or an external id is already in the target
 *   registry (`registerExternalPlugins`).
 * - `reserved_id`  — an external plugin uses the reserved `trustbridge/`
 *   namespace or an id listed in `reservedIds` (core plugin ids).
 */
import { CheckPlugin, PluginRegistry } from './plugin';
/**
 * Namespace reserved for built-in checks in `src/corePlugins.ts`. External
 * plugins may not use it (Issue #918). Compared case-insensitively.
 */
export declare const RESERVED_PLUGIN_ID_PREFIX = "trustbridge/";
/** Longest plugin id accepted from an external plugin (Issue #918). */
export declare const MAX_PLUGIN_ID_LENGTH = 128;
/**
 * Validate the shape of an external plugin id (Issue #918). Returns a stable
 * reason string, or `null` when the id is acceptable.
 *
 * Rules: non-empty, at most {@link MAX_PLUGIN_ID_LENGTH} characters, no
 * whitespace or control characters. The `<owner>/<check-name>` convention
 * (e.g. `acme/kyc-verified`) is recommended but not enforced here.
 */
export declare function validatePluginId(id: string): string | null;
/**
 * True when `id` falls in the reserved `trustbridge/` namespace or matches
 * one of `reservedIds` (case-insensitive).
 */
export declare function isReservedPluginId(id: string, reservedIds?: readonly string[]): boolean;
export interface PluginLoadConfig {
    /**
     * Absolute path to the repository root (e.g., from GITHUB_WORKSPACE).
     * All plugin paths are resolved relative to this root.
     */
    workspaceRoot: string;
    /**
     * Array of allowed plugin paths (relative to workspaceRoot).
     * Empty array (default) means no external plugins are loaded.
     * Example: `['plugins/kyc.ts', 'plugins/custom-reserve.ts']`
     *
     * Paths are loaded in deterministic sorted order (see DISCOVERY ORDER).
     */
    allowedPluginPaths?: string[];
    /**
     * When true, emit debug logs for plugin load attempts (paths checked,
     * validation steps, export inspection). Useful for troubleshooting.
     */
    debugMode?: boolean;
    /**
     * Extra ids external plugins may not use, in addition to the reserved
     * `trustbridge/` namespace — typically `CORE_PLUGIN_IDS` from
     * `src/corePlugins.ts`, or any other ids already registered. A match
     * throws `PluginLoadError` with reason `reserved_id` (Issue #918).
     */
    reservedIds?: readonly string[];
}
/**
 * Error thrown when plugin loading fails (validation, file access, or export).
 */
export declare class PluginLoadError extends Error {
    readonly pluginPath: string;
    readonly reason: 'path_traversal' | 'symlink_escape' | 'not_found' | 'not_file' | 'invalid_export' | 'load_failed' | 'invalid_id' | 'duplicate_id' | 'reserved_id';
    constructor(message: string, pluginPath: string, reason: 'path_traversal' | 'symlink_escape' | 'not_found' | 'not_file' | 'invalid_export' | 'load_failed' | 'invalid_id' | 'duplicate_id' | 'reserved_id');
}
/**
 * Load a single plugin module from a workspace-relative path.
 *
 * The module must export a `default` or named export that matches the
 * `CheckPlugin` interface (with `id`, `label`, `run()`).
 *
 * Throws `PluginLoadError` on any validation or load failure.
 */
export declare function loadPlugin(workspaceRoot: string, pluginPath: string, options?: {
    debugMode?: boolean;
}): Promise<CheckPlugin>;
/**
 * Return the allowlisted plugin paths in deterministic discovery order.
 *
 * Ordering is a stable lexicographic sort of the normalized relative path,
 * so the same allowlist always yields the same load order regardless of the
 * order the workflow author listed the paths in.
 */
export declare function sortPluginPaths(pluginPaths: string[]): string[];
/**
 * Load multiple plugins from workspace paths with allowlist enforcement.
 *
 * Only paths listed in `allowedPluginPaths` are loaded, in deterministic
 * sorted order (see `sortPluginPaths`). Missing or invalid plugins are logged
 * as warnings but do not block the run (fail-open) — a bad plugin is isolated
 * and skipped so core Horizon checks still run.
 *
 * Id collisions fail closed (Issue #918): two plugins exporting the same id
 * (case-insensitive) throw a `PluginLoadError` with reason `duplicate_id`, and
 * a plugin using the reserved `trustbridge/` namespace or an id in
 * `reservedIds` throws with reason `reserved_id`. No partial list is
 * returned when a collision is found.
 *
 * Returns an array of successfully loaded plugins in discovery order.
 */
export declare function loadPluginsFromAllowlist(config: PluginLoadConfig): Promise<CheckPlugin[]>;
/**
 * Register externally loaded plugins into `registry` (typically after
 * `registerCorePlugins()`), failing closed on any id collision (Issue #918).
 *
 * `PluginRegistry.register()` is first-wins and silently ignores a repeated
 * id, which is right for idempotent core registration but would let an
 * external plugin quietly disappear — or, registered first, shadow a core
 * check. This helper checks every plugin against the registry's current
 * contents (case-insensitive) and against the reserved `trustbridge/`
 * namespace **before** registering anything, so a collision leaves the
 * registry unchanged (no partial registration).
 *
 * Throws `PluginLoadError` with reason `reserved_id` or `duplicate_id`.
 */
export declare function registerExternalPlugins(registry: PluginRegistry, plugins: readonly CheckPlugin[]): void;
