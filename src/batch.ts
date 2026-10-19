/**
 * Batch multi-address validation (Issue #105).
 *
 * Validates a list of Stellar addresses sequentially, collecting per-address
 * results and aggregate metrics. Sequential execution keeps request pressure
 * on Horizon predictable and avoids triggering rate limits.
 */

import { CheckConfig, runAccountChecks, unfundedAccountResult, horizonFailureResult, isValidStellarAddress } from './checks';
import { fetchAccount, HorizonError, HorizonCancelledError, findTrustlineBalance, HorizonAccount, isCancellationError } from './horizon';
import { FetchAccountOptions } from './horizon';
import { globalMetrics } from './metrics';
import { getAssetClawbackStatus, AssetConfigInput } from './assets';

// ---------------------------------------------------------------------------
// Issue #725 — `clawback_strict_mode` propagation into batch summaries.
//
// A clawback-enabled trustline only fails in single-address flows because
// `checks.ts` pushes a dedicated "clawback safety" check. Batch rows used to
// derive their failure reason purely from `trustlineExists` / `xlmReserveMet`,
// so a clawback-strict failure surfaced as an empty reason string. These
// exports carry the per-asset attribution all the way into
// `batch_summary_json` and the batch comment table.
// ---------------------------------------------------------------------------

/**
 * `reason_code` emitted for a batch row (or asset) blocked by
 * `clawback_strict_mode: true`. Mirrors the SARIF rule `TB005` used by the
 * single-address path.
 */
export const CLAWBACK_STRICT_REASON_CODE = 'CLAWBACK_STRICT_MODE';

/** Machine-readable `reason_code` carried by every `batch_summary_json` row. */
export const BATCH_REASON_CODES = {
  success: 'SUCCESS',
  trustlineMissing: 'TRUSTLINE_MISSING',
  reserveTooLow: 'RESERVE_TOO_LOW',
  accountNotFunded: 'ACCOUNT_NOT_FUNDED',
  horizonError: 'HORIZON_ERROR',
  invalidAddress: 'INVALID_ADDRESS',
  clawbackStrict: CLAWBACK_STRICT_REASON_CODE,
} as const;

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
    addresses = (parsed as unknown[])
      .map((item, i) => {
        if (typeof item !== 'string') {
          throw new Error(`stellar_addresses JSON array item at index ${i} is not a string.`);
        }
        return item.trim();
      })
      .filter((item) => item.length > 0);
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
/**
 * Build the machine-readable `reason_code` for a batch row.
 *
 * Precedence is deliberate (Issue #725): a clawback strict failure outranks
 * the generic trustline/reserve codes so batch consumers can attribute the row
 * to the `clawback_strict_mode` policy rather than to a missing trustline the
 * account does in fact have.
 */
function deriveBatchReasonCode(
  valid: boolean,
  options: {
    clawbackStrictFailure: boolean;
    invalidAddress?: boolean;
    accountNotFunded?: boolean;
    horizonError?: boolean;
    trustlineExists?: boolean;
    xlmReserveMet?: boolean;
  },
): string {
  if (valid) return BATCH_REASON_CODES.success;
  if (options.invalidAddress) return BATCH_REASON_CODES.invalidAddress;
  if (options.accountNotFunded) return BATCH_REASON_CODES.accountNotFunded;
  if (options.horizonError) return BATCH_REASON_CODES.horizonError;
  if (options.clawbackStrictFailure) return CLAWBACK_STRICT_REASON_CODE;
  if (options.trustlineExists === false) return BATCH_REASON_CODES.trustlineMissing;
  if (options.xlmReserveMet === false) return BATCH_REASON_CODES.reserveTooLow;
  return 'FAILED';
}

/**
 * Collect every asset whose trustline has clawback enabled while
 * `clawback_strict_mode` is on (Issue #725).
 *
 * The primary asset comes from the `ValidationResult` (already evaluated by
 * `checks.ts`); the `assets_json` entries are evaluated against the raw
 * Horizon account so batch mode can attribute a clawback block to a specific
 * `code:issuer` pair instead of only reporting "the row failed".
 */
function collectClawbackStrictAssets(
  account: HorizonAccount,
  config: CheckConfig,
  extraAssets: AssetConfigInput[],
): BatchAssetFailure[] {
  if (config.clawbackStrictMode !== true) return [];

  const failures: BatchAssetFailure[] = [];
  const seen = new Set<string>();
  const record = (assetCode: string, assetIssuer: string, clawbackEnabled: boolean): void => {
    if (!clawbackEnabled) return;
    const key = `${assetCode}:${assetIssuer}`;
    if (seen.has(key)) return;
    seen.add(key);
    failures.push({
      assetCode,
      assetIssuer,
      reasonCode: CLAWBACK_STRICT_REASON_CODE,
      detail: `**${assetCode}** has clawback enabled (${assetIssuer}) — blocked by \`clawback_strict_mode: true\`.`,
    });
  };

  const primaryBalance = findTrustlineBalance(account, config.assetCode, config.assetIssuer);
  if (primaryBalance) {
    record(config.assetCode, config.assetIssuer, getAssetClawbackStatus(primaryBalance).clawbackEnabled);
  }

  for (const asset of extraAssets) {
    const balance = findTrustlineBalance(account, asset.assetCode, asset.assetIssuer);
    if (!balance) continue;
    record(asset.assetCode, asset.assetIssuer, getAssetClawbackStatus(balance).clawbackEnabled);
  }

  return failures;
}

