/**
 * Tests for Issue #908 — audit log line when snooze skips validation.
 *
 * Covers:
 * - Happy path: an active marker snooze skips validation, emits one
 *   structured `snooze_skip` log line (reason_code `snoozed`, check
 *   `snooze`) with the expiry, and the comment notice names the expiry.
 * - Skipped metrics: the `snooze_skipped` counter/metric and a `skipped` job
 *   outcome are recorded when a MetricsCollector is passed.
 * - Failure path: a passing check is never snoozed — no audit line, no metric.
 * - Failure path: an expired window and `forceComment` both run validation
 *   with no audit line.
 * - Redaction: the audit line never carries reaction user logins.
 */

import * as core from '@actions/core';
import {
  SNOOZE_AUDIT_CHECK,
  SNOOZE_AUDIT_EVENT,
  SNOOZE_REASON_CODE,
  SNOOZE_SKIPPED_COUNTER,
  buildSnoozeAuditLogContext,
  enforceSnoozeWindow,
  formatSnoozeExpiry,
  type CommentReaction,
  type SnoozeMarker,
} from '../src/snooze';
import { MetricsCollector, jobOutcomeCounterName } from '../src/metrics';

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const WINDOW_MS = 60 * 60 * 1000; // 1h
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

function auditLines(): string[] {
  return (core.info as jest.Mock).mock.calls
    .map((c) => String(c[0]))
    .filter((line) => line.includes(SNOOZE_AUDIT_EVENT));
}

function parseContext(line: string): Record<string, unknown> {
  return JSON.parse(line.slice(line.indexOf('{')));
}

describe('enforceSnoozeWindow audit trail (Issue #908)', () => {
  it('happy path: emits a structured audit line and a notice with expiry', () => {
    const marker: SnoozeMarker = { status: 'fail', timestamp: NOW - 15 * 60 * 1000 };
    const enforcement = enforceSnoozeWindow(false, marker, [], WINDOW_MS, { now: NOW, issueNumber: 7 });

    const expectedExpiry = new Date(marker.timestamp + WINDOW_MS).toISOString();
    expect(enforcement.skipValidation).toBe(true);
    expect(enforcement.source).toBe('marker');
    expect(enforcement.remainingMs).toBe(45 * 60 * 1000);
    expect(enforcement.expiresAt).toBe(marker.timestamp + WINDOW_MS);
    expect(enforcement.commentNotice).toContain('~45m');
    expect(enforcement.commentNotice).toContain(`snooze expires \`${expectedExpiry}\``);

    const lines = auditLines();
    expect(lines).toHaveLength(1);
    const ctx = parseContext(lines[0]!);
    expect(ctx).toMatchObject({
      component: 'snooze',
      event: SNOOZE_AUDIT_EVENT,
      reason_code: SNOOZE_REASON_CODE,
      check: SNOOZE_AUDIT_CHECK,
      source: 'marker',
      snoozeWindowMs: WINDOW_MS,
      elapsedMs: 15 * 60 * 1000,
      remainingMs: 45 * 60 * 1000,
      expiresAt: expectedExpiry,
      issueNumber: 7,
    });
  });

  it('records skipped metrics and a skipped job outcome', () => {
    const metrics = new MetricsCollector();
    const marker: SnoozeMarker = { status: 'fail', timestamp: NOW - 1000 };
    enforceSnoozeWindow(false, marker, [], WINDOW_MS, { now: NOW, metrics });

    expect(metrics.getCounter(SNOOZE_SKIPPED_COUNTER)).toBe(1);
    expect(metrics.getCounter(jobOutcomeCounterName('skipped'))).toBe(1);
    expect(metrics.getJobOutcome()?.outcome).toBe('skipped');
    const point = metrics.getSummary().metrics.find((m) => m.name === SNOOZE_SKIPPED_COUNTER);
    expect(point).toMatchObject({ value: 1, unit: 'count', tags: { source: 'marker' } });
  });

  it('reaction-based snooze is audited without leaking user logins', () => {
    const reactions: CommentReaction[] = [
      {
        content: ':zzz:',
        created_at: new Date(NOW - 5 * 60 * 1000).toISOString(),
        user: { login: 'secret-maintainer-login', type: 'User' },
      },
    ];
    const enforcement = enforceSnoozeWindow(false, undefined, reactions, WINDOW_MS, { now: NOW });
    expect(enforcement.skipValidation).toBe(true);
    expect(enforcement.source).toBe('reaction');

    const lines = auditLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('secret-maintainer-login');
    expect(parseContext(lines[0]!)['source']).toBe('reaction');
  });

  it('failure path: a passing check is not snoozed and is not audited', () => {
    const metrics = new MetricsCollector();
    const marker: SnoozeMarker = { status: 'fail', timestamp: NOW - 1000 };
    const enforcement = enforceSnoozeWindow(true, marker, [], WINDOW_MS, { now: NOW, metrics });
    expect(enforcement.skipValidation).toBe(false);
    expect(auditLines()).toHaveLength(0);
    expect(metrics.getCounter(SNOOZE_SKIPPED_COUNTER)).toBe(0);
  });

  it('failure path: an expired window runs validation with no audit line', () => {
    const marker: SnoozeMarker = { status: 'fail', timestamp: NOW - WINDOW_MS - 1 };
    const enforcement = enforceSnoozeWindow(false, marker, [], WINDOW_MS, { now: NOW });
    expect(enforcement.skipValidation).toBe(false);
    expect(enforcement.state.snoozeExpired).toBe(true);
    expect(auditLines()).toHaveLength(0);
  });

  it('failure path: forceComment bypasses the snooze with no audit line', () => {
    const marker: SnoozeMarker = { status: 'fail', timestamp: NOW - 1000 };
    const enforcement = enforceSnoozeWindow(false, marker, [], WINDOW_MS, { now: NOW, forceComment: true });
    expect(enforcement.skipValidation).toBe(false);
    expect(auditLines()).toHaveLength(0);
  });

  it('audit: false suppresses the built-in log line but still skips', () => {
    const marker: SnoozeMarker = { status: 'fail', timestamp: NOW - 1000 };
    const enforcement = enforceSnoozeWindow(false, marker, [], WINDOW_MS, { now: NOW, audit: false });
    expect(enforcement.skipValidation).toBe(true);
    expect(auditLines()).toHaveLength(0);
    expect(buildSnoozeAuditLogContext(enforcement, WINDOW_MS)['reason_code']).toBe(SNOOZE_REASON_CODE);
  });
});

describe('formatSnoozeExpiry', () => {
  it('formats valid timestamps as ISO-8601 and malformed ones as unknown', () => {
    expect(formatSnoozeExpiry(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(formatSnoozeExpiry(undefined)).toBe('unknown');
    expect(formatSnoozeExpiry(Number.NaN)).toBe('unknown');
    expect(formatSnoozeExpiry(8.64e15 + 1)).toBe('unknown');
  });
});
