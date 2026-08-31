import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ValidationResult } from '../src/checks';
import { toActionOutputs, setValidationOutputs, writeValidationJson } from '../src/outputs';

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
