/**
 * Batch multi-address validation (Issue #105).
 *
 * Validates a list of Stellar addresses sequentially, collecting per-address
 * results and aggregate metrics. Sequential execution keeps request pressure
 * on Horizon predictable and avoids triggering rate limits.
 */
import { CheckConfig } from './checks';
import { FetchAccountOptions } from './horizon';
import { AssetConfigInput } from './assets';
/**
 * `reason_code` emitted for a batch row (or asset) blocked by
 * `clawback_strict_mode: true`. Mirrors the SARIF rule `TB005` used by the
 * single-address path.
 */
export declare const CLAWBACK_STRICT_REASON_CODE = "CLAWBACK_STRICT_MODE";
/** Machine-readable `reason_code` carried by every `batch_summary_json` row. */
export declare const BATCH_REASON_CODES: {
    readonly success: "SUCCESS";
    readonly trustlineMissing: "TRUSTLINE_MISSING";
    readonly reserveTooLow: "RESERVE_TOO_LOW";
    readonly accountNotFunded: "ACCOUNT_NOT_FUNDED";
    readonly horizonError: "HORIZON_ERROR";
    readonly invalidAddress: "INVALID_ADDRESS";
    readonly clawbackStrict: "CLAWBACK_STRICT_MODE";
};
/** A single asset that hit `clawback_strict_mode` for one address. */
export interface BatchAssetFailure {
    /** Asset code, e.g. `USDC`. */
    assetCode: string;
    /** Issuer account (G… public key or C… contract ID). */
    assetIssuer: string;
    /** Always {@link CLAWBACK_STRICT_REASON_CODE} today; kept explicit for JSON consumers. */
    reasonCode: string;
    /** Human-readable per-asset detail rendered in the batch comment. */
    detail: string;
}
/** Result for a single address in a batch run. */
export interface BatchAddressResult {
    address: string;
    valid: boolean;
    accountFunded: boolean;
    trustlineExists: boolean;
    xlmBalance: string;
    xlmReserveMet: boolean;
    /** Human-readable failure reason, or null when all checks pass. */
    failureReason: string | null;
    /**
     * Machine-readable failure classification (Issue #725). Always populated by
     * `runBatchValidation`; optional on hand-constructed fixtures so existing
     * callers keep compiling.
     */
    reasonCode?: string;
    /**
     * True when at least one asset (primary or `assets_json`) is blocked by
     * `clawback_strict_mode` for this address (Issue #725).
     */
    clawbackStrictFailure?: boolean;
    /**
     * Per-asset clawback strict attribution for this address (Issue #725).
     * Same asset code with different issuers is evaluated independently.
     */
    clawbackStrictAssets?: BatchAssetFailure[];
}
/** Aggregate summary across all addresses in a batch run. */
export interface BatchSummary {
    total: number;
    passed: number;
    failed: number;
    /** Addresses that failed, with their reasons and machine-readable codes. */
    failures: Array<{
        address: string;
        reason: string;
        reasonCode: string;
        /** True when this row failed because of `clawback_strict_mode` (Issue #725). */
        clawbackStrict: boolean;
    }>;
    /** Taxonomy of failure reasons across the batch. */
    failureTaxonomy: {
        accountNotFunded: number;
        trustlineMissing: number;
        reserveInsufficient: number;
        horizonError: number;
        invalidAddress: number;
        /** Rows blocked by `clawback_strict_mode` (Issue #725). */
        clawbackStrict: number;
    };
    /**
     * Number of addresses blocked by `clawback_strict_mode`, counted separately
     * from the warn-mode clawback path (Issue #725).
     */
    clawbackStrictFailures: number;
    /**
     * Whether the run evaluated assets with `clawback_strict_mode` enabled.
     * `false` means a clawback-enabled trustline can only ever warn, so a
     * clawback row is impossible for this run.
     */
    clawbackStrictMode: boolean;
}
export interface BatchRunOptions {
    /** Delay in milliseconds between individual address requests (default: 200 ms). */
    requestDelayMs?: number;
    /** Horizon fetch options forwarded to each fetchAccount call. */
    fetchOptions?: FetchAccountOptions;
    /**
     * Job-cancellation signal (Issues #682 / #683). When aborted, the batch loop
     * stops before the next address and throws {@link HorizonCancelledError} so
     * the caller can exit without writing partial SARIF or posting a comment.
     * Falls back to `fetchOptions.signal` when omitted.
     */
    signal?: AbortSignal;
    /**
     * Additional assets (typically from the `assets_json` input) whose clawback
     * flag is evaluated per address under `clawback_strict_mode` (Issue #725).
     * Same asset code with a different issuer is evaluated independently.
     */
    extraAssets?: AssetConfigInput[];
}
/**
 * Parse the `stellar_addresses` input into a deduplicated list of addresses.
 *
 * Accepts:
 * - Newline-separated list: one address per line (blank lines ignored)
 * - JSON array: `["GABC...", "GDEF..."]`
 *
 * Throws if the resulting list is empty.
 */
export declare function parseBatchAddresses(raw: string): string[];
export declare function runBatchValidation(addresses: string[], config: CheckConfig, horizonUrl: string, options?: BatchRunOptions): Promise<BatchAddressResult[]>;
/**
 * Compute aggregate summary metrics from batch results.
 *
 * @param results Per-address results from {@link runBatchValidation}.
 * @param options `clawbackStrictMode` records the *policy* that was evaluated
 *                (Issue #725). When omitted it is inferred from the results,
 *                which is correct for every path that already observed a
 *                clawback strict failure.
 */
export declare function buildBatchSummary(results: BatchAddressResult[], options?: {
    clawbackStrictMode?: boolean;
}): BatchSummary;
/**
 * Render a compact Markdown summary table for the batch results.
 * Suitable for posting as a single issue comment in batch mode.
 *
 * When at least one row failed because of `clawback_strict_mode` (Issue #725)
 * the table grows a `Clawback` column so the blocking policy is visible at a
 * glance, the clawback taxonomy line is emitted separately from the other
 * buckets, and every clawback row carries its machine-readable
 * `CLAWBACK_STRICT_MODE` reason code. Without a clawback strict failure the
 * rendered markdown is byte-identical to previous versions.
 */
export declare function formatBatchSummaryMarkdown(summary: BatchSummary, assetCode: string): string;
