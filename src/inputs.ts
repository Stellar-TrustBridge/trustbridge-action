import * as fs from 'fs';
import * as path from 'path';

export function parseBooleanInput(value: string, defaultValue: boolean): boolean {
  if (value === undefined || value === '') {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

/**
 * Canonical list of input names declared in `action.yml`.
 *
 * Kept in sync with `action.yml` by the schema parity test
 * (`__tests__/inputs-schema-parity.test.ts`), which fails CI when an input is
 * added to one side only (Issue #769).
 */
export const DECLARED_INPUTS = [
  'skip_for_maintainers',
  'skip_if_maintainer',
  'assignee_address_map',
] as const;

export type DeclaredInput = (typeof DECLARED_INPUTS)[number];

/**
 * Result of {@link resolveMaintainerSkipInput}, carrying the resolved value
 * plus provenance so the action can emit a precise warning instead of
 * guessing which input the user meant.
 */
export interface MaintainerSkipResolution {
  /** Effective value used for the maintainer skip gate. */
  enabled: boolean;
  /** Which input supplied the effective value. */
  source: 'skip_for_maintainers' | 'skip_if_maintainer' | 'default';
  /** True when both inputs were supplied with conflicting boolean values. */
  conflict: boolean;
  /** True when the deprecated alias was used and the canonical input was not. */
  usedDeprecatedAlias: boolean;
}

const TRUTHY = ['true', '1', 'yes'];
const FALSY = ['false', '0', 'no'];

/**
 * Resolve the maintainer-skip input, honouring the canonical
 * `skip_for_maintainers` name and the deprecated `skip_if_maintainer` alias
 * (Issue #448).
 *
 * Precedence rules, in order:
 *
 * 1. `skip_for_maintainers` wins whenever it carries an explicit boolean.
 *    A caller who writes `skip_for_maintainers: false` alongside a stale
 *    `skip_if_maintainer: true` gets the explicit `false` — the canonical
 *    input is never silently overridden.
 * 2. The alias is consulted only when the canonical input is unset/empty.
 *    This is what makes the alias usable at all: `action.yml` gives the
 *    canonical input a `false` default, so "canonical is unset" is detected
 *    from the raw (pre-default) input string rather than from the parsed
 *    value.
 * 3. If neither is supplied, the value is `false` (opt-in only).
 *
 * When both are supplied with conflicting values, `conflict` is set so the
 * caller can warn; the canonical value is still the one used.
 *
 * @param canonicalValue Raw `skip_for_maintainers` input.
 * @param aliasValue     Raw `skip_if_maintainer` input.
 * @returns              Resolved value plus provenance.
 */
export function resolveMaintainerSkipInput(
  canonicalValue: string | undefined,
  aliasValue: string | undefined,
): MaintainerSkipResolution {
  const canonical = (canonicalValue ?? '').trim();
  const alias = (aliasValue ?? '').trim();

  const canonicalIsBoolean = TRUTHY.includes(canonical.toLowerCase())
    || FALSY.includes(canonical.toLowerCase());
  const aliasIsBoolean = TRUTHY.includes(alias.toLowerCase())
    || FALSY.includes(alias.toLowerCase());

  if (canonicalIsBoolean) {
    const enabled = parseBooleanInput(canonical, false);
    return {
      enabled,
      source: 'skip_for_maintainers',
      conflict: aliasIsBoolean && parseBooleanInput(alias, false) !== enabled,
      usedDeprecatedAlias: false,
    };
  }

  if (aliasIsBoolean) {
    return {
      enabled: parseBooleanInput(alias, false),
      source: 'skip_if_maintainer',
      conflict: false,
      usedDeprecatedAlias: true,
    };
  }

  return {
    enabled: false,
    source: 'default',
    conflict: false,
    usedDeprecatedAlias: false,
  };
}

export function parseNumberInput(
  value: string,
  defaultValue: number,
  options: { min?: number; max?: number } = {},
): number {
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }

  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a numeric input, but received: "${value}"`);
  }

  if (options.min !== undefined && parsed < options.min) {
    throw new Error(`Value must be at least ${options.min}. Received: ${parsed}`);
  }

  if (options.max !== undefined && parsed > options.max) {
    throw new Error(`Value must be at most ${options.max}. Received: ${parsed}`);
  }

  return parsed;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Maintainer-provided roster: GitHub username (assignee login) → Stellar G-address.
 * Keys are stored lowercased for case-insensitive GitHub username matching.
 */
export type AssigneeAddressMap = Record<string, string>;

export interface ParseAssigneeAddressMapOptions {
  /** Workspace root used when `raw` is a relative file path. Defaults to cwd. */
  workspaceRoot?: string;
}

/**
 * Parse `assignee_address_map` from either inline JSON or a path to a JSON file.
 *
 * Inline JSON must start with `{`. Anything else is treated as a file path
 * relative to `workspaceRoot` (or absolute).
 */
export function parseAssigneeAddressMap(
  raw: string,
  options: ParseAssigneeAddressMapOptions = {},
): AssigneeAddressMap {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return {};
  }

  // Inline JSON: objects/arrays, or bare JSON literals that should fail validation.
  // Anything else is treated as a file path relative to the workspace.
  const looksLikeInlineJson =
    trimmed.startsWith('{') ||
    trimmed.startsWith('[') ||
    trimmed === 'null' ||
    trimmed === 'true' ||
    trimmed === 'false' ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'));
  let jsonText = trimmed;
  if (!looksLikeInlineJson) {
    const root = options.workspaceRoot ?? process.cwd();
    const candidate = path.isAbsolute(trimmed) ? trimmed : path.join(root, trimmed);
    const resolvedPath = path.normalize(candidate);
    const resolvedRoot = path.normalize(root);

    if (
      !path.isAbsolute(trimmed) &&
      !resolvedPath.startsWith(resolvedRoot + path.sep) &&
      resolvedPath !== resolvedRoot
    ) {
      throw new Error(
        `assignee_address_map path resolves outside the workspace root: "${trimmed}"`,
      );
    }

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(
        `assignee_address_map file not found: "${trimmed}". ` +
          'Provide inline JSON ({"username":"G..."}) or a path to a roster JSON file.',
      );
    }

    try {
      jsonText = fs.readFileSync(resolvedPath, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read assignee_address_map file "${trimmed}": ${msg}`);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(
      'assignee_address_map must be valid JSON (object of GitHub username → G-address) ' +
        'or a path to such a file. Received invalid JSON.',
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'assignee_address_map must be a JSON object mapping GitHub usernames to Stellar G-addresses.',
    );
  }

  const result: AssigneeAddressMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const login = key.trim();
    if (!login) {
      throw new Error('assignee_address_map contains an empty username key.');
    }
    if (typeof value !== 'string') {
      throw new Error(
        `assignee_address_map entry for "${login}" must be a string Stellar G-address.`,
      );
    }
    result[login.toLowerCase()] = value.trim();
  }

  return result;
}

/**
 * Look up a Stellar address for an assignee login in a parsed roster map.
 * Throws an actionable error when the login is missing or not in the map.
 */
export function resolveAddressFromAssigneeMap(
  map: AssigneeAddressMap,
  assigneeLogin: string | undefined | null,
): string {
  const login = (assigneeLogin ?? '').trim();
  if (!login) {
    throw new Error(
      'assignee_address_map was provided but no assignee login was found in the GitHub event context. ' +
        'Use this input with `on: issues: types: [assigned]` (payload.assignee), ' +
        'or ensure the issue has at lea

/* … truncated 6851 chars — edit only what you need near the top … */
