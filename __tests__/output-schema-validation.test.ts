/**
 * Output JSON schema validation tests (Issue #969).
 *
 * Every structured output must be validated before any `core.setOutput` call.
 * A bad output must fail with a path-aware error and must not publish a
 * partially validated set of outputs.
 */
import * as core from '@actions/core';
import { ValidationResult } from '../src/checks';
import {
  ActionOutputSchemaError,
  toActionOutputs,
  validateActionOutput,
  validateActionOutputs,
  setValidationOutputs,
} from '../src/outputs';

jest.mock('@actions/core');

const mockSetOutput = core.setOutput as jest.MockedFunction<typeof core.setOutput>;

const validResult: ValidationResult = {
  valid: true,
  accountFunded: true,
  trustlineExists: true,
  xlmBalance: '5.0000000',
  xlmReserveMet: true,
  checks: [{ passed: true, label: 'Account funded', detail: 'Funded' }],
  reasonCode: 'SUCCESS',
};

beforeEach(() => {
  mockSetOutput.mockClear();
});

describe('output JSON schema validation (Issue #969)', () => {
  it('accepts every structured output produced by toActionOutputs', () => {
    expect(() => validateActionOutputs(toActionOutputs(validResult))).not.toThrow();
  });

  it('publishes all outputs when validation succeeds', () => {
    expect(() => setValidationOutputs(validResult)).not.toThrow();
    expect(mockSetOutput).toHaveBeenCalledWith('checks_json', expect.any(String));
    expect(mockSetOutput.mock.calls.length).toBeGreaterThan(20);
  });

  it('rejects malformed JSON before publishing any output', () => {
    const outputs = toActionOutputs(validResult);
    outputs.checks_json = '{not json';

    expect(() => validateActionOutputs(outputs)).toThrow(ActionOutputSchemaError);
    expect(() => validateActionOutputs(outputs)).toThrow(/checks_json/);
    expect(mockSetOutput).not.toHaveBeenCalled();
  });

  it('validates generated outputs before calling setOutput', () => {
    const invalidExtras = {
      assetsTrustlineStatus: [
        {
          assetCode: 'USDC',
          assetIssuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          trustlineExists: true,
          balance: 123 as unknown as string,
        },
      ],
    };

    expect(() => setValidationOutputs(validResult, undefined, undefined, invalidExtras)).toThrow(
      ActionOutputSchemaError,
    );
    expect(mockSetOutput).not.toHaveBeenCalled();
  });

  it('reports the exact path of a wrong-typed nested field', () => {
    const outputs = toActionOutputs(validResult);
    outputs.checks_json = JSON.stringify([
      { label: 'Account funded', passed: 'yes', detail: 'Funded' },
    ]);

    expect(() => validateActionOutputs(outputs)).toThrow(
      /\$\.checks_json\[0\]\.passed/,
    );
    expect(() => validateActionOutputs(outputs)).toThrow(/must be boolean/);
  });

  it('reports missing required fields in array items', () => {
    validateActionOutput('assets_trustline_status', '[]');
    expect(() =>
      validateActionOutput(
        'assets_trustline_status',
        JSON.stringify([{ asset_code: 'USDC' }]),
      ),
    ).toThrow(/\$\.assets_trustline_status\[0\]\.asset_issuer/);
  });

  it('rejects a batch summary with missing required aggregate fields', () => {
    expect(() => validateActionOutput('batch_summary_json', JSON.stringify({ total: 1 }))).toThrow(
      /\$\.batch_summary_json\.passed/,
    );
  });

  it('accepts the documented empty-string sentinels', () => {
    expect(() => validateActionOutput('conflict_report', '')).not.toThrow();
    expect(() => validateActionOutput('batch_summary_json', '')).not.toThrow();
  });
});
