import { defaultCache, SimpleCache } from './cache';
import { logger, redactHorizonUrl, redactString, LogContext } from './logger';
import { validateHorizonUrl } from './validation';

export interface HorizonBalanceNative {
  balance: string;
  asset_type: 'native';
  buying_liabilities: string;
  selling_liabilities: string;
}

export interface HorizonBalanceCredit {
  balance: string;
  asset_type: 'credit_alphanum4' | 'credit_alphanum12';
  asset_code: string;
  asset_issuer: string;
  buying_liabilities: string;
  selling_liabilities: string;
  /**
   * Present only when the issuer has AUTHORIZATION_REQUIRED set. Absent
   * means the issuer does not require per-account authorization.
   */
  is_authorized?: boolean;
  is_authorized_to_maintain_liabilities?: boolean;
  /**
   * Per-trustline clawback flag (Horizon protocol 17+). Reflects the
   * issuer's AUTH_CLAWBACK_ENABLED setting unless overridden on this
   * specific trustline.
   */
  is_clawback_enabled?: boolean;
}

export interface HorizonBalanceLiquidityPoolShares {
  balance: string;
  asset_type: 'liquidity_pool_shares';
  liquidity_pool_id: string;
  buying_liabilities: string;
  selling_liabilities: string;
  limit: string;
  is_authorized: boolean;
  is_authorized_to_maintain_liabilities: boolean;
}

export interface HorizonBalanceClaimable {
  asset_type: 'claimable_balance_id';
  balance: string;
  claimable_balance_id: string;
}

export type HorizonBalance =
  | HorizonBalanceNative
  | HorizonBalanceCredit
  | HorizonBalanceLiquidityPoolShares
  | HorizonBalanceClaimable;

export interface HorizonAccount {
  id: string;
  account_id: string;
  sequence: string;
  subentry_count: number;
  balances: HorizonBalance[];
  num_sponsoring: number;
  num_sponsored: number;
}

export interface HorizonErrorResponse {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
}

export class HorizonError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'HorizonError';
  }
}

/**
 * Raised when the TLS/certificate handshake to a Horizon endpoint fails
 * (expired cert, self-signed cert, hostname mismatch, untrusted CA, etc).
 * Kept distinct from `HorizonError` so callers can surface a clear
 * "TLS/certificate problem with this endpoint" message instead of
 * attributing the failure to the account being checked. Not retryable —
 * retrying against the same misconfigured endpoint cannot succeed.
 */
export class HorizonTlsError extends HorizonError {
  constructor(
    message: string,
    public readonly originalCode?: string,
  ) {
    super(message, 0, false);
    this.name = 'HorizonTlsError';
  }
}

/**
 * Node/OpenSSL error codes that indicate a TLS handshake or certificate
 * verification failure, as opposed to a generic connection/network error.
 */
const TLS_ERROR_CODES = new Set<string>([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'CERT_CHAIN_TOO_LONG',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_CRL',
  'HOSTNAME_MISMATCH',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
]);

function tlsErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  if (code && TLS_ERROR_CODES.has(code)) return code;
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const causeCode = (cause as NodeJS.ErrnoException).code;
    if (causeCode && TLS_ERROR_CODES.has(causeCode)) return causeCode;
  }
  return undefined;
}

type FetchLike = (
  url: string | import('node-fetch').Request,
  init?: import('node-fetch').RequestInit,
) => Promise<import('node-fetch').Response>;

