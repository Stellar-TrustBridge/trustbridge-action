/**
 * Integration tests for the SARIF upload path.
 *
 * Issue #557 — Add integration test covering SARIF upload path when
 * `sarif_enabled` is true.
 *
 * These tests exercise `src/sarif.ts` end-to-end:
 *   - SARIF document structure and schema compliance
 *   - All-pass and mixed-failure outcomes
 *   - Clawback / auth_required fixture combinations
 *   - The uploadSarifReport integration path (mock upload function)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildSarifDocument,
  serialiseSarif,
  uploadSarifReport,
  SARIF_SCHEMA,
  SARIF_VERSION,
  TOOL_NAME,
  TrustBridgeCheckOutcome,
  SarifDocument,
  SarifUploadFn,
  buildSarifOutput,
  buildSarifRules,
  checkLabelToRuleId,
  reasonCodeToRuleId,
  getSarifSchemaErrors,
  validateSarifSchema,
  writeSarifFile,
  SarifValidationError,
  GENERIC_RULE_ID,
} from '../src/sarif';
import {
  ANNOTATION_SCHEMA_KEYWORDS,
  SARIF_SCHEMA_FILE,
  SUPPORTED_SCHEMA_KEYWORDS,
  loadSarifJsonSchema,
} from '../src/sarifSchema';
import {
  ValidationResult,
  circuitOpenFailureResult,
  rateBudgetExhaustedResult,
} from '../src/checks';

const TEST_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const PRIMARY_HORIZON = 'https://horizon.stellar.org';

function makeOutcome(overrides: Partial<TrustBridgeCheckOutcome> = {}): TrustBridgeCheckOutcome {
  return {
    horizonUrl: PRIMARY_HORIZON,
    stellarAddress: TEST_ADDRESS,
    accountFunded: true,
    trustlineExists: true,
    xlmReserveMet: true,
    assetCode: 'USDC',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildSarifDocument — document structure
// ---------------------------------------------------------------------------
describe('buildSarifDocument', () => {
  it('returns a valid SARIF 2.1.0 document skeleton', () => {
    const doc = buildSarifDocument(makeOutcome());

    expect(doc.$schema).toBe(SARIF_SCHEMA);
    expect(doc.version).toBe(SARIF_VERSION);
    expect(doc.runs).toHaveLength(1);
  });

  it('names the driver correctly', () => {
    const doc = buildSarifDocument(makeOutcome());
    const { driver } = doc.runs[0].tool;

    expect(driver.name).toBe(TOOL_NAME);
    expect(driver.informationUri).toContain('trustbridge-action');
    expect(typeof driver.version).toBe('string');
  });

  it('emits exactly three rules (TB001, TB002, TB003)', () => {
    const doc = buildSarifDocument(makeOutcome());
    const ruleIds = doc.runs[0].tool.driver.rules.map((r) => r.id);

    expect(ruleIds).toEqual(['TB001', 'TB002', 'TB003']);
  });

  it('emits three results — one per check', () => {
    const doc = buildSarifDocument(makeOutcome());
    expect(doc.runs[0].results).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// All-pass outcome
// ---------------------------------------------------------------------------
describe('buildSarifDocument: all checks pass', () => {
  let doc: SarifDocument;

  beforeEach(() => {
    doc = buildSarifDocument(makeOutcome());
  });

  it('sets all result levels to "none" when all checks pass', () => {
    const levels = doc.runs[0].results.map((r) => r.level);
    expect(levels).toEqual(['none', 'none', 'none']);
  });

  it('maps rule IDs to the correct checks', () => {
    const results = doc.runs[0].results;
    expect(results[0].ruleId).toBe('TB001');
    expect(results[1].ruleId).toBe('TB002');
    expect(results[2].ruleId).toBe('TB003');
  });

  it('includes the stellar address in TB001 message when account is funded', () => {
    const tb001 = doc.runs[0].results.find((r) => r.ruleId === 'TB001');
    expect(tb001?.message.text).toContain(TEST_ADDRESS);
    expect(tb001?.message.text).toContain('funded');
  });
});

// ---------------------------------------------------------------------------
// Failure outcomes — individual gates
// ---------------------------------------------------------------------------
describe('buildSarifDocument: account not funded', () => {
  it('sets TB001 level to "error" when accountFunded=false', () => {
    const doc = buildSarifDocument(makeOutcome({ accountFunded: false }));
    const tb001 = doc.runs[0].results.find((r) => r.ruleId === 'TB001');
    expect(tb001?.level).toBe('error');
    expect(tb001?.message.text).toContain('not found');
  });

  it('keeps TB002 and TB003 at "none" when only the account gate fails', () => {
    const doc = buildSarifDocument(
      makeOutcome({ accountFunded: false, trustlineExists: true, xlmReserveMet: true }),
    );
    const levels = doc.runs[0].results.reduce<Record<string, string>>((acc, r) => {
      acc[r.ruleId] = r.level;
      return acc;
    }, {});
    expect(levels['TB001']).toBe('error');
    expect(levels['TB002']).toBe('none');
    expect(levels['TB003']).toBe('none');
  });
});

describe('buildSarifDocument: trustline missing', () => {
  it('sets TB002 level to "error" when trustlineExists=false', () => {
    const doc = buildSarifDocument(makeOutcome({ trustlineExists: false }));
    const tb002 = doc.runs[0].results.find((r) => r.ruleId === 'TB002');
    expect(tb002?.level).toBe('error');
    expect(tb002?.message.text).toContain('missing');
  });

  it('includes the assetCode in the TB002 message', () => {
    const doc = buildSarifDocument(makeOutcome({ trustlineExists: false, assetCode: 'EURC' }));
    const tb002 = doc.runs[0].results.find((r) => r.ruleId === 'TB002');
    expect(tb002?.message.text).toContain('EURC');
  });
});

describe('buildSarifDocument: XLM reserve not met', () => {
  it('sets TB003 level to "error" when xlmReserveMet=false', () => {
    const doc = buildSarifDocument(makeOutcome({ xlmReserveMet: false }));
    const tb003 = doc.runs[0].results.find((r) => r.ruleId === 'TB003');
    expect(tb003?.level).toBe('error');
    expect(tb003?.message.text).toContain('below');
  });
});

describe('buildSarifDocument: all checks fail', () => {
  it('sets all result levels to "error" when every check fails', () => {
    const doc = buildSarifDocument(
      makeOutcome({ accountFunded: false, trustlineExists: false, xlmReserveMet: false }),
    );
    const levels = doc.runs[0].results.map((r) => r.level);
    expect(levels).toEqual(['error', 'error', 'error']);
  });
});

// ---------------------------------------------------------------------------
// serialiseSarif
// ---------------------------------------------------------------------------
describe('serialiseSarif', () => {
  it('produces valid JSON', () => {
    const doc = buildSarifDocument(makeOutcome());
    const json = serialiseSarif(doc);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('round-trips through JSON.parse without data loss', () => {
    const doc = buildSarifDocument(makeOutcome({ accountFunded: false }));
    const json = serialiseSarif(doc);
    const parsed = JSON.parse(json) as SarifDocument;
    expect(parsed.version).toBe(SARIF_VERSION);
    expect(parsed.runs[0].results[0].level).toBe('error');
  });

  it('includes the schema URL in the serialised output', () => {
    const json = serialiseSarif(buildSarifDocument(makeOutcome()));
    expect(json).toContain(SARIF_SCHEMA);
  });
});

// ---------------------------------------------------------------------------
// uploadSarifReport integration path (sarif_enabled=true)
// ---------------------------------------------------------------------------
describe('uploadSarifReport: integration with mock upload function', () => {
  it('calls the upload function once with the serialised SARIF JSON', async () => {
    const uploadFn: SarifUploadFn = jest.fn().mockResolvedValueOnce(undefined);

    await uploadSarifReport(makeOutcome(), uploadFn);

    expect(uploadFn).toHaveBeenCalledTimes(1);
    const [sarifJson] = (uploadFn as jest.Mock).mock.calls[0] as [string];
    const doc = JSON.parse(sarifJson) as SarifDocument;
    expect(doc.version).toBe(SARIF_VERSION);
  });

  it('passes the horizonUrl as the second argument to uploadFn', async () => {
    const uploadFn: SarifUploadFn = jest.fn().mockResolvedValueOnce(undefined);

    await uploadSarifReport(makeOutcome({ horizonUrl: 'https://horizon-testnet.stellar.org' }), uploadFn);

    const [, horizonUrl] = (uploadFn as jest.Mock).mock.calls[0] as [string, string];
    expect(horizonUrl).toBe('https://horizon-testnet.stellar.org');
  });

  it('re-throws upload function errors so callers can emit a warning', async () => {
    const uploadFn: SarifUploadFn = jest.fn().mockRejectedValueOnce(new Error('upload failed'));

    await expect(uploadSarifReport(makeOutcome(), uploadFn)).rejects.toThrow('upload failed');
  });

  it('uploads a document with error-level results when checks fail', async () => {
    const uploadFn: SarifUploadFn = jest.fn().mockResolvedValueOnce(undefined);
    const outcome = makeOutcome({ accountFunded: false, trustlineExists: false });

    await uploadSarifReport(outcome, uploadFn);

    const [sarifJson] = (uploadFn as jest.Mock).mock.calls[0] as [string];
    const doc = JSON.parse(sarifJson) as SarifDocument;
    const errorResults = doc.runs[0].results.filter((r) => r.level === 'error');
    expect(errorResults).toHaveLength(2); // TB001 + TB002
  });

  it('uploads a clean document (all "none" levels) when every check passes', async () => {
    const uploadFn: SarifUploadFn = jest.fn().mockResolvedValueOnce(undefined);

    await uploadSarifReport(makeOutcome(), uploadFn);

    const [sarifJson] = (uploadFn as jest.Mock).mock.calls[0] as [string];
    const doc = JSON.parse(sarifJson) as SarifDocument;
    const errorResults = doc.runs[0].results.filter((r) => r.level === 'error');
    expect(errorResults).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Regression: custom asset codes and testnet horizon
// ---------------------------------------------------------------------------
describe('buildSarifDocument: custom asset and testnet horizon', () => {
  it('uses the provided assetCode in TB002 rule description', () => {
    const doc = buildSarifDocument(
      makeOutcome({ assetCode: 'EURC', horizonUrl: 'https://horizon-testnet.stellar.org' }),
    );
    const tb002Rule = doc.runs[0].tool.driver.rules.find((r) => r.id === 'TB002');
    expect(tb002Rule?.shortDescription.text).toContain('EURC');
  });
});

// ---------------------------------------------------------------------------
// Issue #678 — buildSarifRules TB001–TB010 and ValidationResult mapping
// ---------------------------------------------------------------------------

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const CHECK_CONFIG = {
  assetCode: 'USDC',
  assetIssuer: USDC_ISSUER,
  minXlmReserve: 1.5,
  horizonUrl: PRIMARY_HORIZON,
};

function makeValidationResult(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    valid: true,
    accountFunded: true,
    trustlineExists: true,
    xlmBalance: '10.0000000',
    xlmReserveMet: true,
    reasonCode: 'SUCCESS',
    checks: [
      { passed: true, label: 'Account funded', detail: 'Account is funded.' },
      { passed: true, label: 'USDC trustline', detail: 'Trustline for USDC is configured.' },
      { passed: true, label: 'XLM reserve', detail: 'Reserve met.' },
    ],
    ...overrides,
  };
}

function sarifResults(sarif: Record<string, unknown>): any[] {
  return (sarif.runs as any[])[0].results;
}

function resultsFor(sarif: Record<string, unknown>, ruleId: string): any[] {
  return sarifResults(sarif).filter((r) => r.ruleId === ruleId);
}

describe('buildSarifRules (Issue #678)', () => {
  it('declares TB001–TB010 plus the generic TB000 fallback, in order', () => {
    expect(buildSarifRules().map((r) => r.id)).toEqual([
      'TB001', 'TB002', 'TB003', 'TB004', 'TB005',
      'TB006', 'TB007', 'TB008', 'TB009', 'TB010',
      GENERIC_RULE_ID,
    ]);
  });

  it('gives every rule a unique id, a name, a description and an https helpUri', () => {
    const rules = buildSarifRules();
    expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
    for (const rule of rules) {
      expect(rule.name).toMatch(/^[A-Z][A-Za-z]+$/);
      expect(rule.shortDescription.text.length).toBeGreaterThan(0);
      expect(rule.fullDescription?.text.length).toBeGreaterThan(0);
      expect(rule.helpUri).toMatch(/^https:\/\//);
    }
  });

  it('names the new rules after their scenarios', () => {
    const names = Object.fromEntries(buildSarifRules().map((r) => [r.id, r.name]));
    expect(names).toMatchObject({
      TB006: 'UnauthorizedTrustline',
      TB007: 'MilestoneGate',
      TB008: 'ClawbackEnabledAdvisory',
      TB009: 'RateBudgetExhausted',
      TB010: 'CircuitOpen',
    });
  });

  it('every ruleId emitted by buildSarifOutput is declared in the driver', () => {
    const fixtures = [
      makeValidationResult(),
      makeValidationResult({ valid: false, reasonCode: 'MILESTONE_GATE_SKIPPED', checks: [] }),
      makeValidationResult({ clawbackEnabled: true }),
      rateBudgetExhaustedResult('budget of 3 requests exhausted', CHECK_CONFIG),
      circuitOpenFailureResult('circuit open', CHECK_CONFIG),
      makeValidationResult({
        checks: [{ passed: true, label: 'SEP-0001 home domain', detail: 'ok' }],
      }),
    ];
    for (const fixture of fixtures) {
      const sarif = buildSarifOutput(fixture, 'USDC', PRIMARY_HORIZON, TEST_ADDRESS);
      const declared = new Set(
        ((sarif.runs as any[])[0].tool.driver.rules as any[]).map((r) => r.id),
      );
      for (const result of sarifResults(sarif)) {
        expect(declared.has(result.ruleId)).toBe(true);
      }
    }
  });
});

describe('reasonCodeToRuleId / checkLabelToRuleId (Issue #678)', () => {
  it('maps the run-level reason codes to TB007, TB009 and TB010', () => {
    expect(reasonCodeToRuleId('MILESTONE_GATE_SKIPPED')).toBe('TB007');
    expect(reasonCodeToRuleId('RATE_BUDGET_EXHAUSTED')).toBe('TB009');
    expect(reasonCodeToRuleId('CIRCUIT_OPEN')).toBe('TB010');
  });

  it('returns undefined for check-level and unknown reason codes', () => {
    expect(reasonCodeToRuleId('TRUSTLINE_MISSING')).toBeUndefined();
    expect(reasonCodeToRuleId('SOMETHING_NEW')).toBeUndefined();
    expect(reasonCodeToRuleId(undefined)).toBeUndefined();
  });

  it('falls back to the declared generic rule for unknown labels', () => {
    expect(checkLabelToRuleId('Claimable balances')).toBe(GENERIC_RULE_ID);
    expect(checkLabelToRuleId('Some future check')).toBe(GENERIC_RULE_ID);
  });

  it('keeps clawback labels out of TB002', () => {
    expect(checkLabelToRuleId('USDC clawback safety')).toBe('TB005');
    expect(checkLabelToRuleId('USDC trustline')).toBe('TB002');
  });
});

describe('buildSarifOutput: TB006–TB010 results (Issue #678)', () => {
  it('reports a rate-budget exhaustion under TB009 instead of TB004', () => {
    const sarif = buildSarifOutput(
      rateBudgetExhaustedResult('budget of 3 requests exhausted', CHECK_CONFIG),
      'USDC',
      PRIMARY_HORIZON,
      TEST_ADDRESS,
    );
    const tb009 = resultsFor(sarif, 'TB009');
    expect(tb009).toHaveLength(1);
    expect(tb009[0].level).toBe('error');
    expect(tb009[0].message.text).toContain('Rate budget exhausted');
    expect(resultsFor(sarif, 'TB004')).toHaveLength(0);
  });

  it('reports an open circuit breaker under TB010 instead of TB004', () => {
    const sarif = buildSarifOutput(
      circuitOpenFailureResult('Circuit breaker open for horizon.stellar.org', CHECK_CONFIG),
      'USDC',
      PRIMARY_HORIZON,
      TEST_ADDRESS,
    );
    const tb010 = resultsFor(sarif, 'TB010');
    expect(tb010).toHaveLength(1);
    expect(tb010[0].level).toBe('error');
    expect(resultsFor(sarif, 'TB004')).toHaveLength(0);
  });

  it('keeps a plain Horizon error under TB004', () => {
    const sarif = buildSarifOutput(
      makeValidationResult({
        valid: false,
        reasonCode: 'HORIZON_ERROR',
        checks: [{ passed: false, label: 'Horizon availability', detail: 'HTTP 503' }],
      }),
      'USDC',
      PRIMARY_HORIZON,
      TEST_ADDRESS,
    );
    expect(resultsFor(sarif, 'TB004')).toHaveLength(1);
    expect(resultsFor(sarif, 'TB009')).toHaveLength(0);
    expect(resultsFor(sarif, 'TB010')).toHaveLength(0);
  });

  it('adds a TB007 warning when the milestone gate skipped validation', () => {
    const sarif = buildSarifOutput(
      makeValidationResult({ valid: false, reasonCode: 'MILESTONE_GATE_SKIPPED', checks: [] }),
      'USDC',
      PRIMARY_HORIZON,
      TEST_ADDRESS,
    );
    const tb007 = resultsFor(sarif, 'TB007');
    expect(tb007).toHaveLength(1);
    expect(tb007[0].level).toBe('warning');
    expect(tb007[0].message.text).toContain('milestone');
  });

  it('adds a TB008 warning when clawback is enabled but strict mode did not block', () => {
    const sarif = buildSarifOutput(
      makeValidationResult({ clawbackEnabled: true }),
      'USDC',
      PRIMARY_HORIZON,
      TEST_ADDRESS,
    );
    const tb008 = resultsFor(sarif, 'TB008');
    expect(tb008).toHaveLength(1);
    expect(tb008[0].level).toBe('warning');
    expect(tb008[0].message.text).toContain('clawback_strict_mode');
  });

  it('reports a strict-mode clawback block under TB005 only, without a TB008 advisory', () => {
    const sarif = buildSarifOutput(
      makeValidationResult({
        valid: false,
        clawbackEnabled: true,
        checks: [
          { passed: true, label: 'Account funded', detail: 'ok' },
          { passed: false, label: 'USDC clawback safety', detail: 'blocked by clawback_strict_mode' },
        ],
      }),
      'USDC',
      PRIMARY_HORIZON,
      TEST_ADDRESS,
    );
    expect(resultsFor(sarif, 'TB005')).toHaveLength(1);
    expect(resultsFor(sarif, 'TB005')[0].level).toBe('error');
    expect(resultsFor(sarif, 'TB008')).toHaveLength(0);
  });

  it('reports an unauthorized trustline under TB006 when the policy is fail', () => {
    const sarif = buildSarifOutput(
      makeValidationResult({
        valid: false,
        trustlineAuthorized: false,
        unauthorizedTrustlinePolicy: 'fail',
        reasonCode: 'TRUSTLINE_UNAUTHORIZED',
        checks: [
          { passed: false, label: 'USDC trustline', detail: 'not authorized by the issuer' },
        ],
      }),
      'USDC',
      PRIMARY_HORIZON,
      TEST_ADDRESS,
    );
    const tb006 = resultsFor(sarif, 'TB006');
    expect(tb006).toHaveLength(1);
    expect(tb006[0].level).toBe('error');
  });

  it('keeps distinct messages when several failures share one rule id', () => {
    const sarif = buildSarifOutput(
      makeValidationResult({
        valid: false,
        checks: [
          { passed: false, label: 'USDC trustline', detail: 'Primary USDC trustline missing.' },
          { passed: false, label: 'EURC trustline (extra)', detail: 'Extra EURC trustline missing.' },
        ],
      }),
      'USDC',
      PRIMARY_HORIZON,
      TEST_ADDRESS,
    );
    const tb002 = resultsFor(sarif, 'TB002');
    expect(tb002).toHaveLength(2);
    expect(new Set(tb002.map((r) => r.message.text)).size).toBe(2);
  });

  it('emits no TB006–TB010 results for a clean run', () => {
    const sarif = buildSarifOutput(makeValidationResult(), 'USDC', PRIMARY_HORIZON, TEST_ADDRESS);
    const ids = sarifResults(sarif).map((r) => r.ruleId);
    for (const id of ['TB006', 'TB007', 'TB008', 'TB009', 'TB010']) {
      expect(ids).not.toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #679 — SARIF 2.1.0 JSON Schema validation
// ---------------------------------------------------------------------------

function validSarif(overrides: Partial<ValidationResult> = {}): any {
  return JSON.parse(
    JSON.stringify(
      buildSarifOutput(makeValidationResult(overrides), 'USDC', PRIMARY_HORIZON, TEST_ADDRESS),
    ),
  );
}

describe('vendored SARIF 2.1.0 schema (Issue #679)', () => {
  it('is pinned under schemas/ and loads without a network fetch', () => {
    const schemaPath = path.join(__dirname, '..', 'schemas', SARIF_SCHEMA_FILE);
    expect(fs.existsSync(schemaPath)).toBe(true);

    const schema = loadSarifJsonSchema() as any;
    expect(schema.properties.version.enum).toEqual(['2.1.0']);
    expect(schema.required).toEqual(['version', 'runs']);
    expect(schema.definitions.run).toBeDefined();
  });

  it('only uses keywords the bundled validator enforces or can ignore', () => {
    const known = new Set<string>([...SUPPORTED_SCHEMA_KEYWORDS, ...ANNOTATION_SCHEMA_KEYWORDS]);
    const unknown = new Set<string>();

    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (!known.has(key)) unknown.add(key);
        if (key === 'properties' || key === 'definitions') {
          Object.values(value as Record<string, unknown>).forEach(walk);
        } else if (key !== 'enum' && key !== 'default' && key !== 'required') {
          walk(value);
        }
      }
    };
    walk(loadSarifJsonSchema());

    expect([...unknown]).toEqual([]);
  });
});

describe('validateSarifSchema (Issue #679)', () => {
  it('accepts the SARIF produced by buildSarifOutput for passing and failing runs', () => {
    const fixtures = [
      validSarif(),
      validSarif({ clawbackEnabled: true }),
      validSarif({ valid: false, reasonCode: 'MILESTONE_GATE_SKIPPED', checks: [] }),
      JSON.parse(
        JSON.stringify(
          buildSarifOutput(
            rateBudgetExhaustedResult('budget exhausted', CHECK_CONFIG),
            'USDC',
            PRIMARY_HORIZON,
            TEST_ADDRESS,
          ),
        ),
      ),
      JSON.parse(
        JSON.stringify(
          buildSarifOutput(
            circuitOpenFailureResult('circuit open', CHECK_CONFIG),
            'USDC',
            PRIMARY_HORIZON,
            TEST_ADDRESS,
          ),
        ),
      ),
    ];
    for (const sarif of fixtures) {
      expect(getSarifSchemaErrors(sarif)).toEqual([]);
      expect(validateSarifSchema(sarif)).toBe(true);
    }
  });

  it('accepts the minimal upload document from buildSarifDocument', () => {
    const doc = JSON.parse(serialiseSarif(buildSarifDocument(makeOutcome({ accountFunded: false }))));
    expect(getSarifSchemaErrors(doc)).toEqual([]);
  });

  it('rejects non-objects', () => {
    expect(validateSarifSchema(null)).toBe(false);
    expect(validateSarifSchema('{}')).toBe(false);
    expect(validateSarifSchema([])).toBe(false);
  });

  it('rejects a document without runs', () => {
    const sarif = validSarif();
    delete sarif.runs;
    expect(getSarifSchemaErrors(sarif)).toContain('$: missing required property "runs"');
  });

  it('rejects a wrong SARIF version', () => {
    const sarif = validSarif();
    sarif.version = '2.0.0';
    expect(validateSarifSchema(sarif)).toBe(false);
    expect(getSarifSchemaErrors(sarif).some((e) => e.startsWith('$.version'))).toBe(true);
  });

  it('rejects a run without tool.driver', () => {
    const sarif = validSarif();
    delete sarif.runs[0].tool.driver;
    expect(getSarifSchemaErrors(sarif)).toContain('$.runs[0].tool: missing required property "driver"');
  });

  it('rejects a driver without a name', () => {
    const sarif = validSarif();
    delete sarif.runs[0].tool.driver.name;
    expect(getSarifSchemaErrors(sarif)).toContain(
      '$.runs[0].tool.driver: missing required property "name"',
    );
  });

  it('rejects driver.rules that is not an array', () => {
    const sarif = validSarif();
    sarif.runs[0].tool.driver.rules = { TB001: {} };
    expect(getSarifSchemaErrors(sarif)).toContain('$.runs[0].tool.driver.rules: must be of type array');
  });

  it('rejects a rule without an id and duplicate rules', () => {
    const missingId = validSarif();
    delete missingId.runs[0].tool.driver.rules[0].id;
    expect(getSarifSchemaErrors(missingId)).toContain(
      '$.runs[0].tool.driver.rules[0]: missing required property "id"',
    );

    const duplicate = validSarif();
    duplicate.runs[0].tool.driver.rules.push(duplicate.runs[0].tool.driver.rules[0]);
    expect(validateSarifSchema(duplicate)).toBe(false);
  });

  it('rejects an invalid result level and a result without a message', () => {
    const badLevel = validSarif();
    badLevel.runs[0].results[0].level = 'critical';
    expect(validateSarifSchema(badLevel)).toBe(false);

    const noMessage = validSarif();
    delete noMessage.runs[0].results[0].message;
    expect(getSarifSchemaErrors(noMessage)).toContain(
      '$.runs[0].results[0]: missing required property "message"',
    );
  });

  it('rejects a message with neither text nor id (anyOf)', () => {
    const sarif = validSarif();
    sarif.runs[0].results[0].message = {};
    expect(getSarifSchemaErrors(sarif)).toContain(
      '$.runs[0].results[0].message: must match at least one schema in anyOf',
    );
  });

  it('rejects unknown top-level and result properties (additionalProperties: false)', () => {
    const topLevel = validSarif();
    topLevel.extra = true;
    expect(getSarifSchemaErrors(topLevel)).toContain('$: unexpected property "extra"');

    const result = validSarif();
    result.runs[0].results[0].severity = 'high';
    expect(getSarifSchemaErrors(result)).toContain('$.runs[0].results[0]: unexpected property "severity"');
  });

  it('rejects a non-URI helpUri', () => {
    const sarif = validSarif();
    sarif.runs[0].tool.driver.rules[0].helpUri = 'not a uri';
    expect(validateSarifSchema(sarif)).toBe(false);
  });

  it('allows arbitrary keys inside property bags', () => {
    const sarif = validSarif();
    sarif.runs[0].properties.githubAddedField = { nested: [1, 2, 3] };
    expect(validateSarifSchema(sarif)).toBe(true);
  });

  it('validates a large run quickly', () => {
    const many = Array.from({ length: 2000 }, (_, i) => ({
      passed: i % 2 === 0,
      label: i % 2 === 0 ? 'XLM reserve' : 'USDC trustline',
      detail: `check ${i}`,
    }));
    const sarif = validSarif({ checks: many });
    const started = Date.now();
    expect(validateSarifSchema(sarif)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('writeSarifFile (Issue #679)', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'trustbridge-sarif-'));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('writes a schema-valid SARIF file under the workspace', () => {
    const sarif = buildSarifOutput(makeValidationResult(), 'USDC', PRIMARY_HORIZON, TEST_ADDRESS);
    const written = writeSarifFile(sarif, 'reports/trustbridge.sarif', workspace);

    expect(written).toBe(path.join(workspace, 'reports', 'trustbridge.sarif'));
    const parsed = JSON.parse(fs.readFileSync(written, 'utf8'));
    expect(validateSarifSchema(parsed)).toBe(true);
  });

  it('throws SarifValidationError and writes nothing when the document is invalid', () => {
    const sarif = buildSarifOutput(makeValidationResult(), 'USDC', PRIMARY_HORIZON, TEST_ADDRESS);
    delete ((sarif.runs as any[])[0].tool as any).driver;

    expect(() => writeSarifFile(sarif, 'trustbridge.sarif', workspace)).toThrow(SarifValidationError);
    expect(fs.existsSync(path.join(workspace, 'trustbridge.sarif'))).toBe(false);

    try {
      writeSarifFile(sarif, 'trustbridge.sarif', workspace);
    } catch (error) {
      expect((error as SarifValidationError).violations).toContain(
        '$.runs[0].tool: missing required property "driver"',
      );
      expect((error as Error).message).toContain('SARIF 2.1.0 schema validation');
    }
  });

  it('refuses paths that escape the workspace', () => {
    const sarif = buildSarifOutput(makeValidationResult(), 'USDC', PRIMARY_HORIZON, TEST_ADDRESS);
    expect(() => writeSarifFile(sarif, '../outside.sarif', workspace)).toThrow(/inside the workspace/);
  });
});
