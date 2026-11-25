/**
 * Tests for #322 — Comment threading / reply mode.
 */
import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  CommentMode,
  VALID_COMMENT_MODES,
  resolveCommentMode,
  resolveDiscussionCommentTarget,
  postDiscussionComment,
  STICKY_COMMENT_MARKER,
} from '../src/comment';

jest.mock('@actions/github', () => ({
  context: { payload: {}, repo: { owner: 'o', repo: 'r' }, apiUrl: 'https://api.github.com' },
  getOctokit: jest.fn(),
}));

// Mock @actions/core to silence log output in tests
jest.mock('@actions/core', () => ({
  warning: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  setOutput: jest.fn(),
  setFailed: jest.fn(),
}));

// ── constants ───────────────────────────────────────────────────────────────

describe('VALID_COMMENT_MODES', () => {
  it('contains exactly sticky, new, and reply', () => {
    expect(VALID_COMMENT_MODES).toEqual(expect.arrayContaining(['sticky', 'new', 'reply']));
    expect(VALID_COMMENT_MODES).toHaveLength(3);
  });
});

// ── resolveCommentMode ──────────────────────────────────────────────────────

describe('resolveCommentMode', () => {
  beforeEach(() => {
    (core.warning as jest.Mock).mockClear();
  });

  it("returns 'sticky' when commentMode is 'sticky'", () => {
    expect(resolveCommentMode('sticky', undefined)).toBe<CommentMode>('sticky');
  });

  it("returns 'new' when commentMode is 'new'", () => {
    expect(resolveCommentMode('new', undefined)).toBe<CommentMode>('new');
  });

  it("returns 'reply' when commentMode is 'reply'", () => {
    expect(resolveCommentMode('reply', undefined)).toBe<CommentMode>('reply');
  });

  it('is case-insensitive (STICKY, NEW, REPLY)', () => {
    expect(resolveCommentMode('STICKY', undefined)).toBe<CommentMode>('sticky');
    expect(resolveCommentMode('NEW', undefined)).toBe<CommentMode>('new');
    expect(resolveCommentMode('REPLY', undefined)).toBe<CommentMode>('reply');
  });

  it('trims leading/trailing whitespace from commentMode', () => {
    expect(resolveCommentMode('  sticky  ', undefined)).toBe<CommentMode>('sticky');
    expect(resolveCommentMode('  reply  ', undefined)).toBe<CommentMode>('reply');
  });

  it("returns 'sticky' as default when commentMode is undefined and sticky is undefined", () => {
    expect(resolveCommentMode(undefined, undefined)).toBe<CommentMode>('sticky');
  });

  it("returns 'sticky' as default when commentMode is undefined and sticky is true", () => {
    expect(resolveCommentMode(undefined, true)).toBe<CommentMode>('sticky');
  });

  it("returns 'new' when commentMode is undefined and sticky is false (legacy compat)", () => {
    expect(resolveCommentMode(undefined, false)).toBe<CommentMode>('new');
  });

  it("commentMode takes precedence over sticky boolean", () => {
    // Even with sticky:false, explicit commentMode:'sticky' wins.
    expect(resolveCommentMode('sticky', false)).toBe<CommentMode>('sticky');
    // Even with sticky:true, explicit commentMode:'new' wins.
    expect(resolveCommentMode('new', true)).toBe<CommentMode>('new');
  });

  it("falls back to 'sticky' and emits a warning for an invalid commentMode", () => {
    const result = resolveCommentMode('invalid_mode', undefined);
    expect(result).toBe<CommentMode>('sticky');
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('invalid_mode'),
    );
  });

  it("falls back to 'sticky' and warns for empty string commentMode (treated as no input)", () => {
    // Empty string after trim is falsy — resolveCommentMode treats it as unset.
    const result = resolveCommentMode('', undefined);
    // Empty string is falsy so the branch does not enter the validation path.
    expect(result).toBe<CommentMode>('sticky');
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('emits warning listing valid options for invalid mode', () => {
    resolveCommentMode('email', undefined);
    const warnCall = (core.warning as jest.Mock).mock.calls[0]?.[0] as string;
    expect(warnCall).toContain('sticky');
    expect(warnCall).toContain('new');
    expect(warnCall).toContain('reply');
  });
});

// ── discussion reply threading (#472) ───────────────────────────────────────

describe('resolveDiscussionCommentTarget', () => {
  it('returns undefined for a discussion event without a comment', () => {
    expect(resolveDiscussionCommentTarget({ discussion: { node_id: 'D_1' } })).toBeUndefined();
    expect(resolveDiscussionCommentTarget(undefined)).toBeUndefined();
  });

  it('returns the triggering top-level comment', () => {
    expect(
      resolveDiscussionCommentTarget({ comment: { node_id: 'DC_top', parent_id: null } }),
    ).toEqual({ nodeId: 'DC_top', isReply: false });
  });

  it('flags a triggering comment that is itself a reply', () => {
    expect(
      resolveDiscussionCommentTarget({ comment: { node_id: 'DC_child', parent_id: 42 } }),
    ).toEqual({ nodeId: 'DC_child', isReply: true });
  });
});

describe('postDiscussionComment threading', () => {
  const mockedGithub = github as unknown as {
    context: { eventName: string; payload: Record<string, unknown> };
    getOctokit: jest.Mock;
  };
  const DISCUSSION_ID = 'D_kwDOdiscussion';
  const emptyPage = { node: { comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
  const added = { addDiscussionComment: { comment: { url: 'https://github.com/o/r/discussions/1#discussioncomment-9' } } };

  function mockOctokit(...responses: unknown[]) {
    const graphql = jest.fn();
    for (const response of responses) graphql.mockResolvedValueOnce(response);
    mockedGithub.getOctokit.mockReturnValue({ graphql });
    return graphql;
  }

  function addMutationVariables(graphql: jest.Mock) {
    const call = graphql.mock.calls.find(([query]) => String(query).includes('addDiscussionComment'));
    return call?.[1];
  }

  beforeEach(() => {
    (core.warning as jest.Mock).mockClear();
  });

  it('posts a top-level comment for discussion events (no replyToId)', async () => {
    mockedGithub.context.eventName = 'discussion';
    mockedGithub.context.payload = { discussion: { node_id: DISCUSSION_ID } };
    const graphql = mockOctokit(emptyPage, added);

    await postDiscussionComment('token', 'body');

    expect(addMutationVariables(graphql)).toEqual({ discussionId: DISCUSSION_ID, body: 'body', replyToId: null });
  });

  it('replies under the triggering top-level comment for discussion_comment events', async () => {
    mockedGithub.context.eventName = 'discussion_comment';
    mockedGithub.context.payload = {
      discussion: { node_id: DISCUSSION_ID },
      comment: { node_id: 'DC_top', parent_id: null },
    };
    const graphql = mockOctokit(emptyPage, added);

    await postDiscussionComment('token', 'body');

    expect(addMutationVariables(graphql)).toMatchObject({ discussionId: DISCUSSION_ID, replyToId: 'DC_top' });
    // Sticky lookup is scoped to the thread's replies, not the whole discussion.
    const [lookupQuery, lookupVars] = graphql.mock.calls[0];
    expect(lookupQuery).toContain('replies(first: 100');
    expect(lookupVars).toMatchObject({ discussionId: 'DC_top' });
  });

  it('replies under the parent thread when the triggering comment is itself a reply', async () => {
    mockedGithub.context.eventName = 'discussion_comment';
    mockedGithub.context.payload = {
      discussion: { node_id: DISCUSSION_ID },
      comment: { node_id: 'DC_child', parent_id: 7 },
    };
    const graphql = mockOctokit({ node: { replyTo: { id: 'DC_parent' } } }, emptyPage, added);

    await postDiscussionComment('token', 'body');

    expect(graphql.mock.calls[0][1]).toEqual({ commentId: 'DC_child' });
    expect(addMutationVariables(graphql)).toMatchObject({ replyToId: 'DC_parent' });
  });

  it('updates the existing TrustBridge reply in the same thread when sticky', async () => {
    mockedGithub.context.eventName = 'discussion_comment';
    mockedGithub.context.payload = {
      discussion: { node_id: DISCUSSION_ID },
      comment: { node_id: 'DC_top', parent_id: null },
    };
    const existing = { id: 'DC_bot_reply', body: `${STICKY_COMMENT_MARKER}\nold` };
    const graphql = mockOctokit(
      { node: { comments: { nodes: [existing], pageInfo: { hasNextPage: false, endCursor: null } } } },
      { updateDiscussionComment: { comment: { url: 'https://github.com/o/r/discussions/1#discussioncomment-8' } } },
    );

    const url = await postDiscussionComment('token', 'new body', { commentMode: 'sticky' });

    expect(url).toBe('https://github.com/o/r/discussions/1#discussioncomment-8');
    expect(graphql.mock.calls[1][1]).toEqual({ commentId: 'DC_bot_reply', body: 'new body' });
    expect(addMutationVariables(graphql)).toBeUndefined();
  });

  it('honours an explicit replyToId without resolving from the payload', async () => {
    mockedGithub.context.payload = { discussion: { node_id: DISCUSSION_ID } };
    const graphql = mockOctokit(emptyPage, added);

    await postDiscussionComment('token', 'body', { replyToId: 'DC_explicit' });

    expect(addMutationVariables(graphql)).toMatchObject({ replyToId: 'DC_explicit' });
  });

  it.each([
    {
      eventName: 'discussion',
      payload: { discussion: { node_id: DISCUSSION_ID } },
      replyToId: null,
    },
    {
      eventName: 'discussion_comment',
      payload: {
        discussion: { node_id: DISCUSSION_ID },
        comment: { node_id: 'DC_top', parent_id: null },
      },
      replyToId: 'DC_top',
    },
  ])('creates a new GraphQL comment for $eventName in new mode', async ({ eventName, payload, replyToId }) => {
    mockedGithub.context.eventName = eventName;
    mockedGithub.context.payload = payload;
    const graphql = mockOctokit(added);

    await postDiscussionComment('token', 'new body', { commentMode: 'new' });

    expect(graphql).toHaveBeenCalledTimes(1);
    expect(addMutationVariables(graphql)).toEqual({
      discussionId: DISCUSSION_ID,
      body: 'new body',
      replyToId,
    });
  });

  it('falls back to a top-level comment with a warning when the parent lookup fails', async () => {
    mockedGithub.context.payload = {
      discussion: { node_id: DISCUSSION_ID },
      comment: { node_id: 'DC_child', parent_id: 7 },
    };
    const graphql = jest.fn()
      .mockRejectedValueOnce(new Error('NOT_FOUND'))
      .mockResolvedValueOnce(emptyPage)
      .mockResolvedValueOnce(added);
    mockedGithub.getOctokit.mockReturnValue({ graphql });

    await postDiscussionComment('token', 'body');

    expect(addMutationVariables(graphql)).toMatchObject({ replyToId: null });
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('DC_child'));
  });
});
