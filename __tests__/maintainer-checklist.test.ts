/**
 * Issue #778 — MAINTAINER_CHECKLIST documents the Wave freeze labeling steps
 * and stays linked from USAGE and FAQ.
 */
import * as fs from 'fs';
import * as path from 'path';

const read = (file: string) => fs.readFileSync(path.join(__dirname, '..', 'docs', file), 'utf8');

describe('Wave freeze labeling docs (#778)', () => {
  const checklist = read('MAINTAINER_CHECKLIST.md');

  it('lists label, snooze, freeze and unfreeze steps in order', () => {
    const section = checklist.split('## Wave freeze labeling')[1];
    expect(section).toBeDefined();
    const order = ['**Label**', '**Snooze**', '**Freeze**', '**Unfreeze**'].map((s) => section.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('only references inputs that exist in action.yml', () => {
    const actionYml = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');
    const section = checklist.split('## Wave freeze labeling')[1];
    const inputs = [...section.matchAll(/`([a-z_]+)(?::[^`]*)?`/g)].map((m) => m[1]).filter((n) => n.includes('_'));
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(actionYml).toMatch(new RegExp(`^  ${input}:`, 'm'));
    }
  });

  it('is linked from USAGE and FAQ', () => {
    expect(read('USAGE.md')).toContain('MAINTAINER_CHECKLIST.md');
    expect(read('FAQ.md')).toMatch(/\{#wave-freeze\}[\s\S]*MAINTAINER_CHECKLIST\.md/);
  });
});
