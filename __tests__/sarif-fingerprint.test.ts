/**
 * Issue #893 — SARIF fingerprint stability across `reason_code` renames.
 *
 * `partialFingerprints['trustbridge/v1']` is the identity GitHub code scanning
 * (GHAS) uses to decide whether two runs report the *same* finding. Wave orgs
 * gate payout readiness on those code-scanning histories, so the contract is:
 *
 *   1. message text may change freely — wording, account address, balances,
 *      Horizon URL, tool version — and the fingerprint must stay the same, so
 *      a cosmetic diff never re-opens an alert;
 *   2. a `reason_code` change (including a rename in the frozen catalog at
 *      `src/reasonCodes.ts`) must move the fingerprint, because the finding is
 *      genuinely different;
 *   3. the inputs are exactly `ruleId` + `checkLabel` + `assetCode` +
 *      `reasonCode` — nothing else.
 *
 * `__tests__/__golden__/sarif-fingerprints.json` locks concrete values so an
 * accidental change to the algorithm fails CI instead of silently rewriting
 * every open alert downstream. Regenerate it deliberately with:
 *
 *   node -e "const c=require('crypto');console.log(c.createHash('sha256')
 *     .update(['TB002','USDC trustline','USDC','TRUSTLINE_MISSING'].join('\u0000'))
 *     .digest('hex').slice(0,32))"
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  SARIF_FINGERPRINT_KEY,
  buildSarifDocument,
  buildSarifOutput,
  computeSarifFingerprint,
  getSarifSchemaErrors,
  sarifPartialFingerprints,
  sarifRunReasonCode,
  serialiseSarif,
  validateSarifSchema,
  type SarifFingerprintInputs,
  type TrustBridgeCheckOutcome,
} from '../src/sarif';
import type { CheckResultItem, ValidationResult } from '../src/checks';
import type { ReasonCode } from '../src/reasonCodes';

const GOLDEN_PATH = path.join(__dirname, '__golden__', 'sarif-fingerprints.json');

const ADDRESS_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const ADDRESS_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const HORIZON = 'https://horizon.stellar.org';
const HORIZON_FALLBACK = 'https://horizon-fallback.stellar.org';

interface GoldenInputCase {
  name: string;
  inputs: SarifFingerprintInputs;
  fingerprint: string;
}

interface GoldenFile {
  issue: number;
  key: string;
  algorithm: string;
  fingerprints: GoldenInputCase[];
  document: {
    name: string;
    assetCode: string;
    reasonCode: string;
    results: Array<{ checkLabel: string; fingerprint: string }>;
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function check(label: string, detail: string, passed: boolean): CheckResultItem {
  return { label, detail, passed };
}

/** A failing `USDC trustline` run — the shape Wave payout gates block on. */
function makeResult(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    valid: false,
    accountFunded: true,
    trustlineExists: false,
    xlmBalance: '1.5000000',
    xlmReserveMet: true,
    checks: [
      check('Account funded', `Account ${ADDRESS_A} is funded and active.`, true),
      check('USDC trustline', 'Trustline for USDC is missing.', false),
      check('XLM reserve', 'XLM balance meets the minimum reserve requirement.', true),
    ],
    ...overrides,
  };
}

function makeOutcome(overrides: Partial<TrustBridgeCheckOutcome> = {}): TrustBridgeCheckOutcome {
  return {
    horizonUrl: HORIZON,
    stellarAddress: ADDRESS_A,
    accountFunded: true,
    trustlineExists: true,
    xlmReserveMet: true,
    assetCode: 'USDC',
    ...overrides,
  };
}

interface ResultRow {
  ruleId: string;
  checkLabel: string;
  fingerprint: string;
  level: string;
}

function rows(sarif: Record<string, unknown>): ResultRow[] {
  const runs = sarif.runs as Array<{ results: Array<Record<string, any>> }>;
  return runs[0].results.map((result) => ({
    ruleId: result.ruleId,
    checkLabel: result.properties?.checkLabel ?? '',
    fingerprint: result.partialFingerprints?.[SARIF_FINGERPRINT_KEY],
    level: result.level,
  }));
}

/** The fingerprint sequence in document order — what GHAS matches across runs. */
function fingerprintsOf(sarif: Record<string, unknown>): string[] {
  return rows(sarif).map((row) => row.fingerprint);
}

