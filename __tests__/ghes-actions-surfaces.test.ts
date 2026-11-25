/**
 * ghes-actions-surfaces.test.ts (Issue #897)
 *
 * Drift test for the "Actions outputs, summaries and annotations" matrix in
 * docs/GHES_COMPATIBILITY.md, plus runtime behaviour where github.com and
 * GHES runners differ (missing GITHUB_OUTPUT / GITHUB_STEP_SUMMARY).
 *
 * The last block only runs on a real GHES runner (GITHUB_SERVER_URL is set
 * and is not github.com). Everywhere else it is reported as skipped.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  GITHUB_OUTPUT_VALUE_LIMIT_BYTES,
  MAX_OUTPUT_VALUE_BYTES,
  WORKFLOW_ANNOTATION_LIMITS,
  resolveOutputTransport,
  truncateJsonArray,
} from '../src/outputs';
import {
  JOB_SUMMARY_MAX_BYTES,
  JOB_SUMMARY_TRUNCATED_MARKER,
  guardJobSummaryMarkdown,
  isJobSummaryAvailable,
} from '../src/summary';
import { CHECK_RUN_ANNOTATIONS_PER_REQUEST } from '../src/checks-run';
import { COMMENT_SIZE_LIMIT_BYTES } from '../src/comment';
import { MetricsCollector, writeJobSummary } from '../src/metrics';

const REPO_ROOT = path.resolve(__dirname, '..');
const GHES_DOC = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'GHES_COMPATIBILITY.md'), 'utf8');
const USAGE_DOC = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'USAGE.md'), 'utf8');

const BEGIN_MARKER = '<!-- GHES_ACTIONS_SURFACES_BEGIN -->';
const END_MARKER = '<!-- GHES_ACTIONS_SURFACES_END -->';
const ANCHOR = 'actions-outputs-summaries-and-annotations-issue-897';

const fmt = (n: number) => n.toLocaleString('en-US');

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function parseMatrix(): { header: string[]; rows: Map<string, Record<string, string>> } {
  const begin = GHES_DOC.indexOf(BEGIN_MARKER);
  const end = GHES_DOC.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error('GHES Actions surfaces matrix markers missing or out of order');
  }
  const lines = GHES_DOC.slice(begin + BEGIN_MARKER.length, end)
    .split('\n')
    .filter((l) => l.trim().startsWith('|'));
  const header = splitRow(lines[0]);
  const rows = new Map<string, Record<string, string>>();
  for (const line of lines.slice(2)) {
    const cells = splitRow(line);
    const key = cells[0].replace(/`/g, '');
    rows.set(key, Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
  }
  return { header, rows };
}

const REQUIRED_ROW_KEYS = [
  'step-output-value',
  'output-transport',
  'job-summary-availability',
  'job-summary-size',
  'check-run-annotations',
  'workflow-annotations',
  'comment-body',
] as const;

describe('GHES Actions surfaces matrix (#897)', () => {
  const { header, rows } = parseMatrix();

  it('has the documented columns', () => {
    expect(header).toEqual(['Key', 'Surface', 'github.com', 'GHES', 'TrustBridge behaviour', 'Constant']);
  });

  it('documents every required row', () => {
    expect([...rows.keys()].sort()).toEqual([...REQUIRED_ROW_KEYS].sort());
  });

  it('every row has a github.com and a GHES cell with a status icon', () => {
    for (const row of rows.values()) {
      expect(row['github.com']).toMatch(/^(✅|⚠️|❌)/);
      expect(row.GHES).toMatch(/^(✅|⚠️|❌)/);
    }
  });

  it('size and count cells match the code constants', () => {
    expect(GITHUB_OUTPUT_VALUE_LIMIT_BYTES).toBe(1024 * 1024);
    expect(MAX_OUTPUT_VALUE_BYTES).toBeLessThan(GITHUB_OUTPUT_VALUE_LIMIT_BYTES);

    const output = rows.get('step-output-value')!;
    expect(output['github.com']).toContain(fmt(GITHUB_OUTPUT_VALUE_LIMIT_BYTES));
    expect(output.GHES).toContain(fmt(GITHUB_OUTPUT_VALUE_LIMIT_BYTES));
    expect(output['TrustBridge behaviour']).toContain(fmt(MAX_OUTPUT_VALUE_BYTES));

    const summary = rows.get('job-summary-size')!;
    expect(summary['github.com']).toContain(fmt(JOB_SUMMARY_MAX_BYTES));
    expect(summary.GHES).toContain(fmt(JOB_SUMMARY_MAX_BYTES));

    const checkRun = rows.get('check-run-annotations')!;
    expect(checkRun['github.com']).toContain(String(CHECK_RUN_ANNOTATIONS_PER_REQUEST));
    expect(checkRun.GHES).toContain(String(CHECK_RUN_ANNOTATIONS_PER_REQUEST));

    const workflow = rows.get('workflow-annotations')!;
    for (const cell of [workflow['github.com'], workflow.GHES]) {
      expect(cell).toContain(`${WORKFLOW_ANNOTATION_LIMITS.errorsPerStep} errors`);
      expect(cell).toContain(`${WORKFLOW_ANNOTATION_LIMITS.warningsPerStep} warnings`);
      expect(cell).toContain(`${WORKFLOW_ANNOTATION_LIMITS.perJob} per job`);
    }

    const comment = rows.get('comment-body')!;
    expect(comment['github.com']).toContain(fmt(COMMENT_SIZE_LIMIT_BYTES));
    expect(comment.GHES).toContain(fmt(COMMENT_SIZE_LIMIT_BYTES));
  });

  it('every Constant cell names an exported symbol', () => {
    const exported = new Set([
      'GITHUB_OUTPUT_VALUE_LIMIT_BYTES',
      'MAX_OUTPUT_VALUE_BYTES',
      'resolveOutputTransport()',
      'isJobSummaryAvailable()',
      'JOB_SUMMARY_MAX_BYTES',
      'CHECK_RUN_ANNOTATIONS_PER_REQUEST',
      'WORKFLOW_ANNOTATION_LIMITS',
      'COMMENT_SIZE_LIMIT_BYTES',
    ]);
    for (const row of rows.values()) {
      const names = [...row.Constant.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(exported).toContain(name);
    }
  });

  it('USAGE.md links to the matrix', () => {
    expect(USAGE_DOC).toContain(`GHES_COMPATIBILITY.md#${ANCHOR}`);
    expect(GHES_DOC).toContain('## Actions Outputs, Summaries and Annotations (Issue #897)');
  });
});

describe('runner surfaces that differ on GHES (#897)', () => {
  it('happy path: github.com-style runner uses the file command and has a Job Summary', () => {
    const env = { GITHUB_OUTPUT: '/tmp/out', GITHUB_STEP_SUMMARY: '/tmp/summary' };
    expect(resolveOutputTransport(env)).toBe('file-command');
    expect(isJobSummaryAvailable(env)).toBe(true);
  });

  it('older GHES runner without GITHUB_OUTPUT falls back to the workflow command', () => {
    expect(resolveOutputTransport({})).toBe('workflow-command');
    expect(resolveOutputTransport({ GITHUB_OUTPUT: '' })).toBe('workflow-command');
  });

  it('GHES without Job Summaries: availability is false and writeJobSummary does not throw', async () => {
    expect(isJobSummaryAvailable({})).toBe(false);
    expect(isJobSummaryAvailable({ GITHUB_STEP_SUMMARY: '' })).toBe(false);

    const saved = process.env.GITHUB_STEP_SUMMARY;
    delete process.env.GITHUB_STEP_SUMMARY;
    try {
      await expect(writeJobSummary(new MetricsCollector().buildJobSummary())).resolves.toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.GITHUB_STEP_SUMMARY = saved;
    }
  });

  it('malformed env input is treated as missing', () => {
    expect(resolveOutputTransport(null as never)).toBe('workflow-command');
    expect(isJobSummaryAvailable(null as never)).toBe(false);
  });

  it('oversized Job Summary is truncated with the stable marker', () => {
    const big = 'x'.repeat(100) + '\n' + 'y'.repeat(200);
    const guarded = guardJobSummaryMarkdown(big, { maxBytes: 250 });
    expect(guarded.truncated).toBe(true);
    expect(Buffer.byteLength(guarded.markdown, 'utf8')).toBeLessThanOrEqual(250);
    expect(guarded.markdown).toContain(JOB_SUMMARY_TRUNCATED_MARKER);
  });

  it('oversized output is truncated under the budget and flagged', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ i, pad: 'z'.repeat(40) }));
    const result = truncateJsonArray(items, (xs) => JSON.stringify(xs), 500);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.json, 'utf8')).toBeLessThanOrEqual(500);
  });
});

const serverUrl = process.env.GITHUB_SERVER_URL ?? '';
const onGhesRunner = serverUrl !== '' && !/^https:\/\/github\.com\/?$/i.test(serverUrl);

// Skip marker: only meaningful on a self-hosted GHES runner.
(onGhesRunner ? describe : describe.skip)('live GHES runner surfaces (#897)', () => {
  it('reports which output transport and Job Summary support this runner has', () => {
    const transport = resolveOutputTransport();
    expect(['file-command', 'workflow-command']).toContain(transport);
    expect(typeof isJobSummaryAvailable()).toBe('boolean');
  });

  it('GITHUB_API_URL points at the GHES host', () => {
    const host = new URL(serverUrl).host;
    expect(process.env.GITHUB_API_URL ?? '').toContain(host);
  });
});
