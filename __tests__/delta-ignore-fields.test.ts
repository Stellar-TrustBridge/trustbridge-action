/**
 * Issue #926: delta ignore-list for volatile fields such as timestamps.
 */
import {
  computeValidationDelta,
  DEFAULT_DELTA_IGNORED_FIELDS,
  formatDeltaMarkdown,
  parseDeltaIgnoreFields,
} from '../src/delta';

describe('computeValidationDelta ignore-list (Issue #926)', () => {
  it('ignores default volatile fields and embedded ISO timestamps', () => {
    const delta = computeValidationDelta(
      { checks: [{ label: 'Trustline', passed: true, checkedAt: '1', detail: 'ok at 2026-01-01T00:00:00Z' }] },
      { checks: [{ label: 'Trustline', passed: true, checkedAt: '2', detail: 'ok at 2026-11-24T10:11:12.345Z' }] },
    );
    expect(DEFAULT_DELTA_IGNORED_FIELDS).toContain('checkedAt');
    expect(delta?.unchanged).toEqual(['Trustline']);
    expect(delta?.changed).toBeUndefined();
    expect(formatDeltaMarkdown(delta)).not.toContain('Details changed');
  });

  it('reports meaningful detail changes that are not on the ignore-list', () => {
    const delta = computeValidationDelta(
      { checks: [{ label: 'XLM reserve', passed: true, detail: 'balance 10' }] },
      { checks: [{ label: 'XLM reserve', passed: true, detail: 'balance 3' }] },
    );
    expect(delta?.changed).toEqual(['XLM reserve']);
    expect(formatDeltaMarkdown(delta)).toContain('**Details changed:** XLM reserve');
  });

  it('honors caller-supplied ignore fields but never ignores status transitions', () => {
    const delta = computeValidationDelta(
      { checks: [{ label: 'A', passed: true, ledger: 1 }, { label: 'B', passed: true }] },
      { checks: [{ label: 'A', passed: true, ledger: 2 }, { label: 'B', passed: false }] },
      { ignoreFields: ['ledger', 'passed', 'label'] },
    );
    expect(delta?.changed).toBeUndefined();
    expect(delta?.newlyFailed).toEqual(['B']);
  });

  it('still returns null on first run', () => {
    expect(computeValidationDelta(null, { checks: [{ label: 'A', passed: true }] })).toBeNull();
  });
});

describe('parseDeltaIgnoreFields', () => {
  it('parses, dedupes and reports invalid names', () => {
    expect(parseDeltaIgnoreFields(' ledger, ledger\nrequest-id ,, ')).toEqual({
      fields: ['ledger'],
      invalid: ['request-id'],
    });
    expect(parseDeltaIgnoreFields(undefined)).toEqual({ fields: [], invalid: [] });
  });
});
