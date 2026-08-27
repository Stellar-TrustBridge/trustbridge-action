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
        'or ensure the issue has at least one assignee.',
    );
  }

  const address = map[login.toLowerCase()];
  if (!address) {
    throw new Error(
      `Assignee "${login}" is not present in assignee_address_map. ` +
        'Add an entry for this GitHub username mapping to their Stellar G-address, ' +
        'or pass stellar_address_input explicitly instead of using the roster map.',
    );
  }

  return address;
}

export type UnauthorizedTrustlinePolicy = 'fail' | 'warn' | 'ignore';

/**
 * Parses the `unauthorized_trustline_policy` input, which controls how a
 * trustline that exists but is not yet authorized by the issuer
 * (AUTHORIZATION_REQUIRED) is treated:
 *   - "fail"   — the trustline check does not pass; readiness outputs
 *                reflect the stricter meaning.
 *   - "warn"   — the trustline check still passes, but a warning is added
 *                to the comment. This is the safe default: it surfaces the
 *                risk without breaking existing green workflows.
 *   - "ignore" — no additional check or warning (pre-#72 behavior).
 */
export function parseUnauthorizedTrustlinePolicy(value: string): UnauthorizedTrustlinePolicy {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return 'warn';
  }
  if (normalized === 'fail' || normalized === 'warn' || normalized === 'ignore') {
    return normalized;
  }
  throw new Error(
    `unauthorized_trustline_policy must be one of "fail", "warn", or "ignore". Received: "${value}"`,
  );
}


// ---------------------------------------------------------------------------
// #147 — TRUSTBRIDGE_* environment variable support
// ---------------------------------------------------------------------------

/**
 * Mapping of TRUSTBRIDGE_* environment variable names to action input names.
 * Explicit `with:` values always win; env is only used when with: is empty.
 */
export const TRUSTBRIDGE_ENV_MAP: Record<string, string> = {
  TRUSTBRIDGE_HORIZON_URL: 'horizon_url',
  TRUSTBRIDGE_HORIZON_URL_FALLBACK: 'horizon_url_fallback',
  TRUSTBRIDGE_RPC_FALLBACK_URL: 'rpc_fallback_url',
  TRUSTBRIDGE_ASSET_CODE: 'asset_code',
  TRUSTBRIDGE_ASSET_ISSUER: 'asset_issuer',
  TRUSTBRIDGE_MIN_XLM_RESERVE: 'min_xlm_reserve',
  TRUSTBRIDGE_FAIL_ON_MISSING: 'fail_on_missing',
  TRUSTBRIDGE_DEBUG_MODE: 'debug_mode',
  TRUSTBRIDGE_HORIZON_TIMEOUT_MS: 'horizon_timeout_ms',
  TRUSTBRIDGE_STICKY_COMMENT: 'sticky_comment',
  TRUSTBRIDGE_WAIT_UNTIL_FUNDED: 'wait_until_funded',
  TRUSTBRIDGE_WAIT_UNTIL_FUNDED_TIMEOUT_MS: 'wait_until_funded_timeout_ms',
  TRUSTBRIDGE_WAIT_UNTIL_FUNDED_INTERVAL_MS: 'wait_until_funded_interval_ms',
  TRUSTBRIDGE_HORIZON_CACHE_TTL_MS: 'horizon_cache_ttl_ms',
  TRUSTBRIDGE_USE_CACHE: 'use_cache',
  TRUSTBRIDGE_LOG_INPUTS: 'log_inputs',
  TRUSTBRIDGE_PREFLIGHT_ONLY: 'preflight_only',
  TRUSTBRIDGE_UNASSIGN_ON_NOT_READY: 'unassign_on_not_ready',
};

/**
 * Resolve an action input with TRUSTBRIDGE_* env fallback.
 */
export function resolveInput(
  inputName: string,
  withValue: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  if (withValue !== '') {
    return withValue;
  }

  const envKey = Object.entries(TRUSTBRIDGE_ENV_MAP).find(
    ([, mapped]) => mapped === inputName,
  )?.[0];

  if (envKey) {
    const envValue = env[envKey];
    if (envValue !== undefined && envValue !== '') {
      return envValue;
    }
  }

  return '';
}

/**
 * Resolve campaign preset name from network/preset inputs.
 * Empty string means "no preset".
 */
export function parsePresetInput(networkInput?: string, presetInput?: string): string {
  const preset = (presetInput ?? '').trim().toLowerCase();
  if (preset) return preset;
  const network = (networkInput ?? '').trim().toLowerCase();
  if (network === 'testnet' || network === 'public' || network === 'mainnet') {
    return network === 'mainnet' ? 'public' : network;
  }
  return '';
}
