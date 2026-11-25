/**
 * Locale negotiation tests (Issue #974).
 *
 * The action must negotiate the comment locale from an optional explicit
 * `locale` action input and the Actions runner language environment, with a
 * deterministic fallback to English. Unknown locales must never throw or
 * produce a partially rendered comment.
 */
import { getStrings, negotiateLocale, parseLocaleInput, SUPPORTED_LOCALES } from '../src/i18n';
import { getRunnerLanguage } from '../src/inputs';

describe('parseLocaleInput (Issue #974)', () => {
  it('accepts every supported canonical locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(parseLocaleInput(locale)).toBe(locale);
      expect(parseLocaleInput(` ${locale.toUpperCase()} `)).toBe(locale);
    }
  });

  it('extracts the base language from POSIX and BCP-47 runner values', () => {
    expect(parseLocaleInput('es_ES.UTF-8')).toBe('es');
    expect(parseLocaleInput('pt-BR')).toBe('pt');
    expect(parseLocaleInput('ja_JP@calendar=japanese')).toBe('ja');
    expect(parseLocaleInput('de_DE.UTF-8')).toBe('de');
  });

  it('falls back to English for unknown, empty, and malformed values', () => {
    expect(parseLocaleInput('')).toBe('en');
    expect(parseLocaleInput(undefined)).toBe('en');
    expect(parseLocaleInput('xx_XX.UTF-8')).toBe('en');
    expect(parseLocaleInput('not a locale')).toBe('en');
    expect(parseLocaleInput('-')).toBe('en');
  });
});

describe('negotiateLocale (Issue #974)', () => {
  it('prefers a valid explicit locale over the runner language', () => {
    expect(negotiateLocale({ explicitLocale: 'fr', runnerLanguage: 'es_ES.UTF-8' })).toBe('fr');
    expect(getStrings('fr')).not.toBe(getStrings('en'));
  });

  it('uses the runner language when the explicit input is unset', () => {
    expect(negotiateLocale({ explicitLocale: '', runnerLanguage: 'pt-BR' })).toBe('pt');
    expect(negotiateLocale({ explicitLocale: undefined, runnerLanguage: 'ja_JP.UTF-8' })).toBe('ja');
  });

  it('uses the first supported language in a LANGUAGE list', () => {
    expect(negotiateLocale({ explicitLocale: '', runnerLanguage: 'xx:de_DE.UTF-8:fr' })).toBe('de');
  });

  it('falls through an unsupported explicit locale to a supported runner locale', () => {
    expect(negotiateLocale({ explicitLocale: 'klingon', runnerLanguage: 'es_ES.UTF-8' })).toBe('es');
  });

  it('falls back to English when neither source is supported', () => {
    expect(negotiateLocale({ explicitLocale: 'klingon', runnerLanguage: 'xx_XX.UTF-8' })).toBe('en');
    expect(negotiateLocale({})).toBe('en');
    expect(getStrings(negotiateLocale({}))).toBe(getStrings('en'));
  });
});

describe('getRunnerLanguage (Issue #974)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('reads the Actions runner language environment in precedence order', () => {
    expect(
      getRunnerLanguage({ LANGUAGE: 'fr_FR.UTF-8', LC_ALL: 'de_DE.UTF-8', LANG: 'es_ES.UTF-8' }),
    ).toBe('fr_FR.UTF-8');
    expect(getRunnerLanguage({ LC_ALL: 'de_DE.UTF-8', LANG: 'es_ES.UTF-8' })).toBe('de_DE.UTF-8');
    expect(getRunnerLanguage({ LANG: 'es_ES.UTF-8' })).toBe('es_ES.UTF-8');
  });

  it('returns an empty string when no runner language is set', () => {
    expect(getRunnerLanguage({})).toBe('');
  });
});
