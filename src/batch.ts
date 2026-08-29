/**
 * Batch multi-address validation (Issue #105).
 *
 * Validates a list of Stellar addresses sequentially, collecting per-address
 * results and aggregate metrics. Sequential execution keeps request pressure
 * on Horizon predictable and avoids triggering rate limits.
 */

import { CheckConfig, runAccountChecks, unfundedAccountResult, horizonFailureResult, isValidStellarAddress } from './checks';
import { fetchAccount, HorizonError } from './horizon';
import { FetchAccountOptions } from './horizon';
import { globalMetrics } from './metrics';

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
  failures: Array<{ address: string; reason: string }>;
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

const DEFAULT_REQUEST_DELAY_MS = 200;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
export function parseBatchAddresses(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('stellar_addresses input is empty. Provide at least one Stellar address.');
  }

  let addresses: string[];

  if (trimmed.startsWith('[')) {
    // JSON array
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('stellar_addresses looks like a JSON array but could not be parsed. Check the JSON syntax.');
    }
    if (!Array.isArray(parsed)) {
      throw new Error('stellar_addresses JSON must be an array of strings.');
    }
    addresses = (parsed as unknown[]).map((item, i) => {
      if (typeof item !== 'string') {
        throw new Error(`stellar_addresses JSON array item at index ${i} is not a string.`);
      }
      return item.trim();
    });
  } else {
    // Newline-separated
    addresses = trimmed
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  if (addresses.length === 0) {
    throw new Error('stellar_addresses input contains no non-empty entries.');
  }

  // Deduplicate, preserving order
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const addr of addresses) {
    if (!seen.has(addr)) {
      seen.add(addr);
      deduped.push(addr);
    }
  }

  return deduped;
}

/**
 * Run validation checks against each address in `addresses` sequentially.
 * A configurable delay between requests keeps Horizon pressure low.
 */
export async function runBatchValidation(
  addresses: string[],
  config: CheckConfig,
  horizonUrl: string,
  options: BatchRunOptions = {},
): Promise<BatchAddressResult[]> {
  const requestDelayMs = options.requestDelayMs ?? DEFAULT_REQUEST_DELAY_MS;
  const fetchOptions = options.fetchOptions ?? {};

  globalMetrics.incrementCounter('batch_run_start');
  globalMetrics.recordMetric('batch_size', addresses.length, 'count');

  const results: BatchAddressResult[] = [];

  for (let i = 0; i < addresses.length; i++) {
    const address = addresses[i];

    // Delay between requests (skip before first)
    if (i > 0 && requestDelayMs > 0) {
      await sleep(requestDelayMs);
    }

    // Validate address format before hitting Horizon
    if (!isValidStellarAddress(address)) {
      results.push({
        address,
        valid: false,
        accountFunded: false,
        trustlineExists: false,
        xlmBalance: '0',
        xlmReserveMet: false,
        failureReason: `Invalid Stellar address format: "${address}"`,
      });
      globalMetrics.incrementCounter('batch_address_invalid');
      continue;
    }

    try {
      const account = await fetchAccount(horizonUrl, address, fetchOptions);
      const result = await runAccountChecks(account, config);

      let failureReason: string | null = null;
      if (!result.valid) {
        const reasons: string[] = [];
        if (!result.trustlineExists) reasons.push('trustline missing');
        if (!result.xlmReserveMet) reasons.push('XLM reserve insufficient');
        failureReason = reasons.join('; ');
      }

      results.push({
        address,
        valid: result.valid,
        accountFunded: result.accountFunded,
        trustlineExists: result.trustlineExists,
        xlmBalance: result.xlmBalance,
        xlmReserveMet: result.xlmReserveMet,
        failureReason,
      });

      if (result.valid) {
        globalMetrics.incrementCounter('batch_address_passed');
      } else {
        globalMetrics.incrementCounter('batch_address_failed');
        if (!result.trustlineExists) globalMetrics.incrementCounter('batch_fail_trustline_missing');
        if (!result.xlmReserveMet) globalMetrics.incrementCounter('batch_fail_reserve_insufficient');
      }
    } catch (error) {
      let failureReason: string;
      let isFunded = false;

      if (error instanceof HorizonError && error.statusCode === 404) {
        failureReason = 'account not funded';
        globalMetrics.incrementCounter('batch_fail_account_not_funded');
      } else if (error instanceof HorizonError) {
        failureReason = `Horizon error (${error.statusCode}): ${error.message}`;
        globalMetrics.incrementCounter('batch_fail_horizon_error');
        isFunded = false;
      } else {
        const msg = error instanceof Error ? error.message : 'unknown error';
        failureReason = `error: ${msg}`;
        globalMetrics.incrementCounter('batch_fail_horizon_error');
      }

      const syntheticResult =
        error instanceof HorizonError && error.statusCode === 404
          ? unfundedAccountResult(address, config)
          : horizonFailureResult(
              error instanceof Error ? error.message : 'unknown error',
              config,
            );

      results.push({
        address,
        valid: false,
        accountFunded: isFunded || syntheticResult.accountFunded,
        trustlineExists: false,
        xlmBalance: syntheticResult.xlmBalance,
        xlmReserveMet: false,
        failureReason,
      });
    }
  }

  globalMetrics.recordMetric('batch_passed', results.filter((r) => r.valid).length, 'count');
  globalMetrics.recordMetric('batch_failed', results.filter((r) => !r.valid).length, 'count');
  globalMetrics.incrementCounter('batch_run_complete');

  return results;
}

