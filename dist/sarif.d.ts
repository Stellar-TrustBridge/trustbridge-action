/**
 * SARIF (Static Analysis Results Interchange Format) 2.1.0 output generation.
 *
 * Emits TrustBridge validation results as SARIF for integration with GitHub
 * Advanced Security (GHAS) code scanning so wallet-check failures appear
 * alongside other security findings.
 *
 * SARIF reference: https://sarifweb.azurewebsites.net/
 */
import { ValidationResult, CheckResultItem } from './checks';
/**
 * SARIF 2.1.0 rule definition for a TrustBridge check.
 */
export interface SarifRule {
    id: string;
    shortDescription: {
        text: string;
    };
    fullDescription?: {
        text: string;
    };
    helpUri?: string;
    properties?: {
        tags?: string[];
        precision?: string;
    };
}
/**
 * SARIF result level mapping from TrustBridge check outcome.
 */
export type SarifLevel = 'note' | 'warning' | 'error';
/** Rule ID for the generic "account has the required trustline" finding. */
export declare const TRUSTLINE_RULE_ID = "TB002";
/** Rule ID for "trustline exists but the issuer has not authorized it". */
export declare const UNAUTHORIZED_TRUSTLINE_RULE_ID = "TB006";
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
}, options?: {
    /** Override the artifact URI (batch mode uses a per-address URI). */
    artifactUri?: string;
    /** Override the human-readable location description. */
    artifactDescription?: string;
    /** Stable per-finding fingerprint so duplicate rules stay distinct. */
    partialFingerprint?: string;
}): Record<string, unknown>;
/**
 * Build a complete SARIF 2.1.0 output from a TrustBridge ValidationResult.
 * Returns a valid SARIF object ready for serialization to JSON and upload
 * to GitHub Advanced Security via the upload-sarif action.
 */
export declare function buildSarifOutput(result: ValidationResult, assetCode: string, horizonUrl: string, stellarAddress: string, version?: string): Record<string, unknown>;
/**
 * Minimal per-address shape needed to build batch SARIF (Issue #681).
 *
 * Structural (rather than importing `BatchAddressResult`) so this module stays
 * free of a `sarif.ts -> batch.ts` dependency cycle.
 */
export interface BatchSarifEntry {
    address: string;
    valid: boolean;
    failureReason?: string | null;
    reasonCode?: string;
    accountFunded?: boolean;
    trustlineExists?: boolean;
    xlmReserveMet?: boolean;
    clawbackStrictAssets?: Array<{
        assetCode: string;
        assetIssuer: string;
        detail: string;
    }>;
}
/**
 * Build a single SARIF 2.1.0 document covering every address in a batch run
 * (Issue #681).
 *
 * Each address gets its own artifact URI (`stellar-address/<address>`) and a
 * stable partial fingerprint, so code scanning can attribute a finding to a
 * specific wallet even when several wallets fail the same rule. Failed
 * addresses always produce at least one result; passing addresses are included
 * at `note` level so the run reflects the whole batch.
 */
export declare function buildBatchSarifOutput(entries: BatchSarifEntry[], assetCode: string, horizonUrl: string, version?: string): Record<string, unknown>;
/**
 * Serialize SARIF output to a JSON string.
 * Safe for writing to a file or environment variable.
 */
export declare function serializeSarif(sarif: Record<string, unknown>): string;
/**
 * Validate that a SARIF output matches the 2.1.0 schema essentials.
 * Returns true if the structure is valid, false otherwise.
 */
export declare function validateSarifSchema(sarif: unknown): boolean;
