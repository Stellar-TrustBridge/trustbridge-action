import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as github from '@actions/github';
import {
  STICKY_COMMENT_MARKER,
  STICKY_COMMENT_MARKER_LEGACY,
  TRUSTBRIDGE_FOOTER,
  MAX_STICKY_COMMENT_SEARCH_PAGES,
  COMMENT_SIZE_LIMIT_BYTES,
  COMMENT_TRUNCATION_NOTICE_BYTES,
  findStickyComment,
  formatCommentBody,
  isTrustBridgeComment,
  postIssueComment,
  resolveIssueOrPullRequestNumber,
  resolveDiscussionNodeId,
  findStickyDiscussionComment,
  postDiscussionComment,
  buildTruncatedCommentBody,
  writeFullReport,
} from '../src/comment';
import { ValidationResult } from '../src/checks';

jest.mock('@actions/github', () => ({
  context: {
    payload: {},
    repo: { owner: 'test-owner', repo: 'test-repo' },
    apiUrl: 'https://api.github.com',
  },
  getOctokit: jest.fn(),
}));

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  setOutput: jest.fn(),
  setFailed: jest.fn(),
  getInput: jest.fn(),
}));

const validationResult: ValidationResult = {
  valid: false,
  accountFunded: false,
  trustlineExists: false,
  xlmBalance: '0',
  xlmReserveMet: false,
  assetBalance: '0',
  assetBalanceMet: false,
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

describe('formatCommentBody golden snapshots', () => {
  beforeAll(() => {
    // Mock Date.now() to return a fixed timestamp for snapshot consistency
    jest.spyOn(Date, 'now').mockReturnValue(1000000000000);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('matches golden snapshot for successful validation result', () => {
    const successResult: ValidationResult = {
      valid: true,
      accountFunded: true,
      trustlineExists: true,
      xlmBalance: '10.5000000',
      xlmReserveMet: true,
      assetBalance: '50.0',
      assetBalanceMet: true,
      checks: [
        { passed: true, label: 'Account funded', detail: 'Account exists on Horizon.' },
        { passed: true, label: 'USDC trustline', detail: 'Trustline exists with balance 50.0.' },
        { passed: true, label: 'XLM reserve', detail: 'Balance 10.5 XLM >= minimum 1.5 XLM.' },
      ],
    };

    const body = formatCommentBody(successResult, {
      ...baseConfig,
      horizonUrl: 'https://horizon.stellar.org',
    });

    expect(body).toMatchSnapshot();
  });

  it('matches golden snapshot for unfunded account failure path', () => {
    const unfundedResult: ValidationResult = {
      valid: false,
      accountFunded: false,
      trustlineExists: false,
      xlmBalance: '0',
      xlmReserveMet: false,
      assetBalance: '0',
      assetBalanceMet: false,
      checks: [
        { passed: false, label: 'Account funded', detail: 'Account was not found on Horizon (404).' },
        { passed: false, label: 'USDC trustline', detail: 'Cannot check trustline without an active account.' },
        { passed: false, label: 'XLM reserve', detail: 'Cannot check XLM reserve without an active account.' },
      ],
      remediation: 'Send at least 1 XLM to activate account GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF.',
    };

    const body = formatCommentBody(unfundedResult, {
      ...baseConfig,
      horizonUrl: 'https://horizon.stellar.org',
    });

    expect(body).toMatchSnapshot();
  });

  it('matches golden snapshot for missing trustline failure path', () => {
    const missingTrustlineResult: ValidationResult = {
      valid: false,
      accountFunded: true,
      trustlineExists: false,
      xlmBalance: '5.0000000',
      xlmReserveMet: true,
      assetBalance: '0',
      assetBalanceMet: false,
      checks: [
        { passed: true, label: 'Account funded', detail: 'Account exists on Horizon.' },
        { passed: false, label: 'USDC trustline', detail: 'Account does not hold a trustline for USDC.' },
        { passed: true, label: 'XLM reserve', detail: 'Balance 5.0 XLM >= minimum 1.5 XLM.' },
      ],
      remediation: 'Add a trustline for asset USDC issued by GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN.',
    };

    const body = formatCommentBody(missingTrustlineResult, {
      ...baseConfig,
      horizonUrl: 'https://horizon.stellar.org',
    });

    expect(body).toMatchSnapshot();
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

  it('includes a machine-readable validation gate summary', () => {
    const body = formatCommentBody(validationResult, {
      ...baseConfig,
      horizonUrl: 'https://horizon.stellar.org',
    });

    expect(body).toContain('### Validation gate');
    expect(body).toContain('Blocked by: Account funded');
    expect(body).toContain('Passed checks: 0/1');
    expect(body).toContain('Failed checks: 1');
  });

  it('includes onboarding checklist by default with unchecked boxes for failures', () => {
    const body = formatCommentBody(validationResult, {
      ...baseConfig,
      horizonUrl: 'https://horizon.stellar.org',
    });

    expect(body).toContain('### Onboarding checklist');
    expect(body).toContain('- [ ] **Fund account**');
    expect(body).toContain('- [ ] **Add USDC trustline**');
    expect(body).toContain('- [ ] **Verify XLM balance**');
    expect(body).toContain('onboarding_checklist');
  });

  it('omits onboarding checklist when disabled', () => {
    const body = formatCommentBody(validationResult, {
      ...baseConfig,
      horizonUrl: 'https://horizon.stellar.org',
      onboardingChecklist: false,
    });

    expect(body).not.toContain('### Onboarding checklist');
    expect(body).toContain('### Results');
    expect(body).toContain('### Validation gate');
  });

  it('checks onboarding boxes from live ValidationResult state', () => {
    const partial: ValidationResult = {
      valid: false,
      accountFunded: true,
      trustlineExists: false,
      xlmBalance: '5.0000000',
      xlmReserveMet: true,
      checks: [
        { passed: true, label: 'Account funded', detail: 'ok' },
        { passed: false, label: 'USDC trustline', detail: 'missing' },
        { passed: true, label: 'XLM reserve', detail: 'ok' },
      ],
    };

    const body = formatCommentBody(partial, {
      ...baseConfig,
      horizonUrl: 'https://horizon.stellar.org',
      onboardingChecklist: true,
    });

    expect(body).toContain('- [x] **Fund account**');
    expect(body).toContain('- [ ] **Add USDC trustline**');
    expect(body).toContain('- [x] **Verify XLM balance**');
  });

  it('includes SEP-0010 dashboard link when sep0010DashboardUrl is set (prefers dashboard over XDR)', () => {
    const body = formatCommentBody(
      {
        valid: false,
        accountFunded: false,
        trustlineExists: false,
        xlmBalance: '0',
        xlmReserveMet: false,
        checks: [{ passed: false, label: 'Account funded', detail: 'not found' }],
      },
      {
        ...baseConfig,
        horizonUrl: 'https://horizon.stellar.org',
        sep0010DashboardUrl: 'https://dashboard.example/verify?address=GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        sep0010ChallengeXdr: 'AAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', // should be ignored when dashboard set
      },
    );
    expect(body).toContain('Proof of wallet control (SEP-0010)');
    expect(body).toContain('dashboard.example');
    expect(body).not.toContain('AAAAAQ'); // raw XDR not rendered when dashboard wins
    // Does not block ready gate (still shows blocked by Account funded)
    expect(body).toContain('Blocked by');
  });

  it('includes truncated SEP-0010 XDR snippet when only challengeXdr is set (no nonce leak)', () => {
    const longXdr = 'AAAAAQ' + 'B'.repeat(100) + 'CCCC';
    const body = formatCommentBody(
      {
        valid: true,
        accountFunded: true,
        trustlineExists: true,
        xlmBalance: '10.0000000',
        xlmReserveMet: true,
        checks: [{ passed: true, label: 'Account funded', detail: 'ok' }],
      },
      {
        ...baseConfig,
        horizonUrl: 'https://horizon.stellar.org',
        sep0010ChallengeXdr: longXdr,
      },
    );
    expect(body).toContain('Proof of wallet control (SEP-0010)');
    expect(body).toContain('…'); // truncated
    expect(body).not.toContain(longXdr); // full XDR not leaked
  });

  it('does not include SEP-0010 section when neither dashboard nor XDR set', () => {
    const body = formatCommentBody(
      {
        valid: true,
        accountFunded: true,
        trustlineExists: true,
        xlmBalance: '10.0000000',
        xlmReserveMet: true,
        checks: [{ passed: true, label: 'Account funded', detail: 'ok' }],
      },
      {
        ...baseConfig,
        horizonUrl: 'https://horizon.stellar.org',
      },
    );
    expect(body).not.toContain('Proof of wallet control');
  });

  it('splits native XLM vs trustline balance (Issue #246) — has USDC but low XLM vs inverse', () => {
    const hasUsdcButLowXlm: ValidationResult = {
      valid: false,
      accountFunded: true,
      trustlineExists: true,
      xlmBalance: '0.5000000',
      xlmReserveMet: false,
      assetBalance: '100.0000000',
      assetBalanceMet: true,
      trustlineLimit: '1000.0000000',
      checks: [
        { passed: true, label: 'Account funded', detail: 'ok' },
        { passed: true, label: 'USDC trustline', detail: 'ok' },
        { passed: false, label: 'XLM reserve', detail: 'low' },
      ],
    };
    const body1 = formatCommentBody(hasUsdcButLowXlm, {
      ...baseConfig,
      horizonUrl: 'https://horizon.stellar.org',
    });
    expect(body1).toContain('**Native XLM balance:** `0.5000000 XLM`');
    expect(body1).toContain('**USDC trustline balance:** `100.0000000 USDC`');

    const hasXlmButNoTrustline: ValidationResult = {
      valid: false,
      accountFunded: true,
      trustlineExists: false,
      xlmBalance: '10.0000000',
      xlmReserveMet: true,
      assetBalance: '0',
      checks: [
        { passed: true, label: 'Account funded', detail: 'ok' },
        { passed: false, label: 'USDC trustline', detail: 'missing' },
        { passed: true, label: 'XLM reserve', detail: 'ok' },
      ],
    };
    const body2 = formatCommentBody(hasXlmButNoTrustline, {
      ...baseConfig,
      horizonUrl: 'https://horizon.stellar.org',
    });
    expect(body2).toContain('**Native XLM balance:** `10.0000000 XLM`');
    expect(body2).toContain('**USDC trustline balance:** `0 USDC` — no trustline');
  });

  it('handles 0 balance trustline vs missing trustline distinctly (7 decimals)', () => {
    const zeroBalance: ValidationResult = {
      valid: false,
      accountFunded: true,
      trustlineExists: true,
      xlmBalance: '10.0000000',
      xlmReserveMet: true,
      assetBalance: '0.0000000',
      trustlineLimit: '500.0000000',
      checks: [
        { passed: true, label: 'Account funded', detail: 'ok' },
        { passed: true, label: 'USDC trustline', detail: 'ok' },
        { passed: true, label: 'XLM reserve', detail: 'ok' },
      ],
    };
    const body = formatCommentBody(zeroBalance, {
      ...baseConfig,
      horizonUrl: 'https://horizon.stellar.org',
    });
    expect(body).toContain('`0.0000000 USDC`');
  });
});

function makeOctokit(overrides: Record<string, jest.Mock> = {}) {
  return {
    paginate: jest.fn(),
    graphql: jest.fn(),
    rest: {
      issues: {
        listComments: jest.fn(),
        createComment: jest.fn(),
        updateComment: jest.fn(),
        getComment: jest.fn(),
      },
      reactions: {
        listForIssueComment: jest.fn(),
      },
    },
    ...overrides,
  };
}


describe('findStickyComment', () => {
  function issueGraphqlResponse(
    nodes: Array<{ id: string; databaseId: number; body: string }>,
    pageInfo: { hasNextPage: boolean; endCursor: string | null },
  ) {
    return {
      repository: {
        issue: {
          comments: { nodes, pageInfo },
        },
      },
    };
  }

  it('returns the databaseId of the comment containing the marker via GraphQL pagination across multiple pages', async () => {
    const octokit = makeOctokit();
    octokit.graphql
      .mockResolvedValueOnce(
        issueGraphqlResponse(
          [
            { id: 'IC_1', databaseId: 101, body: 'unrelated comment 1' },
            { id: 'IC_2', databaseId: 102, body: 'unrelated comment 2' },
          ],
          { hasNextPage: true, endCursor: 'page-1-end' },
        ),
      )
      .mockResolvedValueOnce(
        issueGraphqlResponse(
          [
            { id: 'IC_3', databaseId: 103, body: 'unrelated comment 3' },
            { id: 'IC_4', databaseId: 104, body: `${STICKY_COMMENT_MARKER}\nprevious TrustBridge result` },
          ],
          { hasNextPage: false, endCursor: null },
        ),
      );

    const id = await findStickyComment(
      octokit as unknown as Parameters<typeof findStickyComment>[0],
      'owner',
      'repo',
      42,
    );

    expect(id).toBe(104);
    expect(octokit.graphql).toHaveBeenCalledTimes(2);
    expect(octokit.graphql).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.objectContaining({ owner: 'owner', repo: 'repo', issueNumber: 42, cursor: null }),
    );
    expect(octokit.graphql).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ owner: 'owner', repo: 'repo', issueNumber: 42, cursor: 'page-1-end' }),
    );
  });

  it('honors maxPages cap in GraphQL pagination', async () => {
    const octokit = makeOctokit();
    // Simulate infinite pages
    octokit.graphql.mockResolvedValue(
      issueGraphqlResponse(
        [{ id: 'IC_1', databaseId: 101, body: 'unrelated comment' }],
        { hasNextPage: true, endCursor: 'next-page' },
      ),
    );

    const id = await findStickyComment(
      octokit as unknown as Parameters<typeof findStickyComment>[0],
      'owner',
      'repo',
      42,
      { maxPages: 3 },
    );

    expect(id).toBeUndefined();
    expect(octokit.graphql).toHaveBeenCalledTimes(3);
  });

  it('falls back to REST pagination if GraphQL fails', async () => {
    const octokit = makeOctokit();
    octokit.graphql.mockRejectedValue(new Error('GraphQL API unavailable'));
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

  it('returns undefined when no comment has the marker via REST fallback', async () => {
    const octokit = makeOctokit();
    octokit.graphql.mockRejectedValue(new Error('GraphQL error'));
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
    context: {
      payload: { issue?: { number: number } };
      repo: { owner: string; repo: string };
      apiUrl: string;
    };
    getOctokit: jest.Mock;
  };

  beforeEach(() => {
    mockedGithub.context.payload = { issue: { number: 7 } };
    mockedGithub.context.apiUrl = 'https://api.github.com';
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
    expect(mockedGithub.getOctokit).toHaveBeenCalledWith('token', {
      baseUrl: 'https://api.github.com',
    });
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

  it('suppresses comment update when maintainer added :zzz: reaction within snooze window', async () => {
    const octokit = makeOctokit();
    octokit.paginate.mockResolvedValue([
      { id: 99, body: `${STICKY_COMMENT_MARKER}\nold failure` },
    ]);
    octokit.rest.issues.getComment.mockResolvedValue({
      data: { body: `${STICKY_COMMENT_MARKER}\nold failure` },
    });
    octokit.rest.reactions.listForIssueComment.mockResolvedValue({
      data: [
        {
          content: ':zzz:',
          created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          user: { login: 'maintainer', type: 'User' },
        },
      ],
    });
    mockedGithub.getOctokit.mockReturnValue(octokit);

    const failingBody = `${STICKY_COMMENT_MARKER}\n<!-- trustbridge-action:snooze:status=fail,timestamp=${Date.now()} -->\nnew failure`;
    const url = await postIssueComment('token', failingBody, {
      sticky: true,
      snoozeWindowMs: 30 * 60 * 1000,
    });

    expect(url).toBe('https://github.com/test-owner/test-repo/issues/7#issuecomment-99');
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('bypasses reaction snooze when forceComment is true', async () => {
    const octokit = makeOctokit();
    octokit.paginate.mockResolvedValue([
      { id: 99, body: `${STICKY_COMMENT_MARKER}\nold failure` },
    ]);
    octokit.rest.issues.updateComment.mockResolvedValue({
      data: { html_url: 'https://github.com/o/r/issues/7#issuecomment-99' },
    });
    mockedGithub.getOctokit.mockReturnValue(octokit);

    const failingBody = `${STICKY_COMMENT_MARKER}\n<!-- trustbridge-action:snooze:status=fail,timestamp=${Date.now()} -->\nnew failure`;
    const url = await postIssueComment('token', failingBody, {
      sticky: true,
      snoozeWindowMs: 30 * 60 * 1000,
      forceComment: true,
    });

    expect(url).toBe('https://github.com/o/r/issues/7#issuecomment-99');
    expect(octokit.rest.issues.updateComment).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GitHub Discussions comment path (Issue #221)
// ---------------------------------------------------------------------------

describe('resolveDiscussionNodeId', () => {
  it('extracts the node id from a discussion event payload', () => {
    expect(
      resolveDiscussionNodeId({ discussion: { node_id: 'DIC_kwDOABCD' } }),
    ).toBe('DIC_kwDOABCD');
  });

  it('returns undefined for payloads without a discussion', () => {
    expect(resolveDiscussionNodeId({})).toBeUndefined();
    expect(resolveDiscussionNodeId({ issue: { number: 7 } })).toBeUndefined();
    expect(resolveDiscussionNodeId(null)).toBeUndefined();
    expect(resolveDiscussionNodeId('not-an-object')).toBeUndefined();
  });

  it('returns undefined for empty or non-string node ids', () => {
    expect(resolveDiscussionNodeId({ discussion: { node_id: '' } })).toBeUndefined();
    expect(resolveDiscussionNodeId({ discussion: { node_id: 123 } })).toBeUndefined();
    expect(resolveDiscussionNodeId({ discussion: {} })).toBeUndefined();
  });
});

describe('findStickyDiscussionComment', () => {
  function discussionGraphqlResponse(
    nodes: Array<{ id: string; body: string }>,
    pageInfo: { hasNextPage: boolean; endCursor: string | null },
  ) {
    return {
      node: {
        comments: { nodes, pageInfo },
      },
    };
  }

  it('returns the last TrustBridge comment across pages (pagination)', async () => {
    const octokit = makeOctokit();
    octokit.graphql
      .mockResolvedValueOnce(
        discussionGraphqlResponse(
          [
            { id: 'DC_1', body: 'unrelated' },
            { id: 'DC_2', body: `${STICKY_COMMENT_MARKER}\nfirst` },
          ],
          { hasNextPage: true, endCursor: 'cursor-1' },
        ),
      )
      .mockResolvedValueOnce(
        discussionGraphqlResponse(
          [
            { id: 'DC_3', body: 'another unrelated' },
            { id: 'DC_4', body: `${STICKY_COMMENT_MARKER}\nsecond` },
          ],
          { hasNextPage: false, endCursor: null },
        ),
      );

    const result = await findStickyDiscussionComment(
      octokit as unknown as Parameters<typeof findStickyDiscussionComment>[0],
      'DIC_kwDOABCD',
    );

    expect(result).toEqual({ id: 'DC_4', body: `${STICKY_COMMENT_MARKER}\nsecond` });
    expect(octokit.graphql).toHaveBeenCalledTimes(2);
    expect(octokit.graphql).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.objectContaining({ discussionId: 'DIC_kwDOABCD', cursor: null }),
    );
    expect(octokit.graphql).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ cursor: 'cursor-1' }),
    );
  });

  it('returns undefined when no comment carries the marker', async () => {
    const octokit = makeOctokit();
    octokit.graphql.mockResolvedValue(
      discussionGraphqlResponse(
        [{ id: 'DC_1', body: 'unrelated' }],
        { hasNextPage: false, endCursor: null },
      ),
    );

    const result = await findStickyDiscussionComment(
      octokit as unknown as Parameters<typeof findStickyDiscussionComment>[0],
      'DIC_kwDOABCD',
    );

    expect(result).toBeUndefined();
  });

  it('stops paginating when the discussion node is null (deleted/inaccessible)', async () => {
    const octokit = makeOctokit();
    octokit.graphql.mockResolvedValue({ node: null });

    const result = await findStickyDiscussionComment(
      octokit as unknown as Parameters<typeof findStickyDiscussionComment>[0],
      'DIC_kwDOABCD',
    );

    expect(result).toBeUndefined();
    expect(octokit.graphql).toHaveBeenCalledTimes(1);
  });

  it('honors maxPages cap in discussion GraphQL pagination', async () => {
    const octokit = makeOctokit();
    octokit.graphql.mockResolvedValue(
      discussionGraphqlResponse(
        [{ id: 'DC_1', body: 'unrelated' }],
        { hasNextPage: true, endCursor: 'next-cursor' },
      ),
    );

    const result = await findStickyDiscussionComment(
      octokit as unknown as Parameters<typeof findStickyDiscussionComment>[0],
      'DIC_kwDOABCD',
      { maxPages: 2 },
    );

    expect(result).toBeUndefined();
    expect(octokit.graphql).toHaveBeenCalledTimes(2);
  });
});

describe('postDiscussionComment', () => {
  const mockedGithub = github as unknown as {
    context: {
      payload: { discussion?: { node_id?: string }; issue?: { number: number } };
      repo: { owner: string; repo: string };
      apiUrl: string;
    };
    getOctokit: jest.Mock;
  };

  const DISCUSSION_NODE_ID = 'DIC_kwDOABCD';

  beforeEach(() => {
    mockedGithub.context.payload = { discussion: { node_id: DISCUSSION_NODE_ID } };
    mockedGithub.context.apiUrl = 'https://api.github.com';
  });

  it('returns undefined and warns when there is no discussion context', async () => {
    mockedGithub.context.payload = {};
    const octokit = makeOctokit();
    mockedGithub.getOctokit.mockReturnValue(octokit);

    const result = await postDiscussionComment('token', 'body');

    expect(result).toBeUndefined();
    expect(octokit.graphql).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('creates a new discussion comment via GraphQL when no prior TrustBridge comment exists', async () => {
    const octokit = makeOctokit();
    octokit.graphql
      .mockResolvedValueOnce({ node: { comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } })
      .mockResolvedValueOnce({
        addDiscussionComment: {
          comment: { url: 'https://github.com/o/r/discussions/12#discussioncomment-100' },
        },
      });
    mockedGithub.getOctokit.mockReturnValue(octokit);

    const url = await postDiscussionComment('token', 'new body', { sticky: true });

    expect(url).toBe('https://github.com/o/r/discussions/12#discussioncomment-100');
    expect(octokit.graphql).toHaveBeenCalledTimes(2);
    const createCall = octokit.graphql.mock.calls[1];
    expect(createCall[1]).toEqual(
      expect.objectContaining({ discussionId: DISCUSSION_NODE_ID, body: 'new body' }),
    );
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(mockedGithub.getOctokit).toHaveBeenCalledWith('token', {
      baseUrl: 'https://api.github.com',
    });
  });

  it('updates the existing sticky discussion comment via GraphQL instead of creating a new one', async () => {
    const octokit = makeOctokit();
    octokit.graphql
      .mockResolvedValueOnce({
        node: {
          comments: {
            nodes: [{ id: 'DC_99', body: `${STICKY_COMMENT_MARKER}\nold result` }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      })
      .mockResolvedValueOnce({
        updateDiscussionComment: {
          comment: { url: 'https://github.com/o/r/discussions/12#discussioncomment-99' },
        },
      });
    mockedGithub.getOctokit.mockReturnValue(octokit);

    const url = await postDiscussionComment('token', 'updated body', { sticky: true });

    expect(url).toBe('https://github.com/o/r/discussions/12#discussioncomment-99');
    expect(octokit.graphql).toHaveBeenCalledTimes(2);
    const updateCall = octokit.graphql.mock.calls[1];
    expect(updateCall[1]).toEqual(
      expect.objectContaining({ commentId: 'DC_99', body: 'updated body' }),
    );
  });

  it('always creates a new comment when sticky is disabled', async () => {
    const octokit = makeOctokit();
    octokit.graphql.mockResolvedValueOnce({
      addDiscussionComment: {
        comment: { url: 'https://github.com/o/r/discussions/12#discussioncomment-101' },
      },
    });
    mockedGithub.getOctokit.mockReturnValue(octokit);

    const url = await postDiscussionComment('token', 'body', { sticky: false });

    expect(url).toBe('https://github.com/o/r/discussions/12#discussioncomment-101');
    expect(octokit.graphql).toHaveBeenCalledTimes(1);
    expect(octokit.graphql).toHaveBeenCalledWith(
      expect.stringContaining('addDiscussionComment'),
      expect.objectContaining({ discussionId: DISCUSSION_NODE_ID }),
    );
  });

  it('falls back to creating a new comment when the sticky lookup fails', async () => {
    const octokit = makeOctokit();
    octokit.graphql
      .mockRejectedValueOnce(new Error('GraphQL rate limit exceeded'))
      .mockResolvedValueOnce({
        addDiscussionComment: {
          comment: { url: 'https://github.com/o/r/discussions/12#discussioncomment-102' },
        },
      });
    mockedGithub.getOctokit.mockReturnValue(octokit);

    const url = await postDiscussionComment('token', 'body', { sticky: true });

    expect(url).toBe('https://github.com/o/r/discussions/12#discussioncomment-102');
    expect(octokit.graphql).toHaveBeenCalledTimes(2);
  });

  it('honours an explicit discussionId option over the event payload', async () => {
    mockedGithub.context.payload = { discussion: { node_id: 'DIC_FROM_EVENT' } };
    const octokit = makeOctokit();
    octokit.graphql.mockResolvedValueOnce({
      addDiscussionComment: {
        comment: { url: 'https://github.com/o/r/discussions/12#discussioncomment-103' },
      },
    });
    mockedGithub.getOctokit.mockReturnValue(octokit);

    const url = await postDiscussionComment('token', 'body', {
      sticky: false,
      discussionId: 'DIC_EXPLICIT',
    });

    expect(url).toBe('https://github.com/o/r/discussions/12#discussioncomment-103');
    expect(octokit.graphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ discussionId: 'DIC_EXPLICIT' }),
    );
  });

  it('never calls the REST issues API when posting a discussion comment', async () => {
    const octokit = makeOctokit();
    octokit.graphql
      .mockResolvedValueOnce({ node: { comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } })
      .mockResolvedValueOnce({
        addDiscussionComment: {
          comment: { url: 'https://github.com/o/r/discussions/12#discussioncomment-104' },
        },
      });
    mockedGithub.getOctokit.mockReturnValue(octokit);

    await postDiscussionComment('token', 'body', { sticky: true });

    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(octokit.rest.issues.listComments).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Oversize comment truncation
// ---------------------------------------------------------------------------

describe('COMMENT_SIZE_LIMIT_BYTES', () => {
  it('is 65536 (GitHub comment size limit)', () => {
    expect(COMMENT_SIZE_LIMIT_BYTES).toBe(65536);
  });

  it('leaves enough room for the truncation notice', () => {
    expect(COMMENT_SIZE_LIMIT_BYTES).toBeGreaterThan(COMMENT_TRUNCATION_NOTICE_BYTES);
  });
});

describe('buildTruncatedCommentBody', () => {
  const reportPath = 'trustbridge-report.md';

  it('returns a body within COMMENT_SIZE_LIMIT_BYTES when given an oversized input', () => {
    const oversizedBody = 'x'.repeat(COMMENT_SIZE_LIMIT_BYTES + 10000);
    const truncated = buildTruncatedCommentBody(oversizedBody, reportPath);
    expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThanOrEqual(COMMENT_SIZE_LIMIT_BYTES);
  });

  it('includes the truncation notice', () => {
    const oversizedBody = 'A'.repeat(COMMENT_SIZE_LIMIT_BYTES + 1000);
    const truncated = buildTruncatedCommentBody(oversizedBody, reportPath);
    expect(truncated).toContain('⚠️ Report truncated');
    expect(truncated).toContain(reportPath);
  });

  it('includes a link to USAGE.md in the truncation notice', () => {
    const oversizedBody = 'B'.repeat(COMMENT_SIZE_LIMIT_BYTES + 500);
    const truncated = buildTruncatedCommentBody(oversizedBody, reportPath);
    expect(truncated).toContain('USAGE.md');
  });

  it('preserves the TrustBridge footer so the sticky marker is present', () => {
    const oversizedBody = 'C'.repeat(COMMENT_SIZE_LIMIT_BYTES + 500);
    const truncated = buildTruncatedCommentBody(oversizedBody, reportPath);
    expect(truncated).toContain('trustbridge-action');
  });

  it('embeds the custom report path in the notice', () => {
    const oversizedBody = 'D'.repeat(COMMENT_SIZE_LIMIT_BYTES + 500);
    const customPath = 'artifacts/my-report.md';
    const truncated = buildTruncatedCommentBody(oversizedBody, customPath);
    expect(truncated).toContain(customPath);
  });

  it('cuts on a line boundary (no partial lines in truncated content)', () => {
    const line = 'line content here\n';
    const repeated = line.repeat(Math.ceil((COMMENT_SIZE_LIMIT_BYTES + 5000) / line.length));
    const truncated = buildTruncatedCommentBody(repeated, reportPath);
    const noticeSeparator = '---\n> **⚠️ Report truncated**';
    const cutIndex = truncated.indexOf(noticeSeparator);
    if (cutIndex > 0) {
      const before = truncated.slice(0, cutIndex);
      expect(before.endsWith('\n') || before.endsWith('\n\n')).toBe(true);
    }
  });

  it('stays well under the limit for a body exactly at the boundary', () => {
    const exactBody = 'E'.repeat(COMMENT_SIZE_LIMIT_BYTES);
    const truncated = buildTruncatedCommentBody(exactBody, reportPath);
    expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThanOrEqual(COMMENT_SIZE_LIMIT_BYTES);
  });
});

describe('writeFullReport', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes the full body to the specified path and returns the resolved path', () => {
    const outputPath = path.join(tmpDir, 'report.md');
    const body = '# Full Report\n\nThis is the full content.';

    const result = writeFullReport(body, outputPath);

    expect(result).toBe(outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.readFileSync(outputPath, 'utf8')).toBe(body);
  });

  it('creates intermediate directories as needed', () => {
    const nestedPath = path.join(tmpDir, 'nested', 'deep', 'report.md');
    const body = 'nested report content';

    const result = writeFullReport(body, nestedPath);

    expect(result).toBe(nestedPath);
    expect(fs.existsSync(nestedPath)).toBe(true);
  });

  it('returns undefined and warns when the path is not writable', () => {
    const { warning } = jest.requireMock('@actions/core') as { warning: jest.Mock };
    warning.mockClear();

    // Use a path with a null byte to force a write error cross-platform
    const badPath = path.join(tmpDir, '\0invalid');
    const result = writeFullReport('body', badPath);

    expect(result).toBeUndefined();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to write full validation report'),
    );
  });

  it('preserves the exact byte content of the full body', () => {
    const body = '# Report\n\nUnicode: こんにちは 🌟\n\nEnd.';
    const outputPath = path.join(tmpDir, 'unicode-report.md');

    writeFullReport(body, outputPath);

    const written = fs.readFileSync(outputPath, 'utf8');
    expect(written).toBe(body);
  });
});