export interface FetchAccountOptions {
  timeoutMs?: number;
  maxRetries?: number;
  horizonUrlFallback?: string;
  fallbackUrls?: string[];
  useCache?: boolean;
  cacheTtlMs?: number;
  cache?: SimpleCache;
  fetchFn?: FetchLike;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_CACHE_TTL_MS = 60_000;

export function normalizeHorizonUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return '';
  }
  const validation = validateHorizonUrl(trimmed, 'horizon_url', { allowHttp: true });
  if (!validation.valid) {
    throw new HorizonError(`Invalid horizon_url: ${validation.errors.join('; ')}`, 400, false);
  }
  const parsed = new URL(trimmed);
  const cleanPath = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${cleanPath}`;
}

/**
 * Produce a representation of a configured Horizon URL that is safe to
 * post in a public-facing GitHub issue comment. A private Horizon mirror's
 * hostname can itself be sensitive internal infrastructure information, so
 * by default only the URL scheme is shown. Pass `revealHost: true` (wired
 * to the `debug_mode` input) to show the full host — still routed through
 * `redactHorizonUrl` so any embedded account address stays masked.
 */
export function displayHorizonUrl(url: string, revealHost: boolean): string {
  if (!url) return url;
  if (revealHost) {
    return redactHorizonUrl(url);
  }
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//••• (set debug_mode: true to reveal)`;
  } catch {
    return '••• (set debug_mode: true to reveal)';
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503 || status === 502 || status === 504;
}

export function parseRetryAfterMs(response: import('node-fetch').Response): number | null {
  const header = response.headers.get('retry-after');
  if (!header) {
    return null;
  }
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) {
    return seconds * 1000;
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }
  return null;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildCacheKey(normalizedHorizonUrl: string, stellarAddress: string): string {
  return `horizon:account:${normalizedHorizonUrl}:${stellarAddress}`;
}

function redactCacheKey(key: string): string {
  return redactString(key);
}

function redactCacheStats(stats: { size: number; entries: string[] }): {
  size: number;
  entries: string[];
} {
  return {
    size: stats.size,
    entries: stats.entries.map(redactCacheKey),
  };
}

function safeHorizonContext(
  base: Omit<LogContext, 'stellarAddress' | 'horizonUrl'> & {
    stellarAddress: string;
    horizonUrl: string;
    horizonUrlFallback?: string;
    cacheKey?: string;
  },
): LogContext {
  const ctx: LogContext = { ...base };
  if (base.horizonUrlFallback) {
    ctx.horizonUrlFallback = redactHorizonUrl(base.horizonUrlFallback);
  }
  if (base.cacheKey) {
    ctx.cacheKey = redactCacheKey(base.cacheKey);
  }
  return ctx;
}

/**
 * Snapshot of non-sensitive account fields that are safe to include in a
 * debug log. Never include balance values, sequence numbers, sponsor
 * counts, or the raw account_id — only aggregate structural data, plus
 * the redacted address via `stellarAddress` on the surrounding context.
 */
function safeAccountSummary(account: HorizonAccount): {
  balancesCount: number;
  hasNativeBalance: boolean;
  creditTrustlineCount: number;
  subentryCount: number;
} {
  return {
    balancesCount: account.balances.length,
    hasNativeBalance: account.balances.some((b) => b.asset_type === 'native'),
    creditTrustlineCount: account.balances.filter((b) => isCreditBalance(b)).length,
    subentryCount: account.subentry_count,
  };
}

interface FetchOnceResult {
  account: HorizonAccount;
  statusCode: number;
  latencyMs: number;
  attempts: number;
}

