import {
  determineCheckConclusion,
  buildCheckAnnotations,
  createCheckRun
} from '../src/checks-run';
import * as github from '@actions/github';
import * as core from '@actions/core';

jest.mock('@actions/core');
jest.mock('@actions/github', () => ({
  context: {
    runId: 123,
    repo: { owner: 'test-owner', repo: 'test-repo' },
    sha: '1234567890abcdef'
  },
  getOctokit: jest.fn()
}));
jest.mock('../src/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));
jest.mock('../src/proxy', () => ({
  getOctokitProxyOptions: jest.fn().mockReturnValue({})
}));

describe('checks-run', () => {
  const mockCreateCheck = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (github.getOctokit as jest.Mock).mockReturnValue({
      rest: { checks: { create: mockCreateCheck } }
    });
  });

  describe('determineCheckConclusion', () => {
    it('returns success when valid is true', () => {
      expect(determineCheckConclusion({ valid: true } as any)).toBe('success');
    });

    it('returns failure when valid is false', () => {
      expect(determineCheckConclusion({ valid: false } as any)).toBe('failure');
    });
  });

  describe('buildCheckAnnotations', () => {
    it('builds annotations correctly', () => {
      const result = {
        checks: [
          { passed: true, label: 'Check 1', detail: 'Detail 1' },
          { passed: false, label: 'Check 2', detail: 'Detail 2' }
        ]
      } as any;
      const annotations = buildCheckAnnotations(result);
      expect(annotations).toEqual([
        { path: 'trustbridge-validation', start_line: 1, end_line: 1, annotation_level: 'notice', title: 'Check 1', message: 'Detail 1' },
        { path: 'trustbridge-validation', start_line: 1, end_line: 1, annotation_level: 'failure', title: 'Check 2', message: 'Detail 2' }
      ]);
    });
  });

  describe('createCheckRun', () => {
    const validResult = {
      valid: true,
      checks: [
        { passed: true, label: 'Test', detail: 'Passed' }
      ]
    } as any;

    it('creates a check run successfully', async () => {
      mockCreateCheck.mockResolvedValueOnce({ data: { id: 456 } });
      const result = await createCheckRun(validResult, 'fake-token');
      expect(result.success).toBe(true);
      expect(result.checkRunId).toBe(456);
      expect(mockCreateCheck).toHaveBeenCalled();
    });

    it('fails open on HTTP 403', async () => {
      const error: any = new Error('Permission denied');
      error.status = 403;
      mockCreateCheck.mockRejectedValueOnce(error);

      const result = await createCheckRun(validResult, 'fake-token');
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/403/);
      expect(core.warning).toHaveBeenCalled();
    });

    it('fails open on network failure', async () => {
      mockCreateCheck.mockRejectedValueOnce(new Error('Network error'));

      const result = await createCheckRun(validResult, 'fake-token');
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Network error/);
      expect(core.warning).toHaveBeenCalled();
    });
  });

  describe('createCheckRun cancellation mid-check (Issue #783)', () => {
    const failingResult = {
      valid: false,
      checks: [
        { passed: true, label: 'Account funded', detail: 'ok' },
        { passed: false, label: 'Trustline', detail: 'missing' }
      ]
    } as any;

    it('does not call the Checks API when already cancelled', async () => {
      const controller = new AbortController();
      controller.abort();
      const result = await createCheckRun(failingResult, 'fake-token', { signal: controller.signal });
      expect(result).toMatchObject({ success: false, cancelled: true });
      expect(result.checkRunId).toBeUndefined();
      expect(mockCreateCheck).not.toHaveBeenCalled();
      expect(core.warning).not.toHaveBeenCalled();
    });

    it('reports cancelled, not a failure, when aborted during the API call', async () => {
      const controller = new AbortController();
      mockCreateCheck.mockImplementationOnce(({ request }: any) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
          controller.abort();
        })
      );
      const result = await createCheckRun(failingResult, 'fake-token', { signal: controller.signal });
      expect(result).toMatchObject({ success: false, cancelled: true });
      expect(result.checkRunId).toBeUndefined();
      expect(core.warning).not.toHaveBeenCalled();
    });

    it('forwards the signal to Octokit and writes one completed Check Run on the happy path', async () => {
      const controller = new AbortController();
      mockCreateCheck.mockResolvedValueOnce({ data: { id: 789 } });
      const result = await createCheckRun(failingResult, 'fake-token', { signal: controller.signal });
      expect(result).toMatchObject({ success: true, checkRunId: 789 });
      expect(result.cancelled).toBeUndefined();
      expect(mockCreateCheck).toHaveBeenCalledTimes(1);
      const args = mockCreateCheck.mock.calls[0][0];
      expect(args.status).toBe('completed');
      expect(args.conclusion).toBe('failure');
      expect(args.request.signal).toBe(controller.signal);
    });

    it('still fails open on a non-abort error when a signal is supplied', async () => {
      mockCreateCheck.mockRejectedValueOnce(new Error('Network error'));
      const result = await createCheckRun(failingResult, 'fake-token', { signal: new AbortController().signal });
      expect(result.success).toBe(false);
      expect(result.cancelled).toBeUndefined();
      expect(result.message).toMatch(/Network error/);
    });
  });
});
