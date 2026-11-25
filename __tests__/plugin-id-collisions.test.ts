/**
 * Issue #918 — two plugins registering the same id must fail closed with a
 * clear error. Covers external-vs-external, core-vs-external, case-only
 * collisions, the reserved `trustbridge/` namespace, and malformed ids.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  isReservedPluginId,
  loadPlugin,
  loadPluginsFromAllowlist,
  MAX_PLUGIN_ID_LENGTH,
  PluginLoadError,
  registerExternalPlugins,
  RESERVED_PLUGIN_ID_PREFIX,
  validatePluginId,
} from '../src/pluginLoader';
import { CORE_PLUGIN_IDS, corePlugins } from '../src/corePlugins';
import { CheckPlugin, PluginRegistry } from '../src/plugin';

const workspaces: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trustbridge-plugin-ids-'));
  workspaces.push(dir);
  return dir;
}

function writePlugin(workspaceRoot: string, pluginPath: string, id: string, label = 'External check'): void {
  const absolutePath = path.join(workspaceRoot, pluginPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(
    absolutePath,
    `module.exports = {
      id: ${JSON.stringify(id)},
      label: ${JSON.stringify(label)},
      run() { return { passed: true, detail: 'ok' }; }
    };`,
    'utf8',
  );
}

function plugin(id: string): CheckPlugin {
  return { id, label: `Plugin ${id}`, run: () => ({ passed: true, detail: 'ok' }) };
}

function coreRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  corePlugins.forEach((p) => registry.register(p));
  return registry;
}

afterEach(() => {
  for (const dir of workspaces.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('validatePluginId (Issue #918)', () => {
  it('accepts conventional <owner>/<check-name> ids', () => {
    expect(validatePluginId('acme/kyc-verified')).toBeNull();
    expect(validatePluginId('a'.repeat(MAX_PLUGIN_ID_LENGTH))).toBeNull();
  });

  it.each([
    ['', 'Plugin id must not be empty'],
    ['a'.repeat(MAX_PLUGIN_ID_LENGTH + 1), `Plugin id is ${MAX_PLUGIN_ID_LENGTH + 1} characters; the maximum is ${MAX_PLUGIN_ID_LENGTH}`],
    ['acme/kyc check', 'Plugin id must not contain whitespace or control characters'],
    [' acme/kyc', 'Plugin id must not contain whitespace or control characters'],
    ['acme/kyc\u0000', 'Plugin id must not contain whitespace or control characters'],
  ])('rejects %p with a stable reason', (id, reason) => {
    expect(validatePluginId(id)).toBe(reason);
  });
});

describe('isReservedPluginId (Issue #918)', () => {
  it('reserves the trustbridge/ namespace case-insensitively', () => {
    expect(RESERVED_PLUGIN_ID_PREFIX).toBe('trustbridge/');
    expect(isReservedPluginId('trustbridge/kyc')).toBe(true);
    expect(isReservedPluginId('TrustBridge/Trustline')).toBe(true);
    expect(isReservedPluginId('acme/trustbridge')).toBe(false);
  });

  it('honours an explicit reservedIds list', () => {
    expect(isReservedPluginId('ACME/KYC', ['acme/kyc'])).toBe(true);
    expect(isReservedPluginId('acme/other', ['acme/kyc'])).toBe(false);
  });

  it('every core plugin id is reserved', () => {
    for (const id of CORE_PLUGIN_IDS) {
      expect(isReservedPluginId(id)).toBe(true);
    }
  });
});

describe('loadPlugin rejects malformed ids (Issue #918)', () => {
  it('throws invalid_id for an id containing whitespace', async () => {
    const root = makeWorkspace();
    writePlugin(root, 'plugins/bad.cjs', 'acme/bad id');
    await expect(loadPlugin(root, 'plugins/bad.cjs')).rejects.toMatchObject({
      reason: 'invalid_id',
      message: 'Invalid plugin id: Plugin id must not contain whitespace or control characters.',
    });
  });

  it('throws invalid_id for an oversized id', async () => {
    const root = makeWorkspace();
    writePlugin(root, 'plugins/long.cjs', 'x'.repeat(500));
    await expect(loadPlugin(root, 'plugins/long.cjs')).rejects.toMatchObject({ reason: 'invalid_id' });
  });

  it('allowlist loading skips a malformed id but keeps the valid plugins', async () => {
    const root = makeWorkspace();
    writePlugin(root, 'plugins/a.cjs', 'acme/bad id');
    writePlugin(root, 'plugins/b.cjs', 'acme/good');
    const loaded = await loadPluginsFromAllowlist({
      workspaceRoot: root,
      allowedPluginPaths: ['plugins/a.cjs', 'plugins/b.cjs'],
    });
    expect(loaded.map((p) => p.id)).toEqual(['acme/good']);
  });
});

describe('loadPluginsFromAllowlist id collisions fail closed (Issue #918)', () => {
  it('happy path: distinct external ids load alongside core ids', async () => {
    const root = makeWorkspace();
    writePlugin(root, 'plugins/kyc.cjs', 'acme/kyc');
    writePlugin(root, 'plugins/aml.cjs', 'acme/aml');
    const loaded = await loadPluginsFromAllowlist({
      workspaceRoot: root,
      allowedPluginPaths: ['plugins/kyc.cjs', 'plugins/aml.cjs'],
      reservedIds: CORE_PLUGIN_IDS,
    });
    expect(loaded.map((p) => p.id)).toEqual(['acme/aml', 'acme/kyc']);
  });

  it('rejects an external plugin that reuses a core id (core vs external)', async () => {
    const root = makeWorkspace();
    writePlugin(root, 'plugins/shadow.cjs', 'trustbridge/trustline', 'Always passes');
    const load = loadPluginsFromAllowlist({
      workspaceRoot: root,
      allowedPluginPaths: ['plugins/shadow.cjs'],
      reservedIds: CORE_PLUGIN_IDS,
    });
    await expect(load).rejects.toBeInstanceOf(PluginLoadError);
    await expect(load).rejects.toMatchObject({
      reason: 'reserved_id',
      pluginPath: 'plugins/shadow.cjs',
      message:
        'Reserved plugin id "trustbridge/trustline": plugins/shadow.cjs uses an id reserved for built-in TrustBridge checks. Use your own namespace, e.g. "<org>/<check-name>".',
    });
  });

  it('rejects any id in the trustbridge/ namespace even without reservedIds', async () => {
    const root = makeWorkspace();
    writePlugin(root, 'plugins/ns.cjs', 'TrustBridge/new-check');
    await expect(
      loadPluginsFromAllowlist({ workspaceRoot: root, allowedPluginPaths: ['plugins/ns.cjs'] }),
    ).rejects.toMatchObject({ reason: 'reserved_id' });
  });

  it('rejects ids that differ only by case (external vs external)', async () => {
    const root = makeWorkspace();
    writePlugin(root, 'plugins/a.cjs', 'acme/kyc');
    writePlugin(root, 'plugins/b.cjs', 'ACME/KYC');
    await expect(
      loadPluginsFromAllowlist({
        workspaceRoot: root,
        allowedPluginPaths: ['plugins/a.cjs', 'plugins/b.cjs'],
      }),
    ).rejects.toMatchObject({
      reason: 'duplicate_id',
      pluginPath: 'plugins/b.cjs',
      message:
        'Duplicate plugin id "ACME/KYC": plugins/b.cjs collides with "acme/kyc" from plugins/a.cjs (ids are compared case-insensitively). Plugin ids must be unique.',
    });
  });

  it('fails the same way regardless of allowlist order (deterministic)', async () => {
    const root = makeWorkspace();
    writePlugin(root, 'plugins/a.cjs', 'acme/kyc');
    writePlugin(root, 'plugins/b.cjs', 'acme/kyc');
    for (const order of [
      ['plugins/a.cjs', 'plugins/b.cjs'],
      ['plugins/b.cjs', 'plugins/a.cjs'],
    ]) {
      await expect(
        loadPluginsFromAllowlist({ workspaceRoot: root, allowedPluginPaths: order }),
      ).rejects.toMatchObject({ reason: 'duplicate_id', pluginPath: 'plugins/b.cjs' });
    }
  });

  it('listing the same path twice is a duplicate, not a silent dedupe', async () => {
    const root = makeWorkspace();
    writePlugin(root, 'plugins/a.cjs', 'acme/kyc');
    await expect(
      loadPluginsFromAllowlist({
        workspaceRoot: root,
        allowedPluginPaths: ['plugins/a.cjs', 'plugins/a.cjs'],
      }),
    ).rejects.toMatchObject({ reason: 'duplicate_id' });
  });
});

describe('registerExternalPlugins (Issue #918)', () => {
  it('happy path: registers external plugins after the core plugins', () => {
    const registry = coreRegistry();
    registerExternalPlugins(registry, [plugin('acme/kyc')]);
    expect(registry.list().map((p) => p.id)).toEqual([...CORE_PLUGIN_IDS, 'acme/kyc']);
  });

  it('rejects a plugin that shadows a core check and leaves the registry unchanged', () => {
    const registry = coreRegistry();
    expect(() =>
      registerExternalPlugins(registry, [plugin('acme/kyc'), plugin('trustbridge/xlm-reserve')]),
    ).toThrow(
      expect.objectContaining({
        name: 'PluginLoadError',
        reason: 'reserved_id',
      }),
    );
    // No partial registration: acme/kyc was not added either.
    expect(registry.list().map((p) => p.id)).toEqual([...CORE_PLUGIN_IDS]);
    // The real core check is still the one that runs.
    expect(registry.list().find((p) => p.id === 'trustbridge/xlm-reserve')).toBe(corePlugins[2]);
  });

  it('rejects an id already present in the registry (non-reserved)', () => {
    const registry = new PluginRegistry();
    registry.register(plugin('acme/kyc'));
    expect(() => registerExternalPlugins(registry, [plugin('Acme/KYC')])).toThrow(
      'Duplicate plugin id "Acme/KYC": collides with already registered plugin "acme/kyc". Plugin ids must be unique.',
    );
    expect(registry.size).toBe(1);
  });

  it('rejects two colliding plugins within the same batch', () => {
    const registry = new PluginRegistry();
    expect(() => registerExternalPlugins(registry, [plugin('acme/a'), plugin('acme/a')])).toThrow(
      expect.objectContaining({ reason: 'duplicate_id' }),
    );
    expect(registry.size).toBe(0);
  });

  it('is a no-op for an empty plugin list', () => {
    const registry = coreRegistry();
    registerExternalPlugins(registry, []);
    expect(registry.size).toBe(CORE_PLUGIN_IDS.length);
  });
});
