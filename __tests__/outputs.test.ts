import { ValidationResult } from '../src/checks';
import { toActionOutputs } from '../src/outputs';

const result: ValidationResult = {
  valid: true,
  accountFunded: true,
  trustlineExists: true,
  xlmBalance: '5.0000000',
  xlmReserveMet: true,
  checks: [],
};

describe('toActionOutputs', () => {
  it('serializes validation outputs for GitHub Actions', () => {
    expect(toActionOutputs(result)).toEqual({
      trustline_exists: 'true',
      xlm_balance: '5.0000000',
      account_funded: 'true',
      comment_url: '',
    });
  });

  it('includes a comment URL when provided', () => {
    expect(toActionOutputs(result, 'https://github.com/comment')).toEqual({
      trustline_exists: 'true',
      xlm_balance: '5.0000000',
      account_funded: 'true',
      comment_url: 'https://github.com/comment',
    });
  });
});