function fingerprintForLabel(sarif: Record<string, unknown>, label: string): string {
  const row = rows(sarif).find((candidate) => candidate.checkLabel === label);
  if (!row) throw new Error(`no SARIF result labelled "${label}"`);
  return row.fingerprint;
}

// ---------------------------------------------------------------------------
// Algorithm contract
// ---------------------------------------------------------------------------

describe('computeSarifFingerprint: documented algorithm (Issue #893)', () => {
  const inputs: SarifFingerprintInputs = {
    ruleId: 'TB002',
    checkLabel: 'USDC trustline',
    assetCode: 'USDC',
    reasonCode: 'TRUSTLINE_MISSING',
  };

  it('publishes the versioned partialFingerprints key', () => {
    expect(SARIF_FINGERPRINT_KEY).toBe('trustbridge/v1');
  });

  it('is sha256 over NUL-joined inputs, truncated to 32 hex chars', () => {
    // Re-derived here, independently of src/sarif.ts, so a change to the
    // algorithm or to the input list fails on the contract itself rather than
    // only on the golden file.
    const expected = crypto
      .createHash('sha256')
      .update(['TB002', 'USDC trustline', 'USDC', 'TRUSTLINE_MISSING'].join('\u0000'), 'utf8')
      .digest('hex')
      .slice(0, 32);

    expect(computeSarifFingerprint(inputs)).toBe(expected);
    expect(computeSarifFingerprint(inputs)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('separates fields with NUL so boundaries cannot be forged', () => {
    expect(
      computeSarifFingerprint({ ruleId: 'a', checkLabel: 'bc', assetCode: 'd', reasonCode: 'e' }),
    ).not.toBe(
      computeSarifFingerprint({ ruleId: 'ab', checkLabel: 'c', assetCode: 'd', reasonCode: 'e' }),
    );
  });

  it('wraps the digest under the versioned key', () => {
    expect(sarifPartialFingerprints(inputs)).toEqual({
      [SARIF_FINGERPRINT_KEY]: computeSarifFingerprint(inputs),
    });
  });

  it('is deterministic for repeated calls', () => {
    expect(computeSarifFingerprint(inputs)).toBe(computeSarifFingerprint({ ...inputs }));
  });
});

// ---------------------------------------------------------------------------
// Stability — message text is not an input
// ---------------------------------------------------------------------------

describe('stability: message text never moves a fingerprint', () => {
  it('keeps every fingerprint when only the wording changes', () => {
    const before = buildSarifOutput(makeResult(), 'USDC', HORIZON, ADDRESS_A);
    const after = buildSarifOutput(
      makeResult({
        checks: [
          check('Account funded', 'The account exists and is activated on-chain.', true),
          check('USDC trustline', 'No trustline was found for this asset.', false),
          check('XLM reserve', 'The reserve requirement is satisfied.', true),
        ],
      }),
      'USDC',
      HORIZON,
      ADDRESS_A,
    );

    expect(fingerprintsOf(after)).toEqual(fingerprintsOf(before));
  });

  it('keeps every fingerprint when the account address changes', () => {
    const before = buildSarifOutput(makeResult(), 'USDC', HORIZON, ADDRESS_A);
    const after = buildSarifOutput(
      makeResult({
        checks: [
          check('Account funded', `Account ${ADDRESS_B} is funded and active.`, true),
          check('USDC trustline', `Trustline for USDC is missing on ${ADDRESS_B}.`, false),
          check('XLM reserve', 'XLM balance meets the minimum reserve requirement.', true),
        ],
      }),
      'USDC',
      HORIZON,
      ADDRESS_B,
    );

    expect(fingerprintsOf(after)).toEqual(fingerprintsOf(before));
  });

  it('keeps every fingerprint when the Horizon endpoint changes', () => {
    const before = buildSarifOutput(makeResult(), 'USDC', HORIZON, ADDRESS_A);
    const after = buildSarifOutput(makeResult(), 'USDC', HORIZON_FALLBACK, ADDRESS_A);

    expect(fingerprintsOf(after)).toEqual(fingerprintsOf(before));
  });

  it('keeps every fingerprint when the tool version changes', () => {
    const before = buildSarifOutput(makeResult(), 'USDC', HORIZON, ADDRESS_A, '1.0.0');
    const after = buildSarifOutput(makeResult(), 'USDC', HORIZON, ADDRESS_A, '9.9.9');

    expect(fingerprintsOf(after)).toEqual(fingerprintsOf(before));
  });

  it('keeps the minimal document fingerprints across a changed address', () => {
    const before = buildSarifDocument(makeOutcome({ stellarAddress: ADDRESS_A }));
    const after = buildSarifDocument(makeOutcome({ stellarAddress: ADDRESS_B }));

    expect(rows(after as unknown as Record<string, unknown>).map((r) => r.fingerprint)).toEqual(
      rows(before as unknown as Record<string, unknown>).map((r) => r.fingerprint),
    );
  });

  it('keeps the home domain fingerprint across a changed domain value', () => {
    const before = buildSarifDocument(
      makeOutcome({
        homeDomain: {
          outcome: 'mismatch',
          mode: 'strict',
          actualHomeDomain: 'evil.example',
          expectedHomeDomain: 'centre.io',
        },
      }),
    );
    const after = buildSarifDocument(
      makeOutcome({
        homeDomain: {
          outcome: 'mismatch',
          mode: 'strict',
          actualHomeDomain: 'other.example',
          expectedHomeDomain: 'centre.io',
        },
      }),
    );

    // The minimal document carries no `properties.checkLabel`, so the TB004
    // result is located by its stable rule id.
    const pick = (doc: SarifDocument) =>
      doc.runs[0].results.find((result) => result.ruleId === 'TB004')?.partialFingerprints?.[
        SARIF_FINGERPRINT_KEY
      ];

    expect(pick(after)).toBeDefined();
    expect(pick(after)).toBe(pick(before));
  });
});

// ---------------------------------------------------------------------------
// Sensitivity — reason_code is an input
// ---------------------------------------------------------------------------

describe('sensitivity: reason_code changes move every fingerprint', () => {
  it('moves all fingerprints when the run reason code changes', () => {
    const missing = buildSarifOutput(
      makeResult({ reasonCode: 'TRUSTLINE_MISSING' }),
      'USDC',
      HORIZON,
      ADDRESS_A,
    );
    const tooLow = buildSarifOutput(
      makeResult({ reasonCode: 'RESERVE_TOO_LOW' }),
      'USDC',
      HORIZON,
      ADDRESS_A,
    );

    const before = fingerprintsOf(missing);
    const after = fingerprintsOf(tooLow);
    expect(after).not.toEqual(before);
    after.forEach((fingerprint, index) => expect(fingerprint).not.toBe(before[index]));
  });

  it('moves all fingerprints across a reason_code rename', () => {
    // A catalog rename is a deliberate identity break: the old and new
    // spellings cannot both live in the frozen `ReasonCode` union, so the
    // renamed spelling is cast to model a future catalog.
    const before = buildSarifOutput(
      makeResult({ reasonCode: 'TRUSTLINE_MISSING' }),
      'USDC',
      HORIZON,
      ADDRESS_A,
    );
    const after = buildSarifOutput(
      makeResult({ reasonCode: 'TRUSTLINE_MISSING_RENAMED' as ReasonCode }),
      'USDC',
      HORIZON,
      ADDRESS_A,
    );

    const beforeFingerprints = fingerprintsOf(before);
    const afterFingerprints = fingerprintsOf(after);
    expect(afterFingerprints).not.toEqual(beforeFingerprints);
    afterFingerprints.forEach((fingerprint, index) =>
      expect(fingerprint).not.toBe(beforeFingerprints[index]),
    );
  });

  it('does not depend on the diff between codes, only on their values', () => {
    const renamed = buildSarifOutput(
      makeResult({ reasonCode: 'TRUSTLINE_MISSING_RENAMED' as ReasonCode }),
      'USDC',
      HORIZON,
      ADDRESS_A,
    );
    const unrelated = buildSarifOutput(
      makeResult({ reasonCode: 'CLAWBACK_BLOCKED' }),
      'USDC',
      HORIZON,
      ADDRESS_A,
    );

    expect(fingerprintsOf(renamed)).not.toEqual(fingerprintsOf(unrelated));
  });

  it('normalises an unset reason code to SUCCESS / FAILED like the run properties', () => {
    expect(sarifRunReasonCode({ valid: true })).toBe('SUCCESS');
    expect(sarifRunReasonCode({ valid: false })).toBe('FAILED');
    expect(sarifRunReasonCode({ valid: false, reasonCode: 'HORIZON_ERROR' })).toBe('HORIZON_ERROR');
  });

  it('keeps a passing and a failing run apart when no code is set', () => {
    const passing = buildSarifOutput(
      makeResult({
        valid: true,
        trustlineExists: true,
        checks: [
          check('Account funded', 'Account is funded and active.', true),
          check('USDC trustline', 'Trustline for USDC is present.', true),
          check('XLM reserve', 'XLM balance meets the reserve.', true),
        ],
      }),
      'USDC',
      HORIZON,
      ADDRESS_A,
    );
    const failing = buildSarifOutput(makeResult(), 'USDC', HORIZON, ADDRESS_A);

    expect(fingerprintsOf(passing)).not.toEqual(fingerprintsOf(failing));
  });

  it('uses the run reason code on the TB007 milestone finding', () => {
    const sarif = buildSarifOutput(
      makeResult({ reasonCode: 'MILESTONE_GATE_SKIPPED' }),
      'USDC',
      HORIZON,
      ADDRESS_A,
    );
    const tb007 = rows(sarif).find((row) => row.ruleId === 'TB007');

    expect(tb007?.checkLabel).toBe('Milestone gate');
    expect(tb007?.fingerprint).toBe(
      computeSarifFingerprint({
        ruleId: 'TB007',
        checkLabel: 'Milestone gate',
        assetCode: 'USDC',
        reasonCode: 'MILESTONE_GATE_SKIPPED',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

describe('failure paths', () => {
  it('keeps two TB002 findings apart when one rule id covers several checks', () => {
    const sarif = buildSarifOutput(
      makeResult({
        reasonCode: 'TRUSTLINE_MISSING',
        checks: [
          check('Account funded', 'Account is funded and active.', true),
          check('USDC trustline', 'Trustline for USDC is missing.', false),
          check('extra trustline', 'assets_json trustline is missing.', false),
        ],
      }),
      'USDC',
      HORIZON,
      ADDRESS_A,
    );

    const tb002 = rows(sarif).filter((row) => row.ruleId === 'TB002');
    expect(tb002).toHaveLength(2);
    expect(fingerprintForLabel(sarif, 'USDC trustline')).not.toBe(
      fingerprintForLabel(sarif, 'extra trustline'),
    );
  });

  it('keeps two TB000 fallback findings apart', () => {
    const sarif = buildSarifOutput(
      makeResult({
        reasonCode: 'FAILED',
        checks: [
          check('Account funded', 'Account is funded and active.', true),
          check('SEP-0001 home domain', 'Issuer home_domain does not match.', false),
          check('Claimable balances', 'Claimable balances could not be read.', false),
        ],
      }),
      'USDC',
      HORIZON,
      ADDRESS_A,
    );

    expect(rows(sarif).filter((row) => row.ruleId === 'TB000')).toHaveLength(2);
    expect(fingerprintForLabel(sarif, 'SEP-0001 home domain')).not.toBe(
      fingerprintForLabel(sarif, 'Claimable balances'),
    );
  });

  it('stays deterministic for empty or whitespace-only inputs instead of throwing', () => {
    const empty = computeSarifFingerprint({
      ruleId: '',
      checkLabel: '',
      assetCode: '',
      reasonCode: '',
    });

    expect(empty).toMatch(/^[0-9a-f]{32}$/);
    expect(
      computeSarifFingerprint({ ruleId: '', checkLabel: '', assetCode: '', reasonCode: '' }),
    ).toBe(empty);
    // A whitespace-only label is malformed but must not collide with an empty
    // one — otherwise two broken checks would collapse onto one alert.
    expect(
      computeSarifFingerprint({
        ruleId: 'TB002',
        checkLabel: '  ',
        assetCode: 'USDC',
        reasonCode: 'TRUSTLINE_MISSING',
      }),
    ).not.toBe(
      computeSarifFingerprint({
        ruleId: 'TB002',
        checkLabel: '',
        assetCode: 'USDC',
        reasonCode: 'TRUSTLINE_MISSING',
      }),
    );
  });

  it('omits no result and throws no error when a check set is empty', () => {
    const sarif = buildSarifOutput(
      makeResult({ checks: [], valid: false, reasonCode: 'ACCOUNT_NOT_FUNDED' }),
      'USDC',
      HORIZON,
      ADDRESS_A,
    );

    expect(rows(sarif)).toEqual([]);
  });

  it('is idempotent across repeated builds, ignoring the run timestamp', () => {
    const first = buildSarifOutput(
      makeResult({ reasonCode: 'TRUSTLINE_MISSING' }),
      'USDC',
      HORIZON,
      ADDRESS_A,
    );
    const second = buildSarifOutput(
      makeResult({ reasonCode: 'TRUSTLINE_MISSING' }),
      'USDC',
      HORIZON,
      ADDRESS_A,
    );

    const properties = (first.runs as Array<{ properties: Record<string, unknown> }>)[0].properties;
    expect(properties.runTimestamp).toBeDefined();
    expect(fingerprintsOf(second)).toEqual(fingerprintsOf(first));
  });
});

// ---------------------------------------------------------------------------
// sarifSchema.ts consistency — the emitted shape still validates
// ---------------------------------------------------------------------------

describe('emitted fingerprints stay SARIF 2.1.0 schema-valid', () => {
  it('accepts partialFingerprints on the full document', () => {
    const sarif = buildSarifOutput(
      makeResult({ reasonCode: 'TRUSTLINE_MISSING' }),
      'USDC',
      HORIZON,
      ADDRESS_A,
    );

    expect(getSarifSchemaErrors(sarif)).toEqual([]);
    expect(validateSarifSchema(sarif)).toBe(true);
  });

  it('accepts partialFingerprints on the minimal document', () => {
    const minimal = JSON.parse(
      serialiseSarif(buildSarifDocument(makeOutcome())),
    ) as Record<string, unknown>;

    expect(validateSarifSchema(minimal)).toBe(true);
  });

  it('rejects a fingerprint value that is not a string', () => {
    const sarif = buildSarifOutput(
      makeResult({ reasonCode: 'TRUSTLINE_MISSING' }),
      'USDC',
      HORIZON,
      ADDRESS_A,
    );
    const result = (sarif.runs as Array<{ results: Array<Record<string, unknown>> }>)[0]
      .results[0];
    result.partialFingerprints = { [SARIF_FINGERPRINT_KEY]: 42 };

    expect(getSarifSchemaErrors(sarif).join('\n')).toMatch(/partialFingerprints/);
  });

  it('rejects a fingerprint bag that is not an object', () => {
    const sarif = buildSarifOutput(
      makeResult({ reasonCode: 'TRUSTLINE_MISSING' }),
      'USDC',
      HORIZON,
      ADDRESS_A,
    );
    const result = (sarif.runs as Array<{ results: Array<Record<string, unknown>> }>)[0]
      .results[0];
    result.partialFingerprints = 'trustbridge/v1';

    expect(getSarifSchemaErrors(sarif).join('\n')).toMatch(/partialFingerprints/);
  });
});

// ---------------------------------------------------------------------------
// Golden file
// ---------------------------------------------------------------------------

describe('golden fingerprints (Issue #893)', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as GoldenFile;

  it('golden file is present, versioned and well-formed', () => {
    expect(fs.existsSync(GOLDEN_PATH)).toBe(true);
    expect(golden.issue).toBe(893);
    expect(golden.key).toBe(SARIF_FINGERPRINT_KEY);
    expect(golden.algorithm).toContain('sha256');
    expect(golden.fingerprints.length).toBeGreaterThan(0);
  });

  it.each(golden.fingerprints)('matches the golden value for $name', ({ inputs, fingerprint }) => {
    expect(computeSarifFingerprint(inputs)).toBe(fingerprint);
  });

  it('matches the golden fingerprints for a full trustline-missing document', () => {
    const sarif = buildSarifOutput(
      makeResult({ reasonCode: golden.document.reasonCode as ReasonCode }),
      golden.document.assetCode,
      HORIZON,
      ADDRESS_A,
    );

    expect(
      rows(sarif).map((row) => ({ checkLabel: row.checkLabel, fingerprint: row.fingerprint })),
    ).toEqual(golden.document.results);
  });

  it('locks the reason_code rename pair to the same inputs and different values', () => {
    const before = golden.fingerprints.find((entry) => entry.name === 'tb002-trustline-missing');
    const after = golden.fingerprints.find(
      (entry) => entry.name === 'tb002-trustline-missing-renamed',
    );

    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after?.inputs).toEqual({ ...before?.inputs, reasonCode: 'TRUSTLINE_MISSING_RENAMED' });
    expect(after?.fingerprint).not.toBe(before?.fingerprint);
  });

  it('fails the comparison when an input drifts without updating the golden', () => {
    const entry = golden.fingerprints[0];

    expect(
      computeSarifFingerprint({ ...entry.inputs, reasonCode: `${entry.inputs.reasonCode}_DRIFT` }),
    ).not.toBe(entry.fingerprint);
  });
});
