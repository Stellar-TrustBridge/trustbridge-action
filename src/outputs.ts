import * as core from '@actions/core';

import { ValidationResult } from './checks';

export interface ActionOutputs {
  trustline_exists: string;
  xlm_balance: string;
  account_funded: string;
  comment_url: string;
}

export function toActionOutputs(result: ValidationResult, commentUrl?: string): ActionOutputs {
  return {
    trustline_exists: String(result.trustlineExists),
    xlm_balance: result.xlmBalance,
    account_funded: String(result.accountFunded),
    comment_url: commentUrl ?? '',
  };
}

export function setValidationOutputs(result: ValidationResult, commentUrl?: string): void {
  const outputs = toActionOutputs(result, commentUrl);
  for (const [name, value] of Object.entries(outputs)) {
    core.setOutput(name, value);
  }
}
