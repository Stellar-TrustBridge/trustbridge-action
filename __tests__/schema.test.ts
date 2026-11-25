/**
 * Schema drift guard (Issue #103).
 *
 * Asserts that every input declared in action.yml has a corresponding
 * property in schemas/action-inputs.schema.json. Fails on the first
 * missing property so contributors know exactly what to add.
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadYamlInputKeys(actionYmlPath: string): string[] {
  const raw = fs.readFileSync(actionYmlPath, 'utf8');
  // Simple line-based parser — only needs to extract top-level input names
  // from the `inputs:` block (no YAML library required).
  const keys: string[] = [];
  let inInputs = false;

  for (const line of raw.split('\n')) {
    if (line.match(/^inputs:\s*$/)) {
      inInputs = true;
      continue;
    }
    if (inInputs) {
      // Stop when we hit the next top-level key (outputs:, runs:, etc.)
      if (line.match(/^[a-z]/) && !line.match(/^\s/)) {
        break;
      }
      // Two-space indented key = input name
      const match = line.match(/^  ([a-z_][a-z0-9_]*):\s*$/);
      if (match) {
        keys.push(match[1]);
      }
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..');
const ACTION_YML = path.join(ROOT, 'action.yml');
const SCHEMA_PATH = path.join(ROOT, 'schemas', 'action-inputs.schema.json');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Action input JSON schema (Issue #103)', () => {
  let schema: Record<string, unknown>;
  let schemaProperties: Record<string, unknown>;
  let actionInputKeys: string[];

  beforeAll(() => {
    const schemaRaw = fs.readFileSync(SCHEMA_PATH, 'utf8');
    schema = JSON.parse(schemaRaw) as Record<string, unknown>;
    schemaProperties = (schema.properties as Record<string, unknown>) ?? {};
    actionInputKeys = loadYamlInputKeys(ACTION_YML);
  });

  it('schema file exists at schemas/action-inputs.schema.json', () => {
    expect(fs.existsSync(SCHEMA_PATH)).toBe(true);
  });

  it('schema is valid JSON with a $schema field', () => {
    expect(schema['$schema']).toBeDefined();
  });

  it('schema has a properties object', () => {
    expect(typeof schemaProperties).toBe('object');
    expect(Object.keys(schemaProperties).length).toBeGreaterThan(0);
  });

  it('schema marks github_token as required', () => {
    const required = schema['required'] as string[] | undefined;
    expect(required).toBeDefined();
    expect(required).toContain('github_token');
  });

  it('every action.yml input has a schema property (drift guard)', () => {
    const missingFromSchema = actionInputKeys.filter(
      (key) => !(key in schemaProperties),
    );
    expect(missingFromSchema).toEqual([]);
  });

  it('security-sensitive URL fields have https pattern', () => {
    for (const field of ['horizon_url', 'horizon_url_fallback', 'webhook_url']) {
      if (field in schemaProperties) {
        const prop = schemaProperties[field] as Record<string, unknown>;
        expect(prop.pattern as string).toMatch(/https/);
      }
    }
  });

  it('stellar_address_input has G-address pattern', () => {
    if ('stellar_address_input' in schemaProperties) {
      const prop = schemaProperties['stellar_address_input'] as Record<string, unknown>;
      expect(prop.pattern).toBeDefined();
      expect(prop.pattern as string).toContain('G');
    }
  });

  it('asset_issuer allows both G and C addresses', () => {
    if ('asset_issuer' in schemaProperties) {
      const prop = schemaProperties['asset_issuer'] as Record<string, unknown>;
      expect(prop.pattern as string).toMatch(/\[GC\]/);
    }
  });

  it('boolean-string inputs use enum ["true","false"]', () => {
    const boolFields = [
      'fail_on_missing',
      'debug_mode',
      'sticky_comment',
      'use_cache',
      'wait_until_funded',
      'auto_wallet_labels',
    ];
    for (const field of boolFields) {
      if (field in schemaProperties) {
        const prop = schemaProperties[field] as Record<string, unknown>;
        expect(prop.enum).toEqual(['true', 'false']);
      }
    }
  });

  it('numeric string fields have a numeric pattern', () => {
    const numericFields = [
      'horizon_timeout_ms',
      'max_retries',
      'retry_base_delay_ms',
      'retry_max_delay_ms',
      'webhook_timeout_ms',
    ];
    for (const field of numericFields) {
      if (field in schemaProperties) {
        const prop = schemaProperties[field] as Record<string, unknown>;
        expect(prop.pattern as string).toMatch(/\^.*\[0-9\]/);
      }
    }
  });

  it('webhook_url field has description noting HTTPS requirement', () => {
    if ('webhook_url' in schemaProperties) {
      const prop = schemaProperties['webhook_url'] as Record<string, unknown>;
      expect((prop.description as string).toLowerCase()).toContain('https');
    }
  });

  it('webhook_secret field description mentions it is never logged', () => {
    if ('webhook_secret' in schemaProperties) {
      const prop = schemaProperties['webhook_secret'] as Record<string, unknown>;
      expect((prop.description as string).toLowerCase()).toContain('never logged');
    }
  });

  it('schema additionalProperties is false', () => {
    expect(schema['additionalProperties']).toBe(false);
  });

  it('schema $id points to the expected GitHub raw URL', () => {
    expect(schema['$id']).toContain('trustbridge-action');
    expect(schema['$id']).toContain('schemas/action-inputs.schema.json');
  });
});
