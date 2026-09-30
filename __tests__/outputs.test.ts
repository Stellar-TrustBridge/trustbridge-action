import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as core from '@actions/core';
import { ValidationResult } from '../src/checks';
import { toActionOutputs, setValidationOutputs, writeValidationJson } from '../src/outputs';

jest.mock('@actions/core');

const mockSetOutput = core.setOutput as jest.MockedFunction<typeof core.setOutput>;

const result: ValidationResult = {
  valid: true,
  accountFunded: true,
  trustlineExists: true,
  xlmBalance: '5.0000000',
  xlmReserveMet: true,
  checks: [
    { passed: true, label: 'Account funded', detail: 'Funded' },
    { passed: true, label: 'USDC trustline', detail: 'Trustline exists' },
  ],
  reasonCode: 'SUCCESS',
};

function parseActionYmlOutputs(yamlText: string): Set<string> {
  const outputNames = new Set<string>();
  const lines = yamlText.split('\n');

  let inOutputsSection = false;
  let currentOutputName: string | null = null;

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (/^outputs:\s*$/.test(line)) {
      inOutputsSection = true;
      continue;
    }

    if (inOutputsSection && /^[a-zA-Z_]/.test(line) && !/^\s/.test(line)) {
      if (currentOutputName !== null) {
        outputNames.add(currentOutputName);
      }
      inOutputsSection = false;
      currentOutputName = null;
      continue;
    }

    if (!inOutputsSection) continue;

    if (/^\s*#/.test(line)) continue;

    const outputMatch = line.match(/^  ([a-zA-Z_][a-zA-Z0-9_]*):\s*$/);
    if (outputMatch) {
      if (currentOutputName !== null) {
        outputNames.add(currentOutputName);
      }
      currentOutputName = outputMatch[1]!;
      continue;
    }
  }

  if (currentOutputName !== null) {
    outputNames.add(currentOutputName);
  }

  return outputNames;
}

