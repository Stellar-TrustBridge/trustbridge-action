/**
 * Output size cap tests (Issue #854).
 *
 * `truncateJsonArray` is the shared deterministic-truncation primitive used
 * by `toActionOutputs` (assets_trustline_status), `buildMatrixOutputs`
 * (assignee_results_json / matrix_ready_map), and `src/index.ts`'s
 * batch_summary_json. This suite covers the primitive directly (exact
 * boundary sizes, multibyte characters, determinism) plus the three call
 * sites that wire it into real outputs.
 */
import {
  truncateJsonArray,
  MAX_OUTPUT_VALUE_BYTES,
  toActionOutputs,
  buildMatrixOutputs,
} from '../src/outputs';
import { ValidationResult } from '../src/checks';
import { buildBatchSummary, BatchAddressResult } from '../src/batch';

const BASE_RESULT: ValidationResult = {
  valid: true,
  accountFunded: true,
  trustlineExists: true,
  xlmBalance: '5.0000000',
  xlmReserveMet: true,
  checks: [],
};

describe('truncateJsonArray (Issue #854)', () => {
  it('does not truncate when the full JSON already fits the budget', () => {
    const items = [1, 2, 3];
    const result = truncateJsonArray(items, (xs) => JSON.stringify(xs), 1000);
    expect(result).toEqual({ json: '[1,2,3]', truncated: false, includedCount: 3, totalCount: 3 });
  });

  it('returns an empty-array JSON and truncated:false for an empty input', () => {
    const result = truncateJsonArray([], (xs) => JSON.stringify(xs), 10);
    expect(result).toEqual({ json: '[]', truncated: false, includedCount: 0, totalCount: 0 });
  });

  it('keeps a deterministic prefix (earliest entries) when truncation is required', () => {
    const items = Array.from({ length: 100 }, (_, i) => `item-${i}`);
    // Each entry is ~10 bytes JSON-encoded (`"item-NN",`); budget for ~20 entries.
    const budget = 220;
    const result = truncateJsonArray(items, (xs) => JSON.stringify(xs), budget);

    expect(result.truncated).toBe(true);
    expect(result.totalCount).toBe(100);
    expect(result.includedCount).toBeGreaterThan(0);
    expect(result.includedCount).toBeLessThan(100);
    expect(Buffer.byteLength(result.json, 'utf8')).toBeLessThanOrEqual(budget);

    const parsed = JSON.parse(result.json) as string[];
    expect(parsed).toEqual(items.slice(0, result.includedCount));
    // Earliest entries kept, not an arbitrary subset.
    expect(parsed[0]).toBe('item-0');
  });

  it('is deterministic across repeated calls with the same input', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: i, note: 'x'.repeat(20) }));
    const a = truncateJsonArray(items, (xs) => JSON.stringify(xs), 500);
    const b = truncateJsonArray(items, (xs) => JSON.stringify(xs), 500);
    expect(a).toEqual(b);
  });

  it('exact boundary: an input whose JSON is exactly maxBytes is not truncated', () => {
    const json = '[1,2,3]';
    const exactBudget = Buffer.byteLength(json, 'utf8');
    const result = truncateJsonArray([1, 2, 3], (xs) => JSON.stringify(xs), exactBudget);
    expect(result.truncated).toBe(false);
    expect(result.json).toBe(json);
  });

  it('exact boundary: one byte under the required size truncates', () => {
    const json = '[1,2,3]';
    const exactBudget = Buffer.byteLength(json, 'utf8');
    const result = truncateJsonArray([1, 2, 3], (xs) => JSON.stringify(xs), exactBudget - 1);
    expect(result.truncated).toBe(true);
    expect(result.includedCount).toBeLessThan(3);
  });

  it('measures size in UTF-8 bytes, not UTF-16 length, for multibyte characters', () => {
    // Each emoji is 1 UTF-16 code unit pair... actually surrogate pair (2
    // UTF-16 units) but 4 UTF-8 bytes; CJK characters are 1 UTF-16 unit but
    // 3 UTF-8 bytes. Either way, .length dramatically understates byte size.
    const items = Array.from({ length: 20 }, () => '🎉検証');
    const fullJson = JSON.stringify(items);
    const byteSize = Buffer.byteLength(fullJson, 'utf8');
    const charLength = fullJson.length;
    // Sanity check on the premise: byte size must exceed UTF-16 length for
    // this input, or the test proves nothing about multibyte correctness.
    expect(byteSize).toBeGreaterThan(charLength);

    // Budget set between the (smaller) char length and the (larger) byte
    // size: a length-based implementation would wrongly report "fits",
    // while a correct byte-based implementation truncates.
    const budget = charLength + 5;
    const result = truncateJsonArray(items, (xs) => JSON.stringify(xs), budget);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.json, 'utf8')).toBeLessThanOrEqual(budget);
    // Every included entry must still be a complete, valid UTF-8 string —
    // no element truncated mid-character.
    const parsed = JSON.parse(result.json) as string[];
    for (const entry of parsed) expect(entry).toBe('🎉検証');
  });

  it('handles a single oversized entry (budget cannot even fit entry 0) without throwing', () => {
    const items = ['x'.repeat(10_000)];
    const result = truncateJsonArray(items, (xs) => JSON.stringify(xs), 100);
    expect(result.truncated).toBe(true);
    expect(result.includedCount).toBe(0);
    expect(result.json).toBe('[]');
  });
});

