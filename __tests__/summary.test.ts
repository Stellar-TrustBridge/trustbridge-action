import { ValidationResult } from '../src/checks';
import { formatFailureSummary, summarizeChecks } from '../src/summary';

const result: ValidationResult = {
  valid: false,
  accountFunded: true,
  trustlineExists: false,
  xlmBalance: '1.0000000',
  xlmReserveMet: false,
  checks: [
    { passed: true, label: 'Account funded', detail: 'ok' },
    { passed: false, label: 'USDC trustline', detail: 'missing' },
    { passed: false, label: 'XLM reserve', detail: 'low' },
  ],
};

describe('summarizeChecks', () => {
  it('counts passed and failed checks', () => {
    expect(summarizeChecks(result)).toEqual({
      total: 3,
      passed: 1,
      failed: 2,
      failedLabels: ['USDC trustline', 'XLM reserve'],
    });
  });

  it('formats failed labels for messages', () => {
    expect(formatFailureSummary(result)).toBe('USDC trustline, XLM reserve');
  });
});
