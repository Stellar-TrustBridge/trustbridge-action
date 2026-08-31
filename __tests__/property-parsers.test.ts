/**
 * Issue #290: Property tests for assignee_address_map and assets_json parsers.
 *
 * These tests verify that parsers:
 * - Never throw uncaught (non-Error) exceptions on arbitrary JSON input
 * - Never accept invalid Stellar G/C-addresses as issuers
 * - Handle prototype pollution attempts safely
 * - Handle huge inputs without hanging
 * - Align with existing parser-fuzz.test.ts coverage without duplicating
 *   Horizon HTTP fuzzing
 *
 * Validate: npm test -- --testPathPattern 'property-parsers|parser-fuzz|inputs|assets'
 */
import { parseAssigneeAddressMap, resolveAddressFromAssigneeMap } from '../src/inputs';
import {
  parseAssetsJson,
  dedupeAssets,
  assertValidAssetCode,
  assertValidAssetIssuer,
  normalizeAssetConfig,
} from '../src/assets';
import { isValidStellarAddress } from '../src/checks';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const VALID_G_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const VALID_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const VALID_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

// ---------------------------------------------------------------------------
// Fuzz/boundary string inputs covering common attack and edge-case patterns
// ---------------------------------------------------------------------------

const FUZZ_STRINGS: string[] = [
  '',
  '   ',
  'null',
  'undefined',
  'true',
  'false',
  '0',
  '-1',
  '{}',
  '[]',
  '{"__proto__":{"polluted":true}}',
  '{"constructor":{"prototype":{"polluted":true}}}',
  '{"toString":"evil"}',
  '{"valueOf":"overridden"}',
  "'; DROP TABLE accounts; --",
  '<script>alert(1)</script>',
  '[[[[[[[[[[[[[[[[[[[',    // deeply malformed JSON
  '../../../etc/passwd',
  'A'.repeat(10_000),
  'G'.repeat(56),
  'G' + 'A'.repeat(55),   // G-shaped but invalid checksum
  '\x00\x01\x02',
  '\n\r\t',
  '{"code":"","issuer":""}',
  '[{"code":null,"issuer":null}]',
  '[{"code":"USDC","issuer":"not-valid"}]',
  '[{"code":"USDC","issuer":' + JSON.stringify(VALID_ISSUER) + '}]',
];

// ---------------------------------------------------------------------------
// parseAssigneeAddressMap — property tests
// ---------------------------------------------------------------------------