async function fetchAccountOnce(
  fetch: FetchLike,
  targetHorizonUrl: string,
  stellarAddress: string,
  timeoutMs: number,
  maxRetries: number,
  endpointKind: 'primary' | 'fallback',
): Promise<FetchOnceResult> {
  const normalizedHorizonUrl = normalizeHorizonUrl(targetHorizonUrl);
  const url = `${normalizedHorizonUrl}/accounts/${stellarAddress}`;
  const safeUrlForLog = redactHorizonUrl(url);

  let attempt = 0;
  let lastError: Error | undefined;

  while (attempt <= maxRetries) {
    const requestStartedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    logger.debug('Horizon fetch start', safeHorizonContext({
      component: 'horizon',
      stellarAddress,
      horizonUrl: targetHorizonUrl,
      endpointKind,
      attempt,
      maxAttempts: maxRetries + 1,
      timeoutMs,
      url: safeUrlForLog,
    }));

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });

      const latencyMs = Date.now() - requestStartedAt;

      if (response.status === 404) {
        logger.debug('Horizon account not found (404)', safeHorizonContext({
          component: 'horizon',
          stellarAddress,
          horizonUrl: targetHorizonUrl,
          endpointKind,
          status: 404,
          latencyMs,
          attempt,
        }));
        throw new HorizonError(
          `Account ${stellarAddress} was not found on Horizon (not funded or activated).`,
          404,
          false,
        );
      }

      if (!response.ok) {
        const retryable = isRetryableStatus(response.status);
        let detail = response.statusText;
        try {
          const body = (await response.json()) as HorizonErrorResponse;
          if (body.detail) {
            detail = body.detail;
          } else if (body.title) {
            detail = body.title;
          }
          logger.debug('Horizon error response parsed', safeHorizonContext({
            component: 'horizon',
            stellarAddress,
            horizonUrl: targetHorizonUrl,
            endpointKind,
            status: response.status,
            retryable,
            latencyMs,
            attempt,
            errorDetail: redactString(detail),
            errorType: body.type ? redactString(body.type) : undefined,
            errorTitle: body.title ? redactString(body.title) : undefined,
          }));
        } catch {
          logger.debug('Horizon error response missing JSON body', safeHorizonContext({
            component: 'horizon',
            stellarAddress,
            horizonUrl: targetHorizonUrl,
            endpointKind,
            status: response.status,
            retryable,
            latencyMs,
            attempt,
            statusText: response.statusText,
          }));
        }

        if (retryable && attempt < maxRetries) {
          const retryAfterHeader = parseRetryAfterMs(response);
          const retryAfter = retryAfterHeader ?? 1000 * 2 ** attempt;
          logger.debug('Horizon retry scheduled', safeHorizonContext({
            component: 'horizon',
            stellarAddress,
            horizonUrl: targetHorizonUrl,
            endpointKind,
            status: response.status,
            retryable,
            latencyMs,
            attempt,
            retryAfterMs: retryAfter,
            retryAfterFromHeader: retryAfterHeader !== null,
            nextAttempt: attempt + 1,
          }));
          await sleep(retryAfter);
          attempt += 1;
          continue;
        }

        logger.debug('Horizon non-retryable HTTP error (exhausted retries)', safeHorizonContext({
          component: 'horizon',
          stellarAddress,
          horizonUrl: targetHorizonUrl,
          endpointKind,
          status: response.status,
          retryable,
          latencyMs,
          attempt,
          final: true,
        }));

        throw new HorizonError(
          `Horizon request failed (${response.status}): ${detail}`,
          response.status,
          retryable,
        );
      }

      const parsed = (await response.json()) as HorizonAccount;
      logger.debug('Horizon fetch success', safeHorizonContext({
        component: 'horizon',
        stellarAddress,
        horizonUrl: targetHorizonUrl,
        endpointKind,
        status: response.status,
        latencyMs,
        attempt,
        ...safeAccountSummary(parsed),
      }));
      return {
        account: parsed,
        statusCode: response.status,
        latencyMs,
        attempts: attempt + 1,
      };
    } catch (error) {
      if (error instanceof HorizonError) {
        throw error;
      }

      const tlsCode = tlsErrorCode(error);
      if (tlsCode) {
        const tlsLatencyMs = Date.now() - requestStartedAt;
        logger.debug('Horizon TLS/certificate verification failed', safeHorizonContext({
          component: 'horizon',
          stellarAddress,
          horizonUrl: targetHorizonUrl,
          endpointKind,
          tlsErrorCode: tlsCode,
          latencyMs: tlsLatencyMs,
          attempt,
          final: true,
        }));
        // Not retryable: retrying against the same endpoint cannot fix a
        // bad certificate, so fail fast instead of burning the retry budget.
        throw new HorizonTlsError(
          'TLS/certificate verification failed while connecting to the configured Horizon endpoint. ' +
            'This is a transport-layer problem with the endpoint itself, not with the Stellar account being checked.',
          tlsCode,
        );
      }

      const isAbort = error instanceof Error && error.name === 'AbortError';
      const message = isAbort
        ? `Horizon request timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : 'Unknown Horizon error';

      const latencyMs = Date.now() - requestStartedAt;

      logger.debug('Horizon transport error', safeHorizonContext({
        component: 'horizon',
        stellarAddress,
        horizonUrl: targetHorizonUrl,
        endpointKind,
        kind: isAbort ? 'timeout' : 'network',
        latencyMs,
        attempt,
        timeoutMs,
        errorMessage: redactString(message),
      }));

      lastError = new HorizonError(message, isAbort ? 408 : 0, true);

      if (attempt < maxRetries) {
        const backoffMs = 1000 * 2 ** attempt;
        logger.debug('Horizon transport retry scheduled', safeHorizonContext({
          component: 'horizon',
          stellarAddress,
          horizonUrl: targetHorizonUrl,
          endpointKind,
          kind: isAbort ? 'timeout' : 'network',
          latencyMs,
          attempt,
          retryAfterMs: backoffMs,
          nextAttempt: attempt + 1,
        }));
        await sleep(backoffMs);
        attempt += 1;
        continue;
      }

      logger.debug('Horizon transport error (exhausted retries)', safeHorizonContext({
        component: 'horizon',
        stellarAddress,
        horizonUrl: targetHorizonUrl,
        endpointKind,
        kind: isAbort ? 'timeout' : 'network',
        latencyMs,
        attempt,
        final: true,
      }));

      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  logger.debug('Horizon retry loop exited without result (fallback throw)', safeHorizonContext({
    component: 'horizon',
    stellarAddress,
    horizonUrl: targetHorizonUrl,
    endpointKind,
    maxAttempts: maxRetries + 1,
  }));

  throw lastError ?? new HorizonError('Horizon request failed after retries', 0, true);
}

export async function fetchAccount(
  horizonUrl: string,
  stellarAddress: string,
  options: FetchAccountOptions = {},
): Promise<HorizonAccount> {
  const fetch: FetchLike =
    options.fetchFn ?? (await import('node-fetch')).default;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cache = options.cache ?? defaultCache;
  const normalizedHorizonUrl = normalizeHorizonUrl(horizonUrl);
  const fallbackCandidate = options.horizonUrlFallback || (options.fallbackUrls && options.fallbackUrls[0]);
  const normalizedFallbackUrl = fallbackCandidate
    ? normalizeHorizonUrl(fallbackCandidate)
    : '';

  if (!normalizedHorizonUrl) {
    throw new HorizonError('horizon_url is required.', 0, false);
  }

  const cachingEnabled = cacheTtlMs > 0;
  const cacheKey = cachingEnabled
    ? buildCacheKey(normalizedHorizonUrl, stellarAddress)
    : '';

  if (cachingEnabled) {
    const cacheStatsBefore = redactCacheStats(cache.getStats());
    logger.debug('Horizon cache lookup start', safeHorizonContext({
      component: 'horizon',
      stellarAddress,
      horizonUrl,
      horizonUrlFallback: normalizedFallbackUrl,
      cacheKey,
      cacheTtlMs,
      cacheSizeBefore: cacheStatsBefore.size,
      cacheEntryCountBefore: cacheStatsBefore.entries.length,
    }));

    const cached = cache.get<HorizonAccount>(cacheKey);
    if (cached) {
      logger.debug('Horizon cache hit', safeHorizonContext({
        component: 'horizon',
        stellarAddress,
        horizonUrl,
        horizonUrlFallback: normalizedFallbackUrl,
        cacheKey,
        cacheTtlMs,
        ...safeAccountSummary(cached),
      }));
      return cached;
    }

    logger.debug('Horizon cache miss', safeHorizonContext({
      component: 'horizon',
      stellarAddress,
      horizonUrl,
      horizonUrlFallback: normalizedFallbackUrl,
      cacheKey,
      cacheTtlMs,
    }));
  } else {
    logger.debug('Horizon cache disabled (ttl=0)', safeHorizonContext({
      component: 'horizon',
      stellarAddress,
      horizonUrl,
      horizonUrlFallback: normalizedFallbackUrl,
      cacheTtlMs: 0,
    }));
  }

  let primaryError: HorizonError | undefined;

  try {
    const result = await fetchAccountOnce(
      fetch,
      normalizedHorizonUrl,
      stellarAddress,
      timeoutMs,
      maxRetries,
      'primary',
    );

    if (cachingEnabled) {
      cache.set(cacheKey, result.account, cacheTtlMs);
      const cacheStatsAfter = redactCacheStats(cache.getStats());
      logger.debug('Horizon cache populate after primary success', safeHorizonContext({
        component: 'horizon',
        stellarAddress,
        horizonUrl,
        horizonUrlFallback: normalizedFallbackUrl,
        cacheKey,
        cacheTtlMs,
        cacheSizeAfter: cacheStatsAfter.size,
        cacheEntryCountAfter: cacheStatsAfter.entries.length,
        source: 'primary',
        ...safeAccountSummary(result.account),
      }));
    }

    return result.account;
  } catch (error) {
    if (error instanceof HorizonError) {
      primaryError = error;
      if (error.statusCode === 404) {
        throw error;
      }
    } else {
      throw error;
    }
  }

  if (!normalizedFallbackUrl) {
    throw primaryError;
  }

  logger.debug('Horizon RPC fallback: primary exhausted, switching to fallback URL', safeHorizonContext({
    component: 'horizon',
    stellarAddress,
    horizonUrl,
    horizonUrlFallback: normalizedFallbackUrl,
    cacheKey: cachingEnabled ? cacheKey : undefined,
    primaryStatusCode: primaryError?.statusCode,
    primaryRetryable: primaryError?.retryable,
    primaryErrorMessage: primaryError ? redactString(primaryError.message) : undefined,
  }));

  try {
    const fallbackResult = await fetchAccountOnce(
      fetch,
      normalizedFallbackUrl,
      stellarAddress,
      timeoutMs,
      maxRetries,
      'fallback',
    );

    if (cachingEnabled) {
      cache.set(cacheKey, fallbackResult.account, cacheTtlMs);
      const cacheStatsAfter = redactCacheStats(cache.getStats());
      logger.debug('Horizon cache populate after fallback success', safeHorizonContext({
        component: 'horizon',
        stellarAddress,
        horizonUrl,
        horizonUrlFallback: normalizedFallbackUrl,
        cacheKey,
        cacheTtlMs,
        cacheSizeAfter: cacheStatsAfter.size,
        cacheEntryCountAfter: cacheStatsAfter.entries.length,
        source: 'fallback',
        ...safeAccountSummary(fallbackResult.account),
      }));
    }

    logger.debug('Horizon RPC fallback succeeded', safeHorizonContext({
      component: 'horizon',
      stellarAddress,
      horizonUrl,
      horizonUrlFallback: normalizedFallbackUrl,
      fallbackAttempts: fallbackResult.attempts,
      fallbackLatencyMs: fallbackResult.latencyMs,
    }));

    return fallbackResult.account;
  } catch (fallbackError) {
    if (fallbackError instanceof HorizonError) {
      logger.debug('Horizon RPC fallback exhausted', safeHorizonContext({
        component: 'horizon',
        stellarAddress,
        horizonUrl,
        horizonUrlFallback: normalizedFallbackUrl,
        primaryStatusCode: primaryError?.statusCode,
        primaryErrorMessage: primaryError ? redactString(primaryError.message) : undefined,
        fallbackStatusCode: fallbackError.statusCode,
        fallbackErrorMessage: redactString(fallbackError.message),
      }));
    }
    throw fallbackError;
  }
}

export interface WaitForFundedAccountOptions {
  /** Total time budget to keep polling before giving up, in milliseconds. */
  timeoutMs?: number;
  /** Delay between polling attempts, in milliseconds. */
  pollIntervalMs?: number;
  /** Per-request timeout passed through to each `fetchAccount` call. */
  requestTimeoutMs?: number;
  /** Per-request retry count passed through to each `fetchAccount` call. */
  maxRetries?: number;
  /** Called after each unfunded (404) poll, before sleeping for the next attempt. */
  onPoll?: (attempt: number, elapsedMs: number) => void;
}

const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * Poll Horizon for an account until it becomes funded or the timeout budget
 * is exhausted. Only Horizon 404 ("not found") responses are treated as
 * "not yet funded" and trigger another poll — any other error (rate limit
 * exhaustion, Horizon outage, network failure) is rethrown immediately so
 * outages don't turn into a silent multi-minute hang.
 */
export async function waitForFundedAccount(
  horizonUrl: string,
  stellarAddress: string,
  options: WaitForFundedAccountOptions = {},
  fetchAccountFn: typeof fetchAccount = fetchAccount,
): Promise<HorizonAccount> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const start = Date.now();
  let attempt = 0;

  for (;;) {
    attempt += 1;

    try {
      return await fetchAccountFn(horizonUrl, stellarAddress, {
        timeoutMs: options.requestTimeoutMs,
        maxRetries: options.maxRetries,
      });
    } catch (error) {
      if (!(error instanceof HorizonError) || error.statusCode !== 404) {
        throw error;
      }

      const elapsedMs = Date.now() - start;
      if (elapsedMs >= timeoutMs) {
        throw new HorizonError(
          `Account ${stellarAddress} was still not funded after waiting ${timeoutMs}ms (wait_until_funded timeout).`,
          404,
          false,
        );
      }

      options.onPoll?.(attempt, elapsedMs);
      await sleep(Math.min(pollIntervalMs, timeoutMs - elapsedMs));
    }
  }
}

/**
 * Narrows to a credit trustline balance (`credit_alphanum4` /
 * `credit_alphanum12`) only. Checks the asset_type allowlist explicitly
 * rather than `!== 'native'` — liquidity-pool-share balances
 * (`asset_type: "liquidity_pool_shares"`) carry no `asset_code`/
 * `asset_issuer` and must never be misclassified as a credit trustline,
 * since that would let a same-shaped LP entry slip through a naive
 * trustline match.
 */
export function isCreditBalance(balance: HorizonBalance): balance is HorizonBalanceCredit {
  return balance.asset_type === 'credit_alphanum4' || balance.asset_type === 'credit_alphanum12';
}

export function getNativeBalance(account: HorizonAccount): string {
  const native = account.balances.find((b) => b.asset_type === 'native');
  return native?.balance ?? '0';
}

export function hasTrustline(
  account: HorizonAccount,
  assetCode: string,
  assetIssuer: string,
): boolean {
  return account.balances.some(
    (balance) =>
      isCreditBalance(balance) &&
      balance.asset_code === assetCode &&
      balance.asset_issuer === assetIssuer,
  );
}

/**
 * Returns the credit trustline balance entry matching `assetCode` +
 * `assetIssuer`, or `undefined` if no such trustline exists. Unlike
 * `hasTrustline`, this exposes the full balance object so callers can
 * inspect per-trustline flags such as `is_authorized` and
 * `is_clawback_enabled`.
 */
export function findTrustlineBalance(
  account: HorizonAccount,
  assetCode: string,
  assetIssuer: string,
): HorizonBalanceCredit | undefined {
  return account.balances.find(
    (balance): balance is HorizonBalanceCredit =>
      isCreditBalance(balance) &&
      balance.asset_code === assetCode &&
      balance.asset_issuer === assetIssuer,
  );
}

/**
 * A trustline is considered authorized unless the issuer has explicitly
 * marked it unauthorized (`is_authorized === false`). Horizon omits this
 * field entirely when the issuer's AUTHORIZATION_REQUIRED flag is not set,
 * so "field absent" must be treated as authorized, not as unknown.
 */
export function isTrustlineAuthorized(balance: HorizonBalanceCredit): boolean {
  return balance.is_authorized !== false;
}

export function parseHorizonBalance(balance: string): number {
  const parsed = Number(balance);
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface HorizonFetchOptions {
  maxRetries?: number;
  retryBaseDelayMs?: number;
}
