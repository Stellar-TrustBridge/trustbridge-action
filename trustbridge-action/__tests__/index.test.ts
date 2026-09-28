import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as core from '@actions/core';
import * as github from '@actions/github';

import { run } from '../src/index';

/**
 * Tests for unassign behavior during GitHub API outages (issue #484).
 *
 * USAGE.md documents that when the GitHub API returns an error (including
 * 5xx outages) while unassigning a reviewer, the action logs a warning and
 * skips the unassign rather than retrying in a storm. These tests pin that
 * behavior so an outage cannot crash the action or trigger retries.
 */

describe('unassign during GitHub API outages (#484)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    process.env['INPUT_GITHUB-TOKEN'] = 'test-token';
    process.env['GITHUB_REPOSITORY'] = 'owner/repo';
    process.env['GITHUB_EVENT_NAME'] = 'pull_request';
    process.env['GITHUB_EVENT_PATH'] = '';

    vi.spyOn(core, 'getInput').mockImplementation((name: string) => {
      if (name === 'github-token') return 'test-token';
      return '';
    });
    vi.spyOn(core, 'setFailed').mockImplementation(() => undefined);
    vi.spyOn(core, 'warning').mockImplementation(() => undefined);
    vi.spyOn(core, 'info').mockImplementation(() => undefined);
    vi.spyOn(core, 'setOutput').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('does not crash when unassign receives a 5xx outage response', async () => {
    const outageError: any = new Error('Server Error');
    outageError.status = 503;

    const removeReviewers = vi.fn().mockRejectedValue(outageError);
    const requestReviewers = vi.fn().mockResolvedValue({ data: {} });

    vi.spyOn(github, 'getOctokit').mockReturnValue({
      rest: {
        pulls: {
          removeRequestedReviewers: removeReviewers,
          requestReviewers,
        },
      },
    } as any);

    await expect(run()).resolves.not.toThrow();
  });

  it('skips (does not retry) unassign on a 5xx outage, matching USAGE.md', async () => {
    const outageError: any = new Error('Bad Gateway');
    outageError.status = 502;

    const removeReviewers = vi.fn().mockRejectedValue(outageError);

    vi.spyOn(github, 'getOctokit').mockReturnValue({
      rest: {
        pulls: {
          removeRequestedReviewers: removeReviewers,
          requestReviewers: vi.fn().mockResolvedValue({ data: {} }),
        },
      },
    } as any);

    await run();

    // USAGE.md: on API error the unassign is skipped, not retried in a storm.
    expect(removeReviewers).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalled();
  });

  it('handles a 500 outage without throwing and reports a warning', async () => {
    const outageError: any = new Error('Internal Server Error');
    outageError.status = 500;

    const removeReviewers = vi.fn().mockRejectedValue(outageError);

    vi.spyOn(github, 'getOctokit').mockReturnValue({
      rest: {
        pulls: {
          removeRequestedReviewers: removeReviewers,
          requestReviewers: vi.fn().mockResolvedValue({ data: {} }),
        },
      },
    } as any);

    await expect(run()).resolves.toBeUndefined();
    expect(removeReviewers).toHaveBeenCalledTimes(1);
  });
});
