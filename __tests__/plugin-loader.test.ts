import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadPlugin, loadPluginsFromAllowlist, PluginLoadError } from '../src/pluginLoader';

// Helpers for symlink tests — skipped on platforms that cannot create symlinks
// without elevated privileges (older Windows without Developer Mode).
function trySymlink(target: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(target, linkPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to create a symlink or Windows junction to `target` at `linkPath`.
 * Returns true on success, false when the OS refuses (e.g. Windows without
 * Developer Mode or SeCreateSymbolicLinkPrivilege).
 *
 * Attempts, in order:
 * 1. Plain symlink (works on Unix and Windows with Dev Mode)
 * 2. 'file' symlink hint (Windows)
 * 3. 'junction' (Windows directory junction — no privilege required for dirs)
 */
function trySymlinkOrJunction(target: string, linkPath: string, type?: 'file' | 'dir' | 'junction'): boolean {
  const attempts: Array<fs.symlink.Type | undefined> = type
    ? [type]
    : [undefined, 'file', 'junction'];

  for (const t of attempts) {
    try {
      if (t) {
        fs.symlinkSync(target, linkPath, t);
      } else {
        fs.symlinkSync(target, linkPath);
      }
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

// Every test works in its own temp workspace, removed afterwards, so the suite
// never touches the repository or depends on files outside the temp dir.
// Fixtures are CommonJS so they load under Jest on every supported Node version.
const workspaces: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trustbridge-plugin-loader-'));
  workspaces.push(dir);
  return dir;
}

function writePlugin(workspaceRoot: string, pluginPath: string, source: string): void {
  const absolutePath = path.join(workspaceRoot, pluginPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, source, 'utf8');
}

function pluginSource(id: string, label = 'KYC verified'): string {
  return `module.exports = {
    id: ${JSON.stringify(id)},
    label: ${JSON.stringify(label)},
    run() { return { passed: true, detail: 'ok' }; }
  };`;
}

afterEach(() => {
  for (const dir of workspaces.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('pluginLoader', () => {
  it('loads a workspace-local plugin from an allowlisted path', async () => {
    const workspaceRoot = makeWorkspace();
    writePlugin(workspaceRoot, 'plugins/kyc.cjs', pluginSource('consumer/kyc-check'));

    const plugin = await loadPlugin(workspaceRoot, 'plugins/kyc.cjs');
    expect(plugin.id).toBe('consumer/kyc-check');
    expect(plugin.label).toBe('KYC verified');
    expect(plugin.run({ account: null, config: {} as never, stellarAddress: 'G' + 'A'.repeat(55) }).passed).toBe(true);
  });

  it('rejects absolute paths', async () => {
    await expect(loadPlugin('C:\\workspace', 'C:\\evil\\kyc.mjs')).rejects.toBeInstanceOf(
      PluginLoadError,
    );
  });

  it('rejects workspace traversal', async () => {
    const workspaceRoot = makeWorkspace();
    await expect(loadPlugin(workspaceRoot, '../outside.mjs')).rejects.toMatchObject({
      reason: 'path_traversal',
    });
  });

  it('skips non-allowlisted plugins', async () => {
    const workspaceRoot = makeWorkspace();
    writePlugin(workspaceRoot, 'plugins/kyc.cjs', pluginSource('consumer/kyc-check'));

    const loaded = await loadPluginsFromAllowlist({
      workspaceRoot,
      allowedPluginPaths: ['plugins/other.cjs'],
    });

    expect(loaded).toEqual([]);
  });

  describe('load failures', () => {
    it('rejects a missing module with reason not_found', async () => {
      const workspaceRoot = makeWorkspace();
      await expect(loadPlugin(workspaceRoot, 'plugins/missing.cjs')).rejects.toMatchObject({
        name: 'PluginLoadError',
        reason: 'not_found',
        pluginPath: 'plugins/missing.cjs',
      });
    });

    it('rejects a directory with reason not_file', async () => {
      const workspaceRoot = makeWorkspace();
      fs.mkdirSync(path.join(workspaceRoot, 'plugins', 'dir.cjs'), { recursive: true });
      await expect(loadPlugin(workspaceRoot, 'plugins/dir.cjs')).rejects.toMatchObject({
        reason: 'not_file',
      });
    });

    it('rejects a module that throws on import with reason load_failed', async () => {
      const workspaceRoot = makeWorkspace();
      writePlugin(workspaceRoot, 'plugins/broken.cjs', `throw new Error('boom at import');`);
      await expect(loadPlugin(workspaceRoot, 'plugins/broken.cjs')).rejects.toMatchObject({
        reason: 'load_failed',
        message: expect.stringContaining('boom at import'),
      });
    });

    it.each([
      ['missing run()', `module.exports = { id: 'x/y', label: 'Y' };`],
      ['empty id', `module.exports = { id: '', label: 'Y', run() {} };`],
      ['non-string label', `module.exports = { id: 'x/y', label: 42, run() {} };`],
      ['no object export', `module.exports = 'not a plugin';`],
    ])('rejects an invalid export (%s) with reason invalid_export', async (_name, source) => {
      const workspaceRoot = makeWorkspace();
      writePlugin(workspaceRoot, 'plugins/invalid.cjs', source);
      await expect(loadPlugin(workspaceRoot, 'plugins/invalid.cjs')).rejects.toMatchObject({
        reason: 'invalid_export',
        message: expect.stringContaining('CheckPlugin interface'),
      });
    });

    it('allowlist loader skips failing plugins and keeps the valid ones', async () => {
      const workspaceRoot = makeWorkspace();
      writePlugin(workspaceRoot, 'plugins/good.cjs', pluginSource('consumer/good'));
      writePlugin(workspaceRoot, 'plugins/invalid.cjs', `module.exports = { id: 'x/y' };`);

      const loaded = await loadPluginsFromAllowlist({
        workspaceRoot,
        allowedPluginPaths: ['plugins/missing.cjs', 'plugins/invalid.cjs', 'plugins/good.cjs'],
      });

      expect(loaded.map((p) => p.id)).toEqual(['consumer/good']);
    });
  });

  describe('duplicate plugin ids', () => {
    it('loads distinct ids in allowlist order', async () => {
      const workspaceRoot = makeWorkspace();
      writePlugin(workspaceRoot, 'plugins/a.cjs', pluginSource('consumer/a'));
      writePlugin(workspaceRoot, 'plugins/b.cjs', pluginSource('consumer/b'));

      const loaded = await loadPluginsFromAllowlist({
        workspaceRoot,
        allowedPluginPaths: ['plugins/a.cjs', 'plugins/b.cjs'],
      });

      expect(loaded.map((p) => p.id)).toEqual(['consumer/a', 'consumer/b']);
    });

    it('fails with a clear duplicate_id error naming both paths', async () => {
      const workspaceRoot = makeWorkspace();
      writePlugin(workspaceRoot, 'plugins/a.cjs', pluginSource('consumer/kyc', 'KYC A'));
      writePlugin(workspaceRoot, 'plugins/b.cjs', pluginSource('consumer/kyc', 'KYC B'));

      const load = loadPluginsFromAllowlist({
        workspaceRoot,
        allowedPluginPaths: ['plugins/a.cjs', 'plugins/b.cjs'],
      });

      await expect(load).rejects.toBeInstanceOf(PluginLoadError);
      await expect(load).rejects.toMatchObject({
        reason: 'duplicate_id',
        pluginPath: 'plugins/b.cjs',
        message:
          'Duplicate plugin id "consumer/kyc": plugins/b.cjs exports the same id as plugins/a.cjs. Plugin ids must be unique.',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Symlink escape tests
  // These tests verify that a symlink (or Windows junction) inside the
  // workspace that points to a file outside the workspace root is rejected —
  // not just the lexical path.
  // ---------------------------------------------------------------------------
  describe('symlink escape prevention', () => {
    it('rejects a symlink that points outside the workspace root', async () => {
      // Create a workspace and a separate "outside" directory with a real plugin.
      const workspaceRoot = makeWorkspace();
      const outsideDir = makeWorkspace();
      const outsidePlugin = path.join(outsideDir, 'evil.cjs');
      fs.writeFileSync(outsidePlugin, pluginSource('evil/escape'), 'utf8');

      // Place a symlink inside the workspace that points to the outside file.
      const pluginsDir = path.join(workspaceRoot, 'plugins');
      fs.mkdirSync(pluginsDir, { recursive: true });
      const symlinkPath = path.join(pluginsDir, 'evil.cjs');

      const created = trySymlinkOrJunction(outsidePlugin, symlinkPath, 'file');
      if (!created) {
        // Skip gracefully on Windows without symlink privilege.
        return;
      }

      await expect(loadPlugin(workspaceRoot, 'plugins/evil.cjs')).rejects.toMatchObject({
        name: 'PluginLoadError',
        reason: 'symlink_escape',
        pluginPath: 'plugins/evil.cjs',
      });
    });

    it('rejects a Windows junction directory that escapes workspace (directory symlink)', async () => {
      // Create a workspace and a separate "outside" directory with a real plugin.
      const workspaceRoot = makeWorkspace();
      const outsideDir = makeWorkspace();
      const outsidePlugin = path.join(outsideDir, 'secret.cjs');
      fs.writeFileSync(outsidePlugin, pluginSource('evil/dir-escape'), 'utf8');

      // Create plugins/ with a junctioned/symlinked subdirectory pointing outside.
      const pluginsDir = path.join(workspaceRoot, 'plugins');
      fs.mkdirSync(pluginsDir, { recursive: true });
      const symlinkDir = path.join(pluginsDir, 'outside');

      // 'junction' works without elevation on Windows for directories.
      const created = trySymlinkOrJunction(outsideDir, symlinkDir, 'junction');
      if (!created) {
        return;
      }

      // The lexical path plugins/outside/secret.cjs is inside plugins/ — only
      // realpath resolution reveals it escapes the workspace.
      await expect(loadPlugin(workspaceRoot, 'plugins/outside/secret.cjs')).rejects.toMatchObject({
        name: 'PluginLoadError',
        reason: 'symlink_escape',
        pluginPath: 'plugins/outside/secret.cjs',
      });
    });

    it('accepts a plugin that is a symlink pointing to a file still inside the workspace', async () => {
      const workspaceRoot = makeWorkspace();
      const realPlugin = path.join(workspaceRoot, 'plugins', 'real.cjs');
      fs.mkdirSync(path.dirname(realPlugin), { recursive: true });
      fs.writeFileSync(realPlugin, pluginSource('consumer/symlinked'), 'utf8');

      const symlinkPath = path.join(workspaceRoot, 'plugins', 'link.cjs');
      const created = trySymlinkOrJunction(realPlugin, symlinkPath, 'file');
      if (!created) {
        return;
      }

      const plugin = await loadPlugin(workspaceRoot, 'plugins/link.cjs');
      expect(plugin.id).toBe('consumer/symlinked');
    });

    it('allowlist loader skips junction-escape plugins with a warning and loads remaining plugins', async () => {
      const workspaceRoot = makeWorkspace();
      const outsideDir = makeWorkspace();
      const outsidePlugin = path.join(outsideDir, 'evil.cjs');
      fs.writeFileSync(outsidePlugin, pluginSource('evil/escape'), 'utf8');

      const pluginsDir = path.join(workspaceRoot, 'plugins');
      fs.mkdirSync(pluginsDir, { recursive: true });

      // Try junction (dir) first; fall back to file symlink.
      const symlinkDir = path.join(pluginsDir, 'outside');
      const createdDir = trySymlinkOrJunction(outsideDir, symlinkDir, 'junction');
      if (!createdDir) {
        // Fall back: try creating a file symlink directly to the plugin.
        const symlinkFile = path.join(pluginsDir, 'evil.cjs');
        const createdFile = trySymlinkOrJunction(outsidePlugin, symlinkFile, 'file');
        if (!createdFile) {
          return; // cannot create any symlink — skip test
        }
        writePlugin(workspaceRoot, 'plugins/good.cjs', pluginSource('consumer/good'));
        const loaded = await loadPluginsFromAllowlist({
          workspaceRoot,
          allowedPluginPaths: ['plugins/evil.cjs', 'plugins/good.cjs'],
        });
        expect(loaded.map((p) => p.id)).toEqual(['consumer/good']);
        return;
      }

      // The good plugin should still load; the junction-escaped one is skipped.
      writePlugin(workspaceRoot, 'plugins/good.cjs', pluginSource('consumer/good'));

      const loaded = await loadPluginsFromAllowlist({
        workspaceRoot,
        allowedPluginPaths: ['plugins/outside/evil.cjs', 'plugins/good.cjs'],
      });

      expect(loaded.map((p) => p.id)).toEqual(['consumer/good']);
    });
  });
});
