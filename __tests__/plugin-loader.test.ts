import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadPlugin, loadPluginsFromAllowlist, PluginLoadError } from '../src/pluginLoader';

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trustbridge-plugin-loader-'));
}

describe('pluginLoader', () => {
  it('loads a workspace-local plugin from an allowlisted path', async () => {
    const workspaceRoot = makeWorkspace();
    const pluginPath = 'plugins/kyc.mjs';
    const absolutePath = path.join(workspaceRoot, pluginPath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(
      absolutePath,
      `export default {
        id: 'consumer/kyc-check',
        label: 'KYC verified',
        run() { return { passed: true, detail: 'ok' }; }
      };`,
      'utf8',
    );

    const plugin = await loadPlugin(workspaceRoot, pluginPath);
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
    const pluginPath = 'plugins/kyc.mjs';
    const absolutePath = path.join(workspaceRoot, pluginPath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(
      absolutePath,
      `export default {
        id: 'consumer/kyc-check',
        label: 'KYC verified',
        run() { return { passed: true, detail: 'ok' }; }
      };`,
      'utf8',
    );

    const loaded = await loadPluginsFromAllowlist({
      workspaceRoot,
      allowedPluginPaths: ['plugins/other.mjs'],
    });

    expect(loaded).toEqual([]);
  });
});
