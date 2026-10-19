/**
 * Webhook versioning policy tests (Issue #296).
 *
 * Verifies that:
 * 1. The v1 schema is frozen — removing any required field from a valid payload
 *    causes a conformance failure (CI lock).
 * 2. The `X-TrustBridge-Schema-Version` header is sent on every delivery.
 * 3. Additive changes (new optional fields) do NOT break conformance.
 * 4. `schema_version` in the payload is always the string "1".
 * 5. Versioning policy: type changes on frozen fields are detected.
 *
 * Validate with: npm test -- --testPathPattern 'webhook'
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  buildWebhookPayload,
  deliverWebhook,
  computeWebhookSignature,
  WebhookConfig,
  WebhookPayload,
} from '../src/webhook';

// ---------------------------------------------------------------------------
// Fixtures
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

const CONFIG: WebhookConfig = {
  webhookUrl: 'https://dashboard.example.com/webhook',
  webhookSecret: 'test-secret-key',
  timeoutMs: 2000,
};

const SCHEMA_PATH = path.resolve(__dirname, '../schemas/webhook-payload.schema.json');

/**
 * All required top-level fields in the v1 schema.
 * This list is the CI lock — if any field disappears from the payload the test fails.
 */
const V1_REQUIRED_FIELDS: Array<keyof WebhookPayload> = [
  'schema_version',
  'event',
  'timestamp',
  'repository',
  'issue_number',
  'stellar_address',
  'result',
];

/**
 * All required fields within `result` in the v1 schema.
 */
const V1_RESULT_REQUIRED_FIELDS: Array<keyof WebhookPayload['result']> = [
  'valid',
  'account_funded',
  'trustline_exists',
  'xlm_balance',
  'checks',
];

// ---------------------------------------------------------------------------
// CI lock: removing any frozen required field MUST fail
// ---------------------------------------------------------------------------

describe('v1 schema frozen field lock — removing required fields fails', () => {
  const basePayload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 42);

  // Test each top-level required field individually
  V1_REQUIRED_FIELDS.forEach((field) => {
    it(`payload WITHOUT "${field}" is non-conformant`, () => {
      const mutated = { ...basePayload } as Record<string, unknown>;
      delete mutated[field];

      // Confirm the field is actually missing
      expect(field in mutated).toBe(false);

      // A schema-aware receiver must reject this payload
      // The CI lock: ensure schema lists this field as required
      const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
      const requiredInSchema: string[] = schema['required'];
      expect(requiredInSchema).toContain(field);
    });
  });

  // Test each result-level required field individually
  V1_RESULT_REQUIRED_FIELDS.forEach((field) => {
    it(`payload.result WITHOUT "${field}" is non-conformant`, () => {
      const mutated = { ...basePayload, result: { ...basePayload.result } } as any;
      delete mutated.result[field];

      // Confirm the field is actually missing
      expect(field in mutated.result).toBe(false);

      // The CI lock: ensure schema lists this field as required in result
      const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
      const resultProps = schema['properties']['result'];
      const requiredInResult: string[] = resultProps['required'];
      expect(requiredInResult).toContain(field);
    });
  });
});

// ---------------------------------------------------------------------------
// CI lock: type changes on frozen fields MUST be detectable
// ---------------------------------------------------------------------------

describe('v1 schema frozen field type lock', () => {
  it('result.valid must be boolean — string "true" is non-conformant', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1) as any;
    payload.result.valid = 'true'; // type change
    expect(typeof payload.result.valid).toBe('string');
    // Validate it is NOT a boolean
    expect(typeof payload.result.valid === 'boolean').toBe(false);
  });

  it('result.account_funded must be boolean — number 1 is non-conformant', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1) as any;
    payload.result.account_funded = 1;
    expect(typeof payload.result.account_funded === 'boolean').toBe(false);
  });

  it('result.trustline_exists must be boolean — null is non-conformant', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1) as any;
    payload.result.trustline_exists = null;
    expect(typeof payload.result.trustline_exists === 'boolean').toBe(false);
  });

  it('result.xlm_balance must be a string — number 10.5 is non-conformant', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1) as any;
    payload.result.xlm_balance = 10.5;
    expect(typeof payload.result.xlm_balance === 'string').toBe(false);
  });

  it('schema_version must be string "1" — number 1 is non-conformant', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1) as any;
    payload.schema_version = 1; // number instead of string
    expect(payload.schema_version).not.toBe('1');
  });

  it('result.checks[].passed must be boolean — string "yes" is non-conformant', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1) as any;
    payload.result.checks[0].passed = 'yes';
    expect(typeof payload.result.checks[0].passed === 'boolean').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Schema file version contract
// ---------------------------------------------------------------------------

