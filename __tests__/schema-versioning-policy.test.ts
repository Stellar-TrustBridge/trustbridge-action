/**
 * Webhook and reason-code versioning policy (Issue #784).
 *
 * Keeps docs/SCHEMA.md, schemas/ and src/webhook.ts on the same version.
 */

import * as fs from 'fs';
import * as path from 'path';
import { WEBHOOK_SCHEMA_VERSION, validateWebhookPayload } from '../src/webhook';

const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const schemaDoc = read('docs/SCHEMA.md');
const webhookSchema = JSON.parse(read('schemas/webhook-payload.schema.json'));
const reasonCodes = JSON.parse(read('schemas/reason-codes.json'));

function documentedVersion(contract: string): string {
  const row = schemaDoc.split('\n').find((l) => l.startsWith(`| ${contract} |`));
  if (!row) throw new Error(`docs/SCHEMA.md versioning table has no "${contract}" row`);
  return row.split('|')[4].trim().replace(/`/g, '');
}

describe('schema versioning policy (Issue #784)', () => {
  it('documents the policy and links BREAKING_CHANGES.md', () => {
    expect(schemaDoc).toMatch(/## Webhook and reason-code versioning policy/);
    expect(schemaDoc).toContain('BREAKING_CHANGES.md');
    expect(read('docs/BREAKING_CHANGES.md')).toContain('SCHEMA.md#webhook-and-reason-code-versioning-policy');
  });

  it('keeps the webhook version aligned across docs, schema and runtime', () => {
    expect(documentedVersion('Webhook payload')).toBe(WEBHOOK_SCHEMA_VERSION);
    expect(webhookSchema.properties.schema_version.enum).toEqual([WEBHOOK_SCHEMA_VERSION]);
  });

  it('keeps the reason-code catalog version aligned with docs', () => {
    expect(documentedVersion('Reason codes')).toBe(reasonCodes.version);
  });

  it('records `since` on every reason code', () => {
    const missing = reasonCodes.codes.filter((c: any) => typeof c.since !== 'string' || c.since === '').map((c: any) => c.code);
    expect(missing).toEqual([]);
  });

  it('rejects payloads with an unknown schema_version', () => {
    const errors = validateWebhookPayload({ schema_version: '2' });
    expect(errors).toContain(`schema_version: must be "${WEBHOOK_SCHEMA_VERSION}"`);
  });

  it('fails with a clear error when a contract row is missing', () => {
    expect(() => documentedVersion('Nonexistent contract')).toThrow(/no "Nonexistent contract" row/);
  });
});
