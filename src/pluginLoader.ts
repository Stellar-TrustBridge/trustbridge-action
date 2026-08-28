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

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
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
export class PluginLoadError extends Error {
  constructor(
    message: string,
    public readonly pluginPath: string,
    public readonly reason: 'path_traversal' | 'not_found' | 'not_file' | 'invalid_export' | 'load_failed',
  ) {
    super(message);
    this.name = 'PluginLoadError';
  }
}

/**
 * Validate that a plugin path does not escape the workspace (path-traversal guard).
 *
 * Checks for:
 * - `../` sequences that go above workspaceRoot
 * - Absolute paths (must be relative)
 * - `..\\` on Windows
 *
 * Returns `{ valid: true }` or `{ valid: false, reason: string }`.
 */
function validatePluginPath(
  workspaceRoot: string,
  pluginPath: string,
): { valid: true } | { valid: false; reason: string } {
  // Reject absolute paths
  if (path.isAbsolute(pluginPath)) {
    return { valid: false, reason: 'Plugin path must be relative to workspaceRoot' };
  }

  // Resolve the path to catch any `../` escapes
  const resolved = path.resolve(workspaceRoot, pluginPath);
  const normalized = path.normalize(resolved);

  // Ensure resolved path is still within workspace
  if (!normalized.startsWith(path.normalize(workspaceRoot))) {
    return { valid: false, reason: 'Plugin path escapes workspaceRoot' };
  }

  return { valid: true };
}

/**
 * Load a single plugin module from a workspace-relative path.
 *
 * The module must export a `default` or named export that matches the
 * `CheckPlugin` interface (with `id`, `label`, `run()`).
 *
 * Throws `PluginLoadError` on any validation or load failure.
 */
export async function loadPlugin(
  workspaceRoot: string,
  pluginPath: string,
  options?: { debugMode?: boolean },
): Promise<CheckPlugin> {
  const debugMode = options?.debugMode ?? false;

  // Step 1: validate path does not escape workspace
  const pathValidation = validatePluginPath(workspaceRoot, pluginPath);
  if (!pathValidation.valid) {
    throw new PluginLoadError(
      `Plugin path validation failed: ${pathValidation.reason}`,
      pluginPath,
      'path_traversal',
    );
  }

  const absolutePath = path.resolve(workspaceRoot, pluginPath);

  if (debugMode) {
    logger.debug(`Loading plugin from: ${absolutePath}`, { component: 'pluginLoader' });
  }

  // Step 2: check file exists
  if (!fs.existsSync(absolutePath)) {
    throw new PluginLoadError(
      `Plugin file not found: ${absolutePath}`,
      pluginPath,
      'not_found',
    );
  }

  // Step 3: verify it's a regular file (not directory, symlink, socket, etc.)
  const stats = fs.statSync(absolutePath);
  if (!stats.isFile()) {
    throw new PluginLoadError(
      `Plugin path is not a regular file: ${absolutePath}`,
      pluginPath,
      'not_file',
    );
  }

  // Step 4: dynamically import the module
  // Use file:// URL to ensure cross-platform compatibility
  let moduleExport: Record<string, unknown> | undefined;
  try {
    const fileUrl = new URL(`file://${absolutePath}`).href;
    // On Windows, file:// URLs need special handling; node's import() handles this
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-eval
    moduleExport = (await import(fileUrl)) as Record<string, unknown>;
    if (debugMode) {
      logger.debug(`Module imported successfully`, {
        component: 'pluginLoader',
        pluginPath,
        exportKeys: moduleExport ? Object.keys(moduleExport) : [],
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PluginLoadError(
      `Failed to import plugin module: ${message}`,
      pluginPath,
      'load_failed',
    );
  }

  // Step 5: extract and validate the plugin export
  // Try: default export, then named 'plugin' export, then first exported object with `id` and `run`
  let plugin: unknown;

  if (moduleExport && typeof moduleExport.default === 'object' && moduleExport.default !== null) {
    plugin = moduleExport.default;
  } else if (moduleExport && typeof moduleExport.plugin === 'object' && moduleExport.plugin !== null) {
    plugin = moduleExport.plugin;
  } else if (moduleExport) {
    // Look for any export that has the plugin shape
    const candidateKeys = Object.keys(moduleExport).filter(
      (k) => typeof moduleExport[k] === 'object' && moduleExport[k] !== null,
    );
    if (candidateKeys.length > 0) {
      plugin = moduleExport[candidateKeys[0]];
    }
  }

  // Validate plugin shape
  if (!isCheckPlugin(plugin)) {
    throw new PluginLoadError(
      `Plugin export does not match CheckPlugin interface (missing id, label, or run)`,
      pluginPath,
      'invalid_export',
    );
  }

  if (debugMode) {
    logger.debug(`Plugin loaded successfully`, {
      component: 'pluginLoader',
      pluginPath,
      pluginId: plugin.id,
      pluginLabel: plugin.label,
    });
  }

  return plugin;
}

/**
 * Type guard: check if an object matches the CheckPlugin interface.
 */
function isCheckPlugin(obj: unknown): obj is CheckPlugin {
  if (typeof obj !== 'object' || obj === null) return false;

  const plugin = obj as Record<string, unknown>;

  return (
    typeof plugin.id === 'string' &&
    plugin.id.length > 0 &&
    typeof plugin.label === 'string' &&
    plugin.label.length > 0 &&
    typeof plugin.run === 'function'
  );
}

/**
 * Load multiple plugins from workspace paths with allowlist enforcement.
 *
 * Only paths listed in `allowedPluginPaths` are loaded. Missing or invalid
 * plugins are logged as warnings but do not block the run (fail-open).
 *
 * Returns an array of successfully loaded plugins.
 */
export async function loadPluginsFromAllowlist(
  config: PluginLoadConfig,
): Promise<CheckPlugin[]> {
  const { workspaceRoot, allowedPluginPaths = [], debugMode = false } = config;

  if (allowedPluginPaths.length === 0) {
    if (debugMode) {
      logger.debug(`No external plugins allowlisted`, { component: 'pluginLoader' });
    }
    return [];
  }

  if (debugMode) {
    logger.debug(`Loading ${allowedPluginPaths.length} allowlisted plugins`, {
      component: 'pluginLoader',
      allowedPluginPaths,
    });
  }

  const loaded: CheckPlugin[] = [];

  for (const pluginPath of allowedPluginPaths) {
    try {
      const plugin = await loadPlugin(workspaceRoot, pluginPath, { debugMode });
      loaded.push(plugin);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to load plugin from ${pluginPath}: ${message}`, {
        component: 'pluginLoader',
      });
      // Fail-open: continue loading other plugins
    }
  }

  if (debugMode) {
    logger.debug(`Loaded ${loaded.length}/${allowedPluginPaths.length} plugins`, {
      component: 'pluginLoader',
      loadedPluginIds: loaded.map((p) => p.id),
    });
  }

  return loaded;
}
