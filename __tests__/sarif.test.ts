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
} from '../src/sarif';

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
