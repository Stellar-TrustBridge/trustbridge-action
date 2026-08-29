/**
 * Tests for src/i18n.ts — Issue #313
 *
 * Covers:
 *  - isValidLocale / parseLocaleInput utilities (all 6 locales + edge cases)
 *  - getStrings key parity: every interface key present and non-empty for all locales
 *  - Function-based string signatures: called with representative args, results checked
 *  - CJK / long-translation wrapping: Japanese strings must not produce empty values
 *    and must encode address/amount placeholders correctly
 *  - Locale-specific smoke: a few distinctive phrases per locale
 */

import {
  getStrings,
  isValidLocale,
  parseLocaleInput,
  type CommentStrings,
} from '../src/i18n';

// ---------------------------------------------------------------------------
// Helper: enumerate every *string-typed* key in a CommentStrings object
// ---------------------------------------------------------------------------
function stringKeys(cs: CommentStrings): string[] {
  return Object.entries(cs)
    .filter(([, v]) => typeof v === 'string')
    .map(([k]) => k);
}

// ---------------------------------------------------------------------------
// isValidLocale
// ---------------------------------------------------------------------------
describe('isValidLocale', () => {
  it('returns true for all six supported locales (lowercase)', () => {
    expect(isValidLocale('en')).toBe(true);
    expect(isValidLocale('es')).toBe(true);
    expect(isValidLocale('pt')).toBe(true);
    expect(isValidLocale('ja')).toBe(true);
    expect(isValidLocale('fr')).toBe(true);
    expect(isValidLocale('de')).toBe(true);
  });

  it('returns true for uppercase variants', () => {
    expect(isValidLocale('EN')).toBe(true);
    expect(isValidLocale('ES')).toBe(true);
    expect(isValidLocale('PT')).toBe(true);
    expect(isValidLocale('JA')).toBe(true);
    expect(isValidLocale('FR')).toBe(true);
    expect(isValidLocale('DE')).toBe(true);
  });

  it('returns false for unsupported locales', () => {
    expect(isValidLocale('zh')).toBe(false);
    expect(isValidLocale('ko')).toBe(false);
    expect(isValidLocale('ru')).toBe(false);
    expect(isValidLocale('invalid')).toBe(false);
    expect(isValidLocale('enUS')).toBe(false);
  });

  it('returns false for null, undefined, and empty string', () => {
    expect(isValidLocale(null)).toBe(false);
    expect(isValidLocale(undefined)).toBe(false);
    expect(isValidLocale('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseLocaleInput
// ---------------------------------------------------------------------------
describe('parseLocaleInput', () => {
  it('parses all six valid locale strings', () => {
    expect(parseLocaleInput('en')).toBe('en');
    expect(parseLocaleInput('es')).toBe('es');
    expect(parseLocaleInput('pt')).toBe('pt');
    expect(parseLocaleInput('ja')).toBe('ja');
    expect(parseLocaleInput('fr')).toBe('fr');
    expect(parseLocaleInput('de')).toBe('de');
  });

  it('normalizes uppercase to lowercase', () => {
    expect(parseLocaleInput('EN')).toBe('en');
    expect(parseLocaleInput('ES')).toBe('es');
    expect(parseLocaleInput('PT')).toBe('pt');
    expect(parseLocaleInput('JA')).toBe('ja');
    expect(parseLocaleInput('FR')).toBe('fr');
    expect(parseLocaleInput('DE')).toBe('de');
  });

  it('trims surrounding whitespace', () => {
    expect(parseLocaleInput('  en  ')).toBe('en');
    expect(parseLocaleInput('  ja ')).toBe('ja');
    expect(parseLocaleInput(' fr')).toBe('fr');
    expect(parseLocaleInput('de ')).toBe('de');
  });

  it('falls back to English for invalid or unsupported locales', () => {
    expect(parseLocaleInput('zh')).toBe('en');
    expect(parseLocaleInput('invalid')).toBe('en');
    expect(parseLocaleInput('')).toBe('en');
  });

  it('falls back to English for undefined and null', () => {
    expect(parseLocaleInput(undefined)).toBe('en');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseLocaleInput(null as any)).toBe('en');
  });
});

// ---------------------------------------------------------------------------
// Key parity: every CommentStrings key must be defined (and non-empty for strings)
// for every locale — including the three new ones.
// ---------------------------------------------------------------------------
const ALL_LOCALES = ['en', 'es', 'pt', 'ja', 'fr', 'de'] as const;

describe('key parity across all locales', () => {
  const enKeys = stringKeys(getStrings('en'));

  for (const locale of ALL_LOCALES) {
    describe(`locale: ${locale}`, () => {
      const strings = getStrings(locale);

      it('has all string-typed keys defined', () => {
        for (const key of enKeys) {
          expect((strings as unknown as Record<string, unknown>)[key]).toBeDefined();
        }
      });

      it('all string-typed values are non-empty', () => {
        for (const [, value] of Object.entries(strings)) {
          if (typeof value === 'string') {
            expect(value.length).toBeGreaterThan(0);
          }
        }
      });

      it('all function-typed keys are functions', () => {
        const enStrings = getStrings('en');
        for (const [key, value] of Object.entries(enStrings)) {
          if (typeof value === 'function') {
            const localeFn = (strings as unknown as Record<string, unknown>)[key];
            expect(typeof localeFn).toBe('function');
          }
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Function-based strings: called with representative args for all locales
// ---------------------------------------------------------------------------
describe('function-based strings for new locales', () => {
  const TEST_ADDRESS = 'GABC...XYZ';
  const TEST_AMOUNT = '10';
  const TEST_ASSET = 'USDC';
  const TEST_ISSUER = 'GA5Z...KZVN';
  const TEST_BALANCE = '2.5';
  const TEST_REQUIRED = '1.5';
  const TEST_COST = '1.5';

  for (const locale of ['ja', 'fr', 'de'] as const) {
    describe(`locale: ${locale}`, () => {
      const s = getStrings(locale);

      it('accountFundedPassDetail includes the address', () => {
        const result = s.accountFundedPassDetail(TEST_ADDRESS);
        expect(result).toContain(TEST_ADDRESS);
        expect(result.length).toBeGreaterThan(TEST_ADDRESS.length);
      });

      it('accountFundedFailDetail includes the address', () => {
        const result = s.accountFundedFailDetail(TEST_ADDRESS);
        expect(result).toContain(TEST_ADDRESS);
        expect(result.length).toBeGreaterThan(TEST_ADDRESS.length);
      });

      it('trustlineLabel includes the asset code', () => {
        const result = s.trustlineLabel(TEST_ASSET);
        expect(result).toContain(TEST_ASSET);
      });

      it('trustlinePassDetail includes asset and issuer', () => {
        const result = s.trustlinePassDetail(TEST_ASSET, TEST_ISSUER);
        expect(result).toContain(TEST_ASSET);
        expect(result).toContain(TEST_ISSUER);
      });

      it('trustlineFailHasTrustlines includes asset and issuer', () => {
        const result = s.trustlineFailHasTrustlines(TEST_ASSET, TEST_ISSUER);
        expect(result).toContain(TEST_ASSET);
        expect(result).toContain(TEST_ISSUER);
      });

      it('xlmReservePassDetail includes balance and required', () => {
        const result = s.xlmReservePassDetail(TEST_BALANCE, TEST_REQUIRED);
        expect(result).toContain(TEST_BALANCE);
        expect(result).toContain(TEST_REQUIRED);
      });

      it('xlmReserveFailDetail includes balance and required', () => {
        const result = s.xlmReserveFailDetail(TEST_BALANCE, TEST_REQUIRED);
        expect(result).toContain(TEST_BALANCE);
        expect(result).toContain(TEST_REQUIRED);
      });

      it('remediationAddTrustline includes the asset code and a URL', () => {
        const result = s.remediationAddTrustline(TEST_ASSET);
        expect(result).toContain(TEST_ASSET);
        expect(result).toContain('https://');
      });

      it('remediationSendXlm includes amount and address', () => {
        const result = s.remediationSendXlm(TEST_AMOUNT, TEST_ADDRESS);
        expect(result).toContain(TEST_AMOUNT);
        expect(result).toContain(TEST_ADDRESS);
      });

      it('remediationActivateAccount includes address, balance, and asset', () => {
        const result = s.remediationActivateAccount(TEST_ADDRESS, TEST_BALANCE, TEST_ASSET);
        expect(result).toContain(TEST_ADDRESS);
        expect(result).toContain(TEST_BALANCE);
        expect(result).toContain(TEST_ASSET);
      });

      it('remediationAccountNotFound includes the asset code', () => {
        const result = s.remediationAccountNotFound(TEST_ASSET);
        expect(result).toContain(TEST_ASSET);
      });

      it('remediationEstimatedSetupCost includes the cost value', () => {
        const result = s.remediationEstimatedSetupCost(TEST_COST);
        expect(result).toContain(TEST_COST);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// CJK wrapping tests (Japanese-specific)
// ---------------------------------------------------------------------------
describe('CJK / Japanese wrapping safety', () => {
  const ja = getStrings('ja');

  it('heading is a string and contains "TrustBridge"', () => {
    expect(typeof ja.heading).toBe('string');
    expect(ja.heading).toContain('TrustBridge');
  });

  it('heading does not exceed 80 characters (Markdown table safety)', () => {
    // GitHub renders Markdown tables in HTML — proportional fonts — but keeping
    // headings concise avoids layout issues in narrow-viewport previews.
    expect(ja.heading.length).toBeLessThanOrEqual(80);
  });

  it('CJK string keys contain Japanese characters (non-ASCII)', () => {
    // A correct Japanese locale must include at least some CJK codepoints.
    const hasCJK = Object.values(ja)
      .filter((v): v is string => typeof v === 'string')
      .some((s) => /[\u3000-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(s));
    expect(hasCJK).toBe(true);
  });

  it('accountFundedPassDetail with a long address stays under 200 chars', () => {
    // Real Stellar addresses are 56 chars; test with a 56-char address.
    const addr = 'G' + 'A'.repeat(55);
    const result = ja.accountFundedPassDetail(addr);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it('remediationActivateAccount does not produce undefined placeholder tokens', () => {
    const result = ja.remediationActivateAccount('GABC...', '1.5', 'USDC');
    // Should not contain '{' or '}' — those would be unfilled template slots
    expect(result).not.toContain('{');
    expect(result).not.toContain('}');
  });

  it('trustlineFailNoTrustlines is a non-empty string', () => {
    expect(typeof ja.trustlineFailNoTrustlines).toBe('string');
    expect(ja.trustlineFailNoTrustlines.length).toBeGreaterThan(0);
  });

  it('remediationHorizonError is a non-empty string', () => {
    expect(typeof ja.remediationHorizonError).toBe('string');
    expect(ja.remediationHorizonError.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Locale-specific smoke: distinctive phrases
// ---------------------------------------------------------------------------
describe('locale-specific smoke tests', () => {
  it('Japanese heading contains "Stellar"', () => {
    const ja = getStrings('ja');
    expect(ja.heading).toContain('Stellar');
  });

  it('Japanese resultsHeading is "結果"', () => {
    expect(getStrings('ja').resultsHeading).toBe('結果');
  });

  it('Japanese balancesHeading is "残高"', () => {
    expect(getStrings('ja').balancesHeading).toBe('残高');
  });

  it('French heading contains "Vérification"', () => {
    const fr = getStrings('fr');
    expect(fr.heading).toContain('Vérification');
  });

  it('French resultsHeading is "Résultats"', () => {
    expect(getStrings('fr').resultsHeading).toBe('Résultats');
  });

  it('French readyToProceed contains "réussi"', () => {
    expect(getStrings('fr').readyToProceed).toContain('réussi');
  });

  it('German heading contains "Kontoprüfung"', () => {
    const de = getStrings('de');
    expect(de.heading).toContain('Kontoprüfung');
  });

  it('German resultsHeading is "Ergebnisse"', () => {
    expect(getStrings('de').resultsHeading).toBe('Ergebnisse');
  });

  it('German remediationHorizonError contains "horizon_url"', () => {
    expect(getStrings('de').remediationHorizonError).toContain('horizon_url');
  });
});

// ---------------------------------------------------------------------------
// Fallback: getStrings still returns English for unknown locale
// ---------------------------------------------------------------------------
describe('getStrings fallback', () => {
  it('falls back to English for completely unknown locale', () => {
    const strings = getStrings('xx');
    expect(strings.heading).toBe('TrustBridge — Stellar Account Check');
  });

  it('case-insensitive lookup works for ja/fr/de', () => {
    expect(getStrings('JA').heading).toBe(getStrings('ja').heading);
    expect(getStrings('FR').heading).toBe(getStrings('fr').heading);
    expect(getStrings('DE').heading).toBe(getStrings('de').heading);
  });
});

// ---------------------------------------------------------------------------
// Table-width regression guard: strings used in Markdown table cells
// should not be excessively wide (>= 200 chars) to avoid GitHub table overflow.
// ---------------------------------------------------------------------------
describe('Markdown table cell width guard', () => {
  // Keys that appear verbatim inside table cells in the formatted comment:
  const tableCellKeys: Array<keyof CommentStrings> = [
    'xlmBalance',
    'minimumRequired',
    'inputColumn',
    'valueColumn',
    'outputColumn',
    'valueRunColumn',
    'descriptionColumn',
    'accountFundedOutput',
    'trustlineExistsOutput',
    'xlmBalanceOutput',
    'commentUrlOutput',
  ];

  for (const locale of ALL_LOCALES) {
    it(`locale ${locale}: table-cell keys are all < 200 chars`, () => {
      const strings = getStrings(locale);
      for (const key of tableCellKeys) {
        const value = strings[key];
        if (typeof value === 'string') {
          expect(value.length).toBeLessThan(200);
        }
      }
    });
  }
});
