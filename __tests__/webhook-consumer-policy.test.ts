/**
 * Issue #917 — webhook payload versioning policy for additive fields.
 *
 * Locks the receiver rules documented in docs/SCHEMA.md ("Webhook payload
 * versioning policy") to the reference reader `readWebhookPayloadForConsumer`
 * in src/webhook.ts, and keeps docs/SCHEMA.md, docs/BREAKING_CHANGES.md,
 * docs/USAGE.md and the runtime field lists consistent.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  buildWebhookPayload,
  readWebhookPayloadForConsumer,
  validateWebhookPayload,
  WEBHOOK_ASSET_REASON_CODES,
  WEBHOOK_CHECK_REQUIRED_FIELDS,
  WEBHOOK_CONSUMER_ERROR_CODES,
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOK_MAX_IGNORED_FIELDS_LISTED,
  WEBHOOK_PAYLOAD_OPTIONAL_FIELDS,
  WEBHOOK_PAYLOAD_REQUIRED_FIELDS,
  WEBHOOK_RESULT_REQUIRED_FIELDS,
  WEBHOOK_SCHEMA_VERSION,
  WEBHOOK_SUPPORTED_SCHEMA_VERSIONS,
  WEBHOOK_TRUNCATABLE_FIELDS,
} from '../src/webhook';

const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const schemaDoc = read('docs/SCHEMA.md');
const breakingDoc = read('docs/BREAKING_CHANGES.md');
const usageDoc = read('docs/USAGE.md');
const webhookSchema = JSON.parse(read('schemas/webhook-payload.schema.json'));

const ADDRESS = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

function basePayload(): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(
      buildWebhookPayload(
        {
          valid: true,
          accountFunded: true,
          trustlineExists: true,
          xlmBalance: '10.5000000',
          checks: [{ label: 'Account funded', passed: true, detail: 'ok' }],
        } as never,
        ADDRESS,
        'acme/payouts',
        42,
      ),
    ),
  );
}

/** The policy section of docs/SCHEMA.md, up to the next `### ` heading. */
function policySection(): string {
  const start = schemaDoc.indexOf('### Webhook payload versioning policy (Issue #917)');
  if (start === -1) throw new Error('docs/SCHEMA.md is missing the Issue #917 policy section');
  const rest = schemaDoc.slice(start + 1);
  const end = rest.search(/\n### /);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('readWebhookPayloadForConsumer — happy path (Issue #917)', () => {
  it('accepts a current producer payload with nothing ignored', () => {
    const result = readWebhookPayloadForConsumer(JSON.stringify(basePayload()));
    expect(result).toMatchObject({ ok: true, ignoredFields: [], unknownReasonCodes: [] });
  });

  it('ignores unknown fields at every level and drops them from the payload', () => {
    const payload = basePayload();
    payload.run_id = '9876543210';
    (payload.result as Record<string, unknown>).score = 0.97;
    ((payload.result as Record<string, unknown>).checks as Array<Record<string, unknown>>)[0].duration_ms = 12;

    const result = readWebhookPayloadForConsumer(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ignoredFields).toEqual(['payload.run_id', 'result.score', 'result.checks[0].duration_ms']);
    expect(result.payload).not.toHaveProperty('run_id');
    expect(result.payload.result).not.toHaveProperty('score');
    expect(result.payload.result.checks[0]).toEqual({ label: 'Account funded', passed: true });
    // The reduced payload is valid under the strict producer check.
    expect(validateWebhookPayload(result.payload)).toEqual([]);
  });

  it('tolerates unknown asset reason codes and dropped_fields values', () => {
    const payload = basePayload();
    payload.assets = [
      {
        asset_code: 'EURC',
        asset_issuer: 'GDHU...7JQB',
        primary: false,
        trustline_exists: true,
        clawback_enabled: false,
        reason_code: 'TRUSTLINE_FROZEN',
        limit: '1000',
      },
    ];
    payload.truncated = true;
    payload.dropped_fields = ['assets', 'result.annotations'];

    const result = readWebhookPayloadForConsumer(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownReasonCodes).toEqual(['TRUSTLINE_FROZEN', 'result.annotations']);
    expect(result.ignoredFields).toEqual(['assets[0].limit']);
    expect(result.payload.assets?.[0].reason_code).toBe('TRUSTLINE_FROZEN');
  });

  it('accepts the worked example from docs/SCHEMA.md exactly as documented', () => {
    const match = policySection().match(/```json\n([\s\S]*?)\n```/);
    expect(match).not.toBeNull();
    const result = readWebhookPayloadForConsumer((match as RegExpMatchArray)[1]);
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        ignoredFields: ['payload.run_id', 'result.checks[0].duration_ms'],
        unknownReasonCodes: ['TRUSTLINE_FROZEN'],
      }),
    );
  });

  it('caps the listed ignored fields', () => {
    const payload = basePayload();
    for (let i = 0; i < WEBHOOK_MAX_IGNORED_FIELDS_LISTED + 5; i++) payload[`extra_${i}`] = i;
    const result = readWebhookPayloadForConsumer(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ignoredFields).toHaveLength(WEBHOOK_MAX_IGNORED_FIELDS_LISTED + 1);
    expect(result.ignoredFields[result.ignoredFields.length - 1]).toBe('...and 5 more');
  });
});

