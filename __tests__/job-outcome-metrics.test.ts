/**
 * Issue #899 — job-level outcome counters (pass / fail / skipped) and
 * per-check skipped counts.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import {
  CHECK_KINDS,
  JOB_OUTCOMES,
  JOB_OUTCOME_PROMETHEUS_METRICS,
  MetricsCollector,
  checkSkippedCounterName,
  jobOutcomeCounterName,
  writeJobSummary,
  type JobOutcome,
} from '../src/metrics';
import { classifyCheckKind, isCheckSkipped, listSkippedCheckKinds } from '../src/summary';
import { ValidationResult } from '../src/checks';

jest.mock('@actions/core');

const mockCore = core as jest.Mocked<typeof core>;

function outcomeCounters(m: MetricsCollector): Record<JobOutcome, number> {
  return Object.fromEntries(
    JOB_OUTCOMES.map((o) => [o, m.getCounter(jobOutcomeCounterName(o))]),
  ) as Record<JobOutcome, number>;
}

function makeResult(checks: { label: string; passed: boolean; detail: string }[]): ValidationResult {
  return { valid: checks.every((c) => c.passed), checks } as ValidationResult;
}

describe('recordJobOutcome (#899)', () => {
  it.each(JOB_OUTCOMES.map((o) => [o]))('records %s and nothing else', (outcome) => {
    const m = new MetricsCollector();
    m.recordJobOutcome(outcome);
    const counters = outcomeCounters(m);
    expect(counters[outcome]).toBe(1);
    expect(Object.values(counters).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('outcomes are mutually exclusive: the first call wins', () => {
    const m = new MetricsCollector();
    m.recordJobOutcome('pass');
    const second = m.recordJobOutcome('fail', ['trustline']);
    expect(second.outcome).toBe('pass');
    expect(outcomeCounters(m)).toEqual({ pass: 1, fail: 0, skipped: 0 });
    expect(m.getCounter(checkSkippedCounterName('trustline'))).toBe(0);
    expect(m.getSummary().metrics.filter((p) => p.name === 'job_outcome')).toHaveLength(1);
  });

  it('repeated identical calls are idempotent', () => {
    const m = new MetricsCollector();
    m.recordJobOutcome('fail', ['xlm_reserve']);
    m.recordJobOutcome('fail', ['xlm_reserve']);
    expect(m.getCounter(jobOutcomeCounterName('fail'))).toBe(1);
    expect(m.getCounter(checkSkippedCounterName('xlm_reserve'))).toBe(1);
  });

  it('counts skipped checks per kind and folds unknown kinds into other', () => {
    const m = new MetricsCollector();
    const record = m.recordJobOutcome('fail', [
      'trustline_limit',
      'asset_balance',
      'asset_balance',
      'GABC_not_a_kind' as never,
    ]);
    expect(record.skippedChecks).toEqual({ trustline_limit: 1, asset_balance: 2, other: 1 });
    expect(m.getCounter(checkSkippedCounterName('asset_balance'))).toBe(2);
    expect(m.getCounter(checkSkippedCounterName('other'))).toBe(1);
    const tags = m
      .getSummary()
      .metrics.filter((p) => p.name === 'check_skipped')
      .map((p) => p.tags?.check);
    for (const tag of tags) expect(CHECK_KINDS).toContain(tag);
  });

  it('rejects an unknown outcome without recording anything', () => {
    const m = new MetricsCollector();
    expect(() => m.recordJobOutcome('error' as JobOutcome)).toThrow(/outcome must be one of/);
    expect(m.getJobOutcome()).toBeUndefined();
    expect(outcomeCounters(m)).toEqual({ pass: 0, fail: 0, skipped: 0 });
  });

  it('tolerates a malformed skipped list', () => {
    const m = new MetricsCollector();
    const record = m.recordJobOutcome('pass', null as never);
    expect(record.skippedChecks).toEqual({});
  });

  it('resetJobOutcome lets the next job record a new outcome; reset clears it', () => {
    const m = new MetricsCollector();
    m.recordJobOutcome('skipped');
    m.resetJobOutcome();
    m.recordJobOutcome('pass');
    expect(outcomeCounters(m)).toEqual({ pass: 1, fail: 0, skipped: 1 });
    m.reset();
    expect(m.getJobOutcome()).toBeUndefined();
  });

  it('includes the outcome in buildJobSummary and its JSON artifact', () => {
    const m = new MetricsCollector();
    expect(m.buildJobSummary().jobOutcome).toBeUndefined();
    m.recordJobOutcome('fail', ['trustline_limit']);
    const report = m.buildJobSummary();
    expect(report.jobOutcome).toBe('fail');
    const artifact = JSON.parse(report.jsonArtifact);
    expect(artifact.jobOutcome).toEqual({ outcome: 'fail', skippedChecks: { trustline_limit: 1 } });
    expect(artifact.counters[jobOutcomeCounterName('fail')]).toBe(1);
  });

  it('renders a Job outcome row in the Job Summary table', async () => {
    const addTable = jest.fn().mockReturnThis();
    (mockCore.summary as unknown as Record<string, jest.Mock>) = {
      addHeading: jest.fn().mockReturnThis(),
      addTable,
      addDetails: jest.fn().mockReturnThis(),
      write: jest.fn().mockResolvedValue(undefined),
    };
    const m = new MetricsCollector();
    m.recordJobOutcome('skipped');
    await writeJobSummary(m.buildJobSummary());
    const flat = (addTable.mock.calls[0][0] as unknown[][]).flat().map(String);
    expect(flat).toContain('Job outcome');
    expect(flat).toContain('skipped');
  });
});

describe('skipped check classification (#899)', () => {
  it('happy path: an all-passing result has no skipped checks', () => {
    const result = makeResult([
      { label: 'Account funded', passed: true, detail: 'Account is active.' },
      { label: 'USDC trustline', passed: true, detail: 'Trustline is configured.' },
    ]);
    expect(listSkippedCheckKinds(result)).toEqual([]);
  });

  it('detects "Cannot verify" and "Check skipped" rows', () => {
    const result = makeResult([
      { label: 'Account funded', passed: false, detail: 'Account not found.' },
      { label: 'USDC trustline', passed: false, detail: 'Cannot verify trustline until the account exists.' },
      { label: 'XLM reserve', passed: false, detail: 'Check skipped — the Horizon circuit breaker was open.' },
      { label: 'Trustline limit', passed: false, detail: 'Cannot verify trustline limit (USDC trustline does not exist).' },
    ]);
    expect(listSkippedCheckKinds(result)).toEqual(['trustline', 'xlm_reserve', 'trustline_limit']);
  });

  it('never leaks asset codes into kinds', () => {
    expect(classifyCheckKind('SECRETCOIN minimum balance')).toBe('asset_balance');
    expect(classifyCheckKind('SECRETCOIN clawback safety')).toBe('clawback');
    expect(classifyCheckKind('Some new row')).toBe('other');
    expect(classifyCheckKind(undefined as never)).toBe('other');
  });

  it('handles malformed check rows', () => {
    expect(isCheckSkipped({ detail: 42 })).toBe(false);
    expect(listSkippedCheckKinds({ checks: undefined as never })).toEqual([]);
  });
});

describe('job outcome docs (#899)', () => {
  const architecture = fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'ARCHITECTURE.md'),
    'utf8',
  );

  it('documents both Prometheus names', () => {
    expect(architecture).toContain(JOB_OUTCOME_PROMETHEUS_METRICS.jobOutcome);
    expect(architecture).toContain(JOB_OUTCOME_PROMETHEUS_METRICS.checkSkipped);
  });

  it('documents every outcome and check kind', () => {
    for (const o of JOB_OUTCOMES) expect(architecture).toContain(`\`${o}\``);
    for (const k of CHECK_KINDS) expect(architecture).toContain(`\`${k}\``);
  });
});
