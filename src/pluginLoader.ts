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

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import { CheckPlugin, PluginRegistry } from './plugin';

/**
 * Namespace reserved for built-in checks in `src/corePlugins.ts`. External
 * plugins may not use it (Issue #918). Compared case-insensitively.
 */
export const RESERVED_PLUGIN_ID_PREFIX = 'trustbridge/';

/** Longest plugin id accepted from an external plugin (Issue #918). */
export const MAX_PLUGIN_ID_LENGTH = 128;

/**
 * Validate the shape of an external plugin id (Issue #918). Returns a stable
 * reason string, or `null` when the id is acceptable.
 *
 * Rules: non-empty, at most {@link MAX_PLUGIN_ID_LENGTH} characters, no
 * whitespace or control characters. The `<owner>/<check-name>` convention
 * (e.g. `acme/kyc-verified`) is recommended but not enforced here.
 */
export function validatePluginId(id: string): string | null {
  if (id.length === 0) return 'Plugin id must not be empty';
  if (id.length > MAX_PLUGIN_ID_LENGTH) {
    return `Plugin id is ${id.length} characters; the maximum is ${MAX_PLUGIN_ID_LENGTH}`;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(id)) {
    return 'Plugin id must not contain whitespace or control characters';
  }
  return null;
}

/** Case-insensitive collision key for plugin ids. */
function pluginIdKey(id: string): string {
  return id.toLowerCase();
}

/**
 * True when `id` falls in the reserved `trustbridge/` namespace or matches
 * one of `reservedIds` (case-insensitive).
 */
