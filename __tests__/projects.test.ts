import { updateProjectV2Status, matchesRepoAllowlist } from '../src/projects';
import * as core from '@actions/core';
import { logger } from '../src/logger';

jest.mock('@actions/core');
jest.mock('../src/logger');

describe('updateProjectV2Status', () => {
  const mockGraphql = jest.fn();
  const mockOctokit = { graphql: mockGraphql };

  beforeEach(() => {
    mockGraphql.mockReset();
    jest.clearAllMocks();
  });

  it('updates project status (happy path, single-select)', async () => {
    mockGraphql.mockResolvedValueOnce({
      node: {
        fields: {
          nodes: [
            {
              id: 'field-1',
              name: 'Status',
              options: [
                { id: 'opt-1', name: 'Done' }
              ]
            }
          ]
        }
      }
    });

    mockGraphql.mockResolvedValueOnce({
      addProjectV2ItemById: {
        item: { id: 'item-1' }
      }
    });

    mockGraphql.mockResolvedValueOnce({});

    const result = await updateProjectV2Status({
      octokit: mockOctokit as any,
      projectId: 'proj-1',
      contentNodeId: 'content-1',
      targetStatusValue: 'Done'
    });

    expect(result).toEqual({ updated: true, itemId: 'item-1' });
    expect(mockGraphql).toHaveBeenCalledTimes(3);
  });

  it('updates project status (happy path, text field)', async () => {
    mockGraphql.mockResolvedValueOnce({
      node: {
        fields: {
          nodes: [
            {
              id: 'field-1',
              name: 'Status'
            }
          ]
        }
      }
    });

    mockGraphql.mockResolvedValueOnce({
      addProjectV2ItemById: {
        item: { id: 'item-1' }
      }
    });

    mockGraphql.mockResolvedValueOnce({});

    const result = await updateProjectV2Status({
      octokit: mockOctokit as any,
      projectId: 'proj-1',
      contentNodeId: 'content-1',
      targetStatusValue: 'Done'
    });

    expect(result).toEqual({ updated: true, itemId: 'item-1' });
  });

  it('handles missing project or missing fields', async () => {
    mockGraphql.mockResolvedValueOnce({ node: null });

    const result = await updateProjectV2Status({
      octokit: mockOctokit as any,
      projectId: 'proj-1',
      contentNodeId: 'content-1',
      targetStatusValue: 'Done'
    });

    expect(result.updated).toBe(false);
    expect(result.error).toMatch(/not found or lacks readable fields/);
    expect(core.warning).toHaveBeenCalled();
  });

  it('handles missing status option', async () => {
    mockGraphql.mockResolvedValueOnce({
      node: {
        fields: {
          nodes: [
            {
              id: 'field-1',
              name: 'Status',
              options: [
                { id: 'opt-1', name: 'In Progress' }
              ]
            }
          ]
        }
      }
    });

    mockGraphql.mockResolvedValueOnce({
      addProjectV2ItemById: {
        item: { id: 'item-1' }
      }
    });

    mockGraphql.mockResolvedValueOnce({});

    const result = await updateProjectV2Status({
      octokit: mockOctokit as any,
      projectId: 'proj-1',
      contentNodeId: 'content-1',
      targetStatusValue: 'Done'
    });

    expect(result.updated).toBe(false);
    expect(result.error).toMatch(/Option "Done" not found/);
    expect(core.warning).toHaveBeenCalled();
  });

  it('soft-fails on GraphQL errors (does not throw)', async () => {
    mockGraphql.mockRejectedValueOnce(new Error('Resource not accessible by integration'));

    const result = await updateProjectV2Status({
      octokit: mockOctokit as any,
      projectId: 'proj-1',
      contentNodeId: 'content-1',
      targetStatusValue: 'Done'
    });

    expect(result.updated).toBe(false);
    expect(result.error).toMatch(/Resource not accessible/);
    expect(core.warning).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// matchesRepoAllowlist (Issue #855)
// ---------------------------------------------------------------------------

describe('matchesRepoAllowlist', () => {
  describe('exact owner/repo patterns', () => {
    it('matches an exact owner/repo pattern', () => {
      const result = matchesRepoAllowlist('Stellar-TrustBridge/trustbridge-action', [
        'Stellar-TrustBridge/trustbridge-action',
      ]);
      expect(result.allowed).toBe(true);
      expect(result.matchedPattern).toBe('Stellar-TrustBridge/trustbridge-action');
    });

    it('is case-insensitive on both owner and repo segments', () => {
      expect(matchesRepoAllowlist('stellar-trustbridge/TRUSTBRIDGE-ACTION', [
        'Stellar-TrustBridge/trustbridge-action',
      ]).allowed).toBe(true);
    });

    it('rejects a repo in the same org that is not individually listed', () => {
      const result = matchesRepoAllowlist('Stellar-TrustBridge/some-other-repo', [
        'Stellar-TrustBridge/trustbridge-action',
      ]);
      expect(result.allowed).toBe(false);
    });

    it('rejects an unrelated fork with the same repo name under a different owner', () => {
      const result = matchesRepoAllowlist('random-fork-owner/trustbridge-action', [
        'Stellar-TrustBridge/trustbridge-action',
      ]);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('does not match');
    });
  });

  describe('org-wide patterns', () => {
    it('matches every repo under a bare org pattern', () => {
      expect(matchesRepoAllowlist('MyOrg/repo-a', ['MyOrg']).allowed).toBe(true);
      expect(matchesRepoAllowlist('MyOrg/repo-b', ['MyOrg']).allowed).toBe(true);
    });

    it('matches every repo under an explicit "owner/*" pattern', () => {
      const result = matchesRepoAllowlist('MyOrg/repo-a', ['MyOrg/*']);
      expect(result.allowed).toBe(true);
      expect(result.matchedPattern).toBe('MyOrg/*');
    });

    it('does not let an org-wide pattern leak into a different org', () => {
      expect(matchesRepoAllowlist('OtherOrg/repo-a', ['MyOrg']).allowed).toBe(false);
      expect(matchesRepoAllowlist('OtherOrg/repo-a', ['MyOrg/*']).allowed).toBe(false);
    });
  });

  describe('ambiguous glob rejection (fail-closed)', () => {
    it.each([
      '*',
      '*/repo',
      'owner/re*po',
      'owner/*po',
      'owner/po*',
      '**',
      'owner/**',
      'owner/?epo',
    ])('rejects the ambiguous pattern %j and never matches it', (pattern) => {
      const result = matchesRepoAllowlist('owner/repo', [pattern]);
      expect(result.allowed).toBe(false);
      expect(result.rejectedPatterns).toEqual([
        expect.objectContaining({ pattern, reason: 'ambiguous_glob' }),
      ]);
    });

    it('rejects a pattern with more than one slash', () => {
      const result = matchesRepoAllowlist('owner/repo', ['owner/repo/extra']);
      expect(result.allowed).toBe(false);
      expect(result.rejectedPatterns).toEqual([
        expect.objectContaining({ pattern: 'owner/repo/extra', reason: 'multiple_slashes' }),
      ]);
    });

    it('a rejected glob never grants access even when it textually overlaps the real repo', () => {
      // Without the glob guard, a naive implementation might treat "owner/*"
      // style patterns permissively; a bare "*" must still be rejected.
      const result = matchesRepoAllowlist('owner/repo', ['*']);
      expect(result.allowed).toBe(false);
    });

    it('one bad pattern does not block matching against the other valid patterns', () => {
      const result = matchesRepoAllowlist('owner/repo', ['*', 'owner/repo']);
      expect(result.allowed).toBe(true);
      expect(result.matchedPattern).toBe('owner/repo');
      expect(result.rejectedPatterns).toHaveLength(1);
    });
  });

  describe('empty allowlist (fail-closed default)', () => {
    it('denies every repository when the allowlist is empty', () => {
      const result = matchesRepoAllowlist('Stellar-TrustBridge/trustbridge-action', []);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('denying by default');
    });

    it('denies every repository when every configured pattern is rejected as invalid', () => {
      const result = matchesRepoAllowlist('owner/repo', ['*', '']);
      expect(result.allowed).toBe(false);
      expect(result.rejectedPatterns).toHaveLength(2);
    });
  });

  describe('renamed repositories (fixture)', () => {
    it('fails closed for an allowlist entry that still names the old repository name', () => {
      // github.context.repo always reports the CURRENT name post-rename, so
      // an allowlist still referencing "old-name" after a rename to
      // "new-name" must simply fail closed — there is no fuzzy/historical
      // matching, by design (see matchesRepoAllowlist's docstring).
      const result = matchesRepoAllowlist('Stellar-TrustBridge/new-name', [
        'Stellar-TrustBridge/old-name',
      ]);
      expect(result.allowed).toBe(false);
    });

    it('an operator who updates the allowlist to the new name regains access', () => {
      const result = matchesRepoAllowlist('Stellar-TrustBridge/new-name', [
        'Stellar-TrustBridge/new-name',
      ]);
      expect(result.allowed).toBe(true);
    });
  });

  describe('archived repositories (documented limitation, fixture)', () => {
    it('matches purely on the owner/repo string — archival status is not encoded in it and is not detected here', () => {
      // An archived repo's `owner/repo` string is unchanged, so a pure
      // string matcher has no signal to act on; this is intentional (see
      // matchesRepoAllowlist's docstring) rather than a gap, and callers
      // that must exclude archived repos check
      // github.context.payload.repository.archived separately.
      const result = matchesRepoAllowlist('Stellar-TrustBridge/archived-repo', [
        'Stellar-TrustBridge/archived-repo',
      ]);
      expect(result.allowed).toBe(true);
    });
  });

  describe('malformed repository input', () => {
    it('rejects a repository string missing the owner segment', () => {
      expect(matchesRepoAllowlist('trustbridge-action', ['owner/trustbridge-action']).allowed).toBe(false);
    });

    it('rejects an empty repository string', () => {
      const result = matchesRepoAllowlist('', ['owner/repo']);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not a well-formed');
    });

    it('rejects a repository string with an extra slash', () => {
      expect(matchesRepoAllowlist('owner/repo/extra', ['owner/repo']).allowed).toBe(false);
    });
  });

  describe('idempotence', () => {
    it('returns the identical result across repeated calls with the same input', () => {
      const a = matchesRepoAllowlist('owner/repo', ['owner/repo', '*']);
      const b = matchesRepoAllowlist('owner/repo', ['owner/repo', '*']);
      expect(a).toEqual(b);
    });
  });
});
