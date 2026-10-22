/**
 * Issue #790 — duplicate workflow runs must update the same TrustBridge
 * comment instead of posting a second one.
 *
 * Simulates an in-memory issue thread shared by several "runs" so the tests
 * exercise the real lookup → update/create → reconcile sequence in
 * `postIssueComment`, including two runs racing past an empty thread.
 */

import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  postIssueComment,
  reconcileDuplicateStickyComment,
  STICKY_COMMENT_MARKER,
} from '../src/comment';

jest.mock('@actions/core');
jest.mock('@actions/github');

const mockCore = core as jest.Mocked<typeof core>;
const ISSUE = 790;

interface StoredComment {
  id: number;
  body: string;
  html_url: string;
}

/** A fake issue thread backed by an array, exposing the Octokit surface comment.ts uses. */
function buildThread(initial: string[] = []) {
  let nextId = 1000;
  const comments: StoredComment[] = [];
  const add = (body: string): StoredComment => {
    const c = { id: nextId++, body, html_url: `https://github.com/org/repo/issues/${ISSUE}#issuecomment-${nextId - 1}` };
    comments.push(c);
    return c;
  };
  initial.forEach(add);

  const octokit = {
    paginate: jest.fn(async () => comments.map((c) => ({ ...c }))),
    rest: {
      issues: {
        listComments: jest.fn(),
        getComment: jest.fn(async ({ comment_id }: { comment_id: number }) => ({
          data: comments.find((c) => c.id === comment_id),
        })),
        createComment: jest.fn(async ({ body }: { body: string }) => ({ data: { ...add(body) } })),
        updateComment: jest.fn(async ({ comment_id, body }: { comment_id: number; body: string }) => {
          const c = comments.find((x) => x.id === comment_id);
          if (!c) throw Object.assign(new Error('Not Found'), { status: 404 });
          c.body = body;
          return { data: { ...c } };
        }),
        deleteComment: jest.fn(async ({ comment_id }: { comment_id: number }) => {
          const i = comments.findIndex((x) => x.id === comment_id);
          if (i === -1) throw Object.assign(new Error('Not Found'), { status: 404 });
          comments.splice(i, 1);
          return { status: 204 };
        }),
      },
    },
  };
  return { octokit, comments };
}

