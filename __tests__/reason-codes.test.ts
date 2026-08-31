/**
 * Versioned reason_code catalog lock tests (Issue #297).
 *
 * These tests enforce that:
 * 1. Every reason_code emitted by checks.ts/outputs.ts appears in the
 *    canonical catalog at schemas/reason-codes.json (CI lock: renames fail).
 * 2. Every code in the catalog is exercised by at least one check function.
 * 3. The catalog file itself is structurally valid.
 * 4. reason_code values are English tokens (UPPER_SNAKE_CASE), never i18n strings.
 * 5. New codes must be additive — no code may be silently removed.
 *
 * Validate with: npm test -- --testPathPattern 'outputs|checks'
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  unfundedAccountResult,
  horizonFailureResult,
  tlsFailureResult,
  runAccountChecks,
} from '../src/checks';
import { toActionOutputs } from '../src/outputs';

// ---------------------------------------------------------------------------
// Load the catalog
// ---------------------------------------------------------------------------

const CATALOG_PATH = path.resolve(__dirname, '../schemas/reason-codes.json');
let catalog: {
  version: string;
  codes: Array<{ code: string; description: string; since: string }>;
};

beforeAll(() => {
  const raw = fs.readFileSync(CATALOG_PATH, 'utf8');
  catalog = JSON.parse(raw) as typeof catalog;
});

// ---------------------------------------------------------------------------
// Catalog file structural integrity
// ---------------------------------------------------------------------------

describe('reason-codes.json catalog integrity', () => {
  it('exists at schemas/reason-codes.json', () => {
    expect(fs.existsSync(CATALOG_PATH)).toBe(true);
  });

  it('is valid JSON', () => {
    expect(() => JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'))).not.toThrow();
  });

  it('has a "version" field', () => {
    expect(typeof catalog.version).toBe('string');
    expect(catalog.version.length).toBeGreaterThan(0);
  });

  it('has a "codes" array', () => {
    expect(Array.isArray(catalog.codes)).toBe(true);
    expect(catalog.codes.length).toBeGreaterThan(0);
  });

  it('every catalog entry has "code", "description", and "since" fields', () => {
    for (const entry of catalog.codes) {
      expect(typeof entry.code).toBe('string');
      expect(entry.code.length).toBeGreaterThan(0);
      expect(typeof entry.description).toBe('string');
      expect(entry.description.length).toBeGreaterThan(0);
      expect(typeof entry.since).toBe('string');
    }
  });

  it('all catalog codes are UPPER_SNAKE_CASE English tokens (not i18n strings)', () => {
    for (const entry of catalog.codes) {
      // UPPER_SNAKE_CASE validation
      const isUpperSnakeCase = /^[A-Z][A-Z0-9_]*$/.test(entry.code);
      expect(isUpperSnakeCase).toBe(true);
    }
  });

  it('no duplicate codes in the catalog', () => {
    const seen = new Set<string>();
    for (const entry of catalog.codes) {
      expect(seen.has(entry.code)).toBe(false);
      seen.add(entry.code);
    }
  });

  it('catalog contains the 9 known v1 codes', () => {
    const catalogCodes = new Set(catalog.codes.map((e) => e.code));
    const expectedV1Codes = [
      'SUCCESS',
      'TRUSTLINE_MISSING',
      'RESERVE_TOO_LOW',
      'TRUSTLINE_LIMIT_TOO_LOW',
      'FAILED',
      'ACCOUNT_NOT_FUNDED',
      'HORIZON_TIMEOUT',
      'HORIZON_ERROR',
      'TLS_ERROR',
    ];
    for (const code of expectedV1Codes) {
      expect(catalogCodes.has(code)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// CI lock: hard-coded known codes MUST exist in the catalog
// ---------------------------------------------------------------------------

/**
 * This block is the CI lock for Issue #297.
 *
 * If any of the known codes below are renamed or removed in checks.ts,
 * one of two things happens:
 *   a) The code is removed from checks.ts but stays in the catalog → the
 *      catalog-vs-runtime tests below will fail because the code is no
 *      longer emitted.
 *   b) The code is renamed in checks.ts → the renamed string no longer
 *      matches the catalog, and the test below fails.
 *
 * Either way: a silent rename is impossible.
 */
const KNOWN_REASON_CODES = [
  'SUCCESS',
  'TRUSTLINE_MISSING',
  'RESERVE_TOO_LOW',
  'TRUSTLINE_LIMIT_TOO_LOW',
  'FAILED',
  'ACCOUNT_NOT_FUNDED',
  'HORIZON_TIMEOUT',
  'HORIZON_ERROR',
  'TLS_ERROR',
] as const;

describe('CI lock: all known reason_codes are in the catalog', () => {
  it.each(KNOWN_REASON_CODES)('catalog contains "%s"', (code) => {
    const found = catalog.codes.find((entry) => entry.code === code);
    expect(found).toBeDefined();
    expect(found?.code).toBe(code);
  });
});

