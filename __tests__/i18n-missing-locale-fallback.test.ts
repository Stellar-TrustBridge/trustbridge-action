/**
 * Missing-locale fallback tests for comment templates (Issue #859).
 *
 * `getStrings()` (src/i18n.ts) and `interpolateTemplate()` (src/template.ts)
 * are the two places a `locale` string chosen in action.yml reaches the
 * comment body. Both must degrade predictably — to the complete English
 * pack — for any locale string that isn't an exact match in `LOCALES`,
 * and must never throw mid-run or leave a placeholder unresolved in the
 * rendered Markdown. This file is the fallback-contract specification;
 * key-parity and per-locale smoke tests already live in `i18n.test.ts`.
 */
import { getStrings, SUPPORTED_LOCALES, CommentStrings, Locale } from '../src/i18n';
import { interpolateTemplate, TemplateContext } from '../src/template';
import { formatCommentBody } from '../src/comment';
import { ValidationResult } from '../src/checks';

const EN = getStrings('en');
const STRING_KEYS = Object.keys(EN).filter(
  (k) => typeof (EN as unknown as Record<string, unknown>)[k] === 'string',
) as (keyof CommentStrings)[];

// ---------------------------------------------------------------------------
// getStrings(): malformed / missing locale strings
// ---------------------------------------------------------------------------

describe('getStrings fallback for malformed locale input', () => {
  const malformed = [
    '',
    '   ',
    'en ', // trailing whitespace — not an exact LOCALES key
    ' en',
    'ENGLISH',
    'xx',
    'en-US', // BCP-47 region variant, not cataloged as its own pack
    'ja_JP',
    '🇯🇵',
    'null',
    'undefined',
    "'; DROP TABLE locales;--",
    'a'.repeat(5000),
  ];

  it.each(malformed.map((input, i) => [i, input] as const))(
    'falls back to the complete English pack for case #%i',
    (_i, input) => {
      const strings = getStrings(input);
      expect(strings).toEqual(EN);
    },
  );

  it.each(malformed.map((input, i) => [i, input] as const))(
    'never throws for case #%i',
    (_i, input) => {
      expect(() => getStrings(input)).not.toThrow();
    },
  );

  it('falls back to English for undefined (cast through the Locale|string union)', () => {
    expect(getStrings(undefined as unknown as string)).toEqual(EN);
  });

  it('falls back to English for null (cast through the Locale|string union)', () => {
    expect(getStrings(null as unknown as string)).toEqual(EN);
  });
});

// ---------------------------------------------------------------------------
// getStrings(): every supported locale resolves to a fully-populated pack
// ---------------------------------------------------------------------------

describe('getStrings never returns a partially translated pack', () => {
  it.each(SUPPORTED_LOCALES)('locale "%s" has every string-typed key non-empty', (locale) => {
    const strings = getStrings(locale);
    for (const key of STRING_KEYS) {
      const value = (strings as unknown as Record<string, unknown>)[key];
      expect(typeof value).toBe('string');
      expect((value as string).length).toBeGreaterThan(0);
    }
  });

  it.each(SUPPORTED_LOCALES)('locale "%s" exposes exactly the same keys as English', (locale) => {
    const strings = getStrings(locale);
    expect(Object.keys(strings).sort()).toEqual(Object.keys(EN).sort());
  });
});

// ---------------------------------------------------------------------------
// interpolateTemplate(): missing-locale-key edge cases inside templates
// ---------------------------------------------------------------------------

describe('interpolateTemplate missing-locale-key fallback', () => {
  const ctx: TemplateContext = {
    account: 'GABC',
    asset: 'USDC',
    issuer: 'GISSUER',
    network: 'testnet',
    horizon: 'https://horizon-testnet.stellar.org',
    status: '✅',
    locale: 'en',
  };

  it('resolves a real key for every supported locale without throwing', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const result = interpolateTemplate('{{locale:resultsHeading}}', { ...ctx, locale });
      expect(result.length).toBeGreaterThan(0);
      expect(result).not.toContain('undefined');
      expect(result).not.toContain('{{');
    }
  });

  it('an unknown {{locale:KEY}} resolves to empty string, not "undefined" or a thrown error', () => {
    const result = interpolateTemplate('[{{locale:thisKeyDoesNotExist}}]', ctx);
    expect(result).toBe('[]');
  });

  it('an empty {{locale:}} key resolves to empty string', () => {
    const result = interpolateTemplate('[{{locale:}}]', ctx);
    expect(result).toBe('[]');
  });

  it('a malformed locale on the context still resolves known keys via the English fallback', () => {
    const result = interpolateTemplate('{{locale:resultsHeading}}', { ...ctx, locale: 'not-a-real-locale' });
    expect(result).toBe(EN.resultsHeading);
  });

  it('mixing a resolved key and an unresolved key in one template leaves no placeholder behind', () => {
    const result = interpolateTemplate(
      '{{locale:resultsHeading}} / {{locale:nope}} / {{account}}',
      ctx,
    );
    expect(result).toBe(`${EN.resultsHeading} /  / GABC`);
    expect(result).not.toContain('{{');
    expect(result).not.toContain('undefined');
  });
});

// ---------------------------------------------------------------------------
// Multi-check summary rendering: every locale, boundary check counts
// ---------------------------------------------------------------------------

function makeResult(checks: ValidationResult['checks']): ValidationResult {
  const passedCount = checks.filter((c) => c.passed).length;
  return {
    valid: passedCount === checks.length && checks.length > 0,
    accountFunded: passedCount > 0,
    trustlineExists: passedCount > 0,
    xlmBalance: '0',
    xlmReserveMet: passedCount > 0,
    checks,
  };
}

const baseConfig = {
  stellarAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  assetCode: 'USDC',
  assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  minXlmReserve: 1.5,
  horizonUrl: 'https://horizon-testnet.stellar.org',
};

describe('multi-check validation-gate summary across locales (boundary counts)', () => {
  const scenarios: Array<{ label: string; checks: ValidationResult['checks'] }> = [
    { label: 'zero checks (0/0)', checks: [] },
    { label: 'all failed (0/3)', checks: [
      { passed: false, label: 'a', detail: 'a' },
      { passed: false, label: 'b', detail: 'b' },
      { passed: false, label: 'c', detail: 'c' },
    ] },
    { label: 'all passed (3/3)', checks: [
      { passed: true, label: 'a', detail: 'a' },
      { passed: true, label: 'b', detail: 'b' },
      { passed: true, label: 'c', detail: 'c' },
    ] },
    { label: 'single check (1/1)', checks: [{ passed: true, label: 'a', detail: 'a' }] },
  ];

  for (const locale of SUPPORTED_LOCALES) {
    describe(`locale: ${locale}`, () => {
      for (const { label, checks } of scenarios) {
        it(`renders the gate summary for ${label} without "undefined" or NaN`, () => {
          const body = formatCommentBody(makeResult(checks), { ...baseConfig, locale });
          expect(body).not.toContain('undefined');
          expect(body).not.toContain('NaN');
          expect(body).toContain(`${checks.filter((c) => c.passed).length}/${checks.length}`);
        });
      }
    });
  }
});
