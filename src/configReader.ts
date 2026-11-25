/**
 * Consumer trustbridge.yml reader (Issue #45).
 *
 * Reads an optional `.trustbridge.yml` (or any path supplied via the
 * `trustbridge_config_path` action input) from the consumer repository,
 * parses it as YAML using a minimal built-in parser (no extra deps), and
 * validates it through the full security layer in `src/validation.ts`:
 *
 *   1. SSRF prevention  — Horizon/RPC URL fields are blocked from targeting
 *      private IPs, loopback addresses, and cloud-metadata endpoints.
 *   2. Injection prevention — free-form string fields are rejected if they
 *      contain shell meta-characters, newlines, or null bytes.
 *   3. Secret redaction — known secret field names (token, api_key, …) are
 *      never logged; they are replaced with "***" in any diagnostic output.
 *
 * The reader is intentionally conservative: unknown keys are ignored (or, in
 * strict mode, rejected with a "did you mean" hint — Issue #927), and
 * only the fields declared in `TrustbridgeConsumerConfig` are surfaced to
 * the caller.  This keeps the attack surface small and prevents a malicious
 * config from injecting unexpected values into the action runtime.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  TrustbridgeConsumerConfig,
  validateTrustbridgeConfig,
  redactSecretFields,
  ValidationResult,
} from './validation';
import { redactString } from './logger';

// ---------------------------------------------------------------------------
// Minimal YAML parser
// ---------------------------------------------------------------------------
// We intentionally avoid pulling in a full YAML library — the consumer
// config is a small flat key/value file so a line-by-line parser is both
// safer (no prototype pollution, no YAML bombs) and dependency-free.

/**
 * Parse a minimal YAML file that contains only top-level key: value pairs.
 * Supports:
 *   - Quoted strings (single or double)
 *   - Unquoted strings
 *   - Booleans (true / false, case-insensitive)
 *   - Integers and floats
 *   - Comments (lines starting with #, and inline # comments)
 *   - Blank lines
 *
 * Deliberately does NOT support: nested objects, lists, anchors, aliases,
 * multi-line values, or any YAML feature that could be used for injection.
 */
export function parseSimpleYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    // Strip inline comment (unquoted #)
    const line = rawLine.replace(/#[^'"]*$/, '').trim();
    if (!line) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();

    if (!key) continue;

    result[key] = parseYamlValue(rawValue);
  }

  return result;
}

function parseYamlValue(raw: string): unknown {
  // Quoted strings
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }

  // Booleans
  if (raw.toLowerCase() === 'true') return true;
  if (raw.toLowerCase() === 'false') return false;

  // Null / empty
  if (raw === '' || raw.toLowerCase() === 'null' || raw === '~') return null;

  // Numbers
  const num = Number(raw);
  if (!Number.isNaN(num) && raw !== '') return num;

  // Plain string
  return raw;
}

// ---------------------------------------------------------------------------
// Known keys / strict mode (Issue #927)
// ---------------------------------------------------------------------------

/** Every key `.trustbridge.yml` understands (mirrors `TrustbridgeConsumerConfig`). */
export const KNOWN_CONFIG_KEYS: readonly string[] = [
  'horizon_url',
  'horizon_url_fallback',
  'rpc_fallback_url',
  'asset_code',
  'asset_issuer',
  'min_xlm_reserve',
  'min_asset_balance',
  'fail_on_missing',
];

