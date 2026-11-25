/**
 * SARIF 2.1.0 JSON Schema validation (Issue #679).
 *
 * The official OASIS SARIF 2.1.0 schema (errata01, JSON Schema draft-04) is
 * vendored at `schemas/sarif-schema-2.1.0.json` and read from disk — never
 * fetched at runtime — so validation also works on air-gapped runners and
 * GHES. `ncc` relocates the file next to `dist/index.js` because it is loaded
 * through `path.join(__dirname, ...)`.
 *
 * Rather than bundling a full JSON Schema engine, this module implements the
 * draft-04 keyword subset the SARIF schema actually uses: `$ref` (local
 * `#/definitions/*` pointers), `type`, `enum`, `required`, `properties`,
 * `additionalProperties`, `items`, `minItems`, `uniqueItems`, `minimum`,
 * `maximum`, `pattern`, `format` (`uri`, `date-time`), `anyOf` and `oneOf`.
 * Annotation-only keywords (`description`, `default`, `title`, …) are ignored.
 * `__tests__/sarif.test.ts` locks that list against the vendored schema, so
 * re-vendoring a schema that introduces a new keyword fails CI instead of
 * silently skipping it.
 */

import * as fs from 'fs';
import * as path from 'path';

/** File name of the vendored schema under `schemas/`. */
export const SARIF_SCHEMA_FILE = 'sarif-schema-2.1.0.json';

/** Validation keywords this validator enforces. */
export const SUPPORTED_SCHEMA_KEYWORDS = [
  '$ref',
  'type',
  'enum',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'minItems',
  'uniqueItems',
  'minimum',
  'maximum',
  'pattern',
  'format',
  'anyOf',
  'oneOf',
] as const;

/** Keywords that carry no validation semantics and are safely ignored. */
export const ANNOTATION_SCHEMA_KEYWORDS = [
  '$schema',
  'id',
  'title',
  'description',
  'default',
  'definitions',
] as const;

/** Stop collecting after this many violations to bound work on huge payloads. */
export const MAX_SARIF_SCHEMA_ERRORS = 50;

export type JsonSchema = { [keyword: string]: unknown };

let cachedSchema: JsonSchema | undefined;

/**
 * Load (and memoise) the vendored SARIF 2.1.0 JSON Schema.
 *
 * @throws {Error} When the vendored file is missing or not valid JSON.
 */
export function loadSarifJsonSchema(): JsonSchema {
  if (!cachedSchema) {
    const schemaPath = path.join(__dirname, '..', 'schemas', SARIF_SCHEMA_FILE);
    cachedSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as JsonSchema;
  }
  return cachedSchema;
}

interface ValidationContext {
  root: JsonSchema;
  errors: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'null':
      return value === null;
    default:
      return false;
  }
}

/** Key-order independent serialisation used for `enum` and `uniqueItems`. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const URI_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s]*$/;
const DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;

function matchesFormat(value: string, format: string): boolean {
  switch (format) {
    case 'uri':
      return URI_PATTERN.test(value);
    case 'date-time':
      return DATE_TIME_PATTERN.test(value) && !isNaN(Date.parse(value));
    default:
      // `uri-reference` and unknown formats are not asserted (draft-04 allows
      // validators to treat `format` as an annotation).
      return true;
  }
}

function resolveRef(root: JsonSchema, ref: string): JsonSchema | undefined {
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = root;
  for (const rawPart of ref.slice(2).split('/')) {
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isPlainObject(node)) return undefined;
    node = node[part];
  }
  return isPlainObject(node) ? node : undefined;
}

function childPath(base: string, key: string | number): string {
  if (typeof key === 'number') return `${base}[${key}]`;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;
}

function countErrors(
  value: unknown,
  schema: JsonSchema,
  at: string,
  ctx: ValidationContext,
): number {
  const sub: ValidationContext = { root: ctx.root, errors: [] };
  validateNode(value, schema, at, sub);
  return sub.errors.length;
}

function validateNode(
  value: unknown,
  schema: JsonSchema,
  at: string,
  ctx: ValidationContext,
): void {
  if (ctx.errors.length >= MAX_SARIF_SCHEMA_ERRORS) return;

  // draft-04: `$ref` replaces every sibling keyword.
  if (typeof schema.$ref === 'string') {
    const target = resolveRef(ctx.root, schema.$ref);
    if (!target) {
      ctx.errors.push(`${at}: unresolvable schema reference "${schema.$ref}"`);
      return;
    }
    validateNode(value, target, at, ctx);
    return;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((t) => matchesType(value, t))) {
      ctx.errors.push(`${at}: must be of type ${types.join(' | ')}`);
      return;
    }
  }

  if (Array.isArray(schema.enum)) {
    const actual = canonicalJson(value);
    if (!schema.enum.some((candidate) => canonicalJson(candidate) === actual)) {
      ctx.errors.push(
        `${at}: must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`,
      );
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      ctx.errors.push(`${at}: must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      ctx.errors.push(`${at}: must be <= ${schema.maximum}`);
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      ctx.errors.push(`${at}: must match pattern ${schema.pattern}`);
    }
    if (typeof schema.format === 'string' && !matchesFormat(value, schema.format)) {
      ctx.errors.push(`${at}: must be a valid ${schema.format}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      ctx.errors.push(`${at}: must contain at least ${schema.minItems} item(s)`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set<string>();
      value.forEach((item, idx) => {
        const key = canonicalJson(item);
        if (seen.has(key)) ctx.errors.push(`${childPath(at, idx)}: duplicate item (uniqueItems)`);
        seen.add(key);
      });
    }
    if (isPlainObject(schema.items)) {
      const itemSchema = schema.items;
      value.forEach((item, idx) => validateNode(item, itemSchema, childPath(at, idx), ctx));
    } else if (Array.isArray(schema.items)) {
      (schema.items as JsonSchema[]).forEach((itemSchema, idx) => {
        if (idx < value.length) validateNode(value[idx], itemSchema, childPath(at, idx), ctx);
      });
    }
  }

  if (isPlainObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const field of schema.required as string[]) {
        if (!(field in value)) ctx.errors.push(`${at}: missing required property "${field}"`);
      }
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const [key, child] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (isPlainObject(propertySchema)) {
        validateNode(child, propertySchema, childPath(at, key), ctx);
      } else if (schema.additionalProperties === false) {
        ctx.errors.push(`${at}: unexpected property "${key}"`);
      } else if (isPlainObject(schema.additionalProperties)) {
        validateNode(child, schema.additionalProperties, childPath(at, key), ctx);
      }
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as JsonSchema[];
    if (!branches.some((branch) => countErrors(value, branch, at, ctx) === 0)) {
      ctx.errors.push(`${at}: must match at least one schema in anyOf`);
    }
  }

  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf as JsonSchema[];
    const matches = branches.filter((branch) => countErrors(value, branch, at, ctx) === 0).length;
    if (matches !== 1) {
      ctx.errors.push(`${at}: must match exactly one schema in oneOf (matched ${matches})`);
    }
  }
}

/**
 * Validate `value` against a JSON Schema (draft-04 subset, see module docs).
 *
 * @returns Human-readable violations such as
 *   `$.runs[0].tool.driver: missing required property "name"`; empty when valid.
 *   At most {@link MAX_SARIF_SCHEMA_ERRORS} entries are returned.
 */
export function validateAgainstJsonSchema(value: unknown, schema: JsonSchema): string[] {
  const ctx: ValidationContext = { root: schema, errors: [] };
  validateNode(value, schema, '$', ctx);
  return ctx.errors.slice(0, MAX_SARIF_SCHEMA_ERRORS);
}
