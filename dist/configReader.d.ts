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
import { TrustbridgeConsumerConfig, ValidationResult } from './validation';
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
export declare function parseSimpleYaml(content: string): Record<string, unknown>;
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
export declare function readTrustbridgeConfig(configPath?: string, workspaceRoot?: string): ReadConfigResult;
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
export declare function mergeConsumerConfig<T extends Record<string, unknown>>(actionInputs: T, consumerConfig: TrustbridgeConsumerConfig | null, explicitInputs: Set<string>): T;