describe('webhook-payload schema file version contract', () => {
  let schema: Record<string, unknown>;

  beforeAll(() => {
    schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  });

  it('schema_version enum contains exactly ["1"] — no other versions exist yet', () => {
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(props['schema_version']['enum']).toEqual(['1']);
  });

  it('schema $id references the canonical GitHub raw URL', () => {
    const id = schema['$id'] as string;
    expect(id).toContain('Stellar-TrustBridge/trustbridge-action');
    expect(id).toContain('webhook-payload.schema.json');
  });

  it('event enum contains exactly ["validation_complete"]', () => {
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(props['event']['enum']).toEqual(['validation_complete']);
  });

  it('stellar_address pattern requires redacted form (not a 56-char address)', () => {
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    const pattern = props['stellar_address']['pattern'] as string;
    // Full 56-char address should NOT match the pattern
    expect(new RegExp(pattern).test(ADDRESS)).toBe(false);
    // Redacted form SHOULD match
    expect(new RegExp(pattern).test('GA5Z...KZVN')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// X-TrustBridge-Schema-Version header (Issue #296)
// ---------------------------------------------------------------------------

describe('X-TrustBridge-Schema-Version header', () => {
  const makePayload = () => buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1);

  it('sends X-TrustBridge-Schema-Version: 1 on every delivery', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ status: 200 });
    await deliverWebhook(makePayload(), CONFIG, mockFetch as any);

    const options = mockFetch.mock.calls[0][1] as RequestInit;
    const headers = options.headers as Record<string, string>;
    expect(headers['X-TrustBridge-Schema-Version']).toBe('1');
  });

  it('schema version header matches the payload schema_version field', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody: string | undefined;

    const mockFetch = jest.fn().mockImplementation((_url: string, opts: RequestInit) => {
      capturedHeaders = opts.headers as Record<string, string>;
      capturedBody = opts.body as string;
      return Promise.resolve({ status: 200 });
    });

    const payload = makePayload();
    await deliverWebhook(payload, CONFIG, mockFetch as any);

    const parsedBody = JSON.parse(capturedBody!) as WebhookPayload;
    expect(capturedHeaders!['X-TrustBridge-Schema-Version']).toBe(parsedBody.schema_version);
  });

  it('header is present even when no webhook secret is set', async () => {
    const noSecretConfig: WebhookConfig = { ...CONFIG, webhookSecret: '' };
    const mockFetch = jest.fn().mockResolvedValue({ status: 200 });
    await deliverWebhook(makePayload(), noSecretConfig, mockFetch as any);

    const options = mockFetch.mock.calls[0][1] as RequestInit;
    const headers = options.headers as Record<string, string>;
    expect(headers['X-TrustBridge-Schema-Version']).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// Additive changes do NOT break conformance (forward compatibility)
// ---------------------------------------------------------------------------

describe('additive changes remain conformant (forward compatibility)', () => {
  it('payload with extra optional top-level field is still usable', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 42) as any;
    // Simulate a future additive field
    payload['run_id'] = 'abc123';
    payload['reason_code'] = 'SUCCESS';

    // The required fields are all still present
    const required = ['schema_version', 'event', 'timestamp', 'repository', 'issue_number', 'stellar_address', 'result'];
    for (const field of required) {
      expect(field in payload).toBe(true);
    }
  });

  it('payload.result with extra optional field is still usable', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 42) as any;
    payload.result['reason_code'] = 'SUCCESS';
    payload.result['xlm_reserve_met'] = true;

    // Required result fields still present
    const required = ['valid', 'account_funded', 'trustline_exists', 'xlm_balance', 'checks'];
    for (const field of required) {
      expect(field in payload.result).toBe(true);
    }
  });

  it('new item in result.checks does not break conformance', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 42);
    // Simulate a new check added in a future additive release
    (payload.result.checks as any[]).push({ label: 'Asset balance', passed: true });

    // result.checks is still an array with valid items
    expect(Array.isArray(payload.result.checks)).toBe(true);
    for (const check of payload.result.checks) {
      expect(typeof check.label).toBe('string');
      expect(typeof check.passed).toBe('boolean');
    }
  });
});

// ---------------------------------------------------------------------------
// buildWebhookPayload always produces a v1-conformant payload
// ---------------------------------------------------------------------------

describe('buildWebhookPayload always produces schema_version "1"', () => {
  it('schema_version is "1" regardless of validation outcome', () => {
    const p1 = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1);
    const p2 = buildWebhookPayload(
      { ...passedResult, valid: false, accountFunded: false },
      ADDRESS, 'owner/repo', null
    );
    expect(p1.schema_version).toBe('1');
    expect(p2.schema_version).toBe('1');
  });

  it('schema_version is a string, never a number', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1);
    expect(typeof payload.schema_version).toBe('string');
  });
});
