/**
 * Tests for #319 — Merge resolution conflict report.
 */
import {
  buildConflictReport,
  formatConflictReportMarkdown,
  ConflictSource,
  ConflictReport,
} from '../src/outputs';
import { toActionOutputs } from '../src/outputs';
import { ValidationResult } from '../src/checks';

// ── helpers ──────────────────────────────────────────────────────────────────

const ADDR_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const ADDR_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBUA';

const baseResult: ValidationResult = {
  valid: true,
  accountFunded: true,
  trustlineExists: true,
  xlmBalance: '5.0000000',
  xlmReserveMet: true,
  checks: [
    { passed: true, label: 'Account funded', detail: 'ok' },
    { passed: true, label: 'USDC trustline', detail: 'ok' },
  ],
  reasonCode: 'SUCCESS',
};

// ── buildConflictReport ──────────────────────────────────────────────────────

describe('buildConflictReport', () => {
  it('returns hasConflicts:false when no sources provided', () => {
    const report = buildConflictReport({});
    expect(report.hasConflicts).toBe(false);
    expect(report.conflicts).toEqual([]);
  });

  it('returns hasConflicts:false when only one source per field', () => {
    const report = buildConflictReport({
      stellar_address: [{ source: 'workflow_input', value: ADDR_A }],
    });
    expect(report.hasConflicts).toBe(false);
  });

  it('returns hasConflicts:false when two sources agree on same value', () => {
    const report = buildConflictReport({
      stellar_address: [
        { source: 'workflow_input', value: ADDR_A },
        { source: 'assignee_map', value: ADDR_A },
      ],
    });
    expect(report.hasConflicts).toBe(false);
  });

  it('detects conflict when two sources disagree on stellar_address', () => {
    const report = buildConflictReport({
      stellar_address: [
        { source: 'workflow_input', value: ADDR_A },
        { source: 'assignee_map', value: ADDR_B },
      ],
    });
    expect(report.hasConflicts).toBe(true);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]!.field).toBe('stellar_address');
    expect(report.conflicts[0]!.resolvedValue).toBe(ADDR_A); // first source wins
    expect(report.conflicts[0]!.sources).toHaveLength(2);
  });

  it('resolvedValue is the FIRST source (highest precedence)', () => {
    const report = buildConflictReport({
      stellar_address: [
        { source: 'workflow_input', value: ADDR_A },
        { source: 'contract', value: ADDR_B },
        { source: 'config_file', value: ADDR_B },
      ],
    });
    expect(report.conflicts[0]!.resolvedValue).toBe(ADDR_A);
  });

  it('detects conflicts across multiple fields simultaneously', () => {
    const report = buildConflictReport({
      stellar_address: [
        { source: 'workflow_input', value: ADDR_A },
        { source: 'assignee_map', value: ADDR_B },
      ],
      asset_issuer: [
        { source: 'workflow_input', value: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
        { source: 'contract', value: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBUA' },
      ],
    });
    expect(report.hasConflicts).toBe(true);
    expect(report.conflicts).toHaveLength(2);
  });

  it('masks address values in privacy mode', () => {
    const report = buildConflictReport(
      {
        stellar_address: [
          { source: 'workflow_input', value: ADDR_A },
          { source: 'assignee_map', value: ADDR_B },
        ],
      },
      { privacyMode: true },
    );
    expect(report.hasConflicts).toBe(true);
    const conflict = report.conflicts[0]!;
    // Masked value should be first4…last4 format
    expect(conflict.resolvedValue).toMatch(/^[A-Z]{4}…[A-Z0-9]{4}$/);
    expect(conflict.resolvedValue).not.toBe(ADDR_A);
  });

  it('does NOT mask non-address values even in privacy mode', () => {
    const report = buildConflictReport(
      {
        asset_code: [
          { source: 'workflow_input', value: 'USDC' },
          { source: 'config_file', value: 'EURC' },
        ],
      },
      { privacyMode: true },
    );
    const conflict = report.conflicts[0]!;
    expect(conflict.resolvedValue).toBe('USDC');
  });

  it('uses custom `now` timestamp', () => {
    const report = buildConflictReport({}, { now: '2026-06-01T12:00:00.000Z' });
    expect(report.generatedAt).toBe('2026-06-01T12:00:00.000Z');
  });
});

