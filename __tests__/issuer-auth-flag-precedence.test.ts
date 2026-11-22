/**
 * Issue #898 — issuer authorization flag precedence decision table.
 *
 * The table lives in three places that must agree:
 *   - `ISSUER_AUTH_FLAG_DECISION_TABLE` in src/assets.ts (code)
 *   - `__tests__/fixtures/issuer-auth-flag-decision-table.json` (fixture)
 *   - the "Issuer authorization flag decision table" section of docs/USAGE.md
 * and every row must produce the same reason code through the full
 * `runAccountChecks` pipeline in src/checks.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  ISSUER_AUTH_FLAG_DECISION_TABLE,
  ISSUER_AUTH_FLAG_PRECEDENCE,
  resolveIssuerAuthFlagVerdict,
  type IssuerAuthFlagDecisionRow,
  type IssuerAuthFlagState,
} from '../src/assets';
import { runAccountChecks } from '../src/checks';
import {
  makeHorizonAccount,
  TEST_HORIZON_ASSET_ISSUER,
} from './helpers/horizon-account';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'issuer-auth-flag-decision-table.json');
const USAGE_PATH = path.join(__dirname, '..', 'docs', 'USAGE.md');

const fixtureRows = (
  JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as { rows: IssuerAuthFlagDecisionRow[] }
).rows;

function accountFor(state: IssuerAuthFlagState) {
  return makeHorizonAccount({
    trustlines: state.trustlineExists
      ? [
          {
            assetCode: 'USDC',
            assetIssuer: TEST_HORIZON_ASSET_ISSUER,
            balance: '50.0000000',
            ...(state.trustlineAuthorized === undefined
              ? {}
              : { isAuthorized: state.trustlineAuthorized }),
            ...(state.clawbackEnabled === undefined
              ? {}
              : { isClawbackEnabled: state.clawbackEnabled }),
          },
        ]
      : [],
    flags: {
      auth_required: state.authRequired ?? false,
      auth_revocable: state.authRevocable ?? false,
      auth_immutable: state.authImmutable ?? false,
      auth_clawback_enabled: state.clawbackEnabled ?? false,
    },
  });
}

describe('issuer authorization flag decision table (#898)', () => {
  it('code table and JSON fixture are identical', () => {
    expect(JSON.parse(JSON.stringify(ISSUER_AUTH_FLAG_DECISION_TABLE))).toEqual(fixtureRows);
  });

  it('row ids are unique', () => {
    const ids = fixtureRows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every reason code in the table is covered by the documented precedence', () => {
    for (const row of fixtureRows) {
      expect(ISSUER_AUTH_FLAG_PRECEDENCE).toContain(row.reasonCode);
    }
    expect(ISSUER_AUTH_FLAG_PRECEDENCE).toEqual([
      'TRUSTLINE_MISSING',
      'TRUSTLINE_UNAUTHORIZED',
      'CLAWBACK_BLOCKED',
      'SUCCESS',
    ]);
  });

  it.each(fixtureRows.map((r) => [r.id, r] as const))(
    'resolver: %s',
    (_id, row) => {
      expect(resolveIssuerAuthFlagVerdict(row.state).reasonCode).toBe(row.reasonCode);
    },
  );

  it.each(fixtureRows.map((r) => [r.id, r] as const))(
    'runAccountChecks: %s',
    (_id, row) => {
      const result = runAccountChecks(accountFor(row.state), {
        assetCode: 'USDC',
        assetIssuer: TEST_HORIZON_ASSET_ISSUER,
        minXlmReserve: 1.5,
        unauthorizedTrustlinePolicy: row.state.unauthorizedTrustlinePolicy,
        clawbackStrictMode: row.state.clawbackStrictMode,
      });
      expect(result.reasonCode).toBe(row.reasonCode);
      expect(result.valid).toBe(row.reasonCode === 'SUCCESS');
    },
  );

  it('docs/USAGE.md lists every row id with its reason code', () => {
    const usage = fs.readFileSync(USAGE_PATH, 'utf8');
    for (const row of fixtureRows) {
      const line = usage.split('\n').find((l) => l.includes(`\`${row.id}\``));
      expect(line).toBeDefined();
      expect(line).toContain(`\`${row.reasonCode}\``);
    }
  });
});

describe('resolveIssuerAuthFlagVerdict', () => {
  it('happy path: authorized trustline with no flags is SUCCESS with no notes', () => {
    expect(
      resolveIssuerAuthFlagVerdict({ trustlineExists: true, trustlineAuthorized: true }),
    ).toEqual({
      reasonCode: 'SUCCESS',
      authorizationBlocks: false,
      clawbackBlocks: false,
      notes: [],
    });
  });

  it('failure path: authorization outranks clawback when both block', () => {
    const verdict = resolveIssuerAuthFlagVerdict({
      trustlineExists: true,
      trustlineAuthorized: false,
      clawbackEnabled: true,
      unauthorizedTrustlinePolicy: 'fail',
      clawbackStrictMode: true,
    });
    expect(verdict.reasonCode).toBe('TRUSTLINE_UNAUTHORIZED');
    expect(verdict.authorizationBlocks).toBe(true);
    expect(verdict.clawbackBlocks).toBe(true);
  });

  it('failure path: missing trustline ignores every trustline flag', () => {
    const verdict = resolveIssuerAuthFlagVerdict({
      trustlineExists: false,
      trustlineAuthorized: false,
      clawbackEnabled: true,
      unauthorizedTrustlinePolicy: 'fail',
      clawbackStrictMode: true,
    });
    expect(verdict).toEqual({
      reasonCode: 'TRUSTLINE_MISSING',
      authorizationBlocks: false,
      clawbackBlocks: false,
      notes: [],
    });
  });

  it('issuer capability flags are notes only and never change the code', () => {
    const verdict = resolveIssuerAuthFlagVerdict({
      trustlineExists: true,
      trustlineAuthorized: true,
      authRequired: true,
      authRevocable: true,
      authImmutable: true,
    });
    expect(verdict.reasonCode).toBe('SUCCESS');
    expect(verdict.notes).toEqual(['auth_required', 'auth_revocable', 'auth_immutable']);
  });

  it('emits warn notes for non-blocking unauthorized and clawback states', () => {
    const verdict = resolveIssuerAuthFlagVerdict({
      trustlineExists: true,
      trustlineAuthorized: false,
      clawbackEnabled: true,
    });
    expect(verdict.reasonCode).toBe('SUCCESS');
    expect(verdict.notes).toEqual(['unauthorized_warn', 'clawback_warn']);
  });

  it('malformed field values fall back to permissive defaults', () => {
    const verdict = resolveIssuerAuthFlagVerdict({
      trustlineExists: true,
      trustlineAuthorized: 'false' as unknown as boolean,
      clawbackEnabled: 1 as unknown as boolean,
      unauthorizedTrustlinePolicy: 'FAIL' as unknown as 'fail',
      clawbackStrictMode: 'true' as unknown as boolean,
    });
    expect(verdict.reasonCode).toBe('SUCCESS');
    expect(verdict.authorizationBlocks).toBe(false);
    expect(verdict.clawbackBlocks).toBe(false);
  });

  it('is deterministic for repeated invocations', () => {
    const state: IssuerAuthFlagState = {
      trustlineExists: true,
      trustlineAuthorized: false,
      unauthorizedTrustlinePolicy: 'fail',
    };
    expect(resolveIssuerAuthFlagVerdict(state)).toEqual(resolveIssuerAuthFlagVerdict(state));
  });
});
