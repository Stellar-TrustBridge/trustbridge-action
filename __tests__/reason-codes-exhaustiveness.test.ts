/**
 * TypeScript exhaustiveness proof for the frozen reason_code catalog
 * (Issue #856).
 *
 * src/reasonCodes.ts is the compile-time mirror of schemas/reason-codes.json.
 * Any check branch that assigns a `ValidationResult.reasonCode` outside the
 * `ReasonCode` union fails `tsc` (see `npm run typecheck`), not just a Jest
 * assertion at runtime. `handleReasonCode` below exhaustively switches over
 * every `ReasonCode`; if `REASON_CODES` gains an entry without a matching
 * `case`, the `default` branch's argument stops being `never` and the build
 * breaks at the `assertExhaustiveReasonCode(code)` call site.
 */
import {
  REASON_CODES,
  type ReasonCode,
  isReasonCode,
  assertExhaustiveReasonCode,
} from '../src/reasonCodes';
import * as fs from 'fs';
import * as path from 'path';

function handleReasonCode(code: ReasonCode): string {
  switch (code) {
    case 'SUCCESS':
    case 'TRUSTLINE_MISSING':
    case 'RESERVE_TOO_LOW':
    case 'TRUSTLINE_LIMIT_TOO_LOW':
    case 'ACCOUNT_NOT_FUNDED':
    case 'HORIZON_TIMEOUT':
    case 'HORIZON_ERROR':
    case 'TLS_ERROR':
    case 'FAILED':
    case 'TRUSTLINE_UNAUTHORIZED':
    case 'CLAWBACK_BLOCKED':
    case 'CIRCUIT_OPEN':
    case 'RATE_BUDGET_EXHAUSTED':
    case 'HOME_DOMAIN_MISMATCH':
    case 'HOME_DOMAIN_MISSING':
    case 'MILESTONE_GATE_SKIPPED':
    case 'MAINTAINER_SKIPPED':
    case 'SAC_ISSUER_NOT_VERIFIABLE':
    case 'HORIZON_WAIT_BUDGET_EXHAUSTED':
    case 'EXTRA_TRUSTLINE_MISSING':
    case 'SOROBAN_CONTRACT_NOT_FOUND':
    case 'SOROBAN_RPC_UNAVAILABLE':
      return code;
    default:
      // If this line fails to compile, a code was added to REASON_CODES
      // above without a matching `case` here.
      return assertExhaustiveReasonCode(code);
  }
}

describe('ReasonCode exhaustiveness (Issue #856)', () => {
  it('handleReasonCode resolves every cataloged code without throwing', () => {
    for (const code of REASON_CODES) {
      expect(handleReasonCode(code)).toBe(code);
    }
  });

  it('isReasonCode narrows cataloged strings and rejects unknown ones', () => {
    for (const code of REASON_CODES) {
      expect(isReasonCode(code)).toBe(true);
    }
    expect(isReasonCode('NOT_A_REAL_CODE')).toBe(false);
    expect(isReasonCode('')).toBe(false);
  });

  it('REASON_CODES has no duplicates', () => {
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length);
  });

  // Keeps the TS union (src/reasonCodes.ts) and the public JSON catalog
  // (schemas/reason-codes.json) from drifting apart: this is the second,
  // independent half of the freeze — __tests__/reason-codes.test.ts already
  // locks the JSON catalog against runtime emissions.
  it('REASON_CODES contains exactly the codes in schemas/reason-codes.json', () => {
    const catalogPath = path.resolve(__dirname, '../schemas/reason-codes.json');
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as {
      codes: Array<{ code: string }>;
    };
    const catalogCodes = catalog.codes.map((c) => c.code).sort();
    const unionCodes = [...REASON_CODES].sort();
    expect(unionCodes).toEqual(catalogCodes);
  });
});
