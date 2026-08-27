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
 */
import { CheckPlugin } from './plugin';
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
     */
    allowedPluginPaths?: string[];
    /**
     * When true, emit debug logs for plugin load attempts (paths checked,
     * validation steps, export inspection). Useful for troubleshooting.
     */
    debugMode?: boolean;
}
/**
 * Error thrown when plugin loading fails (validation, file access, or export).
 */
export declare class PluginLoadError extends Error {
    readonly pluginPath: string;
    readonly reason: 'path_traversal' | 'not_found' | 'not_file' | 'invalid_export' | 'load_failed';
    constructor(message: string, pluginPath: string, reason: 'path_traversal' | 'not_found' | 'not_file' | 'invalid_export' | 'load_failed');
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
 * Load multiple plugins from workspace paths with allowlist enforcement.
 *
 * Only paths listed in `allowedPluginPaths` are loaded. Missing or invalid
 * plugins are logged as warnings but do not block the run (fail-open).
 *
 * Returns an array of successfully loaded plugins.
 */
export declare function loadPluginsFromAllowlist(config: PluginLoadConfig): Promise<CheckPlugin[]>;
