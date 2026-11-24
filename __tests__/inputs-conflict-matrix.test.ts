import {
  INPUT_CONFLICT_MATRIX,
  INPUT_CONFLICT_REASON_CODE,
  assertNoInputConflicts,
  detectInputConflicts,
} from '../src/inputs';
import * as fs from 'fs';
import * as path from 'path';

describe('inputs mutually exclusive conflict matrix (Issue #951)', () => {
  it('happy path: defaults and single flags produce no conflicts', () => {
    expect(detectInputConflicts({})).toEqual([]);
    expect(detectInputConflicts({ preflight_only: 'true' })).toEqual([]);
    expect(detectInputConflicts({ fixture_mode: 'true', preflight_only: 'false' })).toEqual([]);
    expect(() => assertNoInputConflicts({ wait_until_funded: 'true' })).not.toThrow();
  });

  it.each(INPUT_CONFLICT_MATRIX.map((r) => [r.id, r.inputs] as const))(
    'detects %s when both are true',
    (id, [a, b]) => {
      const conflicts = detectInputConflicts({ [a]: 'true', [b]: 'yes' });
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].id).toBe(id);
      expect(conflicts[0].reasonCode).toBe(INPUT_CONFLICT_REASON_CODE);
      expect(conflicts[0].message).toContain(`${a} and ${b} cannot both be true`);
    },
  );

  it('ignores unrecognised / empty values (no false positives)', () => {
    expect(detectInputConflicts({ preflight_only: 'maybe', wait_until_funded: 'true' })).toEqual([]);
    expect(detectInputConflicts({ preflight_only: '', wait_until_funded: '' })).toEqual([]);
  });

  it('reports every conflict in deterministic matrix order', () => {
    const all = { preflight_only: 'true', fixture_mode: '1', wait_until_funded: 'TRUE', use_friendbot: 'yes' };
    expect(detectInputConflicts(all).map((c) => c.id)).toEqual(INPUT_CONFLICT_MATRIX.map((r) => r.id));
    expect(() => assertNoInputConflicts(all)).toThrow(/Conflicting inputs detected \(4\)/);
  });

  it('every matrix input is declared in action.yml and documented', () => {
    const actionYml = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');
    const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'INPUT_VALIDATION.md'), 'utf8');
    for (const rule of INPUT_CONFLICT_MATRIX) {
      for (const name of rule.inputs) expect(actionYml).toMatch(new RegExp(`^  ${name}:`, 'm'));
      expect(doc).toContain(`\`${rule.inputs[0]}\` + \`${rule.inputs[1]}\``);
    }
  });
});
