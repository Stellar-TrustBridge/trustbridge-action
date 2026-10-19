import {
  buildSarifRules,
  buildSarifOutput,
  buildBatchSarifOutput,
  serializeSarif,
  validateSarifSchema,
  checkToSarifLevel,
  checkLabelToRuleId,
  checkToSarifResult,
} from '../src/sarif';
import { ValidationResult, CheckResultItem, runAccountChecks } from '../src/checks';
import { HorizonAccount } from '../src/horizon';

describe('SARIF output generation', () => {
  const mockValidationResult: ValidationResult = {
    valid: false,
    accountFunded: false,
    trustlineExists: false,
    xlmBalance: '0',
    xlmReserveMet: false,
    checks: [
      {
        passed: false,
        label: 'Account funded',
        detail: 'Account was not found on Horizon.',
      },
      {
        passed: false,
        label: 'USDC trustline',
        detail: 'Cannot verify trustline until the account exists.',
      },
      {
        passed: false,
        label: 'XLM reserve',
        detail: 'Cannot verify XLM balance.',
      },
    ],
  };

  describe('buildSarifRules', () => {
    it('returns an array of SARIF rule definitions', () => {
      const rules = buildSarifRules();
      expect(Array.isArray(rules)).toBe(true);
      expect(rules.length).toBeGreaterThan(0);
    });

    it('includes rules for all check types', () => {
      const rules = buildSarifRules();
      const ruleIds = rules.map((r) => r.id);
      expect(ruleIds).toContain('TB001'); // Account funded
      expect(ruleIds).toContain('TB002'); // Trustline
      expect(ruleIds).toContain('TB003'); // XLM reserve
      expect(ruleIds).toContain('TB004'); // Horizon availability
      expect(ruleIds).toContain('TB005'); // Clawback safety
    });

    it('each rule has required fields', () => {
      const rules = buildSarifRules();
      for (const rule of rules) {
        expect(rule.id).toBeDefined();
        expect(rule.shortDescription).toBeDefined();
        expect(rule.shortDescription.text).toBeDefined();
      }
    });

    it('includes help URIs for documentation', () => {
      const rules = buildSarifRules();
      for (const rule of rules) {
        if (rule.id !== 'TB000') {
          expect(rule.helpUri).toBeDefined();
          expect(rule.helpUri).toMatch(/^https:\/\//);
        }
      }
    });
  });

  describe('checkToSarifLevel', () => {
    it('returns "note" for passed checks', () => {
      const check: CheckResultItem = {
        passed: true,
        label: 'Account funded',
        detail: 'Account is active.',
      };
      expect(checkToSarifLevel(check)).toBe('note');
    });

    it('returns "error" for failed checks', () => {
      const check: CheckResultItem = {
        passed: false,
        label: 'Account funded',
        detail: 'Account was not found.',
      };
      expect(checkToSarifLevel(check)).toBe('error');
    });
  });

  describe('checkLabelToRuleId', () => {
    it('maps "Account funded" to TB001', () => {
      expect(checkLabelToRuleId('Account funded')).toBe('TB001');
    });

    it('maps trustline checks to TB002', () => {
      expect(checkLabelToRuleId('USDC trustline')).toBe('TB002');
      expect(checkLabelToRuleId('EUR trustline')).toBe('TB002');
    });

    it('maps "XLM reserve" to TB003', () => {
      expect(checkLabelToRuleId('XLM reserve')).toBe('TB003');
    });

    it('maps "Horizon availability" to TB004', () => {
      expect(checkLabelToRuleId('Horizon availability')).toBe('TB004');
    });

    it('maps clawback checks to TB005', () => {
      expect(checkLabelToRuleId('USDC clawback safety')).toBe('TB005');
    });

    it('returns TB000 for unknown labels', () => {
      expect(checkLabelToRuleId('Unknown check')).toBe('TB000');
    });
  });

  describe('checkToSarifResult', () => {
    it('converts a check to a SARIF result', () => {
      const check: CheckResultItem = {
        passed: false,
        label: 'Account funded',
        detail: 'Account was not found.',
      };
      const result = checkToSarifResult(
        check,
        'USDC',
        'https://horizon.stellar.org',
        'GABC...XYZ',
      ) as unknown as { ruleId: string; level: string; message: { text: string } };
      expect(result.ruleId).toBe('TB001');
      expect(result.level).toBe('error');
      expect(result.message.text).toBe('Account was not found.');
    });

    it('includes location information', () => {
      const check: CheckResultItem = {
        passed: false,
        label: 'Account funded',
        detail: 'Account was not found.',
      };
      const result = checkToSarifResult(
        check,
        'USDC',
        'https://horizon.stellar.org',
        'GABC...XYZ',
      ) as unknown as {
        locations: Array<{ physicalLocation: unknown }>;
      };
      expect(result.locations).toBeDefined();
      expect(result.locations[0].physicalLocation).toBeDefined();
    });

    it('includes custom properties', () => {
      const check: CheckResultItem = {
        passed: true,
        label: 'USDC trustline',
        detail: 'Trustline is configured.',
      };
      const result = checkToSarifResult(
        check,
        'USDC',
        'https://horizon.stellar.org',
        'GABC...XYZ',
      ) as unknown as { properties: { assetCode: string; checkLabel: string; passed: boolean } };
      expect(result.properties.assetCode).toBe('USDC');
      expect(result.properties.checkLabel).toBe('USDC trustline');
      expect(result.properties.passed).toBe(true);
    });
  });

  describe('buildSarifOutput', () => {
    it('returns a valid SARIF 2.1.0 structure', () => {
      const sarif = buildSarifOutput(
        mockValidationResult,
        'USDC',
        'https://horizon.stellar.org',
        'GABC...XYZ',
      );
      expect(sarif.version).toBe('2.1.0');
      const sarifStr = JSON.stringify(sarif);
      expect(sarifStr).toContain('sarif-schema-2.1.0');
      expect(Array.isArray((sarif as unknown as { runs: unknown[] }).runs)).toBe(true);
    });

    it('includes tool metadata', () => {
      const sarif = buildSarifOutput(
        mockValidationResult,
        'USDC',
        'https://horizon.stellar.org',
        'GABC...XYZ',
        '1.0.0',
      ) as unknown as {
        runs: Array<{ tool: { driver: { name: string; version: string; informationUri: string } } }>;
      };
      const tool = sarif.runs[0].tool.driver;
      expect(tool.name).toBe('TrustBridge Action');
      expect(tool.version).toBe('1.0.0');
      expect(tool.informationUri).toContain('trustbridge-action');
    });

    it('includes all rules', () => {
      const sarif = buildSarifOutput(
        mockValidationResult,
        'USDC',
        'https://horizon.stellar.org',
        'GABC...XYZ',
      ) as unknown as { runs: Array<{ tool: { driver: { rules: unknown[] } } }> };
      const rules = sarif.runs[0].tool.driver.rules;
      expect(rules.length).toBeGreaterThan(0);
    });

    it('converts checks to SARIF results', () => {
      const sarif = buildSarifOutput(
        mockValidationResult,
        'USDC',
        'https://horizon.stellar.org',
        'GABC...XYZ',
      ) as unknown as { runs: Array<{ results: unknown[] }> };
      const results = sarif.runs[0].results;
      expect(results.length).toBe(mockValidationResult.checks.length);
      expect(results[0]).toHaveProperty('ruleId', 'TB001');
      expect(results[0]).toHaveProperty('level', 'error');
    });

    it('includes validation gate summary', () => {
      const sarif = buildSarifOutput(
        mockValidationResult,
        'USDC',
        'https://horizon.stellar.org',
        'GABC...XYZ',
      ) as unknown as {
        runs: Array<{ properties: { validationGate: Record<string, unknown> } }>;
      };
      const gate = sarif.runs[0].properties.validationGate;
      expect(gate.ready).toBe(false);
      expect(gate.totalChecks).toBe(3);
      expect(gate.passedChecks).toBe(0);
      expect(gate.failedChecks).toBe(3);
    });

    it('handles mixed pass/fail results', () => {
      const mixedResult: ValidationResult = {
        valid: false,
        accountFunded: true,
        trustlineExists: false,
        xlmBalance: '5',
        xlmReserveMet: true,
        checks: [
          { passed: true, label: 'Account funded', detail: 'Account is active.' },
          { passed: false, label: 'USDC trustline', detail: 'No trustline.' },
          { passed: true, label: 'XLM reserve', detail: 'Balance is sufficient.' },
        ],
      };
      const sarif = buildSarifOutput(
        mixedResult,
        'USDC',
        'https://horizon.stellar.org',
        'GABC...XYZ',
      ) as unknown as { runs: Array<{ results: Array<{ level: string }> }> };
      const results = sarif.runs[0].results;
      expect(results.filter((r) => r.level === 'note').length).toBe(2);
      expect(results.filter((r) => r.level === 'error').length).toBe(1);
    });
  });

  describe('serializeSarif', () => {
    it('converts SARIF object to JSON string', () => {
      const sarif = buildSarifOutput(
        mockValidationResult,
        'USDC',
        'https://horizon.stellar.org',
        'GABC...XYZ',
      );
      const json = serializeSarif(sarif);
      expect(typeof json).toBe('string');
      expect(json).toContain('"version": "2.1.0"');
    });

    it('produces valid JSON', () => {
      const sarif = buildSarifOutput(
        mockValidationResult,
        'USDC',
        'https://horizon.stellar.org',
        'GABC...XYZ',
      );
      const json = serializeSarif(sarif);
      expect(() => JSON.parse(json)).not.toThrow();
    });

    it('includes proper formatting for readability', () => {
      const sarif = buildSarifOutput(
        mockValidationResult,
        'USDC',
        'https://horizon.stellar.org',
        'GABC...XYZ',
      );
      const json = serializeSarif(sarif);
      expect(json).toContain('\n');
      expect(json.split('\n').some((line: string) => line.startsWith('  '))).toBe(true);
    });
  });

  describe('validateSarifSchema', () => {
    it('validates a correct SARIF structure', () => {
      const sarif = buildSarifOutput(
        mockValidationResult,
        'USDC',
        'https://horizon.stellar.org',
        'GABC...XYZ',
      );
      expect(validateSarifSchema(sarif)).toBe(true);
    });

    it('rejects null or undefined', () => {
      expect(validateSarifSchema(null)).toBe(false);
      expect(validateSarifSchema(undefined)).toBe(false);
    });

    it('rejects non-object values', () => {
      expect(validateSarifSchema('not an object')).toBe(false);
      expect(validateSarifSchema(123)).toBe(false);
    });

    it('rejects wrong SARIF version', () => {
       
      const sarif: any = buildSarifOutput(
        mockValidationResult,
        'USDC',
        'https://horizon.stellar.org',
        'GABC...XYZ',
      );
      sarif.version = '2.0.0';
      expect(validateSarifSchema(sarif)).toBe(false);
    });

    it('rejects missing runs array', () => {
       
      const sarif: any = buildSarifOutput(
        mockValidationResult,
        'USDC',
        'https://horizon.stellar.org',
        'GABC...XYZ',
      );
      sarif.runs = [];
      expect(validateSarifSchema(sarif)).toBe(false);
    });

    it('rejects missing tool.driver', () => {
       
      const sarif: any = buildSarifOutput(
        mockValidationResult,
        'USDC',
        'https://horizon.stellar.org',
        'GABC...XYZ',
      );
      delete sarif.runs[0].tool;
      expect(validateSarifSchema(sarif)).toBe(false);
    });

    it('rejects missing results array', () => {
       
      const sarif: any = buildSarifOutput(
        mockValidationResult,
        'USDC',
        'https://horizon.stellar.org',
        'GABC...XYZ',
      );
      delete sarif.runs[0].results;
      expect(validateSarifSchema(sarif)).toBe(false);
    });
  });
});

describe('SARIF clawback findings (Issue #474)', () => {
  const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  const ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  const account: HorizonAccount = {
    id: ADDRESS,
    account_id: ADDRESS,
    sequence: '1',
    subentry_count: 1,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [
      { balance: '10.0000000', asset_type: 'native', buying_liabilities: '0.0000000', selling_liabilities: '0.0000000' },
      {
        balance: '100.0000000', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: ISSUER,
        buying_liabilities: '0.0000000', selling_liabilities: '0.0000000', is_clawback_enabled: true,
      },
    ],
  };

  it('emits the clawback check from runAccountChecks under stable rule TB005', async () => {
    const result = await runAccountChecks(account, {
      assetCode: 'USDC',
      assetIssuer: ISSUER,
      minXlmReserve: 1.5,
      clawbackStrictMode: true,
    });
    const sarif: any = buildSarifOutput(result, 'USDC', 'https://horizon.stellar.org', ADDRESS);
    const run = sarif.runs[0];

    const clawbackResult = run.results.find((r: any) => r.properties.checkLabel.includes('clawback'));
    expect(clawbackResult).toBeDefined();
    expect(clawbackResult.ruleId).toBe('TB005');
    expect(clawbackResult.level).toBe('error');
    expect(run.tool.driver.rules.map((r: any) => r.id)).toContain('TB005');
  });
});

describe('batch SARIF output (Issue #681)', () => {
  const ADDRESS_A = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  const ADDRESS_B = 'GBBD47IF6LWK2P7MDEVSCWR7DPUWV3NY3DTQEVFL4TWVC5GIOTASHEX2';

  it('produces a schema-valid document with one artifact per address', () => {
    const sarif: any = buildBatchSarifOutput(
      [
        {
          address: ADDRESS_A,
          valid: true,
          accountFunded: true,
          trustlineExists: true,
          xlmReserveMet: true,
        },
        {
          address: ADDRESS_B,
          valid: false,
          accountFunded: false,
          trustlineExists: false,
          xlmReserveMet: false,
          failureReason: 'Account was not found on Horizon.',
        },
      ],
      'USDC',
      'https://horizon.stellar.org',
    );

    expect(validateSarifSchema(sarif)).toBe(true);
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs).toHaveLength(1);

    const results = sarif.runs[0].results as any[];
    const uris = new Set(
      results.map((r) => r.locations[0].physicalLocation.artifactLocation.uri),
    );
    expect(uris).toEqual(
      new Set([
        `stellar-address/${ADDRESS_A}`,
        `stellar-address/${ADDRESS_B}`,
      ]),
    );

    // Every address contributes at least one result, and failures are errors.
    expect(results.some((r) => r.properties.stellarAddress === ADDRESS_A)).toBe(true);
    expect(
      results.some(
        (r) =>
          r.properties.stellarAddress === ADDRESS_B &&
          r.level === 'error' &&
          r.ruleId === 'TB001',
      ),
    ).toBe(true);
  });

  it('keeps duplicate rules distinct with stable partial fingerprints', () => {
    const entry = {
      address: ADDRESS_A,
      valid: false,
      accountFunded: false,
      trustlineExists: false,
      xlmReserveMet: false,
      failureReason: 'Account was not found on Horizon.',
    };
    const first: any = buildBatchSarifOutput([entry], 'USDC', 'https://h');
    const second: any = buildBatchSarifOutput([entry], 'USDC', 'https://h');

    const fingerprints = first.runs[0].results.map(
      (r: any) => r.partialFingerprints.trustbridgeFinding,
    );
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
    expect(
      second.runs[0].results.map(
        (r: any) => r.partialFingerprints.trustbridgeFinding,
      ),
    ).toEqual(fingerprints);
  });

  it('emits clawback findings attributed to the failing address', () => {
    const sarif: any = buildBatchSarifOutput(
      [
        {
          address: ADDRESS_A,
          valid: false,
          accountFunded: true,
          trustlineExists: true,
          xlmReserveMet: true,
          clawbackStrictAssets: [
            {
              assetCode: 'USDC',
              assetIssuer: 'GISSUER',
              detail: 'Asset issuer can claw back balances.',
            },
          ],
        },
      ],
      'USDC',
      'https://horizon.stellar.org',
    );

    const clawback = sarif.runs[0].results.find((r: any) =>
      r.properties.checkLabel.includes('clawback'),
    );
    expect(clawback).toBeDefined();
    expect(clawback.ruleId).toBe('TB005');
    expect(clawback.level).toBe('error');
    expect(clawback.locations[0].physicalLocation.artifactLocation.uri).toBe(
      `stellar-address/${ADDRESS_A}`,
    );
  });

  it('reports batch totals in run properties', () => {
    const sarif: any = buildBatchSarifOutput(
      [
        { address: ADDRESS_A, valid: true },
        { address: ADDRESS_B, valid: false },
      ],
      'USDC',
      'https://horizon.stellar.org',
    );

    expect(sarif.runs[0].properties.batch).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
    });
  });
});
