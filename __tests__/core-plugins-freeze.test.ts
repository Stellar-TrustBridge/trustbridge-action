/**
 * Freeze test for built-in plugin registration (Issue #781).
 *
 * `src/corePlugins.ts` and the "Built-in plugins" table in
 * `docs/PLUGIN_ARCHITECTURE.md` must list the same ids, labels and order.
 */

import * as fs from 'fs';
import * as path from 'path';
import { corePlugins, CORE_PLUGIN_IDS, registerCorePlugins } from '../src/corePlugins';
import { defaultRegistry } from '../src/plugin';

// Registration does not touch Horizon; mock it so this test only depends on
// the plugin list itself.
jest.mock('../src/horizon', () => ({
  getNativeBalance: jest.fn(),
  hasTrustline: jest.fn(),
  parseHorizonBalance: jest.fn(),
}));

const DOC_PATH = path.join(__dirname, '..', 'docs', 'PLUGIN_ARCHITECTURE.md');

interface DocRow {
  order: number;
  id: string;
  label: string;
}

function parseBuiltinPluginTable(markdown: string): DocRow[] {
  const section = markdown.split(/^## Built-in plugins\s*$/m)[1];
  if (section === undefined) throw new Error('docs/PLUGIN_ARCHITECTURE.md is missing a "## Built-in plugins" section');
  const body = section.split(/^## /m)[0];
  const rows: DocRow[] = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^\|\s*(\d+)\s*\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|\s*$/);
    if (m) rows.push({ order: Number(m[1]), id: m[2], label: m[3] });
  }
  if (rows.length === 0) throw new Error('"## Built-in plugins" table has no rows');
  return rows;
}

describe('core plugin registration freeze (Issue #781)', () => {
  const docRows = parseBuiltinPluginTable(fs.readFileSync(DOC_PATH, 'utf8'));

  it('matches the documented ids, labels and order', () => {
    expect(corePlugins.map((p, i) => ({ order: i + 1, id: p.id, label: p.label }))).toEqual(docRows);
  });

  it('freezes the id list', () => {
    expect(CORE_PLUGIN_IDS).toEqual([
      'trustbridge/account-funded',
      'trustbridge/trustline',
      'trustbridge/xlm-reserve',
      'trustbridge/home-domain',
    ]);
    expect(Object.isFrozen(CORE_PLUGIN_IDS)).toBe(true);
  });

  it('has unique ids under the reserved trustbridge/ prefix', () => {
    expect(new Set(CORE_PLUGIN_IDS).size).toBe(CORE_PLUGIN_IDS.length);
    for (const id of CORE_PLUGIN_IDS) expect(id.startsWith('trustbridge/')).toBe(true);
  });

  it('registers every documented plugin with the default registry', () => {
    registerCorePlugins();
    const registered = defaultRegistry.list().map((p) => p.id);
    for (const row of docRows) expect(registered).toContain(row.id);
  });

  it('detects drift when a plugin is missing from the docs', () => {
    const drifted = docRows.slice(0, -1);
    expect(corePlugins.map((p, i) => ({ order: i + 1, id: p.id, label: p.label }))).not.toEqual(drifted);
  });

  it('fails with a clear error when the docs section is missing or empty', () => {
    expect(() => parseBuiltinPluginTable('# Plugins\n')).toThrow(/missing a "## Built-in plugins" section/);
    expect(() => parseBuiltinPluginTable('## Built-in plugins\n\nnothing\n')).toThrow(/has no rows/);
  });
});
