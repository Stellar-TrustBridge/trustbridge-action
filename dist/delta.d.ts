/**
 * Delta vs previous workflow-run validation artifact (Security / Issue #148).
 *
 * Consumers retain `validation.json` across runs (upload-artifact + download
 * on the next cron/dispatch). This module compares the prior snapshot to the
 * current check results and produces a structured delta for comments and JSON.
 *
 * Strategy tradeoffs (documented also in docs/USAGE.md):
 * - **Local artifact path (recommended):** workflow downloads the previous
 *   run's artifact to `previous_validation_path`. No extra API scopes; explicit
 *   matching; fails soft when the file is absent (first run).
 * - **GitHub Actions API auto-discovery (Issue #212):** when no local path is
 *   provided and `GITHUB_TOKEN` + `GITHUB_REPOSITORY` + `GITHUB_RUN_ID` are
 *   available, the action queries the Actions API for the most recent completed
 *   run that uploaded a `validation.json` artifact and downloads it in-memory.
 *   Fails open on 403 / API errors so delta is never required.
 */
import { CheckResultItem, ValidationGate, ValidationResult } from './checks';
/** Minimal prior-check shape used for comparison (label + pass/fail). */
export interface CheckSnapshot {
    label: string;
    passed: boolean;
}
/**
 * Machine-readable validation artifact schema written to `validation.json`.
 * Compatible with the Security artifact introduced for auditing (#83).
 * Never includes tokens or auth headers.
 */
export interface ValidationArtifact {
    schemaVersion: string;
    timestamp: string;
    address: string;
    asset: {
        code: string;
        issuer: string;
    };
    horizonUrl?: string;
    readiness: ValidationGate;
    checks: CheckResultItem[];
    balances: {
        xlm: string;
    };
    /** Present when a previous artifact was loaded and compared. */
    delta?: ValidationDelta;
    /** True when addresses/issuers were privacy-redacted in this payload. */
    privacyMode?: boolean;
}
export interface ValidationDelta {
    previousTimestamp?: string;
    newlyPassed: string[];
    newlyFailed: string[];
    unchanged: string[];
    improved: boolean;
    regressed: boolean;
}
export declare const VALIDATION_ARTIFACT_SCHEMA_VERSION = "1.0.0";
/**
 * Hash a Stellar address for privacy-mode JSON artifacts.
 * Returns `sha256:<16 hex chars>` so payloads stay correlatable without
 * exposing the raw G-/C-address in retained artifacts or Actions logs.
 */
export declare function hashAddressForPrivacy(address: string): string;
/**
 * Apply privacy policy to a string that may contain addresses.
 * When privacyMode is on, addresses are hashed; otherwise first4…last4 redaction.
 */
export declare function privacyMaskAddress(address: string, privacyMode: boolean): string;
/**
 * Strip forbidden sensitive keys from an arbitrary object tree (defense in depth
 * when loading a previous artifact that might have been hand-edited).
 */
export declare function stripSensitiveFields<T>(value: T): T;
/**
 * Compare previous vs current checks by label.
 * Returns `null` when there is no previous snapshot (first run) — callers
 * should omit the delta section entirely rather than erroring.
 */
export declare function computeValidationDelta(previous: {
    checks: CheckSnapshot[];
    timestamp?: string;
} | null | undefined, current: {
    checks: CheckSnapshot[];
}): ValidationDelta | null;
/**
 * Load a previous `validation.json` from disk. Returns `null` (no throw) when
 * the path is empty, the file is missing, or JSON is unreadable/invalid —
 * first-run and artifact-miss cases must never fail the action.
 */
export declare function loadPreviousValidationArtifact(previousPath: string, workspaceRoot?: string): ValidationArtifact | null;
export interface BuildValidationArtifactOptions {
    result: ValidationResult;
    stellarAddress: string;
    assetCode: string;
    assetIssuer: string;
    horizonUrl?: string;
    delta?: ValidationDelta | null;
    privacyMode?: boolean;
    timestamp?: string;
}
/**
 * Build the validation.json payload. Applies privacy masking to addresses
 * and strips any accidental sensitive fields. Never embeds tokens.
 */
export declare function buildValidationArtifact(options: BuildValidationArtifactOptions): ValidationArtifact;
/**
 * Render a Markdown delta section for the issue comment.
 * Returns an empty string when there is no delta (first run).
 */
export declare function formatDeltaMarkdown(delta: ValidationDelta | null | undefined): string;
/**
 * Attempt to auto-discover and download the most recent `validation.json`
 * artifact from prior workflow runs via the GitHub Actions REST API.
 *
 * This is a best-effort, fail-open operation:
 * - Returns `null` when required context is missing (non-Actions env).
 * - Returns `null` on API errors (403, rate limit, network).
 * - Returns `null` when no prior artifact is found (first run).
 *
 * Requires `GITHUB_TOKEN` with `actions: read` permission. When the token
 * lacks this scope, the function returns `null` gracefully so delta is
 * never a hard requirement.
 */
export declare function discoverPreviousValidationArtifact(githubToken: string, artifactName?: string): Promise<ValidationArtifact | null>;
/**
 * Minimal ZIP extraction for a single named file.
 * Parses the ZIP local file headers to find and decompress the target file.
 * Returns the file content as a UTF-8 string, or null if not found.
 *
 * @internal Exported for testing.
 */
export declare function extractFromZip(zipBuffer: Buffer, targetFileName: string): string | null;
/**
 * Result of comparing the current Stellar address against the address stored
 * in the previous `validation.json` artifact.
 */
export interface AddressChangeResult {
    /** True when a previous address was found and it differs from the current. */
    changed: boolean;
    /**
     * The previous address as stored/displayed. When `privacyMode` is true this
     * will be the hashed form (`sha256:<16 hex>`) so the raw prior address is
     * never logged or commented publicly.
     */
    previousAddress: string | null;
    /**
     * The current address as stored/displayed (same masking policy as above).
     */
    currentAddress: string;
    /** True when the comparison was done against hashed values (privacy mode). */
    privacyMode: boolean;
}
/**
 * Detect whether the Stellar address has changed since the last successful
 * validation run.
 *
 * Strategy:
 * - When `privacyMode` is **off** (default), addresses are compared and
 *   stored in plain form (`G…`) in the result for display in the comment.
 * - When `privacyMode` is **on**, both the current and previous addresses are
 *   hashed with SHA-256 and only the hashes are compared/stored. This means
 *   the raw prior address is never placed into a public issue comment.
 *
 * Muxed accounts (M…): muxed addresses encode an underlying G-address and a
 * memo id. Two different muxed addresses over the *same* G-address are treated
 * as the *same* address for comparison purposes — only the base G-address
 * (`[GC][A-Z2-7]{55}`) is extracted for comparison.
 *
 * First-run handling: when `previousArtifact` is null/undefined (no previous
 * run), the function returns `changed: false` so the action never emits a
 * spurious "address changed" warning on first run.
 *
 * @param currentAddress     The Stellar address being validated this run.
 * @param previousArtifact   The loaded previous `validation.json` artifact, or null.
 * @param privacyMode        When true, hash addresses before comparing/storing.
 */
export declare function detectAddressChange(currentAddress: string, previousArtifact: ValidationArtifact | null | undefined, privacyMode?: boolean): AddressChangeResult;
/**
 * Render a Markdown warning section for the issue comment when an address
 * change is detected.
 *
 * Returns an empty string when `changeResult.changed` is false so callers
 * can unconditionally append the result.
 */
export declare function formatAddressChangeWarning(changeResult: AddressChangeResult): string;