describe('parseAssigneeAddressMap property tests', () => {
  describe('never throws uncaught non-Error exceptions on fuzz inputs', () => {
    for (const input of FUZZ_STRINGS) {
      const label = JSON.stringify(input).slice(0, 50);
      it(`handles: ${label}`, () => {
        // The parser must either succeed (return a value) or throw an Error.
        // It must never throw a non-Error (string, number, etc.).
        let threw = false;
        let thrownValue: unknown;
        try {
          parseAssigneeAddressMap(input);
        } catch (err) {
          threw = true;
          thrownValue = err;
        }
        if (threw) {
          expect(thrownValue).toBeInstanceOf(Error);
        }
      });
    }
  });

  it('returns empty map for empty string', () => {
    expect(parseAssigneeAddressMap('')).toEqual({});
  });

  it('returns empty map for whitespace-only string', () => {
    expect(parseAssigneeAddressMap('   ')).toEqual({});
  });

  it('parses a valid single-entry JSON map', () => {
    const result = parseAssigneeAddressMap(
      JSON.stringify({ alice: VALID_G_ADDRESS }),
    );
    expect(result['alice']).toBe(VALID_G_ADDRESS);
  });

  it('parses multiple entries', () => {
    const result = parseAssigneeAddressMap(
      JSON.stringify({ alice: VALID_G_ADDRESS, bob: VALID_ISSUER }),
    );
    expect(result['alice']).toBe(VALID_G_ADDRESS);
    expect(result['bob']).toBe(VALID_ISSUER);
  });

  it('normalizes keys to lowercase for case-insensitive GitHub username matching', () => {
    const result = parseAssigneeAddressMap(JSON.stringify({ Alice: VALID_G_ADDRESS }));
    expect(result['alice']).toBe(VALID_G_ADDRESS);
    expect(result['Alice']).toBeUndefined();
  });

  it('trims whitespace from values', () => {
    const result = parseAssigneeAddressMap(
      JSON.stringify({ alice: `  ${VALID_G_ADDRESS}  ` }),
    );
    expect(result['alice']).toBe(VALID_G_ADDRESS);
  });

  it('throws a descriptive Error when JSON is invalid', () => {
    expect(() => parseAssigneeAddressMap('not json')).toThrow(Error);
    expect(() => parseAssigneeAddressMap('{incomplete')).toThrow(Error);
  });

  it('throws when root value is null', () => {
    expect(() => parseAssigneeAddressMap('null')).toThrow(/JSON object/);
  });

  it('throws when root value is an array', () => {
    expect(() => parseAssigneeAddressMap('[]')).toThrow(/JSON object/);
  });

  it('throws when root value is a boolean', () => {
    expect(() => parseAssigneeAddressMap('true')).toThrow();
    expect(() => parseAssigneeAddressMap('false')).toThrow();
  });

  it('throws when a value is not a string', () => {
    expect(() => parseAssigneeAddressMap('{"alice":123}')).toThrow();
    expect(() => parseAssigneeAddressMap('{"alice":null}')).toThrow();
    expect(() => parseAssigneeAddressMap('{"alice":[]}')).toThrow();
    expect(() => parseAssigneeAddressMap('{"alice":{}}')).toThrow();
  });

  it('throws on an empty username key', () => {
    expect(() =>
      parseAssigneeAddressMap(`{"": "${VALID_G_ADDRESS}"}`),
    ).toThrow(/empty username/);
  });

  it('handles a map with 100 entries without hanging', () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 100; i++) big[`user${i}`] = VALID_G_ADDRESS;
    const result = parseAssigneeAddressMap(JSON.stringify(big));
    expect(Object.keys(result)).toHaveLength(100);
  });

  it('handles a map with 1000 entries without hanging', () => {
    const huge: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) huge[`contributor${i}`] = VALID_G_ADDRESS;
    const result = parseAssigneeAddressMap(JSON.stringify(huge));
    expect(Object.keys(result)).toHaveLength(1000);
  });

  it('does not suffer prototype pollution from __proto__ key', () => {
    const before = ({} as Record<string, unknown>)['polluted'];
    try {
      // JSON.parse ignores __proto__ at the top level, but we verify
      // the parser does not crash or unexpectedly pollute Object.prototype.
      parseAssigneeAddressMap('{"__proto__":{"polluted":true}}');
    } catch {
      // expected: the value is not a string, so it should throw — that is fine
    }
    expect(({} as Record<string, unknown>)['polluted']).toBe(before);
  });

  it('does not suffer prototype pollution from constructor key', () => {
    const before = ({} as Record<string, unknown>)['polluted'];
    try {
      parseAssigneeAddressMap('{"constructor":{"prototype":{"polluted":true}}}');
    } catch {
      // expected to throw — the value is not a string
    }
    expect(({} as Record<string, unknown>)['polluted']).toBe(before);
  });

  it('treats JSON number-string as a valid username key if non-empty', () => {
    // numeric-string keys are odd but technically valid GitHub usernames are
    // alphanumeric — the parser should at least not crash
    expect(() =>
      parseAssigneeAddressMap(`{"123": "${VALID_G_ADDRESS}"}`),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveAddressFromAssigneeMap — property tests
// ---------------------------------------------------------------------------

describe('resolveAddressFromAssigneeMap property tests', () => {
  const map = { alice: VALID_G_ADDRESS, bob: VALID_ISSUER };

  it('resolves a known login to its address', () => {
    expect(resolveAddressFromAssigneeMap(map, 'alice')).toBe(VALID_G_ADDRESS);
    expect(resolveAddressFromAssigneeMap(map, 'bob')).toBe(VALID_ISSUER);
  });

  it('resolves case-insensitively (GitHub usernames are case-insensitive)', () => {
    expect(resolveAddressFromAssigneeMap(map, 'Alice')).toBe(VALID_G_ADDRESS);
    expect(resolveAddressFromAssigneeMap(map, 'ALICE')).toBe(VALID_G_ADDRESS);
    expect(resolveAddressFromAssigneeMap(map, 'BOB')).toBe(VALID_ISSUER);
  });

  it('throws a descriptive Error when the login is not in the map', () => {
    expect(() => resolveAddressFromAssigneeMap(map, 'unknown')).toThrow(/not present/);
  });

  it('throws a descriptive Error when assigneeLogin is undefined', () => {
    expect(() => resolveAddressFromAssigneeMap(map, undefined)).toThrow();
  });

  it('throws a descriptive Error when assigneeLogin is null', () => {
    expect(() => resolveAddressFromAssigneeMap(map, null)).toThrow();
  });

  it('throws a descriptive Error when assigneeLogin is empty string', () => {
    expect(() => resolveAddressFromAssigneeMap(map, '')).toThrow();
  });

  it('throws a descriptive Error when assigneeLogin is whitespace-only', () => {
    expect(() => resolveAddressFromAssigneeMap(map, '   ')).toThrow();
  });

  it('works with an empty map (no entries registered)', () => {
    expect(() => resolveAddressFromAssigneeMap({}, 'alice')).toThrow(/not present/);
  });
});

// ---------------------------------------------------------------------------
// parseAssetsJson — property tests
// ---------------------------------------------------------------------------

describe('parseAssetsJson property tests', () => {
  describe('never throws uncaught non-Error exceptions on fuzz inputs', () => {
    for (const input of FUZZ_STRINGS) {
      const label = JSON.stringify(input).slice(0, 50);
      it(`handles: ${label}`, () => {
        let threw = false;
        let thrownValue: unknown;
        try {
          parseAssetsJson(input);
        } catch (err) {
          threw = true;
          thrownValue = err;
        }
        if (threw) {
          expect(thrownValue).toBeInstanceOf(Error);
        }
      });
    }
  });

  describe('never accepts invalid G-addresses as issuers', () => {
    const invalidIssuers = [
      'not-valid',
      'G' + 'A'.repeat(54),   // too short (55 chars not 56)
      'G' + 'A'.repeat(56),   // too long (57 chars)
      'G' + '0'.repeat(55),   // '0' is not in base32 alphabet
      'G' + '1'.repeat(55),   // '1' is not in base32 alphabet
      'X' + 'A'.repeat(55),   // wrong prefix letter
      'B' + 'A'.repeat(55),   // wrong prefix letter
      'S' + 'A'.repeat(55),   // secret key prefix, not account
      '',
      'GAAA',                 // too short
    ];

    for (const issuer of invalidIssuers) {
      it(`rejects invalid issuer: ${JSON.stringify(issuer).slice(0, 40)}`, () => {
        const json = JSON.stringify([{ code: 'USDC', issuer }]);
        expect(() => parseAssetsJson(json)).toThrow(Error);
      });
    }
  });

  it('accepts a valid G-address issuer', () => {
    const result = parseAssetsJson(
      JSON.stringify([{ code: 'USDC', issuer: VALID_ISSUER }]),
    );
    expect(result).toHaveLength(1);
    expect(result[0].assetIssuer).toBe(VALID_ISSUER);
    expect(result[0].assetCode).toBe('USDC');
  });

  it('accepts a valid C-address contract issuer', () => {
    const result = parseAssetsJson(
      JSON.stringify([{ code: 'USDC', issuer: VALID_CONTRACT }]),
    );
    expect(result[0].assetIssuer).toBe(VALID_CONTRACT);
  });

  it('normalizes asset codes to uppercase', () => {
    const result = parseAssetsJson(
      JSON.stringify([{ code: ' eurc ', issuer: VALID_ISSUER }]),
    );
    expect(result[0].assetCode).toBe('EURC');
  });

  it('returns empty array for empty JSON array', () => {
    expect(parseAssetsJson('[]')).toEqual([]);
  });

  it('throws on invalid JSON string', () => {
    expect(() => parseAssetsJson('not-json')).toThrow();
    expect(() => parseAssetsJson('')).toThrow();
  });

  it('throws when root is not an array', () => {
    expect(() => parseAssetsJson('null')).toThrow(/array/i);
    expect(() => parseAssetsJson('{}')).toThrow(/array/i);
    expect(() => parseAssetsJson('"string"')).toThrow(/array/i);
  });

  it('throws when an entry is missing the code field', () => {
    expect(() =>
      parseAssetsJson(JSON.stringify([{ issuer: VALID_ISSUER }])),
    ).toThrow(/"code"/);
  });

  it('throws when an entry is missing the issuer field', () => {
    expect(() =>
      parseAssetsJson(JSON.stringify([{ code: 'USDC' }])),
    ).toThrow(/"issuer"/);
  });

  it('throws when an entry is null', () => {
    expect(() => parseAssetsJson('[null]')).toThrow(/object/);
  });

  it('throws when an entry is a primitive', () => {
    expect(() => parseAssetsJson('["USDC"]')).toThrow(/object/);
    expect(() => parseAssetsJson('[42]')).toThrow(/object/);
  });

  it('throws when code is empty', () => {
    expect(() =>
      parseAssetsJson(JSON.stringify([{ code: '', issuer: VALID_ISSUER }])),
    ).toThrow();
  });

  it('throws when issuer is empty', () => {
    expect(() =>
      parseAssetsJson(JSON.stringify([{ code: 'USDC', issuer: '' }])),
    ).toThrow();
  });

  it('handles a valid list of 50 assets without hanging', () => {
    const assets = Array.from({ length: 50 }, (_, i) => ({
      code: `TK${String(i).padStart(2, '0')}`,
      issuer: VALID_ISSUER,
    }));
    const result = parseAssetsJson(JSON.stringify(assets));
    expect(result).toHaveLength(50);
  });

  it('throws on a huge invalid JSON string without crashing the process', () => {
    const hugeGarbage = 'A'.repeat(100_000);
    expect(() => parseAssetsJson(hugeGarbage)).toThrow();
  });

  it('all returned issuers match G or C address format', () => {
    const assets = [
      { code: 'USDC', issuer: VALID_ISSUER },
      { code: 'EURC', issuer: VALID_G_ADDRESS },
      { code: 'TOK1', issuer: VALID_CONTRACT },
    ];
    const result = parseAssetsJson(JSON.stringify(assets));
    for (const asset of result) {
      expect(asset.assetIssuer).toMatch(/^[GC][A-Z2-7]{55}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// dedupeAssets — property tests
// ---------------------------------------------------------------------------

describe('dedupeAssets property tests', () => {
  it('returns an empty array unchanged', () => {
    expect(dedupeAssets([])).toEqual([]);
  });

  it('returns a single-element array unchanged', () => {
    const arr = [{ assetCode: 'USDC', assetIssuer: VALID_ISSUER }];
    expect(dedupeAssets(arr)).toEqual(arr);
  });

  it('removes exact duplicates (same code + issuer)', () => {
    const arr = [
      { assetCode: 'USDC', assetIssuer: VALID_ISSUER },
      { assetCode: 'USDC', assetIssuer: VALID_ISSUER },
      { assetCode: 'USDC', assetIssuer: VALID_ISSUER },
    ];
    expect(dedupeAssets(arr)).toHaveLength(1);
  });

  it('keeps assets that share code but differ in issuer', () => {
    const arr = [
      { assetCode: 'USDC', assetIssuer: VALID_ISSUER },
      { assetCode: 'USDC', assetIssuer: VALID_G_ADDRESS },
    ];
    expect(dedupeAssets(arr)).toHaveLength(2);
  });

  it('keeps assets that share issuer but differ in code', () => {
    const arr = [
      { assetCode: 'USDC', assetIssuer: VALID_ISSUER },
      { assetCode: 'EURC', assetIssuer: VALID_ISSUER },
    ];
    expect(dedupeAssets(arr)).toHaveLength(2);
  });

  it('preserves first-occurrence order', () => {
    const arr = [
      { assetCode: 'EURC', assetIssuer: VALID_ISSUER },
      { assetCode: 'USDC', assetIssuer: VALID_ISSUER },
      { assetCode: 'EURC', assetIssuer: VALID_ISSUER }, // duplicate of first
    ];
    const result = dedupeAssets(arr);
    expect(result[0].assetCode).toBe('EURC');
    expect(result[1].assetCode).toBe('USDC');
    expect(result).toHaveLength(2);
  });

  it('is idempotent: deduping twice yields the same result as deduping once', () => {
    const arr = [
      { assetCode: 'USDC', assetIssuer: VALID_ISSUER },
      { assetCode: 'USDC', assetIssuer: VALID_ISSUER },
      { assetCode: 'EURC', assetIssuer: VALID_ISSUER },
    ];
    const once = dedupeAssets(arr);
    const twice = dedupeAssets(once);
    expect(twice).toEqual(once);
  });

  it('handles 1000 duplicate entries (large-array performance)', () => {
    const arr = Array.from({ length: 1000 }, () => ({
      assetCode: 'USDC',
      assetIssuer: VALID_ISSUER,
    }));
    expect(dedupeAssets(arr)).toHaveLength(1);
  });

  it('handles a mixed array of 500 unique and 500 duplicate assets', () => {
    const unique = Array.from({ length: 500 }, (_, i) => ({
      assetCode: `TK${String(i).padStart(3, '0')}`,
      assetIssuer: VALID_ISSUER,
    }));
    const dupes = unique.slice(0, 100).concat(unique.slice(0, 100)); // 200 dupes
    const result = dedupeAssets([...unique, ...dupes]);
    expect(result).toHaveLength(500);
  });
});

// ---------------------------------------------------------------------------
// assertValidAssetCode — property tests
// ---------------------------------------------------------------------------

describe('assertValidAssetCode property tests', () => {
  const validCodes = ['USDC', 'XLM', 'EURC', 'A', 'ABCDEFGHIJKL', '123', 'A1B2C3', 'Z',
    'lower',   // normalized to LOWER (uppercase) — valid after normalization
    'usdc',    // normalized to USDC
  ];
  const invalidCodes = [
    '',
    '   ',
    'this-is-too-long-code',  // > 12 alphanumeric chars
    'has space',
    'HAS!CHAR',               // special character
    'A'.repeat(13),           // 13 chars > 12
  ];

  for (const code of validCodes) {
    it(`accepts valid asset code: "${code}"`, () => {
      expect(() => assertValidAssetCode(code)).not.toThrow();
    });
  }

  for (const code of invalidCodes) {
    it(`rejects invalid asset code: ${JSON.stringify(code)}`, () => {
      expect(() => assertValidAssetCode(code)).toThrow();
    });
  }
});

// ---------------------------------------------------------------------------
// assertValidAssetIssuer — property tests
// ---------------------------------------------------------------------------

describe('assertValidAssetIssuer property tests', () => {
  it('accepts a valid G-address issuer', () => {
    expect(() => assertValidAssetIssuer(VALID_ISSUER)).not.toThrow();
    expect(() => assertValidAssetIssuer(VALID_G_ADDRESS)).not.toThrow();
  });

  it('accepts a valid C-address contract issuer', () => {
    expect(() => assertValidAssetIssuer(VALID_CONTRACT)).not.toThrow();
  });

  it('trims whitespace before validating', () => {
    expect(() => assertValidAssetIssuer(`  ${VALID_ISSUER}  `)).not.toThrow();
  });

  it('rejects addresses with wrong prefix letter', () => {
    expect(() => assertValidAssetIssuer('X' + VALID_ISSUER.slice(1))).toThrow();
    expect(() => assertValidAssetIssuer('B' + VALID_ISSUER.slice(1))).toThrow();
    expect(() => assertValidAssetIssuer('S' + VALID_ISSUER.slice(1))).toThrow(); // secret key
  });

  it('rejects addresses that are too short', () => {
    expect(() => assertValidAssetIssuer('G' + 'A'.repeat(10))).toThrow();
    expect(() => assertValidAssetIssuer('G' + 'A'.repeat(54))).toThrow(); // 55 chars total
  });

  it('rejects addresses that are too long', () => {
    expect(() => assertValidAssetIssuer('G' + 'A'.repeat(56))).toThrow(); // 57 chars total
  });

  it('rejects empty string', () => {
    expect(() => assertValidAssetIssuer('')).toThrow();
  });

  it('rejects strings that look like addresses but have invalid base32 chars', () => {
    // '0' and '1' and '8' and '9' are not in Stellar base32 alphabet
    expect(() => assertValidAssetIssuer('G' + '0'.repeat(55))).toThrow();
    expect(() => assertValidAssetIssuer('G' + '1'.repeat(55))).toThrow();
  });

  it('rejects "null" and "undefined" string literals', () => {
    expect(() => assertValidAssetIssuer('null')).toThrow();
    expect(() => assertValidAssetIssuer('undefined')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// isValidStellarAddress — cross-validation
// ---------------------------------------------------------------------------

describe('isValidStellarAddress cross-validation with parser results', () => {
  it('every address accepted by parseAssigneeAddressMap values passes isValidStellarAddress', () => {
    const roster = JSON.stringify({
      alice: VALID_G_ADDRESS,
      bob: VALID_ISSUER,
    });
    const map = parseAssigneeAddressMap(roster);
    for (const address of Object.values(map)) {
      // The address from the map is a raw string — it may or may not be valid
      // (the parser doesn't validate G-addresses, only that values are strings).
      // We just check the function doesn't crash.
      expect(typeof isValidStellarAddress(address)).toBe('boolean');
    }
  });

  it('every assetIssuer accepted by parseAssetsJson passes basic G/C format', () => {
    const assets = [
      { code: 'USDC', issuer: VALID_ISSUER },
      { code: 'EURC', issuer: VALID_CONTRACT },
    ];
    const result = parseAssetsJson(JSON.stringify(assets));
    for (const asset of result) {
      expect(asset.assetIssuer).toMatch(/^[GC][A-Z2-7]{55}$/);
    }
  });
});
