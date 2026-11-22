import {
  formatJobSummaryMarkdown,
  JOB_SUMMARY_TRUNCATED_MARKER,
} from '../src/summary';
import { listDeprecatedInputAliases } from '../src/inputs';
import { jitteredRetryDelayMs } from '../src/horizon';

describe('Wave runtime safeguards (#861–#864)', () => {
  it('keeps the compact summary when the full artifact exceeds the budget', () => {
    const result = formatJobSummaryMarkdown(
      {
        latencyMs: 12.4,
        failureCodes: [429, 503],
        totalRuns: 4,
        totalErrors: 2,
        jsonArtifact: 'x'.repeat(20_000),
      },
      { maxBytes: 512 },
    );

    expect(result.truncated).toBe(true);
    expect(result.markdown).toContain(JOB_SUMMARY_TRUNCATED_MARKER);
    expect(result.markdown).toContain('Failure codes');
    expect(Buffer.byteLength(result.markdown)).toBeLessThanOrEqual(512);
  });

  it('rejects malformed report structures with stable errors', () => {
    expect(() => formatJobSummaryMarkdown(undefined as never)).toThrow(
      'summary: Job Summary report must be an object',
    );
    expect(() => formatJobSummaryMarkdown({ failureCodes: '429' } as never)).toThrow(
      'summary: Job Summary failureCodes must be an array',
    );
  });

  it('lists only explicitly supplied legacy aliases', () => {
    expect(
      listDeprecatedInputAliases({
        maintainerAlias: 'true',
        readyPassAlias: '',
        readyLabelPassAlias: 'ready',
      }),
    ).toEqual(['skip_if_maintainer', 'ready_label_pass']);
  });

  it('keeps Retry-After jitter non-negative and below the hard ceiling', () => {
    const delay = jitteredRetryDelayMs(10_000, 2_000);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(2_000);
    expect(jitteredRetryDelayMs(-1, 2_000)).toBe(0);
  });
});
