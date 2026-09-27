import * as fs from 'fs';
import * as path from 'path';

/**
 * Plugin loader with cross-platform path resolution.
 *
 * Path rules (see docs/PLUGIN_ARCHITECTURE.md):
 * - Always join paths with `path.join`/`path.resolve`; never hardcode `/`.
 * - Resolve relative plugin paths against the provided base directory
 *   (defaults to `process.cwd()`), not against an assumed working directory.
 * - Normalize separators so Windows-style (`\`) and Unix-style (`/`) inputs
 *   both resolve to the same canonical path.
 */

export interface PluginManifest {
  name: string;
  entry: string;
  [key: string]: unknown;
}

export interface LoadedPlugin {
  name: string;
  entry: string;
  manifest: PluginManifest;
}

/**
 * Normalize a path so that both Windows-style and Unix-style separators are
 * handled consistently regardless of the host platform.
 */
export function normalizePluginPath(input: string): string {
  if (!input) {
    return input;
  }
  // Convert any backslashes to forward slashes first so that Windows-style
  // separators are understood even when running on a Unix host (and vice
  // versa), then let path.normalize apply the platform-specific rules.
  const unified = input.replace(/\\/g, '/');
  return path.normalize(unified);
}

/**
 * Resolve a plugin path against a base directory in a cross-platform way.
 * Absolute paths are returned normalized; relative paths are resolved against
 * `baseDir` (defaulting to the current working directory).
 */
export function resolvePluginPath(pluginPath: string, baseDir?: string): string {
  const normalized = normalizePluginPath(pluginPath);
  if (path.isAbsolute(normalized)) {
    return normalized;
  }
  const base = baseDir ? normalizePluginPath(baseDir) : process.cwd();
  return path.resolve(base, normalized);
}

/**
 * Load a plugin manifest from disk, resolving its entry path relative to the
 * manifest location so plugins work regardless of the caller's cwd.
 */
export function loadPlugin(pluginPath: string, baseDir?: string): LoadedPlugin {
  const manifestPath = resolvePluginPath(pluginPath, baseDir);
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw) as PluginManifest;

  const manifestDir = path.dirname(manifestPath);
  const entry = resolvePluginPath(manifest.entry, manifestDir);

  return {
    name: manifest.name,
    entry,
    manifest,
  };
}