describe('readWebhookPayloadForConsumer — failure paths (Issue #917)', () => {
  it('rejects an unsupported schema_version with a stable code', () => {
    const payload = { ...basePayload(), schema_version: '2' };
    expect(readWebhookPayloadForConsumer(payload)).toEqual({
      ok: false,
      code: 'WEBHOOK_SCHEMA_VERSION_UNSUPPORTED',
      errors: ['schema_version: "2" is not supported (supported: 1)'],
    });
  });

  it.each([
    ['numeric schema_version', { schema_version: 1 }, 'schema_version: missing or not a string'],
    ['missing schema_version', {}, 'schema_version: missing or not a string'],
  ])('rejects %s as malformed', (_label, override, error) => {
    const payload = { ...basePayload(), ...override } as Record<string, unknown>;
    if (!('schema_version' in override)) delete payload.schema_version;
    expect(readWebhookPayloadForConsumer(payload)).toEqual({
      ok: false,
      code: 'WEBHOOK_PAYLOAD_MALFORMED',
      errors: [error],
    });
  });

  it('rejects a retyped frozen field even though unknown fields are tolerated', () => {
    const payload = basePayload();
    (payload.result as Record<string, unknown>).valid = 'true';
    payload.run_id = 'ignored';
    const result = readWebhookPayloadForConsumer(payload);
    expect(result).toEqual({
      ok: false,
      code: 'WEBHOOK_PAYLOAD_MALFORMED',
      errors: ['result.valid: must be a boolean'],
    });
  });

  it('rejects a missing frozen field', () => {
    const payload = basePayload();
    delete payload.repository;
    const result = readWebhookPayloadForConsumer(payload);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('WEBHOOK_PAYLOAD_MALFORMED');
    expect(result.errors).toContain('payload: missing required property "repository"');
  });

  it.each([
    ['empty body', ''],
    ['invalid JSON', '{"schema_version": "1",'],
    ['JSON array', '[]'],
    ['JSON null', 'null'],
  ])('rejects %s as malformed', (_label, body) => {
    const result = readWebhookPayloadForConsumer(body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('WEBHOOK_PAYLOAD_MALFORMED');
  });

  it('rejects an oversized body before parsing it', () => {
    const body = JSON.stringify({ ...basePayload(), padding: 'x'.repeat(WEBHOOK_MAX_BODY_BYTES) });
    expect(readWebhookPayloadForConsumer(body)).toEqual({
      ok: false,
      code: 'WEBHOOK_PAYLOAD_TOO_LARGE',
      errors: [`body: exceeds ${WEBHOOK_MAX_BODY_BYTES} bytes`],
    });
  });

  it('does not echo a long hostile schema_version back in full', () => {
    const result = readWebhookPayloadForConsumer({ ...basePayload(), schema_version: 'v'.repeat(5_000) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].length).toBeLessThan(200);
  });

  it('never throws on arbitrary input', () => {
    for (const input of [undefined, 0, true, Symbol('x'), () => 1, new Date()]) {
      expect(() => readWebhookPayloadForConsumer(input)).not.toThrow();
      expect(readWebhookPayloadForConsumer(input).ok).toBe(false);
    }
  });
});

describe('versioning policy docs stay consistent with runtime (Issue #917)', () => {
  const section = policySection();

  it('supported versions match the producer version and schema enum', () => {
    expect(WEBHOOK_SUPPORTED_SCHEMA_VERSIONS).toEqual([WEBHOOK_SCHEMA_VERSION]);
    expect(webhookSchema.properties.schema_version.enum).toEqual([...WEBHOOK_SUPPORTED_SCHEMA_VERSIONS]);
  });

  it('documents every frozen and optional field in the field-classes table', () => {
    for (const field of [
      ...WEBHOOK_PAYLOAD_REQUIRED_FIELDS,
      ...WEBHOOK_RESULT_REQUIRED_FIELDS,
      ...WEBHOOK_CHECK_REQUIRED_FIELDS,
      ...WEBHOOK_PAYLOAD_OPTIONAL_FIELDS,
    ]) {
      expect(section).toContain(`\`${field}\``);
    }
  });

  it('every optional runtime field is optional in the JSON schema', () => {
    for (const field of WEBHOOK_PAYLOAD_OPTIONAL_FIELDS) {
      expect(webhookSchema.properties).toHaveProperty(field);
      expect(webhookSchema.required).not.toContain(field);
    }
  });

  it('documents every consumer error code in SCHEMA.md, BREAKING_CHANGES.md and USAGE.md', () => {
    for (const code of WEBHOOK_CONSUMER_ERROR_CODES) {
      expect(section).toContain(`\`${code}\``);
      expect(breakingDoc).toContain(code);
      expect(usageDoc).toContain(code);
    }
  });

  it('cross-links the policy from BREAKING_CHANGES.md and USAGE.md', () => {
    expect(breakingDoc).toContain('SCHEMA.md#webhook-payload-versioning-policy-issue-917');
    expect(usageDoc).toContain('SCHEMA.md#webhook-payload-versioning-policy-issue-917');
  });

  it('closed value sets named in the policy match the runtime lists', () => {
    expect(section).toContain('WEBHOOK_ASSET_REASON_CODES');
    expect(section).toContain('WEBHOOK_TRUNCATABLE_FIELDS');
    expect(WEBHOOK_ASSET_REASON_CODES.length).toBeGreaterThan(0);
    expect(WEBHOOK_TRUNCATABLE_FIELDS.length).toBeGreaterThan(0);
  });
});
