/**
 * Webhook payload contract tests (Issue #295).
 *
 * These tests verify that:
 * 1. `buildWebhookPayload` always produces output that conforms to the
 *    JSON Schema at `schemas/webhook-payload.schema.json`.
 * 2. The schema file itself has the correct structure and required fields.
 * 3. Dashboard implementation notes: see docs/USAGE.md#webhook-dashboard-integration.
 *
 * Validate with: npm test -- --testPathPattern 'webhook'
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  buildWebhookPayload,
  WebhookPayload,
} from '../src/webhook';

// ---------------------------------------------------------------------------
// Load the schema
// ---------------------------------------------------------------------------

const SCHEMA_PATH = path.resolve(__dirname, '../schemas/webhook-payload.schema.json');
let schema: Record<string, unknown>;

beforeAll(() => {
  const raw = fs.readFileSync(SCHEMA_PATH, 'utf8');
  schema = JSON.parse(raw) as Record<string, unknown>;
});

// ---------------------------------------------------------------------------
// Minimal inline schema conformance checker
// (avoids an Ajv dependency while giving clear assertion messages)
// ---------------------------------------------------------------------------

/**
 * Check that a payload object satisfies the top-level required fields and
 * basic type constraints expressed in the webhook schema.
 *
 * Returns an array of violation strings (empty = conformant).
 */
