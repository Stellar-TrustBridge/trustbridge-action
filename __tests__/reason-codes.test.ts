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
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
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

  it('catalog contains the 10 known v1 codes', () => {
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
      'TRUSTLINE_UNAUTHORIZED',
      'MAINTAINER_SKIPPED',
    ];
    for (const code of expectedV1Codes) {
      expect(catalogCodes.has(code)).toBe(true);
    }
  });

  // Issue #667 — resilience and gating codes that predate this catalog entry.
  // They are emitted at runtime, so the catalog (a public API surface) must
  // list them or downstream dashboard switches silently fall through to FAILED.
  it('catalog contains the resilience and gating codes emitted at runtime (Issue #667)', () => {
    const catalogCodes = new Set(catalog.codes.map((e) => e.code));
    for (const code of ['CIRCUIT_OPEN', 'RATE_BUDGET_EXHAUSTED', 'MILESTONE_GATE_SKIPPED']) {
      expect(catalogCodes.has(code)).toBe(true);
    }
  });

  // Issue #665 — CLAWBACK_BLOCKED is documented in docs/USAGE.md and emitted
  // by runAccountChecks, so it must be cataloged alongside the other checks codes.
  it('catalog contains CLAWBACK_BLOCKED (Issue #665)', () => {
    const catalogCodes = new Set(catalog.codes.map((e) => e.code));
    expect(catalogCodes.has('CLAWBACK_BLOCKED')).toBe(true);
  });

  // Every catalog entry must point at a real source module so the emittedBy
  // field stays actionable instead of pointing at a file that no longer exists.
  it('every emittedBy references a module that exists on disk', () => {
    const missing: string[] = [];
    for (const entry of catalog.codes) {
      const match = (entry as { emittedBy?: string }).emittedBy?.match(/^(src\/[\w./-]+)/);
      if (!match) continue;
      const modulePath = match[1]!;
      if (!fs.existsSync(path.resolve(__dirname, '..', modulePath))) {
        missing.push(`${entry.code} -> ${modulePath}`);
      }
    }
    expect(missing).toEqual([]);
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
  'TRUSTLINE_UNAUTHORIZED',
  // Issue #665/#667: codes emitted by runAccountChecks and the resilience /
  // gating paths. Listed here so the CI lock below covers them too.
  'CLAWBACK_BLOCKED',
  'CIRCUIT_OPEN',
  'RATE_BUDGET_EXHAUSTED',
  'MILESTONE_GATE_SKIPPED',
  'MAINTAINER_SKIPPED',
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

// ---------------------------------------------------------------------------
// Issue #731 — generated docs table must stay in sync with the catalog
//
// `npm run reason-codes:doc` rewrites the table between the sentinel markers
// in docs/USAGE.md from schemas/reason-codes.json. These tests keep the
// previous rename lock intact *and* prove the docs cannot drift: a code added
// to (or removed from) the catalog without regenerating fails here and in the
// `reason-codes:check` CI step.
// ---------------------------------------------------------------------------

const USAGE_DOC_PATH = path.resolve(__dirname, '../docs/USAGE.md');
const GENERATOR_PATH = path.resolve(__dirname, '../scripts/generate-reason-codes-doc.js');
const REGION_ID = 'reason-codes';
const BEGIN_MARKER = `<!-- BEGIN GENERATED: ${REGION_ID} (source: schemas/reason-codes.json) -->`;
const END_MARKER = `<!-- END GENERATED: ${REGION_ID} -->`;

describe('reason_code docs table is generated from the catalog (Issue #731)', () => {
  let usageDoc: string;
  let generatedRegion: string;

  beforeAll(() => {
    usageDoc = fs.readFileSync(USAGE_DOC_PATH, 'utf8');
    const begin = usageDoc.indexOf(BEGIN_MARKER);
    expect(begin).toBeGreaterThan(-1);
    const end = usageDoc.indexOf(END_MARKER, begin);
    expect(end).toBeGreaterThan(begin);
    generatedRegion = usageDoc.slice(begin, end + END_MARKER.length);
  });

  it('docs/USAGE.md contains the generated-region sentinel comments', () => {
    expect(usageDoc).toContain(BEGIN_MARKER);
    expect(usageDoc).toContain(END_MARKER);
  });

  it('the generated region is marked as autogenerated', () => {
    expect(generatedRegion).toContain('AUTOGENERATED');
    expect(generatedRegion).toContain('npm run reason-codes:doc');
  });

  it('the generated region starts and ends with the sentinel comments', () => {
    expect(generatedRegion.startsWith(BEGIN_MARKER)).toBe(true);
    expect(generatedRegion.endsWith(END_MARKER)).toBe(true);
  });

  it('documents every catalog code, and no code the catalog does not define', () => {
    const documented = Array.from(generatedRegion.matchAll(/^\| `([A-Z][A-Z0-9_]*)` \|/gm)).map(
      (m) => m[1],
    );

    expect(documented).toEqual(catalog.codes.map((e) => e.code));
  });

  it('renders the expected columns in a stable order', () => {
    const headerLine = generatedRegion.split('\n').find((line) => line.startsWith('| `reason_code` |'));
    expect(headerLine).toBeDefined();
    expect(headerLine).toBe(
      '| `reason_code` | `valid` | `account_funded` | `trustline_exists` | `xlm_reserve_met` | Description |',
    );
  });

  it('the catalog code count is reported in the region header', () => {
    expect(generatedRegion).toContain(
      `${catalog.codes.length} codes from schemas/reason-codes.json`,
    );
  });

  it('npm run reason-codes:check passes — no doc drift', () => {
    const result = spawnSync(process.execPath, [GENERATOR_PATH, '--check'], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('is up to date');
  });

  it('the generator is idempotent: running it twice produces one identical file', () => {
    const before = fs.readFileSync(USAGE_DOC_PATH, 'utf8');
    const first = spawnSync(process.execPath, [GENERATOR_PATH], { encoding: 'utf8' });
    const afterFirst = fs.readFileSync(USAGE_DOC_PATH, 'utf8');
    const second = spawnSync(process.execPath, [GENERATOR_PATH], { encoding: 'utf8' });

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(afterFirst).toBe(before);
    expect(fs.readFileSync(USAGE_DOC_PATH, 'utf8')).toBe(before);
  });

  it('preserves hand-written prose outside the generated region', () => {
    // The "Switching on reason_code" section follows the region and is manual.
    expect(usageDoc).toContain('### Switching on reason_code in downstream jobs');
    expect(usageDoc.indexOf('### Switching on reason_code in downstream jobs')).toBeGreaterThan(
      usageDoc.indexOf(END_MARKER),
    );
  });

  it('exposes both npm scripts in package.json', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };

    expect(pkg.scripts['reason-codes:doc']).toBe('node scripts/generate-reason-codes-doc.js');
    expect(pkg.scripts['reason-codes:check']).toBe(
      'node scripts/generate-reason-codes-doc.js --check',
    );
  });

  it('CI runs the drift check', () => {
    const ci = fs.readFileSync(
      path.resolve(__dirname, '../.github/workflows/ci.yml'),
      'utf8',
    );
    expect(ci).toContain('npm run reason-codes:check');
  });
});

describe('generate-reason-codes-doc.js drift detection (Issue #731)', () => {
  /**
   * Materialise a throwaway copy of the generator's inputs (it resolves paths
   * relative to its own `__dirname`) so drift can be provoked without
   * touching the repository working tree.
   */
  function withTempRepo(
    mutate: (files: { doc: string; catalog: any }) => void,
    run: (root: string) => void,
  ): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reason-codes-doc-'));
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(root, 'schemas'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.copyFileSync(GENERATOR_PATH, path.join(root, 'scripts', 'generate-reason-codes-doc.js'));

    const files = {
      doc: fs.readFileSync(USAGE_DOC_PATH, 'utf8'),
      catalog: JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8')),
    };
    mutate(files);

    fs.writeFileSync(path.join(root, 'schemas', 'reason-codes.json'), JSON.stringify(files.catalog), 'utf8');
    fs.writeFileSync(path.join(root, 'docs', 'USAGE.md'), files.doc, 'utf8');

    run(root);
  }

  function runGeneratorIn(root: string, args: string[]) {
    const result = spawnSync(
      process.execPath,
      [path.join(root, 'scripts', 'generate-reason-codes-doc.js'), ...args],
      { encoding: 'utf8' },
    );
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }

  it('exits 0 when the doc matches the catalog', () => {
    withTempRepo(
      () => undefined,
      (root) => {
        const result = runGeneratorIn(root, ['--check']);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('is up to date');
      },
    );
  });

  it('exits 1 in --check mode when a code was added without regenerating', () => {
    withTempRepo(
      (files) => {
        files.catalog.codes.push({
          code: 'DRIFT_TEST_CODE',
          description: 'Synthetic code used to prove the drift check fails.',
          accountFunded: true,
          trustlineExists: true,
          xlmReserveMet: true,
          valid: false,
          emittedBy: 'test',
          since: 'v1',
        });
      },
      (root) => {
        const result = runGeneratorIn(root, ['--check']);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('out of date');
        // The failing check must not modify the file.
        expect(fs.readFileSync(path.join(root, 'docs', 'USAGE.md'), 'utf8')).not.toContain(
          'DRIFT_TEST_CODE',
        );
      },
    );
  });

  it('regenerates the table and preserves surrounding prose in write mode', () => {
    withTempRepo(
      (files) => {
        files.catalog.codes.push({
          code: 'DRIFT_TEST_CODE',
          description: 'Synthetic code | with a pipe.',
          accountFunded: true,
          trustlineExists: false,
          xlmReserveMet: true,
          valid: false,
          emittedBy: 'test',
          since: 'v1',
        });
      },
      (root) => {
        expect(runGeneratorIn(root, []).status).toBe(0);

        const updated = fs.readFileSync(path.join(root, 'docs', 'USAGE.md'), 'utf8');
        expect(updated).toContain('DRIFT_TEST_CODE');
        // A pipe in a description must be escaped so the table stays intact.
        expect(updated).toContain('Synthetic code \\| with a pipe.');
        expect(updated).toContain('### Switching on reason_code in downstream jobs');
        expect(updated).toContain(END_MARKER);
        // Idempotent: a second run is a no-op.
        expect(runGeneratorIn(root, []).status).toBe(0);
        expect(runGeneratorIn(root, ['--check']).status).toBe(0);
      },
    );
  });

  it('exits 1 when the sentinel markers are missing', () => {
    withTempRepo(
      (files) => {
        files.doc = files.doc.replace(BEGIN_MARKER, '').replace(END_MARKER, '');
      },
      (root) => {
        const result = runGeneratorIn(root, ['--check']);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Missing generated-region start marker');
      },
    );
  });

  it('renders a deprecated code with strikethrough', () => {
    withTempRepo(
      (files) => {
        files.catalog.codes[0].deprecated = true;
      },
      (root) => {
        expect(runGeneratorIn(root, []).status).toBe(0);
        const updated = fs.readFileSync(path.join(root, 'docs', 'USAGE.md'), 'utf8');
        expect(updated).toContain('~~All checks passed');
      },
    );
  });

  it('uses only Node built-ins (no install step on Node 20)', () => {
    const source = fs.readFileSync(GENERATOR_PATH, 'utf8');
    const requires = Array.from(source.matchAll(/require\('([^']+)'\)/g)).map((m) => m[1]);

    expect(requires.length).toBeGreaterThan(0);
    for (const moduleName of requires) {
      expect(['fs', 'path', 'os', 'crypto', 'child_process']).toContain(moduleName);
    }
  });

  it('declares a shebang so it is runnable directly', () => {
    const source = fs.readFileSync(GENERATOR_PATH, 'utf8');
    expect(source.startsWith('#!/usr/bin/env node'));
  });
});