export interface ReadConfigOptions {
  /**
   * When true, unknown top-level keys are validation errors (the config is
   * rejected). When false (default, lenient mode) they are ignored exactly as
   * before, so existing configs keep working.
   */
  strict?: boolean;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Closest known key within edit distance 3, for "did you mean" hints. */
export function suggestConfigKey(unknown: string): string | null {
  let best: string | null = null;
  let bestDistance = 4;
  const normalized = unknown.toLowerCase().replace(/-/g, '_');
  for (const known of KNOWN_CONFIG_KEYS) {
    const d = editDistance(normalized, known);
    if (d < bestDistance) {
      best = known;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * Lists unknown top-level keys with stable messages. Key names are passed
 * through `redactString` so a pasted secret used as a key is never echoed.
 */
export function findUnknownConfigKeys(raw: Record<string, unknown>): string[] {
  const messages: string[] = [];
  for (const key of Object.keys(raw)) {
    if (KNOWN_CONFIG_KEYS.includes(key)) continue;
    const suggestion = suggestConfigKey(key);
    messages.push(
      `Unknown trustbridge config key "${redactString(key)}"` +
        (suggestion ? ` (did you mean "${suggestion}"?)` : '') +
        `. Known keys: ${KNOWN_CONFIG_KEYS.join(', ')}.`,
    );
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Config file reader
// ---------------------------------------------------------------------------

export interface ReadConfigResult {
  /** The validated and typed config, or null if no config files were found. */
  config: TrustbridgeConsumerConfig | null;
  /** Validation result — always present even when config is null. */
  validation: ValidationResult;
  /** Redacted snapshot of the raw parsed object for diagnostic logging. */
  redactedSnapshot: Record<string, unknown> | null;
  /** Absolute path that was read (or attempted). */
  resolvedPath: string;
  /** True when at least one file existed and was successfully read. */
  found: boolean;
}

/**
 * Reads and merges organization-level and repository-level configuration files.
 * Organization config (.github/trustbridge.yml) is loaded first.
 * Repository config (repoConfigPath or .trustbridge.yml) overrides the org config.
 */
export function readTrustbridgeConfigs(
  repoConfigPath?: string,
  workspaceRoot?: string,
  options: ReadConfigOptions = {},
): ReadConfigResult {
  const root = workspaceRoot ?? process.cwd();

  const orgResult = readTrustbridgeConfig('.github/trustbridge.yml', root, options);

  // Use the explicit repo path, or fallback to default repo path
  const targetRepoPath = repoConfigPath && repoConfigPath.trim() ? repoConfigPath : '.trustbridge.yml';
  const repoResult = readTrustbridgeConfig(targetRepoPath, root, options);

  const valid = orgResult.validation.valid && repoResult.validation.valid;
  const errors = [...orgResult.validation.errors, ...repoResult.validation.errors];
  const warnings = [...orgResult.validation.warnings, ...repoResult.validation.warnings];

  // Merge configs (repo overrides org)
  let config: TrustbridgeConsumerConfig | null = null;
  if (orgResult.config || repoResult.config) {
    config = { ...orgResult.config };
    if (repoResult.config) {
      for (const [key, value] of Object.entries(repoResult.config)) {
        if (value !== undefined) {
          (config as Record<string, unknown>)[key] = value;
        }
      }
    }
  }

  let redactedSnapshot: Record<string, unknown> | null = null;
  if (orgResult.redactedSnapshot || repoResult.redactedSnapshot) {
    redactedSnapshot = { ...orgResult.redactedSnapshot, ...repoResult.redactedSnapshot };
  }

  return {
    config,
    validation: { valid, errors, warnings },
    redactedSnapshot,
    resolvedPath: repoResult.resolvedPath,
    found: orgResult.found || repoResult.found,
  };
}

/**
 * Read and validate a consumer trustbridge.yml config file.
 *
 * @param configPath  Path to the config file, relative to `workspaceRoot`
 *                    or absolute.  Defaults to `.trustbridge.yml` in the
 *                    workspace root when omitted or empty.
 * @param workspaceRoot  Absolute path to the repository root.  Defaults to
 *                       `process.cwd()` when omitted.
 * @param options  `strict: true` rejects unknown keys (Issue #927).
 */
export function readTrustbridgeConfig(
  configPath?: string,
  workspaceRoot?: string,
  options: ReadConfigOptions = {},
): ReadConfigResult {
  const root = workspaceRoot ?? process.cwd();
  const targetPath = configPath && configPath.trim()
    ? path.isAbsolute(configPath)
      ? configPath
      : path.join(root, configPath)
    : path.join(root, '.trustbridge.yml');

  const resolvedPath = path.normalize(targetPath);

  // Path traversal guard: ensure the resolved path stays within the
  // workspace root.  An attacker could supply "../../etc/passwd"; we block
  // any path that escapes the root.
  const resolvedRoot = path.normalize(root);
  if (!resolvedPath.startsWith(resolvedRoot + path.sep) && resolvedPath !== resolvedRoot) {
    return {
      config: null,
      validation: {
        valid: false,
        errors: [
          `trustbridge_config_path resolves outside the workspace root: "${redactString(resolvedPath)}"`,
        ],
        warnings: [],
      },
      redactedSnapshot: null,
      resolvedPath,
      found: false,
    };
  }

  // File existence check
  if (!fs.existsSync(resolvedPath)) {
    return {
      config: null,
      validation: { valid: true, errors: [], warnings: [] },
      redactedSnapshot: null,
      resolvedPath,
      found: false,
    };
  }

  // Read and parse
  let raw: Record<string, unknown>;
  try {
    const content = fs.readFileSync(resolvedPath, 'utf8');
    raw = parseSimpleYaml(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      config: null,
      validation: {
        valid: false,
        errors: [`Failed to read trustbridge config at "${resolvedPath}": ${msg}`],
        warnings: [],
      },
      redactedSnapshot: null,
      resolvedPath,
      found: true,
    };
  }

  // Validate security policy
  const validation = validateTrustbridgeConfig(raw);

  // Issue #927: strict mode turns unknown keys (usually typos that would
  // silently fall back to defaults) into errors; lenient mode ignores them.
  if (options.strict) {
    const unknownKeys = findUnknownConfigKeys(raw);
    if (unknownKeys.length > 0) {
      validation.errors.push(...unknownKeys);
      validation.valid = false;
    }
  }

  // Redacted snapshot for safe diagnostic logging (never log raw)
  const redactedSnapshot = redactSecretFields(raw);

  if (!validation.valid) {
    return {
      config: null,
      validation,
      redactedSnapshot,
      resolvedPath,
      found: true,
    };
  }

  // Extract only the known typed fields
  const config: TrustbridgeConsumerConfig = {};

  if (typeof raw.horizon_url === 'string' && raw.horizon_url.trim()) {
    config.horizon_url = raw.horizon_url.trim();
  }
  if (typeof raw.horizon_url_fallback === 'string' && raw.horizon_url_fallback.trim()) {
    config.horizon_url_fallback = raw.horizon_url_fallback.trim();
  }
  if (typeof raw.rpc_fallback_url === 'string' && raw.rpc_fallback_url.trim()) {
    config.rpc_fallback_url = raw.rpc_fallback_url.trim();
  }
  if (typeof raw.asset_code === 'string' && raw.asset_code.trim()) {
    config.asset_code = raw.asset_code.trim();
  }
  if (typeof raw.asset_issuer === 'string' && raw.asset_issuer.trim()) {
    config.asset_issuer = raw.asset_issuer.trim();
  }
  if (typeof raw.min_xlm_reserve === 'string' && raw.min_xlm_reserve.trim()) {
    config.min_xlm_reserve = raw.min_xlm_reserve.trim();
  }
  if (typeof raw.min_asset_balance === 'string' && raw.min_asset_balance.trim()) {
    config.min_asset_balance = raw.min_asset_balance.trim();
  }
  if (typeof raw.fail_on_missing === 'boolean') {
    config.fail_on_missing = raw.fail_on_missing;
  }

  return {
    config,
    validation,
    redactedSnapshot,
    resolvedPath,
    found: true,
  };
}

/**
 * Merge consumer config values into a set of action input defaults.
 * Consumer config values take precedence over defaults but are overridden
 * by any explicit non-empty action input the workflow author supplied.
 *
 * @param actionInputs  The resolved action inputs (already read from
 *                      `core.getInput`).
 * @param consumerConfig  The parsed and validated consumer config, or null.
 * @param explicitInputs  Set of input names that were explicitly set by the
 *                        workflow author (non-empty string from getInput).
 */
export function mergeConsumerConfig<T extends Record<string, unknown>>(
  actionInputs: T,
  consumerConfig: TrustbridgeConsumerConfig | null,
  explicitInputs: Set<string>,
): T {
  if (!consumerConfig) return actionInputs;

  const merged = { ...actionInputs };

  const overrides: Partial<Record<string, unknown>> = {
    horizonUrl: consumerConfig.horizon_url,
    horizonUrlFallback: consumerConfig.horizon_url_fallback,
    rpcFallbackUrl: consumerConfig.rpc_fallback_url,
    assetCode: consumerConfig.asset_code,
    assetIssuer: consumerConfig.asset_issuer,
    minXlmReserveRaw: consumerConfig.min_xlm_reserve,
    minAssetBalanceRaw: consumerConfig.min_asset_balance,
    failOnMissing: consumerConfig.fail_on_missing,
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && !explicitInputs.has(key)) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }

  return merged;
}