function checkConformance(payload: unknown): string[] {
  const violations: string[] = [];

  if (typeof payload !== 'object' || payload === null) {
    return ['payload is not an object'];
  }

  const p = payload as Record<string, unknown>;

  // Required top-level fields
  const required = [
    'schema_version',
    'event',
    'timestamp',
    'repository',
    'issue_number',
    'stellar_address',
    'result',
  ];
  for (const field of required) {
    if (!(field in p)) {
      violations.push(`missing required field: ${field}`);
    }
  }

  // schema_version must be the string "1"
  if (p['schema_version'] !== '1') {
    violations.push(`schema_version must be "1", got: ${JSON.stringify(p['schema_version'])}`);
  }

  // event must be "validation_complete"
  if (p['event'] !== 'validation_complete') {
    violations.push(`event must be "validation_complete", got: ${JSON.stringify(p['event'])}`);
  }

  // timestamp must be a valid ISO-8601 date-time string
  if (typeof p['timestamp'] !== 'string') {
    violations.push('timestamp must be a string');
  } else {
    const d = new Date(p['timestamp'] as string);
    if (isNaN(d.getTime())) {
      violations.push(`timestamp is not a valid date-time: ${p['timestamp']}`);
    }
  }

  // repository must be "owner/repo" format
  if (typeof p['repository'] !== 'string' || !/^[^/]+\/[^/]+$/.test(p['repository'] as string)) {
    violations.push(`repository must be "owner/repo" format, got: ${JSON.stringify(p['repository'])}`);
  }

  // issue_number must be integer ≥1 or null
  const issueNum = p['issue_number'];
  if (issueNum !== null) {
    if (typeof issueNum !== 'number' || !Number.isInteger(issueNum) || (issueNum as number) < 1) {
      violations.push(`issue_number must be an integer ≥1 or null, got: ${JSON.stringify(issueNum)}`);
    }
  }

  // stellar_address must match the redacted format first-4…last-4
  if (typeof p['stellar_address'] !== 'string') {
    violations.push('stellar_address must be a string');
  } else {
    if (!/^[GC][A-Z2-7]{3}\.{3}[A-Z2-7]{4}$/.test(p['stellar_address'] as string)) {
      violations.push(
        `stellar_address must be redacted (first-4…last-4), got: ${p['stellar_address']}`,
      );
    }
  }

  // result object
  if (typeof p['result'] !== 'object' || p['result'] === null) {
    violations.push('result must be an object');
    return violations;
  }

  const result = p['result'] as Record<string, unknown>;
  const resultRequired = ['valid', 'account_funded', 'trustline_exists', 'xlm_balance', 'checks'];
  for (const field of resultRequired) {
    if (!(field in result)) {
      violations.push(`result missing required field: ${field}`);
    }
  }

  if (typeof result['valid'] !== 'boolean') {
    violations.push(`result.valid must be boolean, got: ${typeof result['valid']}`);
  }
  if (typeof result['account_funded'] !== 'boolean') {
    violations.push(`result.account_funded must be boolean, got: ${typeof result['account_funded']}`);
  }
  if (typeof result['trustline_exists'] !== 'boolean') {
    violations.push(`result.trustline_exists must be boolean, got: ${typeof result['trustline_exists']}`);
  }
  if (typeof result['xlm_balance'] !== 'string') {
    violations.push(`result.xlm_balance must be a string, got: ${typeof result['xlm_balance']}`);
  }

  if (!Array.isArray(result['checks'])) {
    violations.push('result.checks must be an array');
  } else {
    (result['checks'] as unknown[]).forEach((item, i) => {
      if (typeof item !== 'object' || item === null) {
        violations.push(`result.checks[${i}] must be an object`);
        return;
      }
      const check = item as Record<string, unknown>;
      if (typeof check['label'] !== 'string') {
        violations.push(`result.checks[${i}].label must be a string`);
      }
      if (typeof check['passed'] !== 'boolean') {
        violations.push(`result.checks[${i}].passed must be boolean`);
      }
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ADDRESS = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

const passedResult = {
  valid: true,
  accountFunded: true,
  trustlineExists: true,
  xlmBalance: '10.5000000',
  checks: [
    { label: 'Account funded', passed: true, detail: 'ok' },
    { label: 'USDC trustline', passed: true, detail: 'ok' },
    { label: 'XLM reserve', passed: true, detail: 'ok' },
  ],
  remediation: undefined,
} as any;

const failedResult = {
  valid: false,
  accountFunded: false,
  trustlineExists: false,
  xlmBalance: '0',
  checks: [
    { label: 'Account funded', passed: false, detail: 'not found' },
    { label: 'USDC trustline', passed: false, detail: 'n/a' },
    { label: 'XLM reserve', passed: false, detail: 'n/a' },
  ],
  remediation: 'Fund your account',
} as any;

const partialResult = {
  valid: false,
  accountFunded: true,
  trustlineExists: false,
  xlmBalance: '5.0000000',
  checks: [
    { label: 'Account funded', passed: true, detail: 'ok' },
    { label: 'USDC trustline', passed: false, detail: 'no trustline' },
  ],
  remediation: 'Add a USDC trustline',
} as any;

// ---------------------------------------------------------------------------
// Schema file integrity
// ---------------------------------------------------------------------------

describe('webhook-payload.schema.json integrity', () => {
  it('exists at schemas/webhook-payload.schema.json', () => {
    expect(fs.existsSync(SCHEMA_PATH)).toBe(true);
  });

  it('is valid JSON', () => {
    expect(() => JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'))).not.toThrow();
  });

  it('has $schema field referencing JSON Schema draft-07', () => {
    expect(schema['$schema']).toContain('json-schema.org');
  });

  it('has $id field', () => {
    expect(typeof schema['$id']).toBe('string');
    expect((schema['$id'] as string).length).toBeGreaterThan(0);
  });

  it('declares type: object', () => {
    expect(schema['type']).toBe('object');
  });

  it('has additionalProperties: false (strict schema)', () => {
    expect(schema['additionalProperties']).toBe(false);
  });

  it('lists all required top-level fields', () => {
    const required = schema['required'] as string[];
    expect(required).toContain('schema_version');
    expect(required).toContain('event');
    expect(required).toContain('timestamp');
    expect(required).toContain('repository');
    expect(required).toContain('issue_number');
    expect(required).toContain('stellar_address');
    expect(required).toContain('result');
  });

  it('schema_version property enumerates only "1"', () => {
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    const svProp = props['schema_version'];
    expect(svProp['enum']).toEqual(['1']);
  });

  it('event property enumerates only "validation_complete"', () => {
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    const eventProp = props['event'];
    expect(eventProp['enum']).toEqual(['validation_complete']);
  });

  it('result property has additionalProperties: false', () => {
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(props['result']['additionalProperties']).toBe(false);
  });

  it('result.checks items have additionalProperties: false', () => {
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    const resultProps = props['result']['properties'] as Record<string, Record<string, unknown>>;
    const checksItems = resultProps['checks']['items'] as Record<string, unknown>;
    expect(checksItems['additionalProperties']).toBe(false);
  });

  it('stellar_address property has a redacted-format pattern', () => {
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    const addrProp = props['stellar_address'];
    expect(typeof addrProp['pattern']).toBe('string');
    // Pattern must require dots (redacted form), not allow a full 56-char address
    expect(addrProp['pattern'] as string).toContain('\\.');
  });
});

// ---------------------------------------------------------------------------
// Schema conformance: buildWebhookPayload output
// ---------------------------------------------------------------------------

describe('buildWebhookPayload conforms to webhook-payload schema', () => {
  it('passes check for a fully passing result', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 42);
    const violations = checkConformance(payload);
    expect(violations).toEqual([]);
  });

  it('passes check for a fully failing result', () => {
    const payload = buildWebhookPayload(failedResult, ADDRESS, 'owner/repo', 1);
    const violations = checkConformance(payload);
    expect(violations).toEqual([]);
  });

  it('passes check for a partial result (funded but no trustline)', () => {
    const payload = buildWebhookPayload(partialResult, ADDRESS, 'owner/repo', 99);
    const violations = checkConformance(payload);
    expect(violations).toEqual([]);
  });

  it('passes check when issue_number is null', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', null);
    const violations = checkConformance(payload);
    expect(violations).toEqual([]);
  });

  it('passes check for a different repository value', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'stellar-trust/bounty-board', 7);
    const violations = checkConformance(payload);
    expect(violations).toEqual([]);
  });

  it('schema_version is exactly "1" (string, not number)', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1);
    expect(payload.schema_version).toBe('1');
    expect(typeof payload.schema_version).toBe('string');
  });

  it('stellar_address in payload matches the redacted pattern', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1);
    expect(payload.stellar_address).toMatch(/^[GC][A-Z2-7]{3}\.{3}[A-Z2-7]{4}$/);
  });

  it('full Stellar address NEVER appears in the payload', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1);
    expect(JSON.stringify(payload)).not.toContain(ADDRESS);
  });

  it('result.valid is a native boolean, not a string', () => {
    const passing = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1);
    const failing = buildWebhookPayload(failedResult, ADDRESS, 'owner/repo', 1);
    expect(typeof passing.result.valid).toBe('boolean');
    expect(typeof failing.result.valid).toBe('boolean');
  });

  it('result.account_funded is a native boolean', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1);
    expect(typeof payload.result.account_funded).toBe('boolean');
  });

  it('result.trustline_exists is a native boolean', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1);
    expect(typeof payload.result.trustline_exists).toBe('boolean');
  });

  it('result.xlm_balance is a string', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1);
    expect(typeof payload.result.xlm_balance).toBe('string');
  });

  it('result.checks is an array of { label: string, passed: boolean }', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1);
    for (const check of payload.result.checks) {
      expect(typeof check.label).toBe('string');
      expect(typeof check.passed).toBe('boolean');
    }
  });

  it('result.checks does NOT include a "detail" field (no PII leak)', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1);
    for (const check of payload.result.checks) {
      // detail is stripped from the outbound webhook payload
      expect(Object.keys(check)).not.toContain('detail');
    }
  });

  it('timestamp is a valid ISO-8601 date-time', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1);
    const d = new Date(payload.timestamp);
    expect(isNaN(d.getTime())).toBe(false);
    expect(payload.timestamp).toBe(d.toISOString());
  });

  it('passes conformance check with an empty checks array (edge case)', () => {
    const emptyChecks = { ...passedResult, checks: [] };
    const payload = buildWebhookPayload(emptyChecks, ADDRESS, 'owner/repo', 1);
    const violations = checkConformance(payload);
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Negative conformance: mutated payloads MUST fail the schema check
// ---------------------------------------------------------------------------

describe('checkConformance rejects non-conformant payloads', () => {
  it('fails when schema_version is not "1"', () => {
    const payload = { ...buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1), schema_version: '2' as any };
    const violations = checkConformance(payload);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes('schema_version'))).toBe(true);
  });

  it('fails when event is an unknown value', () => {
    const payload = { ...buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1), event: 'unknown_event' as any };
    const violations = checkConformance(payload);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes('event'))).toBe(true);
  });

  it('fails when a required top-level field is missing', () => {
    const { timestamp: _ts, ...payload } = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1);
    const violations = checkConformance(payload);
    expect(violations.some((v) => v.includes('timestamp'))).toBe(true);
  });

  it('fails when stellar_address is not redacted (full address)', () => {
    const payload = { ...buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1), stellar_address: ADDRESS };
    const violations = checkConformance(payload);
    expect(violations.some((v) => v.includes('stellar_address'))).toBe(true);
  });

  it('fails when result.valid is a string instead of boolean', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1);
    (payload.result as any).valid = 'true';
    const violations = checkConformance(payload);
    expect(violations.some((v) => v.includes('result.valid'))).toBe(true);
  });

  it('fails when result.checks contains a non-boolean passed field', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1);
    (payload.result.checks[0] as any).passed = 'yes';
    const violations = checkConformance(payload);
    expect(violations.some((v) => v.includes('passed'))).toBe(true);
  });

  it('fails when issue_number is a negative integer', () => {
    const payload = { ...buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1), issue_number: -1 };
    const violations = checkConformance(payload);
    expect(violations.some((v) => v.includes('issue_number'))).toBe(true);
  });

  it('fails when result is missing entirely', () => {
    const { result: _r, ...payload } = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1);
    const violations = checkConformance(payload as any);
    expect(violations.some((v) => v.includes('result'))).toBe(true);
  });
});
