/**
 * Issue #778 — MAINTAINER_CHECKLIST documents the Wave freeze labeling steps
 * and stays linked from USAGE and FAQ.
 */
import * as fs from 'fs';
import * as path from 'path';

const read = (file: string) => fs.readFileSync(path.join(__dirname, '..', 'docs', file), 'utf8');
const readRoot = (file: string) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

/** Names of the 2-space-indented keys under a top-level block such as `inputs:` in action.yml. */
function topLevelKeys(yml: string, block: string): string[] {
  const lines = yml.split('\n');
  const start = lines.indexOf(`${block}:`);
  if (start < 0) return [];
  const keys: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = /^ {2}([a-z_]+):/.exec(line);
    if (match) keys.push(match[1]);
  }
  return keys;
}

describe('Wave freeze labeling docs (#778)', () => {
  const checklist = read('MAINTAINER_CHECKLIST.md');

  it('lists label, snooze, freeze and unfreeze steps in order', () => {
    const section = checklist.split('## Wave freeze labeling')[1];
    expect(section).toBeDefined();
    const order = ['**Label**', '**Snooze**', '**Freeze**', '**Unfreeze**'].map((s) => section.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('only references inputs or outputs that exist in action.yml', () => {
    const actionYml = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');
    // The label-gate composite action (.github/actions/trustbridge-label-gate)
    // owns `force_validation` and `gate_skipped`, which the Wave section documents.
    const gateYml = fs.readFileSync(
      path.join(__dirname, '..', '.github', 'actions', 'trustbridge-label-gate', 'action.yml'),
      'utf8',
    );
    const known = new Set(
      [actionYml, gateYml].flatMap((yml) => [...topLevelKeys(yml, 'inputs'), ...topLevelKeys(yml, 'outputs')]),
    );
    const section = checklist.split('## Wave freeze labeling')[1];
    const names = [...section.matchAll(/`([a-z_]+)(?::[^`]*)?`/g)].map((m) => m[1]).filter((n) => n.includes('_'));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(known.has(name)).toBe(true);
    }
  });

  it('is linked from USAGE and FAQ', () => {
    expect(read('USAGE.md')).toContain('MAINTAINER_CHECKLIST.md');
    expect(read('FAQ.md')).toMatch(/\{#wave-freeze\}[\s\S]*MAINTAINER_CHECKLIST\.md/);
  });
});

// Issue #923: dist/ refresh and release verification docs stay consistent with
// refresh-dist.yml, ci.yml and package.json.
describe('dist refresh verification docs (#923)', () => {
  const checklist = read('MAINTAINER_CHECKLIST.md');
  const release = read('RELEASE_CHECKLIST.md');
  const packageScripts = JSON.parse(readRoot('package.json')).scripts as Record<string, string>;

  const section = () => {
    const start = checklist.indexOf('## Verify dist/ before tagging a release');
    const end = checklist.indexOf('## Wave freeze labeling');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return checklist.slice(start, end);
  };

  it('every npm script run by refresh-dist.yml exists in package.json', () => {
    const workflow = readRoot('.github/workflows/refresh-dist.yml');
    const scripts = [...workflow.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]);
    expect(scripts).toEqual(expect.arrayContaining(['build', 'test:map-paths']));
    for (const script of scripts) {
      expect(packageScripts).toHaveProperty([script]);
    }
  });

  it('every npm run command in the maintainer checklist exists in package.json', () => {
    const commands = [...section().matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]);
    expect(commands.length).toBeGreaterThan(0);
    for (const script of commands) {
      expect(packageScripts).toHaveProperty([script]);
    }
  });

  it('documents the refresh, manifest and tag-contents steps in order', () => {
    const body = section();
    const from = body.indexOf('Before you tag');
    expect(from).toBeGreaterThanOrEqual(0);
    const order = ['refresh-dist.yml', 'npm run build', 'npm run test:map-paths', 'npm run verify:dist', 'git log -1'].map((s) =>
      body.indexOf(s, from),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('keeps the CI drift rule the checklist describes', () => {
    expect(readRoot('.github/workflows/ci.yml')).toContain('dist/ is out of date with src/');
    expect(section()).toContain('dist/ is out of date');
  });

  it('RELEASE_CHECKLIST links to the dist section and the heading exists', () => {
    expect(release).toContain('MAINTAINER_CHECKLIST.md#verify-dist-before-tagging-a-release');
    expect(checklist).toContain('## Verify dist/ before tagging a release');
  });
});
