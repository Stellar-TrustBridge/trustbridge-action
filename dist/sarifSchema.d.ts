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
/** File name of the vendored schema under `schemas/`. */
export declare const SARIF_SCHEMA_FILE = "sarif-schema-2.1.0.json";
/** Validation keywords this validator enforces. */
export declare const SUPPORTED_SCHEMA_KEYWORDS: readonly ["$ref", "type", "enum", "required", "properties", "additionalProperties", "items", "minItems", "uniqueItems", "minimum", "maximum", "pattern", "format", "anyOf", "oneOf"];
/** Keywords that carry no validation semantics and are safely ignored. */
export declare const ANNOTATION_SCHEMA_KEYWORDS: readonly ["$schema", "id", "title", "description", "default", "definitions"];
/** Stop collecting after this many violations to bound work on huge payloads. */
export declare const MAX_SARIF_SCHEMA_ERRORS = 50;
export type JsonSchema = {
    [keyword: string]: unknown;
};
/**
 * Load (and memoise) the vendored SARIF 2.1.0 JSON Schema.
 *
 * @throws {Error} When the vendored file is missing or not valid JSON.
 */
export declare function loadSarifJsonSchema(): JsonSchema;
/**
 * Validate `value` against a JSON Schema (draft-04 subset, see module docs).
 *
 * @returns Human-readable violations such as
 *   `$.runs[0].tool.driver: missing required property "name"`; empty when valid.
 *   At most {@link MAX_SARIF_SCHEMA_ERRORS} entries are returned.
 */
export declare function validateAgainstJsonSchema(value: unknown, schema: JsonSchema): string[];