export function isReservedPluginId(id: string, reservedIds: readonly string[] = []): boolean {
  const key = pluginIdKey(id);
  if (key.startsWith(RESERVED_PLUGIN_ID_PREFIX)) return true;
  return reservedIds.some((reserved) => pluginIdKey(reserved) === key);
}

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
export class PluginLoadError extends Error {
  constructor(
    message: string,
    public readonly pluginPath: string,
    public readonly reason:
      | 'path_traversal'
      | 'symlink_escape'
      | 'not_found'
      | 'not_file'
      | 'invalid_export'
      | 'load_failed'
      | 'invalid_id'
      | 'duplicate_id'
      | 'reserved_id',
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
 * Resolve the realpath of a plugin file and ensure it still lives under
 * `workspaceRoot`. This catches symlinks and junctions that lexically appear
 * inside the workspace but whose targets resolve to a path outside it.
 *
 * Must be called *after* confirming the file exists (realpathSync requires
 * the path to exist). Returns `{ valid: true }` or throws-safe
 * `{ valid: false, reason: string }`.
 */
function validateRealpathInsideWorkspace(
  workspaceRoot: string,
  absolutePath: string,
): { valid: true } | { valid: false; reason: string } {
  let realPath: string;
  try {
    realPath = fs.realpathSync(absolutePath);
  } catch {
    // If realpathSync fails (e.g. broken symlink), treat as not_found — the
    // caller already checked existsSync, so a failure here means the symlink
    // is dangling.
    return { valid: false, reason: 'Realpath resolution failed (possible dangling symlink)' };
  }

  const normalizedRoot = path.normalize(workspaceRoot);
  const normalizedReal = path.normalize(realPath);

  // The real path must be the workspace root itself or inside it. Use a
  // separator-aware prefix check so a workspace at /tmp/abc does not
  // accidentally match /tmp/abcdef.
  const rootWithSep = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : normalizedRoot + path.sep;

  if (normalizedReal !== normalizedRoot && !normalizedReal.startsWith(rootWithSep)) {
    return {
      valid: false,
      reason: `Plugin real path ${realPath} escapes workspaceRoot via symlink or junction`,
    };
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
      `Plugin path validation failed: ${'reason' in pathValidation ? pathValidation.reason : 'invalid path'}`,
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

  // Step 3: resolve realpath and confirm it stays inside the workspace.
  // This rejects symlinks and junctions whose targets land outside the
  // workspace root — the lexical path check above is not sufficient because
  // path.resolve does not follow symlinks.
  const realpathValidation = validateRealpathInsideWorkspace(workspaceRoot, absolutePath);
  if (!realpathValidation.valid) {
    throw new PluginLoadError(
      `Plugin path escapes workspaceRoot via symlink or junction: ${'reason' in realpathValidation ? realpathValidation.reason : 'unknown'}`,
      pluginPath,
      'symlink_escape',
    );
  }

  // Step 4: verify it's a regular file (not directory, symlink, socket, etc.)
  const stats = fs.statSync(absolutePath);
  if (!stats.isFile()) {
    throw new PluginLoadError(
      `Plugin path is not a regular file: ${absolutePath}`,
      pluginPath,
      'not_file',
    );
  }

  // Step 5: dynamically load the module. CommonJS plugins load through a
  // plain absolute path (transpiled to require(), which resolves temp
  // workspace paths under both plain Node and Jest). file:// URLs do not
  // survive Jest's transpiled require, so they are only used for ESM (.mjs)
  // plugins, which native import() resolves directly in production.
  let moduleExport: Record<string, unknown> | undefined;
  try {
    if (absolutePath.endsWith('.cjs')) {
      moduleExport = (await import(absolutePath)) as Record<string, unknown>;
    } else {
      const fileUrl = new URL(`file://${absolutePath}`).href;
      // On Windows, file:// URLs need special handling; node's import() handles this
      moduleExport = (await import(fileUrl)) as Record<string, unknown>;
    }
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

  // Step 6: extract and validate the plugin export
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

  // Step 7 (Issue #918): reject malformed ids before they can reach a
  // registry, a comment row, or a collision check.
  const idProblem = validatePluginId(plugin.id);
  if (idProblem !== null) {
    throw new PluginLoadError(`Invalid plugin id: ${idProblem}.`, pluginPath, 'invalid_id');
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
 * Return the allowlisted plugin paths in deterministic discovery order.
 *
 * Ordering is a stable lexicographic sort of the normalized relative path,
 * so the same allowlist always yields the same load order regardless of the
 * order the workflow author listed the paths in.
 */
export function sortPluginPaths(pluginPaths: string[]): string[] {
  return [...pluginPaths].sort((a, b) => {
    const na = path.normalize(a);
    const nb = path.normalize(b);
    if (na < nb) return -1;
    if (na > nb) return 1;
    return 0;
  });
}

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
export async function loadPluginsFromAllowlist(
  config: PluginLoadConfig,
): Promise<CheckPlugin[]> {
  const { workspaceRoot, allowedPluginPaths = [], debugMode = false, reservedIds = [] } = config;

  if (allowedPluginPaths.length === 0) {
    if (debugMode) {
      logger.debug(`No external plugins allowlisted`, { component: 'pluginLoader' });
    }
    return [];
  }

  const orderedPaths = sortPluginPaths(allowedPluginPaths);

  if (debugMode) {
    logger.debug(`Loading ${orderedPaths.length} allowlisted plugins`, {
      component: 'pluginLoader',
      allowedPluginPaths: orderedPaths,
    });
  }

  const loaded: CheckPlugin[] = [];
  const pathById = new Map<string, { id: string; path: string }>();

  for (const pluginPath of orderedPaths) {
    let plugin: CheckPlugin;
    try {
      plugin = await loadPlugin(workspaceRoot, pluginPath, { debugMode });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Skipping plugin ${pluginPath}: ${message}`, {
        component: 'pluginLoader',
        pluginPath,
      });
      continue;
    }

    if (isReservedPluginId(plugin.id, reservedIds)) {
      throw new PluginLoadError(
        `Reserved plugin id "${plugin.id}": ${pluginPath} uses an id reserved for built-in TrustBridge checks. ` +
          `Use your own namespace, e.g. "<org>/<check-name>".`,
        pluginPath,
        'reserved_id',
      );
    }

    const existing = pathById.get(pluginIdKey(plugin.id));
    if (existing !== undefined) {
      const sameCase = existing.id === plugin.id;
      throw new PluginLoadError(
        sameCase
          ? `Duplicate plugin id "${plugin.id}": ${pluginPath} exports the same id as ${existing.path}. Plugin ids must be unique.`
          : `Duplicate plugin id "${plugin.id}": ${pluginPath} collides with "${existing.id}" from ${existing.path} (ids are compared case-insensitively). Plugin ids must be unique.`,
        pluginPath,
        'duplicate_id',
      );
    }

    pathById.set(pluginIdKey(plugin.id), { id: plugin.id, path: pluginPath });
    loaded.push(plugin);
  }

  if (debugMode) {
    logger.debug(`Loaded ${loaded.length} of ${orderedPaths.length} allowlisted plugins`, {
      component: 'pluginLoader',
      pluginIds: loaded.map((p) => p.id),
    });
  }

  return loaded;
}

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
export function registerExternalPlugins(registry: PluginRegistry, plugins: readonly CheckPlugin[]): void {
  const taken = new Map<string, string>();
  for (const existing of registry.list()) {
    taken.set(pluginIdKey(existing.id), existing.id);
  }

  for (const plugin of plugins) {
    if (isReservedPluginId(plugin.id)) {
      throw new PluginLoadError(
        `Reserved plugin id "${plugin.id}": external plugins may not use the "${RESERVED_PLUGIN_ID_PREFIX}" namespace.`,
        plugin.id,
        'reserved_id',
      );
    }
    const clash = taken.get(pluginIdKey(plugin.id));
    if (clash !== undefined) {
      throw new PluginLoadError(
        `Duplicate plugin id "${plugin.id}": collides with already registered plugin "${clash}". Plugin ids must be unique.`,
        plugin.id,
        'duplicate_id',
      );
    }
    taken.set(pluginIdKey(plugin.id), plugin.id);
  }

  for (const plugin of plugins) {
    registry.register(plugin);
  }
}