describe('toActionOutputs assets_trustline_status truncation (Issue #854)', () => {
  it('reports outputs_truncated=false when the asset list is small', () => {
    const outputs = toActionOutputs(BASE_RESULT, undefined, undefined, {
      assetsTrustlineStatus: [
        { assetCode: 'EURC', assetIssuer: 'GISSUER', trustlineExists: true, balance: '1.0' },
      ],
    });
    expect(outputs.outputs_truncated).toBe('false');
    expect(JSON.parse(outputs.assets_trustline_status)).toHaveLength(1);
  });

  it('truncates assets_trustline_status and reports outputs_truncated=true for a huge asset list', () => {
    const hugeAssetList = Array.from({ length: 50_000 }, (_, i) => ({
      assetCode: `ASSET${i}`,
      assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      trustlineExists: i % 2 === 0,
      balance: '1.0000000',
    }));

    const outputs = toActionOutputs(BASE_RESULT, undefined, undefined, {
      assetsTrustlineStatus: hugeAssetList,
    });

    expect(outputs.outputs_truncated).toBe('true');
    expect(Buffer.byteLength(outputs.assets_trustline_status, 'utf8')).toBeLessThanOrEqual(
      // MAX_OUTPUT_VALUE_BYTES is not exported from checks.ts import path here,
      // but outputs.ts exports it directly.
      900_000,
    );
    const parsed = JSON.parse(outputs.assets_trustline_status);
    expect(parsed.length).toBeLessThan(hugeAssetList.length);
    // trustlines_summary still reports the TRUE total, not the truncated count.
    expect(outputs.trustlines_summary).toContain(`of ${hugeAssetList.length} additional trustlines present`);
  });

  it('exposes MAX_OUTPUT_VALUE_BYTES as a stable, documented constant', () => {
    expect(MAX_OUTPUT_VALUE_BYTES).toBe(900_000);
    expect(MAX_OUTPUT_VALUE_BYTES).toBeLessThan(1_000_000); // headroom under GitHub's 1MB limit
  });
});