/**
 * Compute aggregate summary metrics from batch results.
 */
export function buildBatchSummary(results: BatchAddressResult[]): BatchSummary {
  const passed = results.filter((r) => r.valid).length;
  const failed = results.length - passed;

  const failures = results
    .filter((r) => !r.valid)
    .map((r) => ({ address: r.address, reason: r.failureReason ?? 'unknown' }));

  const taxonomy = {
    accountNotFunded: 0,
    trustlineMissing: 0,
    reserveInsufficient: 0,
    horizonError: 0,
    invalidAddress: 0,
  };

  for (const r of results) {
    if (r.valid) continue;
    const reason = r.failureReason ?? '';
    if (reason.includes('not funded')) taxonomy.accountNotFunded++;
    else if (reason.includes('Invalid Stellar address')) taxonomy.invalidAddress++;
    else if (reason.startsWith('Horizon error') || reason.startsWith('error:')) taxonomy.horizonError++;
    else {
      if (reason.includes('trustline')) taxonomy.trustlineMissing++;
      if (reason.includes('reserve')) taxonomy.reserveInsufficient++;
    }
  }

  return {
    total: results.length,
    passed,
    failed,
    failures,
    failureTaxonomy: taxonomy,
  };
}

/**
 * Render a compact Markdown summary table for the batch results.
 * Suitable for posting as a single issue comment in batch mode.
 */
export function formatBatchSummaryMarkdown(
  summary: BatchSummary,
  assetCode: string,
): string {
  const statusLine = summary.failed === 0
    ? '✅ All addresses passed validation.'
    : `⚠️ ${summary.failed} of ${summary.total} addresses failed validation.`;

  const rows = [
    '| Address | Funded | Trustline | Reserve | Status |',
    '| ------- | ------ | --------- | ------- | ------ |',
  ];

  // We don't have per-row detail here without the full results — callers
  // should use the JSON artifact for per-address detail and pass results
  // directly. This summary markdown uses the failures list.

  // Build rows from failures only (passed rows omitted for brevity)
  for (const { address, reason } of summary.failures) {
    const short = address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
    rows.push(`| \`${short}\` | ❌ | — | — | ${reason} |`);
  }

  const taxonomy = summary.failureTaxonomy;
  const taxLines = [
    taxonomy.accountNotFunded > 0 ? `- Account not funded: **${taxonomy.accountNotFunded}**` : '',
    taxonomy.trustlineMissing > 0 ? `- ${assetCode} trustline missing: **${taxonomy.trustlineMissing}**` : '',
    taxonomy.reserveInsufficient > 0 ? `- XLM reserve insufficient: **${taxonomy.reserveInsufficient}**` : '',
    taxonomy.horizonError > 0 ? `- Horizon errors: **${taxonomy.horizonError}**` : '',
    taxonomy.invalidAddress > 0 ? `- Invalid address format: **${taxonomy.invalidAddress}**` : '',
  ].filter(Boolean);

  const parts: string[] = [
    '## TrustBridge — Batch Validation Summary',
    '',
    statusLine,
    '',
    `**Total:** ${summary.total} · **Passed:** ${summary.passed} · **Failed:** ${summary.failed}`,
    '',
  ];

  if (summary.failed > 0) {
    parts.push('### Failed addresses', '', ...rows, '');
    if (taxLines.length > 0) {
      parts.push('### Failure taxonomy', '', ...taxLines, '');
    }
  }

  parts.push('_Posted by [trustbridge-action](https://github.com/Stellar-TrustBridge/trustbridge-action)_');

  return parts.join('\n');
}