export async function runBatchValidation(
  addresses: string[],
  config: CheckConfig,
  horizonUrl: string,
  options: BatchRunOptions = {},
): Promise<BatchAddressResult[]> {
  const requestDelayMs = options.requestDelayMs ?? DEFAULT_REQUEST_DELAY_MS;
  const signal = options.signal ?? options.fetchOptions?.signal;
  const fetchOptions: FetchAccountOptions = signal
    ? { ...options.fetchOptions, signal }
    : { ...options.fetchOptions };
  const extraAssets = options.extraAssets ?? [];
  const clawbackStrictMode = config.clawbackStrictMode ?? false;

  globalMetrics.incrementCounter('batch_run_start');
  globalMetrics.recordMetric('batch_size', addresses.length, 'count');

  const results: BatchAddressResult[] = [];

  for (let i = 0; i < addresses.length; i++) {
    const address = addresses[i];

    // Issue #682: stop before the next address when the job is cancelled.
    // Throwing (rather than returning partial results) keeps the caller from
    // silently writing SARIF or posting a comment for an incomplete batch.
    if (signal?.aborted) {
      throw new HorizonCancelledError(
        "Batch validation aborted (job cancelled).",
      );
    }

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
        reasonCode: BATCH_REASON_CODES.invalidAddress,
        clawbackStrictFailure: false,
        clawbackStrictAssets: [],
      });
      globalMetrics.incrementCounter('batch_address_invalid');
      continue;
    }

    try {
      const account = await fetchAccount(horizonUrl, address, fetchOptions);
      const result = await runAccountChecks(account, config);

      // Issue #725: a clawback-strict failure is a per-asset outcome, so the
      // row fails whenever *any* evaluated asset trips `clawback_strict_mode` —
      // including additional `assets_json` entries that the single-asset
      // `ValidationResult` does not cover.
      const clawbackStrictAssets = collectClawbackStrictAssets(account, config, extraAssets);
      const clawbackStrictFailure = clawbackStrictAssets.length > 0;
      const valid = result.valid && !clawbackStrictFailure;

      let failureReason: string | null = null;
      if (!valid) {
        const reasons: string[] = [];
        if (!result.trustlineExists) reasons.push('trustline missing');
        if (!result.xlmReserveMet) reasons.push('XLM reserve insufficient');
        if (clawbackStrictFailure) {
          reasons.push(
            `clawback strict mode: ${clawbackStrictAssets.map((a) => a.assetCode).join(', ')}`,
          );
        }
        failureReason = reasons.join('; ') || 'unknown';
      }

      results.push({
        address,
        valid,
        accountFunded: result.accountFunded,
        trustlineExists: result.trustlineExists,
        xlmBalance: result.xlmBalance,
        xlmReserveMet: result.xlmReserveMet,
        failureReason,
        reasonCode: deriveBatchReasonCode(valid, {
          clawbackStrictFailure,
          trustlineExists: result.trustlineExists,
          xlmReserveMet: result.xlmReserveMet,
        }),
        clawbackStrictFailure,
        clawbackStrictAssets,
      });

      if (valid) {
        globalMetrics.incrementCounter('batch_address_passed');
      } else {
        globalMetrics.incrementCounter('batch_address_failed');
        if (!result.trustlineExists) globalMetrics.incrementCounter('batch_fail_trustline_missing');
        if (!result.xlmReserveMet) globalMetrics.incrementCounter('batch_fail_reserve_insufficient');
        if (clawbackStrictFailure) {
          globalMetrics.incrementCounter('batch_fail_clawback_strict');
          globalMetrics.recordMetric('batch_clawback_strict_assets', clawbackStrictAssets.length, 'count');
        }
      }
    } catch (error) {
      // Issue #682: never downgrade a cancellation into a per-address
      // HORIZON_ERROR row. Abort the whole batch so the caller can exit.
      if (isCancellationError(error) || signal?.aborted) {
        throw error instanceof HorizonCancelledError
          ? error
          : new HorizonCancelledError(
              "Batch validation aborted (job cancelled).",
            );
      }

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
        reasonCode: deriveBatchReasonCode(false, {
          clawbackStrictFailure: false,
          invalidAddress: false,
          accountNotFunded:
            error instanceof HorizonError && error.statusCode === 404,
          horizonError: true,
        }),
        clawbackStrictFailure: false,
        clawbackStrictAssets: [],
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
 *
 * @param results Per-address results from {@link runBatchValidation}.
 * @param options `clawbackStrictMode` records the *policy* that was evaluated
 *                (Issue #725). When omitted it is inferred from the results,
 *                which is correct for every path that already observed a
 *                clawback strict failure.
 */
export function buildBatchSummary(
  results: BatchAddressResult[],
  options: { clawbackStrictMode?: boolean } = {},
): BatchSummary {
  const passed = results.filter((r) => r.valid).length;
  const failed = results.length - passed;

  const failures = results
    .filter((r) => !r.valid)
    .map((r) => ({
      address: r.address,
      reason: r.failureReason ?? 'unknown',
      reasonCode: r.reasonCode ?? BATCH_REASON_CODES.success,
      clawbackStrict: r.clawbackStrictFailure === true,
    }));

  const taxonomy = {
    accountNotFunded: 0,
    trustlineMissing: 0,
    reserveInsufficient: 0,
    horizonError: 0,
    invalidAddress: 0,
    clawbackStrict: 0,
  };

  for (const r of results) {
    if (r.valid) continue;
    // Issue #725: clawback strict failures are counted in their own bucket so
    // a warn-mode clawback warning can never be confused with a strict block,
    // and the clawback clause never leaks into the trustline taxonomy.
    if (r.clawbackStrictFailure === true) {
      taxonomy.clawbackStrict++;
    }
    const reason = r.failureReason ?? '';
    if (reason.includes('not funded')) taxonomy.accountNotFunded++;
    else if (reason.includes('Invalid Stellar address')) taxonomy.invalidAddress++;
    else if (reason.startsWith('Horizon error') || reason.startsWith('error:')) taxonomy.horizonError++;
    else if (r.clawbackStrictFailure !== true) {
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
    clawbackStrictFailures: taxonomy.clawbackStrict,
    clawbackStrictMode:
      options.clawbackStrictMode ?? results.some((r) => r.clawbackStrictFailure === true),
  };
}

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
export function formatBatchSummaryMarkdown(
  summary: BatchSummary,
  assetCode: string,
): string {
  const statusLine = summary.failed === 0
    ? '✅ All addresses passed validation.'
    : `⚠️ ${summary.failed} of ${summary.total} addresses failed validation.`;

  const clawbackStrictFailures =
    summary.clawbackStrictFailures ?? summary.failureTaxonomy.clawbackStrict ?? 0;
  const showClawbackColumn = clawbackStrictFailures > 0;

  const rows = showClawbackColumn
    ? [
        '| Address | Funded | Trustline | Reserve | Clawback | Status |',
        '| ------- | ------ | --------- | ------- | -------- | ------ |',
      ]
    : [
        '| Address | Funded | Trustline | Reserve | Status |',
        '| ------- | ------ | --------- | ------- | ------ |',
      ];

  // We don't have per-row detail here without the full results — callers
  // should use the JSON artifact for per-address detail and pass results
  // directly. This summary markdown uses the failures list.

  // Build rows from failures only (passed rows omitted for brevity)
  for (const failure of summary.failures) {
    const short = failure.address.length > 12
      ? `${failure.address.slice(0, 6)}…${failure.address.slice(-4)}`
      : failure.address;
    const reason = showClawbackColumn && failure.clawbackStrict
      ? `${failure.reason} (\`${failure.reasonCode}\`)`
      : failure.reason;
    rows.push(
      showClawbackColumn
        ? `| \`${short}\` | ❌ | — | — | 🚫 | ${reason} |`
        : `| \`${short}\` | ❌ | — | — | ${reason} |`,
    );
  }

  const taxonomy = summary.failureTaxonomy;
  const taxLines = [
    taxonomy.accountNotFunded > 0 ? `- Account not funded: **${taxonomy.accountNotFunded}**` : '',
    taxonomy.trustlineMissing > 0 ? `- ${assetCode} trustline missing: **${taxonomy.trustlineMissing}**` : '',
    taxonomy.reserveInsufficient > 0 ? `- XLM reserve insufficient: **${taxonomy.reserveInsufficient}**` : '',
    taxonomy.horizonError > 0 ? `- Horizon errors: **${taxonomy.horizonError}**` : '',
    taxonomy.invalidAddress > 0 ? `- Invalid address format: **${taxonomy.invalidAddress}**` : '',
    clawbackStrictFailures > 0
      ? `- Clawback strict mode (${assetCode}): **${clawbackStrictFailures}**`
      : '',
  ].filter(Boolean);

  const parts: string[] = [
    '## TrustBridge — Batch Validation Summary',
    '',
    statusLine,
    '',
    `**Total:** ${summary.total} · **Passed:** ${summary.passed} · **Failed:** ${summary.failed}`,
    '',
  ];

  if (clawbackStrictFailures > 0) {
    parts.push(
      `**Clawback strict failures:** ${clawbackStrictFailures} · \`clawback_strict_mode: true\``,
      '',
    );
  }

  if (summary.failed > 0) {
    parts.push('### Failed addresses', '', ...rows, '');
    if (taxLines.length > 0) {
      parts.push('### Failure taxonomy', '', ...taxLines, '');
    }
  }

  parts.push('_Posted by [trustbridge-action](https://github.com/Stellar-TrustBridge/trustbridge-action)_');

  return parts.join('\n');
}
