/**
 * Batch multi-address validation (Issue #105).
 *
 * Validates a list of Stellar addresses sequentially, collecting per-address
 * results and aggregate metrics. Sequential execution keeps request pressure
 * on Horizon predictable and avoids triggering rate limits.
 */
import { CheckConfig } from './checks';
import { FetchAccountOptions } from './horizon';
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
}
/** Aggregate summary across all addresses in a batch run. */
export interface BatchSummary {
    total: number;
    passed: number;
    failed: number;
    /** Addresses that failed, with their reasons. */
    failures: Array<{
        address: string;
        reason: string;
    }>;
    /** Taxonomy of failure reasons across the batch. */
    failureTaxonomy: {
        accountNotFunded: number;
        trustlineMissing: number;
        reserveInsufficient: number;
        horizonError: number;
        invalidAddress: number;
    };
}
export interface BatchRunOptions {
    /** Delay in milliseconds between individual address requests (default: 200 ms). */
    requestDelayMs?: number;
    /** Horizon fetch options forwarded to each fetchAccount call. */
    fetchOptions?: FetchAccountOptions;
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
/**
 * Run validation checks against each address in `addresses` sequentially.
 * A configurable delay between requests keeps Horizon pressure low.
 */
export declare function runBatchValidation(addresses: string[], config: CheckConfig, horizonUrl: string, options?: BatchRunOptions): Promise<BatchAddressResult[]>;
/**
 * Compute aggregate summary metrics from batch results.
 */
export declare function buildBatchSummary(results: BatchAddressResult[]): BatchSummary;
/**
 * Render a compact Markdown summary table for the batch results.
 * Suitable for posting as a single issue comment in batch mode.
 */
export declare function formatBatchSummaryMarkdown(summary: BatchSummary, assetCode: string): string;
