import * as github from '@actions/github';
import {
  STICKY_COMMENT_MARKER,
  TRUSTBRIDGE_FOOTER,
  findStickyComment,
  formatCommentBody,
  postIssueComment,
} from '../src/comment';
import { ValidationResult } from '../src/checks';

jest.mock('@actions/github', () => ({
  context: {
    payload: {},
    repo: { owner: 'test-owner', repo: 'test-repo' },
  },
  getOctokit: jest.fn(),
}));

const validationResult: ValidationResult = {
  valid: false,
  accountFunded: false,
  trustlineExists: false,
  xlmBalance: '0',
  xlmReserveMet: false,
  checks: [
    {
      passed: false,
      label: 'Account funded',
      detail: 'Account was not found.',
    },
  ],
};

const baseConfig = {
  stellarAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  assetCode: 'USDC',
  assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  minXlmReserve: 1.5,
};

describe('TRUSTBRIDGE_FOOTER', () => {
  it('points back to the action repository', () => {
    expect(TRUSTBRIDGE_FOOTER).toContain('trustbridge-action');
  });
});

describe('formatCommentBody', () => {
  it('uses public Stellar Laboratory links for public Horizon', () => {
    const body = formatCommentBody(validationResult, {
      ...baseConfig,
      horizonUrl: 'https://horizon.stellar.org',
    });

    expect(body).toContain('account-viewer?network=public&account=');
    expect(body).toContain('txbuilder?network=public');
  });

  it('uses testnet Stellar Laboratory links for testnet Horizon', () => {
    const body = formatCommentBody(validationResult, {
      ...baseConfig,
      horizonUrl: 'https://horizon-testnet.stellar.org',
    });

    expect(body).toContain('account-viewer?network=testnet&account=');
    expect(body).toContain('txbuilder?network=testnet');
  });

  it('embeds the sticky comment marker', () => {
    const body = formatCommentBody(validationResult, {
      ...baseConfig,
      horizonUrl: 'https://horizon.stellar.org',
    });

    expect(body).toContain(STICKY_COMMENT_MARKER);
  });
});

function makeOctokit(overrides: Record<string, jest.Mock> = {}) {
  return {
    paginate: jest.fn(),
    rest: {
      issues: {
        listComments: jest.fn(),
        createComment: jest.fn(),
        updateComment: jest.fn(),
      },
    },
    ...overrides,
  };
}


describe('findStickyComment', () => {
  it('returns the id of the comment containing the marker', async () => {
    const octokit = makeOctokit();
    octokit.paginate.mockResolvedValue([
      { id: 1, body: 'unrelated comment' },
      { id: 2, body: `${STICKY_COMMENT_MARKER}\nprevious TrustBridge result` },
    ]);

    const id = await findStickyComment(
      octokit as unknown as Parameters<typeof findStickyComment>[0],
      'owner',
      'repo',
      42,
    );

    expect(id).toBe(2);
    expect(octokit.paginate).toHaveBeenCalledWith(
      octokit.rest.issues.listComments,
      expect.objectContaining({ owner: 'owner', repo: 'repo', issue_number: 42 }),
    );
  });

  it('returns undefined when no comment has the marker', async () => {
    const octokit = makeOctokit();
    octokit.paginate.mockResolvedValue([{ id: 1, body: 'unrelated comment' }]);

    const id = await findStickyComment(
      octokit as unknown as Parameters<typeof findStickyComment>[0],
      'owner',
      'repo',
      42,
    );

    expect(id).toBeUndefined();
  });
});

describe('postIssueComment', () => {
  const mockedGithub = github as unknown as {
    context: { payload: { issue?: { number: number } }; repo: { owner: string; repo: string } };
    getOctokit: jest.Mock;
  };

  beforeEach(() => {
    mockedGithub.context.payload = { issue: { number: 7 } };
  });

  it('returns undefined and warns when there is no issue context', async () => {
    mockedGithub.context.payload = {};
    const octokit = makeOctokit();
    mockedGithub.getOctokit.mockReturnValue(octokit);

    const result = await postIssueComment('token', 'body');

    expect(result).toBeUndefined();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('creates a new comment when sticky and no prior comment exists', async () => {
    const octokit = makeOctokit();
    octokit.paginate.mockResolvedValue([]);
    octokit.rest.issues.createComment.mockResolvedValue({
      data: { html_url: 'https://github.com/o/r/issues/7#issuecomment-1' },
    });
    mockedGithub.getOctokit.mockReturnValue(octokit);

    const url = await postIssueComment('token', 'new body', { sticky: true });

    expect(url).toBe('https://github.com/o/r/issues/7#issuecomment-1');
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 7, body: 'new body' }),
    );
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
  });

  it('updates the existing sticky comment instead of creating a new one', async () => {
    const octokit = makeOctokit();
    octokit.paginate.mockResolvedValue([
      { id: 99, body: `${STICKY_COMMENT_MARKER}\nold result` },
    ]);
    octokit.rest.issues.updateComment.mockResolvedValue({
      data: { html_url: 'https://github.com/o/r/issues/7#issuecomment-99' },
    });
    mockedGithub.getOctokit.mockReturnValue(octokit);

    const url = await postIssueComment('token', 'updated body', { sticky: true });

    expect(url).toBe('https://github.com/o/r/issues/7#issuecomment-99');
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 99, body: 'updated body' }),
    );
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('always creates a new comment when sticky is disabled', async () => {
    const octokit = makeOctokit();
    octokit.rest.issues.createComment.mockResolvedValue({
      data: { html_url: 'https://github.com/o/r/issues/7#issuecomment-2' },
    });
    mockedGithub.getOctokit.mockReturnValue(octokit);

    const url = await postIssueComment('token', 'body', { sticky: false });

    expect(url).toBe('https://github.com/o/r/issues/7#issuecomment-2');
    expect(octokit.paginate).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).toHaveBeenCalled();
  });

  it('falls back to creating a new comment when the sticky lookup fails', async () => {
    const octokit = makeOctokit();
    octokit.paginate.mockRejectedValue(new Error('API rate limit exceeded'));
    octokit.rest.issues.createComment.mockResolvedValue({
      data: { html_url: 'https://github.com/o/r/issues/7#issuecomment-3' },
    });
    mockedGithub.getOctokit.mockReturnValue(octokit);

    const url = await postIssueComment('token', 'body', { sticky: true });

    expect(url).toBe('https://github.com/o/r/issues/7#issuecomment-3');
    expect(octokit.rest.issues.createComment).toHaveBeenCalled();
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
  });
});
