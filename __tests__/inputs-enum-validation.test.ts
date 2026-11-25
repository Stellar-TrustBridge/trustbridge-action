/**
 * Issue #901 — enum validation for `network` and enforcement modes.
 *
 * Table-driven tests for the case-sensitivity policy (trim + lowercase),
 * the empty-value defaults, and the stable error format, plus a drift check
 * that action.yml, the JSON schema and docs/INPUT_VALIDATION.md list the
 * same allowed values as src/inputs.ts.
 *
 * Validate with: npm test -- --testPathPattern inputs-enum-validation
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  parseHomeDomainCheckModeInput,
  parseNetworkInput,
  VALID_HOME_DOMAIN_CHECK_MODES,
  VALID_NETWORK_INPUTS,
} from '../src/inputs';
import {
  clearSpans,
  ENUM_INPUT_MAX_ECHO_LENGTH,
  getSpans,
  validateEnumInput,
} from '../src/validation';

const ROOT = path.resolve(__dirname, '..');

describe('parseNetworkInput', () => {
  it.each([
    ['testnet', 'testnet'],
    ['public', 'public'],
    ['mainnet', 'mainnet'],
    ['Testnet', 'testnet'],
    ['PUBLIC', 'public'],
    ['  mainnet  ', 'mainnet'],
    ['', ''],
    ['   ', ''],
  ])('accepts %j as %j', (raw, expected) => {
    expect(parseNetworkInput(raw)).toBe(expected);
  });

  it('treats undefined as no network preset', () => {
    expect(parseNetworkInput(undefined)).toBe('');
  });

  it.each(['testnett', 'pubnet', 'futurenet', 'test net', 'main-net', 'testnet,public'])(
    'rejects %j with the list of allowed values',
    (raw) => {
      expect(() => parseNetworkInput(raw)).toThrow(
        `network must be one of "testnet", "public", "mainnet". Received: "${raw}"`,
      );
    },
  );
});

describe('parseHomeDomainCheckModeInput', () => {
  it.each([
    ['warn', 'warn'],
    ['strict', 'strict'],
    ['Strict', 'strict'],
    [' WARN ', 'warn'],
    ['', 'warn'],
    [undefined, 'warn'],
  ])('accepts %j as %j', (raw, expected) => {
    expect(parseHomeDomainCheckModeInput(raw)).toBe(expected);
  });

  it.each(['stirct', 'fail', 'enforce', 'true', 'strict!'])(
    'rejects %j instead of silently downgrading to warn',
    (raw) => {
      expect(() => parseHomeDomainCheckModeInput(raw)).toThrow(
        `home_domain_check_mode must be one of "warn", "strict". Received: "${raw}"`,
      );
    },
  );
});

describe('validateEnumInput', () => {
  beforeEach(() => clearSpans());

  it('truncates oversized received values in the error message', () => {
    const oversized = 'x'.repeat(500);
    const result = validateEnumInput(oversized, 'network', VALID_NETWORK_INPUTS);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain(`"${'x'.repeat(ENUM_INPUT_MAX_ECHO_LENGTH)}…"`);
    expect(result.errors[0]).not.toContain('x'.repeat(ENUM_INPUT_MAX_ECHO_LENGTH + 1));
  });

  it('never records the raw value in the validation span', () => {
    validateEnumInput('secret-looking-value', 'network', VALID_NETWORK_INPUTS);
    const spans = getSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('validateEnumInput');
    expect(spans[0].status).toBe('error');
    expect(JSON.stringify(spans[0].attributes)).not.toContain('secret-looking-value');
  });

  it('records an ok span for a valid value', () => {
    expect(validateEnumInput('strict', 'home_domain_check_mode', VALID_HOME_DOMAIN_CHECK_MODES).valid).toBe(true);
    expect(getSpans()[0].status).toBe('ok');
  });
});

describe('allowed enum values stay in sync with action.yml, schema and docs', () => {
  const actionYml = fs.readFileSync(path.join(ROOT, 'action.yml'), 'utf8');
  const schema = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'schemas', 'action-inputs.schema.json'), 'utf8'),
  ) as { properties: Record<string, { enum?: string[] }> };
  const docs = fs.readFileSync(path.join(ROOT, 'docs', 'INPUT_VALIDATION.md'), 'utf8');

  it.each([
    ['network', VALID_NETWORK_INPUTS],
    ['home_domain_check_mode', VALID_HOME_DOMAIN_CHECK_MODES],
  ] as const)('%s', (input, allowed) => {
    expect(schema.properties[input].enum).toEqual(['', ...allowed]);

    const block = actionYml.split(new RegExp(`\\n  ${input}:\\n`))[1]?.split(/\n  \w+:\n/)[0] ?? '';
    for (const value of allowed) {
      expect(block).toContain(`"${value}"`);
      expect(docs).toContain(`\`${value}\``);
    }
    expect(docs).toContain(`\`${input}\``);
  });
});