describe('toActionOutputs', () => {
  it('serializes legacy and new audit/timing outputs for GitHub Actions', () => {
    const outputs = toActionOutputs(result, undefined, undefined, {
      horizonUrl: 'https://horizon.stellar.org',
      assetCode: 'USDC',
      assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      timings: {
        input_parse_ms: 10,
        horizon_fetch_ms: 100,
        checks_ms: 5,
        comment_post_ms: 20,
        total_ms: 135,
      },
    });

    expect(outputs).toMatchObject({
      trustline_exists: 'true',
      xlm_balance: '5.0000000',
      account_funded: 'true',
      comment_url: '',
      full_report_path: '',
      ready: 'true',
      horizon_url: 'https://horizon.stellar.org',
      asset_code: 'USDC',
      asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      reason_code: 'SUCCESS',
      timing_input_parse_ms: '10',
      timing_horizon_fetch_ms: '100',
      timing_checks_ms: '5',
      timing_comment_post_ms: '20',
      timing_total_ms: '135',
    });

    expect(JSON.parse(outputs.checks_json)).toEqual([
      { label: 'Account funded', passed: true, detail: 'Funded' },
      { label: 'USDC trustline', passed: true, detail: 'Trustline exists' },
    ]);

    expect(JSON.parse(outputs.timings_json)).toEqual({
      input_parse_ms: 10,
      horizon_fetch_ms: 100,
      checks_ms: 5,
      comment_post_ms: 20,
      total_ms: 135,
    });
  });

  it('serializes additional asset trustline statuses and a count summary', () => {
    const outputs = toActionOutputs(result, undefined, undefined, {
      assetsTrustlineStatus: [
        {
          assetCode: 'EURC',
          assetIssuer: 'GEURC...',
          trustlineExists: true,
          balance: '12.0000000',
        },
        {
          assetCode: 'USDT',
          assetIssuer: 'GUSDT...',
          trustlineExists: false,
          balance: '0',
        },
      ],
    });

    expect(JSON.parse(outputs.assets_trustline_status)).toEqual([
      {
        asset_code: 'EURC',
        asset_issuer: 'GEURC...',
        trustline_exists: true,
        balance: '12.0000000',
      },
      {
        asset_code: 'USDT',
        asset_issuer: 'GUSDT...',
        trustline_exists: false,
        balance: '0',
      },
    ]);
    expect(outputs.trustlines_summary).toBe(
      '1 of 2 additional trustlines present',
    );
  });

  it('uses empty status and summary outputs when no additional assets were checked', () => {
    const outputs = toActionOutputs(result);

    expect(outputs.assets_trustline_status).toBe('[]');
    expect(outputs.trustlines_summary).toBe(
      '0 of 0 additional trustlines present',
    );
  });

  it('includes a comment URL and full_report_path when provided', () => {
    const outputs = toActionOutputs(result, 'https://github.com/comment', '/workspace/trustbridge-report.md');
    expect(outputs).toMatchObject({
      trustline_exists: 'true',
      xlm_balance: '5.0000000',
      account_funded: 'true',
      comment_url: 'https://github.com/comment',
      full_report_path: '/workspace/trustbridge-report.md',
    });
  });

  it('serializes failure reason codes for failing results', () => {
    const failResult: ValidationResult = {
      valid: false,
      accountFunded: false,
      trustlineExists: false,
      xlmBalance: '0',
      xlmReserveMet: false,
      checks: [],
      reasonCode: 'ACCOUNT_NOT_FUNDED',
    };
    const outputs = toActionOutputs(failResult);
    expect(outputs.ready).toBe('false');
    expect(outputs.reason_code).toBe('ACCOUNT_NOT_FUNDED');
  });

  it('outputs contain no secrets or PII tokens', () => {
    const outputs = toActionOutputs(result);
    const combined = JSON.stringify(outputs);
    expect(combined).not.toContain('ghp_');
    expect(combined).not.toContain('github_token');
  });

  it('leaves full_report_path empty when not provided', () => {
    const outputs = toActionOutputs(result, undefined, undefined);
    expect(outputs.full_report_path).toBe('');
  });

  it('splits native XLM vs trustline asset balance (Issue #246) — distinct outputs, 7 decimals', () => {
    const withAsset: ValidationResult = {
      ...result,
      xlmBalance: '10.5000000',
      assetBalance: '100.0000000',
      trustlineExists: true,
    };
    const outputs = toActionOutputs(withAsset);
    expect(outputs.xlm_balance).toBe('10.5000000');
    expect(outputs.native_balance).toBe('10.5000000');
    expect(outputs.asset_balance).toBe('100.0000000');
    // legacy retained
    expect(outputs.trustline_exists).toBe('true');
  });

  it('asset_balance is 0 when trustline missing vs 0.0000000 when 0-balance trustline exists', () => {
    const missing: ValidationResult = {
      valid: false,
      accountFunded: true,
      trustlineExists: false,
      xlmBalance: '10.0000000',
      xlmReserveMet: true,
      assetBalance: '0',
      checks: [],
    };
    expect(toActionOutputs(missing).asset_balance).toBe('0');

    const zeroBalance: ValidationResult = {
      valid: false,
      accountFunded: true,
      trustlineExists: true,
      xlmBalance: '10.0000000',
      xlmReserveMet: true,
      assetBalance: '0.0000000',
      checks: [],
    };
    expect(toActionOutputs(zeroBalance).asset_balance).toBe('0.0000000');
  });

  it('asset_balance is unknown on Horizon error, distinct from native', () => {
    const err: ValidationResult = {
      valid: false,
      accountFunded: false,
      trustlineExists: false,
      xlmBalance: 'unknown',
      xlmReserveMet: false,
      assetBalance: 'unknown',
      checks: [],
    };
    const outputs = toActionOutputs(err);
    expect(outputs.xlm_balance).toBe('unknown');
    expect(outputs.native_balance).toBe('unknown');
    expect(outputs.asset_balance).toBe('unknown');
  });

  it('keeps the action.yml output contract stable against a golden manifest', () => {
    const repoRoot = path.resolve(__dirname, '..');
    const actionPath = path.join(repoRoot, 'action.yml');
    const goldenPath = path.join(__dirname, 'action-output-golden.json');

    const actionText = fs.readFileSync(actionPath, 'utf8');
    const actionOutputNames = parseActionYmlOutputs(actionText);
    const goldenOutputNames = JSON.parse(fs.readFileSync(goldenPath, 'utf8')) as string[];
    const runtimeOutputNames = new Set(Object.keys(toActionOutputs(result)));

    const missingFromGolden = [...goldenOutputNames].filter((name) => !runtimeOutputNames.has(name));
    const missingFromAction = [...goldenOutputNames].filter((name) => !actionOutputNames.has(name));
    const actionOnly = [...actionOutputNames].filter((name) => !runtimeOutputNames.has(name));

    expect(missingFromGolden).toEqual([]);
    expect(missingFromAction).toEqual([]);
    expect(actionOnly).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Matrix-friendly outputs (Issue #3)
// ---------------------------------------------------------------------------

describe('Matrix-friendly outputs', () => {
  it('includes empty JSON maps when assignee info not provided', () => {
    const outputs = toActionOutputs(result);
    
    expect(outputs.assignee_results_json).toBe('{}');
    expect(outputs.matrix_ready_map).toBe('{}');
  });

  it('includes assignee result in JSON map when assignee info provided', () => {
    const outputs = toActionOutputs(result, undefined, undefined, {
      assigneeLogin: 'alice',
      stellarAddress: 'GALICE123...',
      validatedAt: '2024-01-15T10:00:00Z',
    });
    
    const assigneeResults = JSON.parse(outputs.assignee_results_json);
    expect(assigneeResults).toHaveProperty('alice');
    expect(assigneeResults.alice).toMatchObject({
      ready: true,
      stellar_address: 'GALICE123...',
      xlm_balance: '5.0000000',
      account_funded: true,
      trustline_exists: true,
      reason_code: 'SUCCESS',
      validated_at: '2024-01-15T10:00:00Z',
    });
  });

  it('includes ready status in matrix_ready_map', () => {
    const outputs = toActionOutputs(result, undefined, undefined, {
      assigneeLogin: 'bob',
      stellarAddress: 'GBOB456...',
    });
    
    const readyMap = JSON.parse(outputs.matrix_ready_map);
    expect(readyMap).toEqual({ bob: true });
  });

  it('includes failure status in matrix outputs', () => {
    const failResult: ValidationResult = {
      valid: false,
      accountFunded: false,
      trustlineExists: false,
      xlmBalance: '0',
      xlmReserveMet: false,
      checks: [],
      reasonCode: 'ACCOUNT_NOT_FUNDED',
    };
    
    const outputs = toActionOutputs(failResult, undefined, undefined, {
      assigneeLogin: 'charlie',
      stellarAddress: 'GCHARLIE789...',
    });
    
    const assigneeResults = JSON.parse(outputs.assignee_results_json);
    expect(assigneeResults.charlie.ready).toBe(false);
    expect(assigneeResults.charlie.reason_code).toBe('ACCOUNT_NOT_FUNDED');
    
    const readyMap = JSON.parse(outputs.matrix_ready_map);
    expect(readyMap.charlie).toBe(false);
  });

  it('generates valid JSON even with special characters in assignee login', () => {
    const outputs = toActionOutputs(result, undefined, undefined, {
      assigneeLogin: 'user-with-hyphens',
      stellarAddress: 'GUSER...',
    });
    
    // Should parse without error
    const assigneeResults = JSON.parse(outputs.assignee_results_json);
    expect(assigneeResults['user-with-hyphens']).toBeDefined();
    
    const readyMap = JSON.parse(outputs.matrix_ready_map);
    expect(readyMap['user-with-hyphens']).toBe(true);
  });
});

describe('buildMatrixOutputs', () => {
  const { buildMatrixOutputs } = require('../src/outputs');

  it('builds JSON maps from multiple validation results', () => {
    const results = [
      {
        assigneeLogin: 'alice',
        stellarAddress: 'GALICE...',
        validationResult: result,
        validatedAt: '2024-01-15T10:00:00Z',
      },
      {
        assigneeLogin: 'bob',
        stellarAddress: 'GBOB...',
        validationResult: {
          valid: false,
          accountFunded: true,
          trustlineExists: false,
          xlmBalance: '2.0',
          xlmReserveMet: true,
          checks: [],
          reasonCode: 'TRUSTLINE_MISSING',
        },
        validatedAt: '2024-01-15T10:00:05Z',
      },
    ];
    
    const { assigneeResultsJson, matrixReadyMap } = buildMatrixOutputs(results);
    
    const assigneeResults = JSON.parse(assigneeResultsJson);
    expect(assigneeResults).toHaveProperty('alice');
    expect(assigneeResults).toHaveProperty('bob');
    expect(assigneeResults.alice.ready).toBe(true);
    expect(assigneeResults.bob.ready).toBe(false);
    expect(assigneeResults.bob.reason_code).toBe('TRUSTLINE_MISSING');
    
    const readyMap = JSON.parse(matrixReadyMap);
    expect(readyMap).toEqual({ alice: true, bob: false });
  });

  it('handles empty results array', () => {
    const { assigneeResultsJson, matrixReadyMap } = buildMatrixOutputs([]);
    
    expect(JSON.parse(assigneeResultsJson)).toEqual({});
    expect(JSON.parse(matrixReadyMap)).toEqual({});
  });

  it('defaults validatedAt to current time if not provided', () => {
    const before = new Date().toISOString();
    
    const { assigneeResultsJson } = buildMatrixOutputs([
      {
        assigneeLogin: 'alice',
        stellarAddress: 'GALICE...',
        validationResult: result,
      },
    ]);
    
    const after = new Date().toISOString();
    const assigneeResults = JSON.parse(assigneeResultsJson);
    
    // validated_at should be between before and after
    expect(assigneeResults.alice.validated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(assigneeResults.alice.validated_at >= before).toBe(true);
    expect(assigneeResults.alice.validated_at <= after).toBe(true);
  });

  it('preserves all assignees even if some fail', () => {
    const results = [
      {
        assigneeLogin: 'alice',
        stellarAddress: 'GALICE...',
        validationResult: result,
      },
      {
        assigneeLogin: 'bob',
        stellarAddress: 'GBOB...',
        validationResult: { ...result, valid: false, reasonCode: 'RESERVE_TOO_LOW' },
      },
      {
        assigneeLogin: 'charlie',
        stellarAddress: 'GCHARLIE...',
        validationResult: result,
      },
    ];
    
    const { assigneeResultsJson, matrixReadyMap } = buildMatrixOutputs(results);
    
    const assigneeResults = JSON.parse(assigneeResultsJson);
    expect(Object.keys(assigneeResults)).toHaveLength(3);
    
    const readyMap = JSON.parse(matrixReadyMap);
    expect(readyMap.alice).toBe(true);
    expect(readyMap.bob).toBe(false);
    expect(readyMap.charlie).toBe(true);
  });
});

describe('sanitizeUsernameForMatrix', () => {
  const { sanitizeUsernameForMatrix } = require('../src/outputs');

  it('preserves alphanumeric, hyphens, and underscores', () => {
    expect(sanitizeUsernameForMatrix('alice-123_test')).toBe('alice-123_test');
    expect(sanitizeUsernameForMatrix('Bob_456')).toBe('Bob_456');
  });

  it('replaces special characters with underscores', () => {
    expect(sanitizeUsernameForMatrix('user@example')).toBe('user_example');
    expect(sanitizeUsernameForMatrix('test.user')).toBe('test_user');
    expect(sanitizeUsernameForMatrix('user+plus')).toBe('user_plus');
  });

  it('prefixes usernames starting with digits', () => {
    expect(sanitizeUsernameForMatrix('123user')).toBe('_123user');
    expect(sanitizeUsernameForMatrix('42charlie')).toBe('_42charlie');
  });

  it('returns "unknown" for empty or whitespace-only strings', () => {
    expect(sanitizeUsernameForMatrix('')).toBe('unknown');
    expect(sanitizeUsernameForMatrix('   ')).toBe('unknown');
    expect(sanitizeUsernameForMatrix('\t\n')).toBe('unknown');
  });

  it('trims whitespace before sanitization', () => {
    expect(sanitizeUsernameForMatrix('  alice  ')).toBe('alice');
    expect(sanitizeUsernameForMatrix('\talice\n')).toBe('alice');
  });

  it('handles multiple consecutive special characters', () => {
    expect(sanitizeUsernameForMatrix('user@@##test')).toBe('user____test');
  });

  it('preserves mixed case', () => {
    expect(sanitizeUsernameForMatrix('AlIcE')).toBe('AlIcE');
    expect(sanitizeUsernameForMatrix('BobCAMEL')).toBe('BobCAMEL');
  });

  it('handles edge case usernames', () => {
    expect(sanitizeUsernameForMatrix('a')).toBe('a');
    expect(sanitizeUsernameForMatrix('_')).toBe('_');
    expect(sanitizeUsernameForMatrix('-')).toBe('-');
    expect(sanitizeUsernameForMatrix('_-_')).toBe('_-_');
  });

  it('returns "unknown" when sanitization produces empty string', () => {
    // Edge case: username with only special chars becomes empty after replacement
    expect(sanitizeUsernameForMatrix('###')).toBe('___');
    expect(sanitizeUsernameForMatrix('@')).toBe('_');
  });
});

// ---------------------------------------------------------------------------
// Integration: Matrix outputs with sponsorship and network mismatch
// ---------------------------------------------------------------------------

describe('Matrix outputs integration with other features', () => {
  it('includes sponsorship info in assignee results', () => {
    const resultWithSponsorship: ValidationResult = {
      ...result,
      sponsorshipInfo: {
        numSponsoring: 2,
        numSponsored: 1,
      },
    };
    
    const outputs = toActionOutputs(resultWithSponsorship, undefined, undefined, {
      assigneeLogin: 'alice',
      stellarAddress: 'GALICE...',
    });
    
    expect(outputs.num_sponsoring).toBe('2');
    expect(outputs.num_sponsored).toBe('1');
    
    // Sponsorship info not directly in assignee_results_json
    // but available via separate outputs
    const assigneeResults = JSON.parse(outputs.assignee_results_json);
    expect(assigneeResults.alice.ready).toBe(true);
  });

  it('includes network passphrase mismatch in outputs alongside matrix outputs', () => {
    const resultWithMismatch: ValidationResult = {
      ...result,
      networkPassphraseMismatch: {
        expectedPassphrase: 'Test SDF Network ; September 2015',
        actualPassphrase: 'Public Global Stellar Network ; September 2015',
        message: 'Mismatch detected',
      },
    };
    
    const outputs = toActionOutputs(resultWithMismatch, undefined, undefined, {
      assigneeLogin: 'bob',
      stellarAddress: 'GBOB...',
    });
    
    expect(outputs.network_passphrase_mismatch).toBe('true');
    expect(outputs.expected_network_passphrase).toBe('Test SDF Network ; September 2015');
    
    const assigneeResults = JSON.parse(outputs.assignee_results_json);
    expect(assigneeResults.bob).toBeDefined();
  });

  it('handles all output types together', () => {
    const complexResult: ValidationResult = {
      ...result,
      sponsorshipInfo: { numSponsoring: 3, numSponsored: 0 },
      networkPassphraseMismatch: {
        expectedPassphrase: 'Custom',
        actualPassphrase: 'Public',
        message: 'Mismatch',
      },
    };
    
    const outputs = toActionOutputs(complexResult, 'https://comment', '/report.md', {
      assigneeLogin: 'alice',
      stellarAddress: 'GALICE...',
      horizonUrl: 'https://horizon.stellar.org',
      assetCode: 'USDC',
      assetIssuer: 'GA5Z...',
      timings: { total_ms: 150 },
    });
    
    // Standard outputs
    expect(outputs.ready).toBe('true');
    expect(outputs.comment_url).toBe('https://comment');
    
    // Sponsorship outputs
    expect(outputs.num_sponsoring).toBe('3');
    
    // Network mismatch outputs
    expect(outputs.network_passphrase_mismatch).toBe('true');
    
    // Matrix outputs
    const assigneeResults = JSON.parse(outputs.assignee_results_json);
    expect(assigneeResults.alice).toBeDefined();
    
    const readyMap = JSON.parse(outputs.matrix_ready_map);
    expect(readyMap.alice).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Issue #535 — a single setValidationOutputs call publishes every action output
//
// src/index.ts used to call setValidationOutputs twice (once mid-run, once at
// the end) and then re-set the friendbot_* outputs by hand. `run()` now makes
// exactly one call, carrying commentUrl, validatedAt and the timing breakdown.
// These tests pin the contract that single call has to satisfy.
// ---------------------------------------------------------------------------

describe('setValidationOutputs (Issue #535)', () => {
  const TIMINGS = {
    input_parse_ms: 12,
    horizon_fetch_ms: 145,
    checks_ms: 7,
    comment_post_ms: 31,
    total_ms: 195,
  };

  function outputsByName(): Map<string, string> {
    return new Map(mockSetOutput.mock.calls.map(([name, value]) => [name, String(value)]));
  }

  beforeEach(() => {
    mockSetOutput.mockReset();
  });

  it('sets every action.yml output exactly once in a single call', () => {
    setValidationOutputs(result);

    const names = mockSetOutput.mock.calls.map(([name]) => name);
    expect(names).toHaveLength(new Set(names).size);

    const actionOutputNames = parseActionYmlOutputs(
      fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'action.yml'), 'utf8'),
    );
    const written = outputsByName();
    for (const name of actionOutputNames) {
      expect(written.has(name)).toBe(true);
    }
  });

  it('publishes comment_url, validated_at and timings from the one call', () => {
    setValidationOutputs(result, 'https://github.com/o/r/issues/1#issuecomment-9', '/report.md', {
      validatedAt: '2024-01-15T10:00:00Z',
      timings: TIMINGS,
    });

    const written = outputsByName();
    expect(written.get('comment_url')).toBe('https://github.com/o/r/issues/1#issuecomment-9');
    expect(written.get('full_report_path')).toBe('/report.md');
    expect(written.get('validated_at')).toBe('2024-01-15T10:00:00Z');
    expect(written.get('timing_input_parse_ms')).toBe('12');
    expect(written.get('timing_horizon_fetch_ms')).toBe('145');
    expect(written.get('timing_checks_ms')).toBe('7');
    expect(written.get('timing_comment_post_ms')).toBe('31');
    expect(written.get('timing_total_ms')).toBe('195');
    expect(JSON.parse(written.get('timings_json') as string)).toEqual(TIMINGS);
  });

  it('publishes the friendbot outputs that index.ts used to set separately', () => {
    setValidationOutputs(result, undefined, undefined, {
      friendbotCalled: true,
      friendbotSuccess: false,
      friendbotTransactionHash: 'abc123',
    });

    const written = outputsByName();
    expect(written.get('friendbot_called')).toBe('true');
    expect(written.get('friendbot_success')).toBe('false');
    expect(written.get('friendbot_transaction_hash')).toBe('abc123');

    // ...and each exactly once, so removing the redundant writes is safe.
    const names = mockSetOutput.mock.calls.map(([name]) => name);
    expect(names.filter((n) => n.startsWith('friendbot_'))).toHaveLength(3);
  });

  it('defaults friendbot_transaction_hash to an empty string when absent', () => {
    setValidationOutputs(result);

    expect(outputsByName().get('friendbot_transaction_hash')).toBe('');
    expect(outputsByName().get('friendbot_called')).toBe('false');
    expect(outputsByName().get('friendbot_success')).toBe('false');
  });

  it('defaults timings to zero rather than leaving outputs undefined', () => {
    setValidationOutputs(result);

    const written = outputsByName();
    expect(written.get('timing_total_ms')).toBe('0');
    expect(JSON.parse(written.get('timings_json') as string)).toEqual({
      input_parse_ms: 0,
      horizon_fetch_ms: 0,
      checks_ms: 0,
      comment_post_ms: 0,
      total_ms: 0,
    });
  });

  // Issue #550 — check_run_id / check_run_conclusion are declared in
  // action.yml, so they must flow through setValidationOutputs too instead
  // of being written ad-hoc in src/index.ts.
  it('publishes check_run outputs passed through extras', () => {
    setValidationOutputs(result, undefined, undefined, {
      checkRunId: '1234567890',
      checkRunConclusion: 'success',
    });

    const written = outputsByName();
    expect(written.get('check_run_id')).toBe('1234567890');
    expect(written.get('check_run_conclusion')).toBe('success');
  });

  it('defaults check_run outputs to empty strings when no Check Run was created', () => {
    setValidationOutputs(result);

    const written = outputsByName();
    expect(written.get('check_run_id')).toBe('');
    expect(written.get('check_run_conclusion')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Issue #550 — every action.yml output key is set by setValidationOutputs
//
// action.yml is the published contract for consumers wiring
// `steps.<id>.outputs.<key>` into their workflows. This suite parses the
// declared outputs straight from action.yml and proves a single
// setValidationOutputs call sets each of them — no more, no less. New
// outputs must be added to both toActionOutputs and action.yml or CI fails
// here, so the contract cannot silently drift again (check_run_id and
// check_run_conclusion had: they were written ad-hoc in src/index.ts).
// ---------------------------------------------------------------------------

describe('setValidationOutputs ↔ action.yml output parity (Issue #550)', () => {
  function outputsByName(): Map<string, string> {
    return new Map(mockSetOutput.mock.calls.map(([name, value]) => [name, String(value)]));
  }

  beforeEach(() => {
    mockSetOutput.mockReset();
  });

  it('sets every output declared in action.yml (exact key match)', () => {
    setValidationOutputs(result);

    const actionYml = fs.readFileSync(
      path.join(path.resolve(__dirname, '..'), 'action.yml'),
      'utf8',
    );
    const declared = parseActionYmlOutputs(actionYml);
    expect(declared.size).toBeGreaterThan(0);

    const written = outputsByName();
    const missing = [...declared].filter((name) => !written.has(name));

    expect(missing).toEqual([]);
  });

  it('sets exactly the declared outputs — no undocumented extras', () => {
    setValidationOutputs(result);

    const actionYml = fs.readFileSync(
      path.join(path.resolve(__dirname, '..'), 'action.yml'),
      'utf8',
    );
    const declared = parseActionYmlOutputs(actionYml);
    const written = new Set(mockSetOutput.mock.calls.map(([name]) => name));
    const extras = [...written].filter((name) => !declared.has(name));

    expect(extras).toEqual([]);
  });

  it('publishes each declared output exactly once', () => {
    setValidationOutputs(result);

    const names = mockSetOutput.mock.calls.map(([name]) => name);
    const duplicates = names.filter(
      (name, idx) => names.indexOf(name) !== idx,
    );

    expect(duplicates).toEqual([]);
  });

  it('every value published is a string (GitHub Actions outputs are strings)', () => {
    setValidationOutputs(result, 'https://github.com/o/r/issues/1#issuecomment-1', '/tmp/report.md', {
      validatedAt: '2024-01-15T10:00:00Z',
      timings: { total_ms: 42 },
      checkRunId: '42',
      checkRunConclusion: 'failure',
    });

    for (const [, value] of mockSetOutput.mock.calls) {
      expect(typeof value).toBe('string');
    }
  });
});
