/**
 * Golden file regression test for the core plugin registration order
 * (Issue #851).
 *
 * `registerCorePlugins()` seeds `defaultRegistry` with `corePlugins`
 * (src/corePlugins.ts) in array order, before any user plugin is loaded by
 * `pluginLoader.ts`. `runPlugins()` (src/pluginRunner.ts) preserves that same
 * order in the composed `ValidationResult.checks[]` array, which both the
 * comment renderer (`formatCommentBody`) and the SARIF exporter
 * (`src/sarif.ts`, `result.checks.map(...)`) iterate verbatim. A casual
 * reorder of `corePlugins` therefore reorders comment rows and SARIF
 * results even though every check's pass/fail outcome is unchanged --
 * exactly the kind of diff noise `__tests__/__golden__/core-plugin-order.json`
 * exists to catch deliberately, rather than as a surprise in a Wave CI run.
 *
 * `__tests__/core-plugins-freeze.test.ts` already locks `corePlugins`
 * against the "Built-in plugins" table in docs/PLUGIN_ARCHITECTURE.md. This
 * file is the second, independent lock: a standalone golden JSON fixture
 * that must be touched (intentionally) in the same change as any reorder.
 */
import * as fs from 'fs';
import * as path from 'path';
import { corePlugins, registerCorePlugins } from '../src/corePlugins';
import { PluginRegistry } from '../src/plugin';

jest.mock('../src/horizon', () => ({
  getNativeBalance: jest.fn(),
  hasTrustline: jest.fn(),
  parseHorizonBalance: jest.fn(),
}));

const GOLDEN_PATH = path.join(__dirname, '__golden__', 'core-plugin-order.json');

interface GoldenRow {
  order: number;
  id: string;
  label: string;
}

interface GoldenFile {
  plugins: GoldenRow[];
}

function loadGolden(): GoldenFile {
  return JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as GoldenFile;
}

function actualOrder(plugins: typeof corePlugins): GoldenRow[] {
  return plugins.map((p, i) => ({ order: i + 1, id: p.id, label: p.label }));
}

describe('core plugin registration order golden file (Issue #851)', () => {
  it('the golden file exists and is well-formed', () => {
    expect(fs.existsSync(GOLDEN_PATH)).toBe(true);
    const golden = loadGolden();
    expect(Array.isArray(golden.plugins)).toBe(true);
    expect(golden.plugins.length).toBeGreaterThan(0);
  });

  it('src/corePlugins.ts matches the golden order exactly', () => {
    expect(actualOrder(corePlugins)).toEqual(loadGolden().plugins);
  });

  it('registering corePlugins onto a fresh registry preserves the golden order', () => {
    // Exercises the same `forEach(p => registry.register(p))` loop
    // `registerCorePlugins()` runs against `defaultRegistry`, but against a
    // throwaway registry so this test does not depend on global state.
    const registry = new PluginRegistry();
    corePlugins.forEach((p) => registry.register(p));

    expect(registry.list().map((p) => p.id)).toEqual(loadGolden().plugins.map((row) => row.id));
  });

  it('registers every golden plugin id with the real defaultRegistry', () => {
    registerCorePlugins();
    const { defaultRegistry } = require('../src/plugin');
    const registeredIds = defaultRegistry.list().map((p: { id: string }) => p.id);
    for (const row of loadGolden().plugins) {
      expect(registeredIds).toContain(row.id);
    }
  });

  // --- Regression proof: the golden file actually catches drift ---------

  it('fails the comparison when a plugin is appended without updating the golden', () => {
    const driftedCorePlugins = [
      ...corePlugins,
      { id: 'trustbridge/new-check', label: 'New check', run: () => ({ passed: true, detail: '' }) },
    ];
    expect(actualOrder(driftedCorePlugins)).not.toEqual(loadGolden().plugins);
  });

  it('fails the comparison when two plugins are swapped without updating the golden', () => {
    const reordered = [...corePlugins];
    [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
    expect(actualOrder(reordered)).not.toEqual(loadGolden().plugins);
  });

  it('fails the comparison when a plugin is removed without updating the golden', () => {
    const withOneRemoved = corePlugins.slice(1);
    expect(actualOrder(withOneRemoved)).not.toEqual(loadGolden().plugins);
  });
});
