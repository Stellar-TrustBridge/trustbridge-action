/**
 * Issue #779 — dry-run preflight output snapshot for missing permissions.
 */
import { formatMissingPermissionsDryRun } from '../src/preflight';

jest.mock('@actions/github', () => ({ context: { payload: {}, repo: { owner: 'o', repo: 'r' } } }));

describe('formatMissingPermissionsDryRun (#779)', () => {
  it('snapshots missing issues: write', () => {
    expect(formatMissingPermissionsDryRun(['issues: write'])).toMatchSnapshot();
  });

  it('snapshots missing issues: write and id-token: write', () => {
    expect(formatMissingPermissionsDryRun(['issues: write', 'id-token: write', 'issues: write'])).toMatchSnapshot();
  });

  it('returns an empty string when nothing is missing (happy path)', () => {
    expect(formatMissingPermissionsDryRun([])).toBe('');
  });

  it('rejects unknown permissions with a stable error', () => {
    expect(() => formatMissingPermissionsDryRun(['contents: write'])).toThrow(
      'preflight: unknown permission "contents: write"',
    );
  });
});