describe('buildMatrixOutputs truncation (Issue #854)', () => {
  function makeAssignee(login: string): {
    assigneeLogin: string;
    stellarAddress: string;
    validationResult: ValidationResult;
    validatedAt?: string;
  } {
    return {
      assigneeLogin: login,
      stellarAddress: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      validationResult: BASE_RESULT,
      validatedAt: '2024-01-15T10:00:00Z',
    };
  }

  it('reports truncated=false for a small assignee list', () => {
    const result = buildMatrixOutputs([makeAssignee('alice'), makeAssignee('bob')]);
    expect(result.truncated).toBe(false);
    expect(result.includedCount).toBe(2);
    expect(result.totalCount).toBe(2);
    expect(Object.keys(JSON.parse(result.assigneeResultsJson))).toEqual(['alice', 'bob']);
    expect(Object.keys(JSON.parse(result.matrixReadyMap))).toEqual(['alice', 'bob']);
  });

  it('truncates a huge assignee list and keeps both maps in agreement on which assignees survive', () => {
    const assignees = Array.from({ length: 20_000 }, (_, i) => makeAssignee(`assignee-${i}`));
    const result = buildMatrixOutputs(assignees);

    expect(result.truncated).toBe(true);
    expect(result.totalCount).toBe(20_000);
    expect(result.includedCount).toBeGreaterThan(0);
    expect(result.includedCount).toBeLessThan(20_000);

    const resultsKeys = Object.keys(JSON.parse(result.assigneeResultsJson));
    const readyKeys = Object.keys(JSON.parse(result.matrixReadyMap));
    expect(resultsKeys).toEqual(readyKeys);
    expect(resultsKeys).toHaveLength(result.includedCount);
    // Earliest assignees kept, in input order.
    expect(resultsKeys[0]).toBe('assignee-0');

    expect(Buffer.byteLength(result.assigneeResultsJson, 'utf8')).toBeLessThanOrEqual(900_000);
  });

  it('handles an empty results array', () => {
    const result = buildMatrixOutputs([]);
    expect(result).toEqual({
      assigneeResultsJson: '{}',
      matrixReadyMap: '{}',
      truncated: false,
      includedCount: 0,
      totalCount: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// batch_summary_json truncation (Issue #854) — exercises the exact
// `truncateJsonArray(batchSummary.failures, (subset) => JSON.stringify({
// ...batchSummary, failures: subset }))` expression src/index.ts wires in,
// without needing to drive a full `run()` over thousands of mocked Horizon
// fetches.
// ---------------------------------------------------------------------------

describe('batch_summary_json truncation wiring (Issue #854)', () => {
  function failedRow(i: number): BatchAddressResult {
    return {
      address: `GFAILED${String(i).padStart(10, '0')}ADDRESSPADDINGPADDINGPADDINGPADDINGPAD`.slice(0, 56),
      valid: false,
      accountFunded: false,
      trustlineExists: false,
      xlmBalance: '0',
      xlmReserveMet: false,
      failureReason: 'account not funded',
      reasonCode: 'ACCOUNT_NOT_FUNDED',
      clawbackStrictFailure: false,
      clawbackStrictAssets: [],
    };
  }

  it('does not truncate a small batch summary', () => {
    const summary = buildBatchSummary([failedRow(1), failedRow(2)]);
    const { json, truncated } = truncateJsonArray(
      summary.failures,
      (subset) => JSON.stringify({ ...summary, failures: subset }),
    );
    expect(truncated).toBe(false);
    expect(JSON.parse(json).failures).toHaveLength(2);
  });

  it('truncates failures deterministically for a huge batch while staying under budget', () => {
    const rows = Array.from({ length: 8000 }, (_, i) => failedRow(i));
    const summary = buildBatchSummary(rows);
    expect(summary.failures).toHaveLength(8000);

    const { json, truncated, includedCount, totalCount } = truncateJsonArray(
      summary.failures,
      (subset) => JSON.stringify({ ...summary, failures: subset }),
    );

    expect(truncated).toBe(true);
    expect(totalCount).toBe(8000);
    expect(includedCount).toBeGreaterThan(0);
    expect(includedCount).toBeLessThan(8000);
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(MAX_OUTPUT_VALUE_BYTES);

    const parsed = JSON.parse(json);
    // Aggregate counts (total/passed/failed/failureTaxonomy) stay accurate —
    // only the `failures` array itself is truncated, so a consumer reading
    // `failed` still sees the true count even if `failures.length` is capped.
    expect(parsed.failed).toBe(8000);
    expect(parsed.failures).toHaveLength(includedCount);
    expect(parsed.failures[0].address).toBe(rows[0].address);
  });
});
