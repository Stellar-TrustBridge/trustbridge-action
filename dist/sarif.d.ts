/**
 * SARIF (Static Analysis Results Interchange Format) 2.1.0 support.
 *
 * Two entry points share this module:
 *
 *  - `buildSarifOutput` turns a full `ValidationResult` into the SARIF file
 *    written to `sarif_output_path` for GitHub Advanced Security code
 *    scanning. Rule ids TB001–TB010 are a stable public contract: GHAS users
 *    filter TrustBridge findings by them, so ids are only ever added, never
 *    renumbered.
 *  - `buildSarifDocument` / `uploadSarifReport` serialise a minimal
 *    `TrustBridgeCheckOutcome` for the best-effort upload path. A failure there
 *    emits a workflow warning rather than failing the run so that comment
 *    posting and action outputs are not blocked.
 *
 * Every document can be checked with `validateSarifSchema` /
 * `getSarifSchemaErrors` against the vendored OASIS SARIF 2.1.0 JSON Schema
 * (`schemas/sarif-schema-2.1.0.json`, Issue #679) before it is written or
 * uploaded.
 *
 * SARIF reference: https://sarifweb.azurewebsites.net/
 */
import type { CheckResultItem, HomeDomainCheckMode, HomeDomainOutcome, ValidationResult } from './checks';
export declare const SARIF_SCHEMA = "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json";
export declare const SARIF_VERSION = "2.1.0";
export declare const TOOL_NAME = "trustbridge-action";
export declare const TOOL_VERSION = "1.0.0";
export type SarifLevel = 'error' | 'warning' | 'note' | 'none';
export interface SarifMessage {
    text: string;
}
export interface SarifResult {
    ruleId: string;
    level: SarifLevel;
    message: SarifMessage;
    locations?: SarifLocation[];
}
export interface SarifLocation {
    physicalLocation: {
        artifactLocation: {
            uri: string;
        };
    };
}
export interface SarifRun {
    tool: {
        driver: {
            name: string;
            version: string;
            informationUri: string;
            rules: SarifRule[];
        };
    };
    results: SarifResult[];
}
export interface SarifRule {
    id: string;
    name?: string;
    shortDescription: SarifMessage;
    fullDescription?: SarifMessage;
    helpUri?: string;
    properties?: {
        tags?: string[];
        precision?: string;
    };
    /** Rich help shown by Code Scanning; `markdown` is rendered when present. */
    help?: {
        text: string;
        markdown?: string;
    };
}
/** Stable SARIF rule id for the SEP-0001 home domain check (Issue #708). */
export declare const HOME_DOMAIN_RULE_ID = "TB004";
export declare const HOME_DOMAIN_HELP_URI = "https://github.com/Stellar-TrustBridge/trustbridge-action/blob/main/docs/SEP0001_HOME_DOMAIN.md";
/** Home domain check outcome carried into SARIF when the check is enabled. */
export interface SarifHomeDomainOutcome {
    outcome: HomeDomainOutcome;
    mode: HomeDomainCheckMode;
    actualHomeDomain?: string;
    expectedHomeDomain?: string;
}
export interface SarifDocument {
    $schema: string;
    version: string;
    runs: SarifRun[];
}
export interface TrustBridgeCheckOutcome {
    /** Horizon URL used for this run. */
    horizonUrl: string;
    /** Stellar address that was validated. */
    stellarAddress: string;
    /** Whether the account exists on-chain. */
    accountFunded: boolean;
    /** Whether the configured asset trustline is present. */
    trustlineExists: boolean;
    /** Whether the XLM reserve requirement is met. */
    xlmReserveMet: boolean;
    /** Asset code being checked (e.g. "USDC"). */
    assetCode: string;
    /**
     * SEP-0001 home domain outcome (Issue #708). Present only when
     * `home_domain_check_enabled` is true; adds rule TB004 to the report.
     */
    homeDomain?: SarifHomeDomainOutcome;
}
/**
 * Build a minimal SARIF 2.1.0 document from a TrustBridge check outcome.
 *
 * Three rules are emitted, one per validation gate:
 *  - TB001  account-funded
 *  - TB002  trustline-exists
 *  - TB003  xlm-reserve-met
 *
 * Each failing gate becomes a SARIF result at level "error"; passing gates
 * are emitted at level "none" so the run is always present in the report.
 *
 * When `outcome.homeDomain` is set, a fourth rule is emitted:
 *  - TB004  home-domain-aligned (error in strict mode, warning in warn mode)
 */
export declare function buildSarifDocument(outcome: TrustBridgeCheckOutcome): SarifDocument;
/**
 * Build a SARIF outcome from a `ValidationResult` (Issue #708), so callers
 * don't have to re-derive each gate. `homeDomainCheckMode` is only needed
 * when the home domain check ran.
 */
export declare function sarifOutcomeFromResult(result: ValidationResult, context: {
    horizonUrl: string;
    stellarAddress: string;
    assetCode: string;
    homeDomainCheckMode?: HomeDomainCheckMode;
}): TrustBridgeCheckOutcome;
/**
 * Serialise a SARIF document to a compact JSON string suitable for upload.
 */
export declare function serialiseSarif(doc: SarifDocument): string;
/**
 * Upload function signature expected by `uploadSarif`.
 * Using a callback makes the upload side-effect injectable for tests.
 */
export type SarifUploadFn = (sarifJson: string, horizonUrl: string) => Promise<void>;
/**
 * Build and upload the SARIF report for a TrustBridge check outcome.
 *
 * `uploadFn` is called with the serialised SARIF JSON.  In production it
 * would call the GitHub Code Scanning upload API; in tests it is replaced
 * with a mock so we can assert on the document structure without network calls.
 *
 * @throws {Error} Re-throws if `uploadFn` rejects — callers should catch and
 *   emit a `core.warning` rather than propagating the failure.
 */
