/**
 * Issue #291: Golden comment snapshots for en, es, and pt locales.
 *
 * Renders the full issue comment body for each supported locale and stores
 * golden snapshots so i18n string drift or template regressions fail fast.
 *
 * Validate: npm test -- --testPathPattern 'i18n-comment-snapshots'
 */
import { formatCommentBody } from '../src/comment';
import { getStrings, CommentStrings, Locale } from '../src/i18n';
import { ValidationResult } from '../src/checks';

jest.mock('@actions/github', () => ({
  context: {
    payload: {},
    repo: { owner: 'test-owner', repo: 'test-repo' },
    apiUrl: 'https://api.github.com',
  },
  getOctokit: jest.fn(),
}));

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  setOutput: jest.fn(),
  setFailed: jest.fn(),
  getInput: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const STELLAR_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const HORIZON_URL = 'https://horizon.stellar.org';

const baseConfig = {
  stellarAddress: STELLAR_ADDRESS,
  assetCode: 'USDC',
  assetIssuer: USDC_ISSUER,
  minXlmReserve: 1.5,
  horizonUrl: HORIZON_URL,
};

const successResult: ValidationResult = {
  valid: true,
  accountFunded: true,
  trustlineExists: true,
  xlmBalance: '10.5000000',
  xlmReserveMet: true,
  assetBalance: '50.0',
  assetBalanceMet: true,
  checks: [
    { passed: true, label: 'Account funded', detail: 'Account is active on the Stellar network.' },
    { passed: true, label: 'USDC trustline', detail: 'Trustline for USDC is configured.' },
    { passed: true, label: 'XLM reserve', detail: 'Balance 10.5 XLM meets the minimum of 1.5 XLM.' },
  ],
};

const unfundedResult: ValidationResult = {
  valid: false,
  accountFunded: false,
  trustlineExists: false,
  xlmBalance: '0',
  xlmReserveMet: false,
  assetBalance: '0',
  assetBalanceMet: false,
  checks: [
    {
      passed: false,
      label: 'Account funded',
      detail: 'Account was not found on Horizon — it may not be funded or activated yet.',
    },
    {
      passed: false,
      label: 'USDC trustline',
      detail: 'Cannot verify trustline until the account exists.',
    },
    {
      passed: false,
      label: 'XLM reserve',
      detail: 'Cannot verify XLM balance without an active account.',
    },
  ],
  remediation: 'Send at least 1 XLM to activate the account.',
};

const LOCALES: Locale[] = ['en', 'es', 'pt'];

// ---------------------------------------------------------------------------
// Golden snapshot tests — one snapshot per locale × scenario
// ---------------------------------------------------------------------------

describe('i18n comment golden snapshots (issue #291)', () => {
  beforeAll(() => {
    // Fix timestamp for snapshot consistency
    jest.spyOn(Date, 'now').mockReturnValue(1000000000000);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  for (const locale of LOCALES) {
    describe(`locale: ${locale}`, () => {
      it(`success path renders correctly for locale "${locale}"`, () => {
        const body = formatCommentBody(successResult, { ...baseConfig, locale });
        // Snapshots are stored in __tests__/__snapshots__/i18n-comment-snapshots.test.ts.snap
        expect(body).toMatchSnapshot();
      });

      it(`unfunded failure path renders correctly for locale "${locale}"`, () => {
        const body = formatCommentBody(unfundedResult, { ...baseConfig, locale });
        expect(body).toMatchSnapshot();
      });

      it(`comment body for "${locale}" is a non-empty string`, () => {
        const body = formatCommentBody(successResult, { ...baseConfig, locale });
        expect(typeof body).toBe('string');
        expect(body.length).toBeGreaterThan(0);
      });

      it(`comment body for "${locale}" contains sticky comment marker`, () => {
        const body = formatCommentBody(successResult, { ...baseConfig, locale });
        expect(body).toContain('<!-- trustbridge-action:sticky-comment');
      });

      it(`comment body for "${locale}" contains the account address`, () => {
        const body = formatCommentBody(successResult, { ...baseConfig, locale });
        expect(body).toContain(STELLAR_ADDRESS);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Key parity tests — every string key must exist and be non-empty in all locales
// ---------------------------------------------------------------------------

describe('i18n key parity (issue #291)', () => {
  const enStrings = getStrings('en');

  // Collect only the plain string keys (not functions)
  const stringKeys = (Object.keys(enStrings) as (keyof CommentStrings)[]).filter(
    (k) => typeof enStrings[k] === 'string',
  );

  it('enStrings has at least 20 string keys (sanity check)', () => {
    expect(stringKeys.length).toBeGreaterThanOrEqual(20);
  });

  for (const locale of LOCALES) {
    describe(`locale: ${locale}`, () => {
      it(`all ${stringKeys.length} string keys are present and non-empty`, () => {
        const strings = getStrings(locale);
        const missing: string[] = [];
        const empty: string[] = [];

        for (const key of stringKeys) {
          const value = strings[key];
          if (typeof value !== 'string') {
            missing.push(key);
          } else if (value.trim().length === 0) {
            empty.push(key);
          }
        }

        if (missing.length > 0) {
          throw new Error(
            `Locale "${locale}" is missing ${missing.length} key(s): ${missing.join(', ')}`,
          );
        }
        if (empty.length > 0) {
          throw new Error(
            `Locale "${locale}" has ${empty.length} empty string key(s): ${empty.join(', ')}`,
          );
        }
      });

      it(`all function-based keys are callable and return non-empty strings`, () => {
        const strings = getStrings(locale);
        const funcKeys = (Object.keys(enStrings) as (keyof CommentStrings)[]).filter(
          (k) => typeof enStrings[k] === 'function',
        );

        for (const key of funcKeys) {
          const fn = strings[key];
          expect(typeof fn).toBe('function');
          // Call each function with placeholder args (any Arity ≤ 3)
          const result = (fn as (...args: string[]) => string)(
            'TEST_ARG_1',
            'TEST_ARG_2',
            'TEST_ARG_3',
          );
          expect(typeof result).toBe('string');
          expect(result.length).toBeGreaterThan(0);
        }
      });
    });
  }

  it('unknown locale falls back to English strings', () => {
    const strings = getStrings('xx-unknown');
    expect(strings.heading).toBe(enStrings.heading);
    expect(strings.resultsHeading).toBe(enStrings.resultsHeading);
  });

  it('empty string locale falls back to English', () => {
    const strings = getStrings('');
    expect(strings.heading).toBe(enStrings.heading);
  });

  it('es heading differs from en heading (strings are actually translated)', () => {
    expect(getStrings('es').heading).not.toBe(getStrings('en').heading);
  });

  it('pt heading differs from en heading', () => {
    expect(getStrings('pt').heading).not.toBe(getStrings('en').heading);
  });

  it('es and pt headings are distinct (no copy-paste between locales)', () => {
    // Both are "TrustBridge — Verificação/Verificación..." but different
    // words — verify they are not identical to each other
    const es = getStrings('es').heading;
    const pt = getStrings('pt').heading;
    expect(es).not.toBe(pt);
  });
});