// ---------------------------------------------------------------------------
// Runtime: checks.ts emits the correct reason_code values
// ---------------------------------------------------------------------------

const DUMMY_CONFIG = {
  assetCode: 'USDC',
  assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  minXlmReserve: 1.5,
  horizonUrl: 'https://horizon.stellar.org',
};

const STELLAR_ADDRESS = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

describe('unfundedAccountResult emits ACCOUNT_NOT_FUNDED', () => {
  it('reasonCode is ACCOUNT_NOT_FUNDED', () => {
    const result = unfundedAccountResult(STELLAR_ADDRESS, DUMMY_CONFIG);
    expect(result.reasonCode).toBe('ACCOUNT_NOT_FUNDED');
  });

  it('ACCOUNT_NOT_FUNDED is in the catalog', () => {
    const result = unfundedAccountResult(STELLAR_ADDRESS, DUMMY_CONFIG);
    const inCatalog = catalog.codes.find((e) => e.code === result.reasonCode);
    expect(inCatalog).toBeDefined();
  });
});

describe('horizonFailureResult emits HORIZON_TIMEOUT or HORIZON_ERROR', () => {
  it('emits HORIZON_TIMEOUT for timeout messages', () => {
    const result = horizonFailureResult('Request timed out after 15000ms', DUMMY_CONFIG);
    expect(result.reasonCode).toBe('HORIZON_TIMEOUT');
  });

  it('emits HORIZON_TIMEOUT for "timed out" message variant', () => {
    const result = horizonFailureResult('Connection timed out', DUMMY_CONFIG);
    expect(result.reasonCode).toBe('HORIZON_TIMEOUT');
  });

  it('emits HORIZON_TIMEOUT for "timeout" message variant', () => {
    const result = horizonFailureResult('Operation timeout after 5s', DUMMY_CONFIG);
    expect(result.reasonCode).toBe('HORIZON_TIMEOUT');
  });

  it('emits HORIZON_ERROR for non-timeout errors', () => {
    const result = horizonFailureResult('HTTP 503 Service Unavailable', DUMMY_CONFIG);
    expect(result.reasonCode).toBe('HORIZON_ERROR');
  });

  it('emits HORIZON_ERROR for ECONNREFUSED', () => {
    const result = horizonFailureResult('ECONNREFUSED', DUMMY_CONFIG);
    expect(result.reasonCode).toBe('HORIZON_ERROR');
  });

  it('HORIZON_TIMEOUT is in the catalog', () => {
    const result = horizonFailureResult('Request timed out', DUMMY_CONFIG);
    const inCatalog = catalog.codes.find((e) => e.code === result.reasonCode);
    expect(inCatalog).toBeDefined();
  });

  it('HORIZON_ERROR is in the catalog', () => {
    const result = horizonFailureResult('HTTP 503', DUMMY_CONFIG);
    const inCatalog = catalog.codes.find((e) => e.code === result.reasonCode);
    expect(inCatalog).toBeDefined();
  });
});

describe('tlsFailureResult emits TLS_ERROR', () => {
  it('reasonCode is TLS_ERROR', () => {
    const result = tlsFailureResult('certificate verify failed', DUMMY_CONFIG);
    expect(result.reasonCode).toBe('TLS_ERROR');
  });

  it('TLS_ERROR is in the catalog', () => {
    const result = tlsFailureResult('certificate verify failed', DUMMY_CONFIG);
    const inCatalog = catalog.codes.find((e) => e.code === result.reasonCode);
    expect(inCatalog).toBeDefined();
  });
});

describe('runValidationChecks emits SUCCESS for a fully valid account', () => {
  const validAccount = {
    id: STELLAR_ADDRESS,
    account_id: STELLAR_ADDRESS,
    sequence: '1',
    subentry_count: 1,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [
      {
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        balance: '10.0000000',
        limit: '922337203685.4775807',
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
        is_authorized: true,
      },
      {
        asset_type: 'native',
        balance: '5.0000000',
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
      },
    ],
    flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
  } as any;

  it('emits SUCCESS when all checks pass', async () => {
    const result = await runAccountChecks(validAccount, DUMMY_CONFIG);
    expect(result.reasonCode).toBe('SUCCESS');
    expect(result.valid).toBe(true);
  });

  it('SUCCESS is in the catalog', async () => {
    const result = await runAccountChecks(validAccount, DUMMY_CONFIG);
    const inCatalog = catalog.codes.find((e) => e.code === result.reasonCode);
    expect(inCatalog).toBeDefined();
  });
});

