/**
 * Issue #780 — Job Summary markdown size guard.
 */
import {
  guardJobSummaryMarkdown,
  JOB_SUMMARY_MAX_BYTES,
  JOB_SUMMARY_TRUNCATED_MARKER,
} from '../src/summary';

describe('guardJobSummaryMarkdown (#780)', () => {
  it('returns small summaries unchanged', () => {
    const md = '## TrustBridge\n\n| a | b |\n';
    expect(guardJobSummaryMarkdown(md)).toEqual({
      markdown: md,
      truncated: false,
      originalBytes: Buffer.byteLength(md),
    });
  });

  it('defaults to the 1 MiB GitHub limit', () => {
    expect(JOB_SUMMARY_MAX_BYTES).toBe(1048576);
    const md = 'x'.repeat(JOB_SUMMARY_MAX_BYTES);
    expect(guardJobSummaryMarkdown(md).truncated).toBe(false);
    expect(guardJobSummaryMarkdown(md + 'y').truncated).toBe(true);
  });

  it('truncates large batch output on a line boundary with a comment pointer', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => `| G${i} | ❌ trustline missing |`);
    const md = rows.join('\n');
    const url = 'https://github.com/o/r/issues/1#issuecomment-2';
    const out = guardJobSummaryMarkdown(md, { maxBytes: 4096, commentUrl: url });

    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.markdown)).toBeLessThanOrEqual(4096);
    expect(out.markdown).toContain(JOB_SUMMARY_TRUNCATED_MARKER);
    expect(out.markdown).toContain(url);
    const body = out.markdown.split('\n\n' + JOB_SUMMARY_TRUNCATED_MARKER)[0];
    expect(body.split('\n').every((line) => rows.includes(line))).toBe(true);
    expect(out.markdown).not.toContain('�');
  });

  it('points at the workflow logs when no comment URL is known', () => {
    const out = guardJobSummaryMarkdown('é'.repeat(3000), { maxBytes: 1000 });
    expect(out.markdown).toContain('workflow logs');
    expect(out.markdown).not.toContain('�');
    expect(Buffer.byteLength(out.markdown)).toBeLessThanOrEqual(1000);
  });

  it('fails with stable errors on malformed input', () => {
    expect(() => guardJobSummaryMarkdown(undefined as unknown as string)).toThrow(
      'summary: Job Summary markdown must be a string',
    );
    expect(() => guardJobSummaryMarkdown('x'.repeat(100), { maxBytes: 10 })).toThrow(/too small/);
  });
});
