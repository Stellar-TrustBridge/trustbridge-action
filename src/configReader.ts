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
 * The reader is intentionally conservative: unknown keys are ignored, and
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
// Config file reader
// ---------------------------------------------------------------------------

export interface ReadConfigResult {
  /** The validated and typed config, or null if no config file was found. */
  config: TrustbridgeConsumerConfig | null;
  /** Validation result — always present even when config is null. */
  validation: ValidationResult;
  /** Redacted snapshot of the raw parsed object for diagnostic logging. */
  redactedSnapshot: Record<string, unknown> | null;
  /** Absolute path that was read (or attempted). */
  resolvedPath: string;
  /** True when the file existed and was successfully read. */
  found: boolean;
}

/**
 * Read and validate a consumer trustbridge.yml config file.
 *
 * @param configPath  Path to the config file, relative to `workspaceRoot`
 *                    or absolute.  Defaults to `.trustbridge.yml` in the
 *                    workspace root when omitted or empty.
 * @param workspaceRoot  Absolute path to the repository root.  Defaults to
 *                       `process.cwd()` when omitted.
 */
export function readTrustbridgeConfig(
  configPath?: string,
  workspaceRoot?: string,
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
    failOnMissing: consumerConfig.fail_on_missing,
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && !explicitInputs.has(key)) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }

  return merged;
}