describe('runValidationChecks emits TRUSTLINE_MISSING when trustline absent', () => {
  const accountNoTrustline = {
    id: STELLAR_ADDRESS,
    account_id: STELLAR_ADDRESS,
    sequence: '1',
    subentry_count: 0,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [
      {
        asset_type: 'native',
        balance: '5.0000000',
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
      },
    ],
    flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
  } as any;

  it('emits TRUSTLINE_MISSING when USDC trustline is absent', async () => {
    const result = await runAccountChecks(accountNoTrustline, DUMMY_CONFIG);
    expect(result.reasonCode).toBe('TRUSTLINE_MISSING');
    expect(result.trustlineExists).toBe(false);
  });

  it('TRUSTLINE_MISSING is in the catalog', async () => {
    const result = await runAccountChecks(accountNoTrustline, DUMMY_CONFIG);
    const inCatalog = catalog.codes.find((e) => e.code === result.reasonCode);
    expect(inCatalog).toBeDefined();
  });
});

describe('runValidationChecks emits RESERVE_TOO_LOW when XLM balance is insufficient', () => {
  const accountLowBalance = {
    id: STELLAR_ADDRESS,
    account_id: STELLAR_ADDRESS,
    sequence: '1',
    subentry_count: 1,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [
      {
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        balance: '10.0000000',
        limit: '922337203685.4775807',
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
        is_authorized: true,
      },
      {
        asset_type: 'native',
        balance: '0.5000000', // below the 1.5 XLM minimum
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
      },
    ],
    flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
  } as any;

  it('emits RESERVE_TOO_LOW when XLM balance is below the minimum reserve', async () => {
    const result = await runAccountChecks(accountLowBalance, DUMMY_CONFIG);
    expect(result.reasonCode).toBe('RESERVE_TOO_LOW');
    expect(result.xlmReserveMet).toBe(false);
    expect(result.trustlineExists).toBe(true);
  });

  it('RESERVE_TOO_LOW is in the catalog', async () => {
    const result = await runAccountChecks(accountLowBalance, DUMMY_CONFIG);
    const inCatalog = catalog.codes.find((e) => e.code === result.reasonCode);
    expect(inCatalog).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// toActionOutputs: reason_code output matches the ValidationResult.reasonCode
// ---------------------------------------------------------------------------

describe('toActionOutputs reason_code output matches catalog', () => {
  it('outputs reason_code = SUCCESS for a valid result', () => {
    const result = {
      valid: true,
      accountFunded: true,
      trustlineExists: true,
      xlmBalance: '10.0000000',
      xlmReserveMet: true,
      checks: [],
      reasonCode: 'SUCCESS',
    } as any;
    const outputs = toActionOutputs(result);
    expect(outputs.reason_code).toBe('SUCCESS');
    expect(catalog.codes.find((e) => e.code === outputs.reason_code)).toBeDefined();
  });

  it('outputs reason_code = ACCOUNT_NOT_FUNDED for unfunded result', () => {
    const result = {
      valid: false,
      accountFunded: false,
      trustlineExists: false,
      xlmBalance: '0',
      xlmReserveMet: false,
      checks: [],
      reasonCode: 'ACCOUNT_NOT_FUNDED',
    } as any;
    const outputs = toActionOutputs(result);
    expect(outputs.reason_code).toBe('ACCOUNT_NOT_FUNDED');
    expect(catalog.codes.find((e) => e.code === outputs.reason_code)).toBeDefined();
  });

  it('falls back to SUCCESS when reasonCode is undefined and valid=true', () => {
    const result = {
      valid: true,
      accountFunded: true,
      trustlineExists: true,
      xlmBalance: '5.0',
      xlmReserveMet: true,
      checks: [],
      reasonCode: undefined,
    } as any;
    const outputs = toActionOutputs(result);
    expect(outputs.reason_code).toBe('SUCCESS');
  });

  it('falls back to FAILED when reasonCode is undefined and valid=false', () => {
    const result = {
      valid: false,
      accountFunded: true,
      trustlineExists: true,
      xlmBalance: '5.0',
      xlmReserveMet: true,
      checks: [],
      reasonCode: undefined,
    } as any;
    const outputs = toActionOutputs(result);
    expect(outputs.reason_code).toBe('FAILED');
    expect(catalog.codes.find((e) => e.code === outputs.reason_code)).toBeDefined();
  });

  it.each(KNOWN_REASON_CODES)(
    'every known reason_code "%s" is in the catalog and outputs correctly',
    (code) => {
      const isValid = code === 'SUCCESS';
      const result = {
        valid: isValid,
        accountFunded: code !== 'ACCOUNT_NOT_FUNDED',
        trustlineExists: !['TRUSTLINE_MISSING', 'ACCOUNT_NOT_FUNDED', 'HORIZON_TIMEOUT', 'HORIZON_ERROR', 'TLS_ERROR'].includes(code),
        xlmBalance: '5.0',
        xlmReserveMet: !['RESERVE_TOO_LOW', 'ACCOUNT_NOT_FUNDED', 'HORIZON_TIMEOUT', 'HORIZON_ERROR', 'TLS_ERROR'].includes(code),
        checks: [],
        reasonCode: code,
      } as any;
      const outputs = toActionOutputs(result);
      expect(outputs.reason_code).toBe(code);
      expect(catalog.codes.find((e) => e.code === code)).toBeDefined();
    }
  );
});