export declare function uploadSarifReport(outcome: TrustBridgeCheckOutcome, uploadFn: SarifUploadFn): Promise<void>;
/** Rule ID for the generic "account has the required trustline" finding. */
export declare const TRUSTLINE_RULE_ID = "TB002";
/** Rule ID for "trustline exists but the issuer has not authorized it". */
export declare const UNAUTHORIZED_TRUSTLINE_RULE_ID = "TB006";
/** Rule ID for runs skipped by the milestone gate (Issue #678). */
export declare const MILESTONE_GATE_RULE_ID = "TB007";
/** Rule ID for the clawback-enabled advisory outside strict mode (Issue #678). */
export declare const CLAWBACK_ADVISORY_RULE_ID = "TB008";
/** Rule ID for runs stopped by the `horizon_max_requests` budget (Issue #678). */
export declare const RATE_BUDGET_RULE_ID = "TB009";
/** Rule ID for runs short-circuited by the Horizon circuit breaker (Issue #678). */
export declare const CIRCUIT_OPEN_RULE_ID = "TB010";
/**
 * Fallback rule for checks that map to no dedicated rule (e.g. SEP-0001 home
 * domain, claimable balances, or labels added after this mapping was written).
 * Declared in the driver so every emitted `ruleId` resolves.
 */
export declare const GENERIC_RULE_ID = "TB000";
/**
 * Map a `reason_code` to the dedicated rule that explains *why* the run could
 * not evaluate the account (Issue #678). Returns `undefined` for every other
 * code, including unknown ones, so callers fall back to the per-check
 * label mapping.
 */
export declare function reasonCodeToRuleId(reasonCode: string | undefined): string | undefined;
/**
 * Build SARIF rule definitions from TrustBridge checks.
 * Each check becomes a rule with a stable ID, description, and help URI.
 */
export declare function buildSarifRules(): SarifRule[];
/**
 * Map a TrustBridge check result to a SARIF result level.
 */
export declare function checkToSarifLevel(check: CheckResultItem): SarifLevel;
/**
 * Map a TrustBridge check label to a SARIF rule ID.
 *
 * Unknown labels fall back to {@link GENERIC_RULE_ID}, which is declared in
 * {@link buildSarifRules}, so the result always references a defined rule.
 */
export declare function checkLabelToRuleId(label: string): string;
/**
 * Resolve the SARIF severity for an unauthorized trustline according to the
 * effective `unauthorized_trustline_policy` (Issue #729).
 *
 * - `fail` — blocking policy failure: reported as an `error` under the
 *   dedicated {@link UNAUTHORIZED_TRUSTLINE_RULE_ID} rule.
 * - `warn` (default) — informational only: the trustline check passes, so the
 *   finding stays at `note` severity under the generic trustline rule.
 * - `ignore` — the policy asks for no finding at all, so `undefined` means
 *   "omit the authorization result".
 */
export declare function unauthorizedTrustlineSarifSeverity(result: Pick<ValidationResult, 'trustlineAuthorized' | 'unauthorizedTrustlinePolicy'>): {
    level: SarifLevel;
    ruleId: string;
} | undefined;
/**
 * Build a single SARIF result from a TrustBridge check.
 */
export declare function checkToSarifResult(check: CheckResultItem, assetCode: string, horizonUrl: string, stellarAddress: string, severityOverride?: {
    level: SarifLevel;
    ruleId: string;
}): Record<string, unknown>;
/**
 * Build a complete SARIF 2.1.0 output from a TrustBridge ValidationResult.
 * Returns a valid SARIF object ready for serialization to JSON and upload
 * to GitHub Advanced Security via the upload-sarif action.
 *
 * Besides one result per check, two run-level findings are added (Issue #678):
 *  - TB007 (`warning`) when the milestone gate skipped validation.
 *  - TB008 (`warning`) when the trustline has clawback enabled but
 *    `clawback_strict_mode` did not block it (strict-mode blocks stay TB005).
 */
export declare function buildSarifOutput(result: ValidationResult, assetCode: string, horizonUrl: string, stellarAddress: string, version?: string): Record<string, unknown>;
/**
 * Serialize SARIF output to a JSON string.
 * Safe for writing to a file or environment variable.
 */
export declare function serializeSarif(sarif: Record<string, unknown>): string;
/**
 * Validate a SARIF document against the vendored OASIS SARIF 2.1.0 JSON
 * Schema (`schemas/sarif-schema-2.1.0.json`, Issue #679).
 *
 * @returns Human-readable schema violations (JSON-path style, e.g.
 *   `$.runs[0].tool: missing required property "driver"`); empty when valid.
 */
export declare function getSarifSchemaErrors(sarif: unknown): string[];
/**
 * Validate that a SARIF output conforms to the SARIF 2.1.0 JSON Schema.
 * Returns true if the document is valid, false otherwise. Use
 * {@link getSarifSchemaErrors} to obtain the individual violations.
 */
export declare function validateSarifSchema(sarif: unknown): boolean;
/** Thrown by {@link writeSarifFile} when the document fails schema validation. */
export declare class SarifValidationError extends Error {
    readonly violations: string[];
    constructor(violations: string[]);
}
/**
 * Validate and write a SARIF document under the workspace (`sarif_output_path`).
 *
 * The document is validated first; an invalid document is never written, so
 * `github/codeql-action/upload-sarif` cannot pick up a malformed file left
 * behind by this run.
 *
 * @returns The absolute path that was written.
 * @throws {SarifValidationError} When the document violates the schema.
 * @throws {Error} When `outputPath` resolves outside the workspace.
 */
export declare function writeSarifFile(sarif: Record<string, unknown>, outputPath: string, workspaceRoot?: string): string;
