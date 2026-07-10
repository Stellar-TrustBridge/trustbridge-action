import { getErrorMessage, parseBooleanInput, parseNumberInput } from '../src/inputs';

describe('parseBooleanInput', () => {
  it.each(['true', 'TRUE', '1', 'yes', ' Yes '])(
    'parses %s as true',
    (value) => {
      expect(parseBooleanInput(value, false)).toBe(true);
    },
  );

  it.each(['false', 'FALSE', '0', 'no', ' No '])(
    'parses %s as false',
    (value) => {
      expect(parseBooleanInput(value, true)).toBe(false);
    },
  );

  it('falls back to the default for blank values', () => {
    expect(parseBooleanInput('', true)).toBe(true);
  });

  it('falls back to the default for unknown values', () => {
    expect(parseBooleanInput('sometimes', false)).toBe(false);
  });
});

describe('parseNumberInput', () => {
  it('returns default value for blank inputs', () => {
    expect(parseNumberInput('', 20)).toBe(20);
  });

  it('parses numeric strings correctly', () => {
    expect(parseNumberInput(' 1500 ', 1000)).toBe(1500);
  });

  it('throws when input is not numeric', () => {
    expect(() => parseNumberInput('abc', 1000)).toThrow(
      'Expected a numeric input, but received: "abc"',
    );
  });

  it('throws when input is below min', () => {
    expect(() => parseNumberInput('0', 1000, { min: 1 })).toThrow(
      'Value must be at least 1. Received: 0',
    );
  });

  it('throws when input is above max', () => {
    expect(() => parseNumberInput('100', 10, { max: 50 })).toThrow(
      'Value must be at most 50. Received: 100',
    );
  });
});

describe('getErrorMessage', () => {
  it('reads Error messages and stringifies unknown values', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
    expect(getErrorMessage('plain')).toBe('plain');
  });
});
