/**
 * Issue #919 — every boolean action output is published as exactly "true" or
 * "false" so workflow `if:` conditions (`== 'true'`) branch consistently.
 * Legacy 1/0 values are accepted and normalized; anything else fails closed.
 */
import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import {
  BOOLEAN_OUTPUT_NAMES,
  BooleanOutputError,
  normalizeBooleanOutputs,
  parseBooleanOutput,
  setValidationOutputs,
  toActionOutputs,
  toBooleanOutput,
} from '../src/outputs';
import { ValidationResult } from '../src/checks';

function result(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    valid: true,
    accountFunded: true,
    trustlineExists: true,
    xlmBalance: '10.0000000',
    checks: [],
    reasonCode: 'SUCCESS',
    ...overrides,
  } as ValidationResult;
}

describe('parseBooleanOutput (Issue #919)', () => {
  it.each([
    [true, true],
    [false, false],
    ['true', true],
    ['false', false],
    ['TRUE', true],
    [' False ', false],
    ['1', true],
    ['0', false],
    [1, true],
    [0, false],
    [undefined, false],
    [null, false],
    ['', false],
  ])('parses %p as %p', (input, expected) => {
    expect(parseBooleanOutput(input, 'ready')).toBe(expected);
  });

  it.each([
    ['yes', 'string "yes"'],
    ['maybe', 'string "maybe"'],
    [2, 'number 2'],
    [Number.NaN, 'number NaN'],
    [{}, 'object'],
    [[], 'an array'],
  ])('rejects malformed %p with a stable error', (input, received) => {
    expect(() => parseBooleanOutput(input, 'ready')).toThrow(BooleanOutputError);
    expect(() => parseBooleanOutput(input, 'ready')).toThrow(
      `Output "ready" expects a boolean (true/false, or legacy 1/0); received ${received}.`,
    );
  });

  it('never echoes an oversized raw value in the error', () => {
    const huge = 'G'.repeat(10_000);
    let message = '';
    try {
      parseBooleanOutput(huge, 'account_funded');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('a 10000-character string');
    expect(message).not.toContain('GGGG');
  });
});

describe('toBooleanOutput (Issue #919)', () => {
  let warning: jest.SpyInstance;
  beforeEach(() => {
    warning = jest.spyOn(core, 'warning').mockImplementation(() => {});
  });
  afterEach(() => warning.mockRestore());

  it('returns canonical strings for valid values without warning', () => {
    expect(toBooleanOutput(true)).toBe('true');
    expect(toBooleanOutput('1')).toBe('true');
    expect(toBooleanOutput(0)).toBe('false');
    expect(toBooleanOutput(undefined)).toBe('false');
    expect(warning).not.toHaveBeenCalled();
  });

  it('fails closed to "false" and warns on malformed values', () => {
    expect(toBooleanOutput('yes', 'ready')).toBe('false');
    expect(toBooleanOutput(42, 'ready')).toBe('false');
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning.mock.calls[0][0]).toContain('Output "ready" expects a boolean');
    expect(warning.mock.calls[0][0]).toContain('fail closed');
  });
});

describe('toActionOutputs boolean contract (Issue #919)', () => {
  it('publishes "true"/"false" for every boolean output on the happy path', () => {
    const outputs = toActionOutputs(result(), undefined, undefined, {
      snoozeExpired: true,
      friendbotCalled: true,
      friendbotSuccess: false,
    });
    for (const name of BOOLEAN_OUTPUT_NAMES) {
      expect(['true', 'false']).toContain(outputs[name]);
    }
    expect(outputs.ready).toBe('true');
    expect(outputs.snooze_expired).toBe('true');
    expect(outputs.friendbot_called).toBe('true');
    expect(outputs.friendbot_success).toBe('false');
    expect(outputs.has_conflicts).toBe('false');
  });

  it('never publishes "undefined" when a JS caller omits boolean fields', () => {
    const partial = { xlmBalance: '0', checks: [] } as unknown as ValidationResult;
    const outputs = toActionOutputs(partial);
    expect(outputs.ready).toBe('false');
    expect(outputs.account_funded).toBe('false');
    expect(outputs.trustline_exists).toBe('false');
  });

  it('normalizes legacy 1/0 values supplied by a loosely typed producer', () => {
    const legacy = result({
      valid: 1 as unknown as boolean,
      accountFunded: '1' as unknown as boolean,
      trustlineExists: 0 as unknown as boolean,
    });
    const outputs = toActionOutputs(legacy);
    expect(outputs.ready).toBe('true');
    expect(outputs.account_funded).toBe('true');
    expect(outputs.trustline_exists).toBe('false');
  });
});

describe('normalizeBooleanOutputs (Issue #919)', () => {
  it('rewrites only boolean outputs and leaves others untouched', () => {
    const warning = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const normalized = normalizeBooleanOutputs({
      ready: 'True',
      outputs_truncated: '1',
      has_conflicts: 'nope',
      xlm_balance: '1',
    } as Record<string, string>);
    expect(normalized).toEqual({
      ready: 'true',
      outputs_truncated: 'true',
      has_conflicts: 'false',
      xlm_balance: '1',
    });
    expect(warning).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });
});

describe('setValidationOutputs publishes canonical booleans (Issue #919)', () => {
  it('passes only "true"/"false" to core.setOutput for boolean outputs', () => {
    const published: Record<string, string> = {};
    const spy = jest.spyOn(core, 'setOutput').mockImplementation((name, value) => {
      published[name] = String(value);
    });
    setValidationOutputs(result({ valid: false, trustlineExists: false, reasonCode: 'TRUSTLINE_MISSING' }));
    spy.mockRestore();

    for (const name of BOOLEAN_OUTPUT_NAMES) {
      expect(published[name]).toMatch(/^(true|false)$/);
    }
    expect(published.ready).toBe('false');
    expect(published.trustline_exists).toBe('false');
    expect(published.account_funded).toBe('true');
  });
});

describe('BOOLEAN_OUTPUT_NAMES stays in sync with action.yml (Issue #919)', () => {
  it('every listed boolean output is declared in action.yml', () => {
    const actionYml = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');
    const outputsBlock = actionYml.slice(actionYml.indexOf('\noutputs:'));
    for (const name of BOOLEAN_OUTPUT_NAMES) {
      expect(outputsBlock).toMatch(new RegExp(`\\n  ${name}:`));
    }
  });

  it('is documented in docs/USAGE.md', () => {
    const usage = fs.readFileSync(path.join(__dirname, '..', 'docs', 'USAGE.md'), 'utf8');
    expect(usage).toContain('Boolean outputs in `if:` conditions (Issue #919)');
    for (const name of BOOLEAN_OUTPUT_NAMES) {
      expect(usage).toContain(`\`${name}\``);
    }
  });
});
