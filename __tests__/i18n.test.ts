import {
  getStrings,
  isValidLocale,
  parseLocaleInput,
} from '../src/i18n';

describe('i18n locale utilities', () => {
  describe('isValidLocale', () => {
    it('returns true for supported locales', () => {
      expect(isValidLocale('en')).toBe(true);
      expect(isValidLocale('es')).toBe(true);
      expect(isValidLocale('pt')).toBe(true);
    });

    it('returns true for uppercase variants', () => {
      expect(isValidLocale('EN')).toBe(true);
      expect(isValidLocale('ES')).toBe(true);
      expect(isValidLocale('PT')).toBe(true);
    });

    it('returns false for unsupported locales', () => {
      expect(isValidLocale('fr')).toBe(false);
      expect(isValidLocale('de')).toBe(false);
      expect(isValidLocale('invalid')).toBe(false);
    });

    it('returns false for null or undefined', () => {
      expect(isValidLocale(null)).toBe(false);
      expect(isValidLocale(undefined)).toBe(false);
      expect(isValidLocale('')).toBe(false);
    });
  });

  describe('parseLocaleInput', () => {
    it('parses valid locale strings', () => {
      expect(parseLocaleInput('en')).toBe('en');
      expect(parseLocaleInput('es')).toBe('es');
      expect(parseLocaleInput('pt')).toBe('pt');
    });

    it('normalizes uppercase to lowercase', () => {
      expect(parseLocaleInput('EN')).toBe('en');
      expect(parseLocaleInput('ES')).toBe('es');
      expect(parseLocaleInput('PT')).toBe('pt');
    });

    it('trims whitespace', () => {
      expect(parseLocaleInput('  en  ')).toBe('en');
      expect(parseLocaleInput('  es ')).toBe('es');
    });

    it('falls back to English for invalid locales', () => {
      expect(parseLocaleInput('fr')).toBe('en');
      expect(parseLocaleInput('invalid')).toBe('en');
      expect(parseLocaleInput('')).toBe('en');
    });

    it('falls back to English for undefined or null', () => {
      expect(parseLocaleInput(undefined)).toBe('en');
       
      expect(parseLocaleInput(null as any)).toBe('en');
    });
  });

  describe('getStrings', () => {
    it('returns English strings for en locale', () => {
      const strings = getStrings('en');
      expect(strings.heading).toBe('TrustBridge — Stellar Account Check');
      expect(strings.checkedAccount).toBe('Checked account:');
      expect(strings.resultsHeading).toBe('Results');
    });

    it('returns Spanish strings for es locale', () => {
      const strings = getStrings('es');
      expect(strings.heading).toBe('TrustBridge — Verificación de Cuenta Stellar');
      expect(strings.checkedAccount).toBe('Cuenta verificada:');
      expect(strings.resultsHeading).toBe('Resultados');
    });

    it('returns Portuguese strings for pt locale', () => {
      const strings = getStrings('pt');
      expect(strings.heading).toBe('TrustBridge — Verificação de Conta Stellar');
      expect(strings.checkedAccount).toBe('Conta verificada:');
      expect(strings.resultsHeading).toBe('Resultados');
    });

    it('falls back to English for unsupported locales', () => {
      const strings = getStrings('fr');
      expect(strings.heading).toBe('TrustBridge — Stellar Account Check');
      expect(strings.checkedAccount).toBe('Checked account:');
    });

    it('normalizes uppercase locale strings', () => {
      const stringsUpper = getStrings('ES');
      const stringsLower = getStrings('es');
      expect(stringsUpper.heading).toBe(stringsLower.heading);
    });

    it('handles function-based strings', () => {
      const strings = getStrings('en');
      const detail = strings.accountFundedPassDetail('GABC...XYZ');
      expect(detail).toContain('GABC...XYZ');
      expect(detail).toContain('active');
    });

    it('handles function-based strings in Spanish', () => {
      const strings = getStrings('es');
      const detail = strings.accountFundedPassDetail('GABC...XYZ');
      expect(detail).toContain('GABC...XYZ');
      expect(detail).toContain('activa');
    });

    it('handles function-based strings with multiple parameters', () => {
      const strings = getStrings('en');
      const detail = strings.remediationActivateAccount('GABC...XYZ', '1 XLM', 'USDC');
      expect(detail).toContain('GABC...XYZ');
      expect(detail).toContain('1 XLM');
      expect(detail).toContain('USDC');
    });

    it('provides all required locale keys for English', () => {
      const strings = getStrings('en');
      expect(strings.heading).toBeDefined();
      expect(strings.resultsHeading).toBeDefined();
      expect(strings.validationGateHeading).toBeDefined();
      expect(strings.balancesHeading).toBeDefined();
      expect(strings.remediationHeading).toBeDefined();
      expect(strings.networkMismatchDetected).toBeDefined();
      expect(strings.networkMismatchConfiguredNetwork).toBeDefined();
      expect(strings.networkMismatchActiveNetwork).toBeDefined();
      expect(strings.networkMismatchFix).toBeDefined();
      expect(strings.networkMismatchUpdateUrl).toBeDefined();
    });

    it('provides all required locale keys for Spanish', () => {
      const strings = getStrings('es');
      expect(strings.heading).toBeDefined();
      expect(strings.resultsHeading).toBeDefined();
      expect(strings.validationGateHeading).toBeDefined();
      expect(strings.balancesHeading).toBeDefined();
      expect(strings.remediationHeading).toBeDefined();
      expect(strings.networkMismatchDetected).toBeDefined();
      expect(strings.networkMismatchConfiguredNetwork).toBeDefined();
      expect(strings.networkMismatchActiveNetwork).toBeDefined();
      expect(strings.networkMismatchFix).toBeDefined();
      expect(strings.networkMismatchUpdateUrl).toBeDefined();
    });

    it('provides all required locale keys for Portuguese', () => {
      const strings = getStrings('pt');
      expect(strings.heading).toBeDefined();
      expect(strings.resultsHeading).toBeDefined();
      expect(strings.validationGateHeading).toBeDefined();
      expect(strings.balancesHeading).toBeDefined();
      expect(strings.remediationHeading).toBeDefined();
      expect(strings.networkMismatchDetected).toBeDefined();
      expect(strings.networkMismatchConfiguredNetwork).toBeDefined();
      expect(strings.networkMismatchActiveNetwork).toBeDefined();
      expect(strings.networkMismatchFix).toBeDefined();
      expect(strings.networkMismatchUpdateUrl).toBeDefined();
    });

    it('all English strings are non-empty', () => {
      const strings = getStrings('en');
      Object.entries(strings).forEach(([_key, value]) => {
        if (typeof value === 'string') {
          expect(value.length).toBeGreaterThan(0);
        }
      });
    });

    it('all Spanish strings are non-empty', () => {
      const strings = getStrings('es');
      Object.entries(strings).forEach(([_key, value]) => {
        if (typeof value === 'string') {
          expect(value.length).toBeGreaterThan(0);
        }
      });
    });

    it('all Portuguese strings are non-empty', () => {
      const strings = getStrings('pt');
      Object.entries(strings).forEach(([_key, value]) => {
        if (typeof value === 'string') {
          expect(value.length).toBeGreaterThan(0);
        }
      });
    });
  });
});
