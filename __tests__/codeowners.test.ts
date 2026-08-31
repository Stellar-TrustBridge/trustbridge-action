import * as fs from 'fs';
import * as path from 'path';
import {
  parseCodeowners,
  normalizeOwnerHandle,
  loadCodeowners,
  isMaintainerActor,
} from '../src/codeowners';

describe('parseCodeowners', () => {
  it('parses direct usernames and teams with leading @', () => {
    const content = `
# Global owners
* @alice @org/maintainers @bob
# Docs
/docs/ @charlie
`;
    const owners = parseCodeowners(content);
    expect(owners.has('alice')).toBe(true);
    expect(owners.has('org/maintainers')).toBe(true);
    expect(owners.has('bob')).toBe(true);
    expect(owners.has('charlie')).toBe(true);
    expect(owners.size).toBe(4);
  });

  it('handles empty and comment-only content without throwing', () => {
    expect(parseCodeowners('').size).toBe(0);
    expect(parseCodeowners('# Only comments\n# Another comment').size).toBe(0);
  });

  it('normalizes handles to lowercase', () => {
    const content = '* @Alice @ORG/TEAM';
    const owners = parseCodeowners(content);
    expect(owners.has('alice')).toBe(true);
    expect(owners.has('org/team')).toBe(true);
  });

  it('handles inline comments on rule lines', () => {
    const content = '* @alice @bob # trailing inline comment';
    const owners = parseCodeowners(content);
    expect(owners.has('alice')).toBe(true);
    expect(owners.has('bob')).toBe(true);
    expect(owners.has('trailing')).toBe(false);
    expect(owners.has('inline')).toBe(false);
  });
});

describe('normalizeOwnerHandle', () => {
  it('strips leading @ and lowercases', () => {
    expect(normalizeOwnerHandle('@User1')).toBe('user1');
    expect(normalizeOwnerHandle('user2')).toBe('user2');
    expect(normalizeOwnerHandle('@org/TeamA')).toBe('org/teama');
  });
});

describe('isMaintainerActor', () => {
  const codeowners = new Set(['alice', 'org/core-team', 'bob']);

  it('returns true when actor is in CODEOWNERS directly', () => {
    expect(isMaintainerActor('alice', codeowners)).toBe(true);
    expect(isMaintainerActor('ALICE', codeowners)).toBe(true);
    expect(isMaintainerActor('@alice', codeowners)).toBe(true);
  });

  it('returns true when actor matches team sub-name', () => {
    expect(isMaintainerActor('core-team', codeowners)).toBe(true);
  });

  it('returns true when actor is in maintainersAllowlist', () => {
    expect(isMaintainerActor('charlie', codeowners, ['@charlie', 'david'])).toBe(true);
    expect(isMaintainerActor('david', codeowners, ['@charlie', 'david'])).toBe(true);
  });

  it('returns false when actor is not a maintainer', () => {
    expect(isMaintainerActor('random-contributor', codeowners)).toBe(false);
    expect(isMaintainerActor('', codeowners)).toBe(false);
  });
});

describe('loadCodeowners branch safety', () => {
  const mockOctokit = {
    rest: {
      repos: {
        getContent: jest.fn(),
      },
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fetches from remote base branch when isForkPr is true', async () => {
    const base64Codeowners = Buffer.from('* @remote-maintainer').toString('base64');
    mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
      data: { content: base64Codeowners },
    });

    const owners = await loadCodeowners({
      isForkPr: true,
      githubToken: 'ghp_mocktoken',
      octokit: mockOctokit as any,
      baseRef: 'main',
      owner: 'Stellar-TrustBridge',
      repo: 'trustbridge-action',
    });

    expect(mockOctokit.rest.repos.getContent).toHaveBeenCalledWith({
      owner: 'Stellar-TrustBridge',
      repo: 'trustbridge-action',
      path: '.github/CODEOWNERS',
      ref: 'main',
    });
    expect(owners.has('remote-maintainer')).toBe(true);
  });

  it('fails safe (returns empty set) if fork PR has no token', async () => {
    const owners = await loadCodeowners({
      isForkPr: true,
      githubToken: '',
    });

    expect(owners.size).toBe(0);
  });
});
