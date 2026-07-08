import { ValidationResult } from './checks';

export interface CheckSummary {
  total: number;
  passed: number;
  failed: number;
  failedLabels: string[];
}

export function summarizeChecks(result: ValidationResult): CheckSummary {
  const failedLabels = result.checks
    .filter((check) => !check.passed)
    .map((check) => check.label);

  return {
    total: result.checks.length,
    passed: result.checks.length - failedLabels.length,
    failed: failedLabels.length,
    failedLabels,
  };
}

export function formatFailureSummary(result: ValidationResult): string {
  const summary = summarizeChecks(result);
  return summary.failedLabels.length > 0
    ? summary.failedLabels.join(', ')
    : 'none';
}
