import * as core from '@actions/core';

import { ValidationResult } from './checks';

export function toActionOutputs(result: ValidationResult): Record<string, string> {
  return {
    trustline_exists: String(result.trustlineExists),
    xlm_balance: result.xlmBalance,
    account_funded: String(result.accountFunded),
  };
}

export function setValidationOutputs(result: ValidationResult): void {
  const outputs = toActionOutputs(result);
  for (const [name, value] of Object.entries(outputs)) {
    core.setOutput(name, value);
  }
}