// ── formatConflictReportMarkdown ─────────────────────────────────────────────

describe('formatConflictReportMarkdown', () => {
  it('returns empty string when report is null', () => {
    expect(formatConflictReportMarkdown(null)).toBe('');
  });

  it('returns empty string when report is undefined', () => {
    expect(formatConflictReportMarkdown(undefined)).toBe('');
  });

  it('returns empty string when hasConflicts is false', () => {
    const report: ConflictReport = {
      hasConflicts: false,
      conflicts: [],
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(formatConflictReportMarkdown(report)).toBe('');
  });

  it('includes the section heading when conflicts exist', () => {
    const sources: ConflictSource[] = [
      { source: 'workflow_input', value: ADDR_A },
      { source: 'assignee_map', value: ADDR_B },
    ];
    const report = buildConflictReport({ stellar_address: sources });
    const md = formatConflictReportMarkdown(report);
    expect(md).toContain('### ⚠️ Input source conflicts detected');
  });

  it('includes the conflict table with field, resolved value, and sources', () => {
    const sources: ConflictSource[] = [
      { source: 'workflow_input', value: ADDR_A },
      { source: 'assignee_map', value: ADDR_B },
    ];
    const report = buildConflictReport({ stellar_address: sources });
    const md = formatConflictReportMarkdown(report);
    expect(md).toContain('stellar_address');
    expect(md).toContain('workflow_input');
    expect(md).toContain('assignee_map');
  });

  it('includes precedence explanation', () => {
    const sources: ConflictSource[] = [
      { source: 'workflow_input', value: ADDR_A },
      { source: 'assignee_map', value: ADDR_B },
    ];
    const report = buildConflictReport({ stellar_address: sources });
    const md = formatConflictReportMarkdown(report);
    expect(md).toContain('workflow_input');
    expect(md).toContain('assignee_map');
    expect(md).toContain('config_file');
  });
});

// ── toActionOutputs — conflict_report and has_conflicts ──────────────────────

describe('toActionOutputs — conflict outputs (#319)', () => {
  it('sets conflict_report to empty string and has_conflicts to false when no conflictReport', () => {
    const outputs = toActionOutputs(baseResult);
    expect(outputs.conflict_report).toBe('');
    expect(outputs.has_conflicts).toBe('false');
  });

  it('serialises ConflictReport to JSON in conflict_report output', () => {
    const sources: ConflictSource[] = [
      { source: 'workflow_input', value: ADDR_A },
      { source: 'assignee_map', value: ADDR_B },
    ];
    const conflictReport = buildConflictReport({ stellar_address: sources });
    const outputs = toActionOutputs(baseResult, undefined, undefined, { conflictReport });
    expect(outputs.has_conflicts).toBe('true');
    const parsed = JSON.parse(outputs.conflict_report) as ConflictReport;
    expect(parsed.hasConflicts).toBe(true);
    expect(parsed.conflicts).toHaveLength(1);
  });

  it('has_conflicts is false for a no-conflict report', () => {
    const conflictReport = buildConflictReport({
      stellar_address: [{ source: 'workflow_input', value: ADDR_A }],
    });
    const outputs = toActionOutputs(baseResult, undefined, undefined, { conflictReport });
    expect(outputs.has_conflicts).toBe('false');
    expect(outputs.conflict_report).toContain('"hasConflicts":false');
  });

  it('null conflictReport gives has_conflicts:false', () => {
    const outputs = toActionOutputs(baseResult, undefined, undefined, { conflictReport: null });
    expect(outputs.has_conflicts).toBe('false');
    expect(outputs.conflict_report).toBe('');
  });
});