function trustBridgeBody(label: string): string {
  return `${STICKY_COMMENT_MARKER}\n${label}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  const ctx = github.context as unknown as Record<string, unknown>;
  ctx.repo = { owner: 'org', repo: 'repo' };
  ctx.payload = {};
  ctx.eventName = 'workflow_dispatch';
  ctx.apiUrl = 'https://api.github.com';
});

function useThread(thread: ReturnType<typeof buildThread>) {
  (github.getOctokit as jest.Mock).mockReturnValue(thread.octokit);
}

describe('postIssueComment idempotency across duplicate workflow_dispatch runs (#790)', () => {
  it('second run updates the first run\'s comment instead of creating another', async () => {
    const thread = buildThread();
    useThread(thread);

    await postIssueComment('token', trustBridgeBody('run 1'), { issueNumber: ISSUE });
    await postIssueComment('token', trustBridgeBody('run 2'), { issueNumber: ISSUE });

    expect(thread.comments).toHaveLength(1);
    expect(thread.comments[0].body).toContain('run 2');
    expect(thread.octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(thread.octokit.rest.issues.updateComment).toHaveBeenCalledTimes(1);
  });

  it('two racing runs that both miss the lookup converge on one comment', async () => {
    const thread = buildThread();
    useThread(thread);
    // Both runs read the thread before either has written: hold the first
    // paginate (lookup) call of each run until both have started.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let lookups = 0;
    const realPaginate = thread.octokit.paginate.getMockImplementation()!;
    thread.octokit.paginate.mockImplementation(async (...args: unknown[]) => {
      lookups += 1;
      if (lookups <= 2) {
        const snapshot = await (realPaginate as (...a: unknown[]) => Promise<StoredComment[]>)(...args);
        if (lookups === 2) release();
        await gate;
        return snapshot;
      }
      return (realPaginate as (...a: unknown[]) => Promise<StoredComment[]>)(...args);
    });

    const [a, b] = await Promise.all([
      postIssueComment('token', trustBridgeBody('run A'), { issueNumber: ISSUE }),
      postIssueComment('token', trustBridgeBody('run B'), { issueNumber: ISSUE }),
    ]);

    expect(thread.octokit.rest.issues.createComment).toHaveBeenCalledTimes(2);
    expect(thread.comments).toHaveLength(1);
    expect(thread.octokit.rest.issues.deleteComment).toHaveBeenCalledTimes(1);
    // Both runs report the surviving comment.
    const survivor = thread.comments[0];
    expect([a, b].map((r) => (r as unknown as { id: number }).id)).toEqual([survivor.id, survivor.id]);
  });

  it('comment_mode "new" keeps posting fresh comments (audit trail unchanged)', async () => {
    const thread = buildThread();
    useThread(thread);

    await postIssueComment('token', trustBridgeBody('run 1'), { issueNumber: ISSUE, commentMode: 'new' });
    await postIssueComment('token', trustBridgeBody('run 2'), { issueNumber: ISSUE, commentMode: 'new' });

    expect(thread.comments).toHaveLength(2);
    expect(thread.octokit.rest.issues.deleteComment).not.toHaveBeenCalled();
  });
});

describe('reconcileDuplicateStickyComment (#790)', () => {
  it('returns the created comment when it is the only TrustBridge comment', async () => {
    const thread = buildThread([trustBridgeBody('only')]);
    const created = { id: thread.comments[0].id, url: thread.comments[0].html_url };
    const result = await reconcileDuplicateStickyComment(thread.octokit as never, 'org', 'repo', ISSUE, created, 'x');
    expect(result).toBe(created);
    expect(thread.octokit.rest.issues.updateComment).not.toHaveBeenCalled();
  });

  it('keeps the new comment and warns when the original cannot be updated', async () => {
    const thread = buildThread([trustBridgeBody('original'), trustBridgeBody('duplicate')]);
    thread.octokit.rest.issues.updateComment.mockRejectedValueOnce(new Error('Resource not accessible by integration'));
    const dup = thread.comments[1];
    const created = { id: dup.id, url: dup.html_url };

    const result = await reconcileDuplicateStickyComment(thread.octokit as never, 'org', 'repo', ISSUE, created, 'body');

    expect(result).toBe(created);
    expect(thread.comments).toHaveLength(2); // nothing deleted
    expect(mockCore.warning).toHaveBeenCalledWith(expect.stringContaining('could not be updated'));
  });

  it('still returns the original when deleting the duplicate fails (missing issues: write)', async () => {
    const thread = buildThread([trustBridgeBody('original'), trustBridgeBody('duplicate')]);
    thread.octokit.rest.issues.deleteComment.mockRejectedValueOnce(new Error('Forbidden'));
    const [orig, dup] = thread.comments;

    const result = await reconcileDuplicateStickyComment(
      thread.octokit as never, 'org', 'repo', ISSUE, { id: dup.id, url: dup.html_url }, 'fresh body',
    );

    expect(result.id).toBe(orig.id);
    expect(orig.body).toBe('fresh body');
    expect(mockCore.warning).toHaveBeenCalledWith(expect.stringContaining('issues: write'));
  });

  it('returns the created comment when the re-check lookup throws', async () => {
    const thread = buildThread([trustBridgeBody('x')]);
    thread.octokit.paginate.mockRejectedValueOnce(new Error('ECONNRESET'));
    const created = { id: 1, url: 'u' };
    const result = await reconcileDuplicateStickyComment(thread.octokit as never, 'org', 'repo', ISSUE, created, 'b');
    expect(result).toBe(created);
    expect(mockCore.warning).toHaveBeenCalledWith(expect.stringContaining('ECONNRESET'));
  });
});
