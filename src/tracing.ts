import * as tls from 'tls';
import * as crypto from 'crypto';
import { defaultCache, SimpleCache } from './cache';
import { logger, redactHorizonUrl, redactStellarAddress, redactString, LogContext } from './logger';
import { inferStellarNetwork } from './links';
import { globalMetrics, globalHorizonHistogram } from './metrics';
import { RateBudgetTracker, CircuitBreaker, CircuitOpenError } from './resilience';
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
  limit?: string; // Maximum balance this trustline can hold (Issue #140)
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
  /** Sponsorship fields (CAP-0033). Omitted by older Horizon snapshots — treat as 0 when absent. */
  num_sponsoring?: number;
  num_sponsored?: number;
  /** Horizon base URL that actually served this account snapshot (primary or failover). */
  _servedByUrl?: string;
  /**
   * SEP-0001: The domain that hosts the issuer's stellar.toml metadata file.
   * Populated by Horizon when the issuer account has set a home_domain on-chain.
   * May be absent on older Horizon snapshots or when the issuer has not configured it.
   * Never use this value directly in a network request without SSRF-safe validation.
   */
  home_domain?: string;
  /**
   * Bitmask of account flags set by the issuer (AUTH_REQUIRED, AUTH_REVOCABLE, etc.).
   * Omitted by older Horizon snapshots — treat as 0 when absent.
   */
  flags?: {
    auth_required?: boolean;
    auth_revocable?: boolean;
    auth_immutable?: boolean;
    auth_clawback_enabled?: boolean;
  };
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

export class HorizonRateLimitError extends HorizonError {
  constructor(message: string, public readonly retryAfterMs?: number) {
    super(message, 429, true);
    this.name = 'HorizonRateLimitError';
  }
}

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
 * Thrown when the Horizon TLS certificate fingerprint does not match the
 * configured `horizon_pin_fingerprint` value (Issue #303).
 */
export class HorizonPinMismatchError extends HorizonError {
  constructor(
    message: string,
    public readonly expectedFingerprint: string,
    public readonly actualFingerprint: string,
  ) {
    super(message, 0, false);
    this.name = 'HorizonPinMismatchError';
  }
}

/**
 * Thrown when a Horizon request was short-circuited by the circuit breaker
 * (Issue #209) and surfaced for comment rendering (Issue #434).
 *
 * Distinct from a plain `HorizonError` because the failure says nothing about
 * the account: no request reached the network, so the account was never
 * checked. The sticky comment renders a dedicated "circuit breaker open"
 * banner for this case so a resilience safeguard is not mistaken for an
 * account-level failure.
 *
 * Extends `HorizonError` so existing `instanceof HorizonError` handling keeps
 * working unchanged.
 */
export class HorizonCircuitOpenError extends HorizonError {
  constructor(message: string) {
    super(message, 0, false);
    this.name = "HorizonCircuitOpenError";
  }
}

/** Is this error a circuit-breaker fast-fail (Issue #434)? */
export function isCircuitOpenError(
  error: unknown,
): error is HorizonCircuitOpenError {
  return (
    error instanceof HorizonCircuitOpenError ||
    error instanceof CircuitOpenError ||
    (error instanceof Error && error.name === "HorizonCircuitOpenError")
  );
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

/**
 * Verify the TLS certificate fingerprint of a Horizon endpoint against an
 * expected SHA-256 fingerprint (Issue #303).
 *
 * @param horizonUrl - The Horizon URL to check (must be https:)
 * @param expectedFingerprint - SHA-256 fingerprint in colon-separated uppercase hex (e.g. 'AA:BB:...').
 *   Pass an empty string to skip the pin check and rely on standard WebPKI validation.
 * @throws {HorizonPinMismatchError} When the actual fingerprint does not match `expectedFingerprint`.
 * @throws {HorizonTlsError} When the TLS connection or certificate retrieval fails.
 */
export async function checkCertificatePin(
  horizonUrl: string,
  expectedFingerprint: string,
): Promise<void> {
  const parsed = new URL(horizonUrl);
  if (parsed.protocol !== 'https:') {
    // Only HTTPS connections have TLS certificates to pin
    return;
  }

  // When pinFingerprint is empty (not configured), skip the pin check
  // and rely on standard WebPKI certificate validation.
  if (!expectedFingerprint || expectedFingerprint.trim() === '') {
    return;
  }

  const host = parsed.hostname;
  const port = parseInt(parsed.port || '443', 10);
  const normalizedExpected = expectedFingerprint.toUpperCase().replace(/\s/g, '');

  return new Promise<void>((resolve, reject) => {
    // NOTE: chain validation is intentionally disabled here. The configured
    // SHA-256 fingerprint IS the trust anchor for this probe: connecting only
    // succeeds when the presented certificate hashes exactly to the expected
    // value, which an attacker cannot forge without the pinned private key.
    // Requiring a public chain on top would make pinning unusable for
    // private mirrors while adding no security once the pin is verified.
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => {
      try {
        const cert = socket.getPeerCertificate();
        socket.destroy();

        if (!cert || !cert.raw) {
          reject(new HorizonTlsError(
            'Could not retrieve server certificate for fingerprint check.',
          ));
          return;
        }

        // Compute SHA-256 fingerprint over the raw DER-encoded certificate
        const fingerprint = crypto
          .createHash('sha256')
          .update(cert.raw)
          .digest('hex')
          .toUpperCase()
          .match(/.{2}/g)!
          .join(':');

        const normalizedActual = fingerprint.toUpperCase().replace(/\s/g, '');

        // Compare separator-insensitively: operators paste fingerprints with
        // colons, spaces or nothing between octets.
        const comparableActual = normalizedActual.replace(/:/g, '');
        const comparableExpected = normalizedExpected.replace(/:/g, '');
        if (comparableActual !== comparableExpected) {
          reject(new HorizonPinMismatchError(
            `TLS certificate fingerprint mismatch for Horizon endpoint. ` +
            `Expected: ${normalizedExpected}, Got: ${normalizedActual}. ` +
            `The Horizon host certificate may have changed — update horizon_pin_fingerprint or investigate MITM.`,
            normalizedExpected,
            normalizedActual,
          ));
          return;
        }

        resolve();
      } catch (err) {
        socket.destroy();
        reject(err instanceof Error ? err : new HorizonTlsError('Certificate pin check failed.'));
      }
    });

    socket.on('error', (err) => {
      const tlsCode = (err as NodeJS.ErrnoException).code;
      reject(new HorizonTlsError(
        'TLS connection failed during certificate pin check.',
        tlsCode,
      ));
    });

    // 10 second timeout for the TLS probe
    socket.setTimeout(10000, () => {
      socket.destroy();
      reject(new HorizonTlsError('TLS certificate pin check timed out.'));
    });
  });
}

export type FetchLike = (
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
  /** Short TTL for Horizon 404/not-found markers; zero disables negative caching. */
  negativeCacheTtlMs?: number;
  cache?: SimpleCache;
  fetchFn?: FetchLike;
  /**
   * Optional AbortSignal from a parent controller (e.g. job cancellation).
   * When the signal fires, in-flight and pending requests are aborted
   * immediately; no misleading "account not funded" result is produced.
   */
  signal?: AbortSignal;
  /**
   * Base delay for exponential backoff (`retry_base_delay_ms`). The n-th
   * retry waits `retryBaseDelayMs * 2^n`, capped at `retryMaxDelayMs`.
   */
  retryBaseDelayMs?: number;
  /**
   * Hard cap on any single retry sleep (`retry_max_delay_ms`), applied to
   * both `Retry-After` values and exponential backoff. 0 disables sleeping
   * between retries while still honoring `maxRetries`.
   */
  retryMaxDelayMs?: number;
  /**
   * Cumulative sleep budget across all retries of one endpoint
   * (`retry_max_total_wait_ms`). When the next sleep would exceed it the
   * retry loop aborts with a `HorizonRateLimitError` (429) or the last
   * transport error instead of sleeping.
   */
  retryMaxTotalWaitMs?: number;
  /** Per-run Horizon request budget (`horizon_max_requests`). */
  horizonMaxRequests?: number;
  rateBudgetTracker?: RateBudgetTracker;
  /** Optional circuit breaker for Horizon fetches (Issue #209). */
  circuitBreaker?: CircuitBreaker;
  /**
   * Opt into a fallback URL on a different Stellar network than the primary
   * `horizon_url`. Off by default: a G-address is valid on every network, so
   * a cross-network fallback could silently report data from the wrong ledger.
   */
  allowCrossNetworkFallback?: boolean;
  /** Alias for `allowCrossNetworkFallback` kept for older call sites / tests. */
  allowCrossNetworkFailover?: boolean;
  /** Optional secondary Horizon URL used for same-network failover. */
  secondaryHorizonUrl?: string;
  /** Optional SHA-256 TLS certificate fingerprint pin (Issue #303). */
  pinFingerprint?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
export const DEFAULT_NEGATIVE_CACHE_TTL_MS = 15_000;
export const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
export const DEFAULT_RETRY_MAX_TOTAL_WAIT_MS = 120_000;

export function normalizeHorizonUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return '';
  }
  // Horizon endpoints may use http on private/testnet mirrors; still enforce
  // credential + traversal guards via validateHorizonUrl.
  const validation = validateHorizonUrl(trimmed, 'horizon_url', { allowHttp: true });
  if (!validation.valid) {
    throw new HorizonError(`Invalid horizon_url: ${validation.errors.join('; ')}`, 400, false);
  }
  // Re-check raw traversal after allowing http, since URL() would otherwise normalize it.
  if (/(?:^|\/)(?:\.\.|%2e%2e)(?:\/|$)/i.test(trimmed) || /\/\.\//.test(trimmed)) {
    throw new HorizonError('Invalid horizon_url: path traversal segments are not allowed', 400, false);
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
    // Negative or non-finite values (e.g. "-5", "1e400") are treated as
    // absent so the caller falls back to capped exponential backoff.
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
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

/**
 * Sleep for `ms` milliseconds, but resolve immediately (without throwing) if
 * `signal` is aborted before the timer fires.  The caller is responsible for
 * checking `signal.aborted` after the await if it needs to stop on cancellation.
 */
function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return sleep(ms);
  }
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
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

/**
 * Record a cache hit/miss metric point. The `horizonUrl` and
 * `stellarAddress` tags carry the same key dimensions as the cache entry
 * itself (see `buildCacheKey`), so metrics can be sliced per matrix leg
 * (e.g. per Horizon endpoint) — but the address is redacted first-4/last-4
 * so the metric export never leaks a full contributor address, matching
 * the redaction policy used everywhere else in this module.
 */
function recordCacheMetric(
  outcome: 'hit' | 'miss',
  normalizedHorizonUrl: string,
  stellarAddress: string,
): void {
  globalMetrics.recordMetric(`horizon_cache_${outcome}`, 1, 'count', {
    horizonUrl: redactHorizonUrl(normalizedHorizonUrl),
    stellarAddress: redactStellarAddress(stellarAddress),
  });
  globalMetrics.incrementCounter(`horizon_cache_${outcome}`);
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
  retryMaxDelayMs: number = DEFAULT_RETRY_MAX_DELAY_MS,
  retryMaxTotalWaitMs: number = DEFAULT_RETRY_MAX_TOTAL_WAIT_MS,
  parentSignal?: AbortSignal,
  rateBudgetTracker?: RateBudgetTracker,
  circuitBreaker?: CircuitBreaker,
  retryBaseDelayMs: number = DEFAULT_RETRY_BASE_DELAY_MS,
): Promise<FetchOnceResult> {
  const externalSignal = parentSignal;
  const normalizedHorizonUrl = normalizeHorizonUrl(targetHorizonUrl);
  const url = `${normalizedHorizonUrl}/accounts/${stellarAddress}`;
  const safeUrlForLog = redactHorizonUrl(url);

  let attempt = 0;
  let totalWaitMs = 0;
  let lastError: Error | undefined;

  while (attempt <= maxRetries) {
    // Bail out immediately if the job was cancelled before this attempt.
    if (parentSignal?.aborted) {
      throw new HorizonError('Horizon request aborted (job cancelled).', 0, false);
    }

    const requestStartedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Propagate the parent cancellation signal to the per-request controller.
    let parentAbortHandler: (() => void) | undefined;
    if (parentSignal) {
      parentAbortHandler = () => controller.abort();
      parentSignal.addEventListener("abort", parentAbortHandler);
    }

    logger.debug(
      "Horizon fetch start",
      safeHorizonContext({
        component: "horizon",
        stellarAddress,
        horizonUrl: targetHorizonUrl,
        endpointKind,
        attempt,
        maxAttempts: maxRetries + 1,
        timeoutMs,
        url: safeUrlForLog,
      }),
    );

    try {
      if (rateBudgetTracker) {
        rateBudgetTracker.recordRequest();
      }

      // Issue #209: Wrap Horizon fetches with the circuit breaker.
      // When the circuit is open, this throws CircuitOpenError immediately
      // without reaching the network. Cache hits bypass the circuit breaker.
      const response = circuitBreaker
        ? await circuitBreaker.execute(() =>
            fetch(url, {
              method: 'GET',
              headers: { Accept: 'application/json' },
              signal: controller.signal,
            }),
          )
        : await fetch(url, {
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
        globalHorizonHistogram.record(endpointKind, latencyMs);
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
          logger.debug(
            "Horizon error response parsed",
            safeHorizonContext({
              component: "horizon",
              stellarAddress,
              horizonUrl: targetHorizonUrl,
              endpointKind,
              status: response.status,
              retryable,
              latencyMs,
              attempt,
              // Issue #697: never log Horizon response bodies on retryable
              // (429/5xx) responses — they can echo request details back.
              ...(retryable
                ? { bodyOmitted: true }
                : {
                    errorDetail: redactString(detail),
                    errorType: body.type ? redactString(body.type) : undefined,
                    errorTitle: body.title ? redactString(body.title) : undefined,
                  }),
            }),
          );
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
          // Issue #218: Honor Retry-After on 429s, capped at retryMaxDelayMs.
          // When the header is missing or the value exceeds the cap, fall back
          // to exponential backoff so the action never waits unbounded.
          let retryAfter: number;
          let retryAfterCapped = false;
          if (retryAfterHeader !== null) {
            retryAfter = Math.min(retryAfterHeader, retryMaxDelayMs);
            retryAfterCapped = retryAfterHeader > retryMaxDelayMs;
            if (retryAfterHeader > retryMaxDelayMs) {
              // Issue #705: surface the cap. Only the parsed millisecond
              // values are logged, never the raw header string.
              logger.info(
                `Horizon Retry-After capped: requested ${Math.round(retryAfterHeader)}ms exceeds retry_max_delay_ms (${retryMaxDelayMs}ms); sleeping ${retryAfter}ms.`,
                safeHorizonContext({
                  component: "horizon",
                  stellarAddress,
                  horizonUrl: targetHorizonUrl,
                  endpointKind,
                  status: response.status,
                  attempt,
                  retryAfterRequestedMs: Math.round(retryAfterHeader),
                  retryMaxDelayMs,
                }),
              );
            }
          } else {
            retryAfter = Math.min(
              retryBaseDelayMs * 2 ** attempt,
              retryMaxDelayMs,
            );
            retryAfterCapped = retryBaseDelayMs * 2 ** attempt > retryMaxDelayMs;
          }

          if (totalWaitMs + retryAfter > retryMaxTotalWaitMs) {
            logger.horizonRetry({
              phase: "exhausted",
              reason: "wait_budget",
              attempt,
              maxAttempts: maxRetries + 1,
              status: response.status,
              delayMs: 0,
              capped: retryAfterCapped,
              kind: "http",
              endpointKind,
              horizonUrl: normalizedHorizonUrl,
              stellarAddress,
              retryAfterFromHeader: retryAfterHeader !== null,
            });
            throw new HorizonRateLimitError(
              `Horizon retry wait budget exhausted (total wait ${totalWaitMs + retryAfter}ms exceeds cap of ${retryMaxTotalWaitMs}ms). Please try again later.`,
              retryAfter,
            );
          }

          totalWaitMs += retryAfter;

          logger.horizonRetry({
            phase: 'scheduled',
            attempt,
            maxAttempts: maxRetries + 1,
            status: response.status,
            delayMs: retryAfter,
            capped: retryAfterCapped,
            kind: 'http',
            endpointKind,
            horizonUrl: normalizedHorizonUrl,
            stellarAddress,
            retryAfterFromHeader: retryAfterHeader !== null,
          });
          if (retryAfter > 0) {
            await cancellableSleep(retryAfter, parentSignal);
          }
          // If the job was cancelled during the sleep, bail out on the next
          // iteration's pre-flight check rather than issuing another request.
          attempt += 1;
          continue;
        }

        if (retryable) {
          logger.horizonRetry({
            phase: "exhausted",
            reason: "max_retries",
            attempt,
            maxAttempts: maxRetries + 1,
            status: response.status,
            delayMs: 0,
            capped: false,
            kind: "http",
            endpointKind,
            horizonUrl: normalizedHorizonUrl,
            stellarAddress,
          });
        }

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
      globalHorizonHistogram.record(endpointKind, latencyMs);
      return {
        account: parsed,
        statusCode: response.status,
        latencyMs,
        attempts: attempt + 1,
      };
    } catch (error) {
      if (error instanceof HorizonError || (error instanceof Error && error.name === 'RateBudgetExhaustedError')) {
        throw error;
      }

      // Issue #209: CircuitOpenError means the circuit breaker is open.
      // Treat as non-retryable — the breaker will transition to half-open
      // after its recovery timeout. Surfaced as HorizonCircuitOpenError
      // (Issue #434) so comment rendering shows the dedicated
      // circuit-breaker banner instead of a generic account error.
      if (error instanceof CircuitOpenError) {
        logger.debug('Horizon request blocked by circuit breaker', safeHorizonContext({
          component: 'horizon',
          stellarAddress,
          horizonUrl: targetHorizonUrl,
          endpointKind,
          attempt,
          final: true,
        }));
        throw new HorizonCircuitOpenError(
          `Horizon request blocked by circuit breaker: ${error.message}`,
        );
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
      // If the parent job signal fired, propagate as a non-retryable cancellation.
      const isJobCancelled = isAbort && externalSignal?.aborted;
      const message = isJobCancelled
        ? 'Horizon request aborted (job cancelled).'
        : isAbort
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
        kind: isJobCancelled ? 'cancelled' : isAbort ? 'timeout' : 'network',
        latencyMs,
        attempt,
        timeoutMs,
        errorMessage: redactString(message),
      }));

      // Job cancellation is non-retryable — throw immediately.
      if (isJobCancelled) {
        throw new HorizonError(message, 0, false);
      }

      lastError = new HorizonError(message, isAbort ? 408 : 0, true);

      const transportKind = isAbort ? "timeout" : "network";

      if (attempt < maxRetries) {
        const backoffMs = Math.min(
          retryBaseDelayMs * 2 ** attempt,
          retryMaxDelayMs,
        );
        const backoffCapped = retryBaseDelayMs * 2 ** attempt > retryMaxDelayMs;

        if (totalWaitMs + backoffMs > retryMaxTotalWaitMs) {
          logger.horizonRetry({
            phase: "exhausted",
            reason: "wait_budget",
            attempt,
            maxAttempts: maxRetries + 1,
            status: 0,
            delayMs: 0,
            capped: backoffCapped,
            kind: transportKind,
            endpointKind,
            horizonUrl: normalizedHorizonUrl,
            stellarAddress,
          });
          throw lastError;
        }

        totalWaitMs += backoffMs;

        logger.horizonRetry({
          phase: 'scheduled',
          attempt,
          maxAttempts: maxRetries + 1,
          status: 0,
          delayMs: backoffMs,
          capped: backoffCapped,
          kind: transportKind,
          endpointKind,
          horizonUrl: normalizedHorizonUrl,
          stellarAddress,
        });
        if (backoffMs > 0) {
          await cancellableSleep(backoffMs, parentSignal);
        }
        // If the job was cancelled during the backoff sleep, bail out on the
        // next iteration's pre-flight check rather than issuing another request.
        attempt += 1;
        continue;
      }

      logger.debug(
        "Horizon transport error (exhausted retries)",
        safeHorizonContext({
          component: "horizon",
          stellarAddress,
          horizonUrl: targetHorizonUrl,
          endpointKind,
          kind: transportKind,
          latencyMs,
          attempt,
          final: true,
        }),
      );

      logger.horizonRetry({
        phase: "exhausted",
        reason: "max_retries",
        attempt,
        maxAttempts: maxRetries + 1,
        status: 0,
        delayMs: 0,
        capped: false,
        kind: transportKind,
        endpointKind,
        horizonUrl: normalizedHorizonUrl,
        stellarAddress,
      });

      throw lastError;
    } finally {
      clearTimeout(timer);
      if (parentSignal && parentAbortHandler) {
        parentSignal.removeEventListener("abort", parentAbortHandler);
      }
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
  const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const negativeCacheTtlMs = options.negativeCacheTtlMs ?? DEFAULT_NEGATIVE_CACHE_TTL_MS;
  const retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
  const retryMaxTotalWaitMs = options.retryMaxTotalWaitMs ?? DEFAULT_RETRY_MAX_TOTAL_WAIT_MS;
  const cache = options.cache ?? defaultCache;
  const horizonMaxRequests = options.horizonMaxRequests ?? 0;
  const rateBudgetTracker = options.rateBudgetTracker ?? new RateBudgetTracker(horizonMaxRequests);
  const signal = options.signal;
  const allowCrossNetwork =
    options.allowCrossNetworkFallback === true || options.allowCrossNetworkFailover === true;
  const normalizedHorizonUrl = normalizeHorizonUrl(horizonUrl);
  const candidateFallbacks = [
    options.secondaryHorizonUrl,
    options.horizonUrlFallback,
    ...(options.fallbackUrls ?? []),
  ].filter((u): u is string => Boolean(u && u.trim()));
  const fallbackCandidate = candidateFallbacks[0];
  const normalizedFallbackUrl = fallbackCandidate
    ? normalizeHorizonUrl(fallbackCandidate)
    : '';

  if (!normalizedHorizonUrl) {
    throw new HorizonError('horizon_url is required.', 0, false);
  }

  // Bail out immediately if the job was already cancelled before we start.
  if (signal?.aborted) {
    throw new HorizonError('Horizon request aborted (job cancelled).', 0, false);
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

    const negative = negativeCacheTtlMs > 0 ? cache.getNegative(cacheKey) : null;
    if (negative) {
      recordCacheMetric('hit', normalizedHorizonUrl, stellarAddress);
      throw new HorizonError(negative.message, 404, false);
    }
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
      recordCacheMetric('hit', normalizedHorizonUrl, stellarAddress);
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
    recordCacheMetric('miss', normalizedHorizonUrl, stellarAddress);
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
  const circuitBreaker = options.circuitBreaker;

  try {
    const result = await fetchAccountOnce(
      fetch,
      normalizedHorizonUrl,
      stellarAddress,
      timeoutMs,
      maxRetries,
      'primary',
      retryMaxDelayMs,
      retryMaxTotalWaitMs,
      signal,
      rateBudgetTracker,
      circuitBreaker,
      retryBaseDelayMs,
    );

    result.account._servedByUrl = normalizedHorizonUrl;

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
        if (cachingEnabled && negativeCacheTtlMs > 0) {
          cache.setNegative(cacheKey, error.message, negativeCacheTtlMs);
        }
        throw error;
      }
    } else {
      throw error;
    }
  }

  if (!normalizedFallbackUrl) {
    throw primaryError;
  }

  // Network binding rule: a G-address is valid on every Stellar network, so
  // a fallback URL that resolves to a different network than the primary
  // could silently return funded/trustline/reserve data for the *wrong*
  // ledger instead of failing loudly. Compare the inferred networks and
  // refuse the fallback unless the caller explicitly opted in.
  const primaryNetwork = inferStellarNetwork(normalizedHorizonUrl);
  const fallbackNetwork = inferStellarNetwork(normalizedFallbackUrl);
  const crossNetworkFallback = primaryNetwork !== fallbackNetwork;

  if (crossNetworkFallback && !allowCrossNetwork) {
    logger.debug('Horizon RPC fallback skipped: primary and fallback resolve to different networks', safeHorizonContext({
      component: 'horizon',
      stellarAddress,
      horizonUrl,
      horizonUrlFallback: normalizedFallbackUrl,
      primaryNetwork,
      fallbackNetwork,
      primaryStatusCode: primaryError?.statusCode,
      primaryErrorMessage: primaryError ? redactString(primaryError.message) : undefined,
    }));
    // Fail closed with an explicit cross-network error (Issue #687) rather
    // than surfacing the primary error, so operators can tell a blocked
    // fallback apart from a plain primary outage. The status is synthetic
    // (0): this error describes a policy refusal, not an HTTP response.
    throw new HorizonError(
      `Cross-network fallback from ${primaryNetwork} to ${fallbackNetwork} is blocked: ` +
      `primary ${primaryNetwork} Horizon (${normalizedHorizonUrl}) failed and ` +
      `allow_cross_network_fallback is not enabled, so the ${fallbackNetwork} ` +
      `fallback (${normalizedFallbackUrl}) was not attempted. ` +
      `Primary error: ${primaryError ? redactString(primaryError.message) : 'unknown'}`,
      0,
      false,
    );
  }

  logger.debug('Horizon RPC fallback: primary exhausted, switching to fallback URL', safeHorizonContext({
    component: 'horizon',
    stellarAddress,
    horizonUrl,
    horizonUrlFallback: normalizedFallbackUrl,
    cacheKey: cachingEnabled ? cacheKey : undefined,
    primaryNetwork,
    fallbackNetwork,
    crossNetworkFallback,
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
      retryMaxDelayMs,
      retryMaxTotalWaitMs,
      signal,
      rateBudgetTracker,
      circuitBreaker,
      retryBaseDelayMs,
    );

    fallbackResult.account._servedByUrl = normalizedFallbackUrl;

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

/**
 * Fetch the asset issuer account for the SEP-0001 home domain check (Issue
 * #708). Returns `null` when the issuer is not a classic G-address (Soroban
 * contract issuers have no `home_domain`) or when Horizon can't return it,
 * so the check reports "missing" instead of failing the whole run.
 */
export async function fetchHomeDomainIssuerAccount(
  horizonUrl: string,
  assetIssuer: string,
  options: FetchAccountOptions = {},
): Promise<HorizonAccount | null> {
  const issuer = assetIssuer.trim();
  if (!/^G[A-Z2-7]{55}$/.test(issuer)) {
    return null;
  }
  try {
    return await fetchAccount(horizonUrl, issuer, options);
  } catch (error) {
    logger.debug('Home domain issuer account unavailable', {
      component: 'horizon',
      assetIssuer: issuer,
      horizonUrl,
      errorMessage: error instanceof Error ? redactString(error.message) : 'unknown error',
    });
    return null;
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
  /** Optional AbortSignal from a parent controller (e.g. job cancellation).
   *  When the signal fires, polling stops immediately without emitting a
   *  misleading "account not funded" result. */
  signal?: AbortSignal;
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
  const signal = options.signal;
  const start = Date.now();
  let attempt = 0;

  for (;;) {
    // Bail out cleanly if the job was cancelled — no misleading error message.
    if (signal?.aborted) {
      throw new HorizonError('Polling aborted (job cancelled).', 0, false);
    }

    attempt += 1;

    try {
      return await fetchAccountFn(horizonUrl, stellarAddress, {
        timeoutMs: options.requestTimeoutMs,
        maxRetries: options.maxRetries,
        signal,
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

      // Sleep for the poll interval, but abort immediately if the job is cancelled.
      const sleepMs = Math.min(pollIntervalMs, timeoutMs - elapsedMs);
      await cancellableSleep(sleepMs, signal);
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
 * Locate the credit trustline balance entry for a specific asset so callers
 * can inspect per-trustline flags such as `is_authorized` and
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

/**
 * Get the balance string for a specific credit asset trustline, or `'0'`
 * when the trustline is absent.
 */
export function getAssetBalance(
  account: HorizonAccount,
  assetCode: string,
  assetIssuer: string,
): string {
  return findTrustlineBalance(account, assetCode, assetIssuer)?.balance ?? '0';
}

/**
 * Get the trustline limit for a specific asset, if it exists.
 * Returns the limit as a string (as provided by Horizon) or '0' if not found.
 */
export function getTrustlineLimit(
  account: HorizonAccount,
  assetCode: string,
  assetIssuer: string,
): string {
  const balance = findTrustlineBalance(account, assetCode, assetIssuer);
  return balance?.limit ? balance.limit : '0';
}

export function parseHorizonBalance(balance: string): number {
  const parsed = Number(balance);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Format a stroop amount (1 XLM = 10^7 stroops) as a fixed 7-decimal XLM string.
 */
export function formatStroops(stroops: bigint): string {
  const isNegative = stroops < 0n;
  const absStroops = isNegative ? -stroops : stroops;

  const str = absStroops.toString().padStart(8, '0');
  const intPart = str.slice(0, -7);
  const fracPart = str.slice(-7);

  const cleanFrac = fracPart.replace(/0+$/, '');
  return `${isNegative ? '-' : ''}${intPart}.${cleanFrac.padEnd(7, '0')}`;
}

export interface HorizonFetchOptions {
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

// ---------------------------------------------------------------------------
// Claimable balances helper (Issue #260)
// ---------------------------------------------------------------------------

/**
 * Fetch the number of claimable balances for a claimant address.
 *
 * Used only when `claimableBalancePolicy === 'count'` and the account is 404.
 * Returns 0 on any error (404, network, timeout) so callers can treat the
 * absence as "no evidence" without failing the run. The request is bounded to
 * 5s and validated for SSRF so private Horizon mirrors are never probed
 * with an attacker-controlled claimant.
 *
 * Horizon endpoint: `GET /claimable_balances?claimant=<G-address>&limit=5`
 * The limit is intentionally small — we only need to know if >0 exist and
 * at most a count up to 5 for the informational comment.
 */
export async function fetchClaimableBalanceCount(
  horizonUrl: string,
  stellarAddress: string,
  fetchFn?: FetchLike,
  timeoutMs: number = 5000,
): Promise<number> {
  const validation = validateHorizonUrl(horizonUrl, 'horizon_url', { allowHttp: true });
  if (!validation.valid) {
    return 0;
  }
  let normalized: string;
  try {
    normalized = normalizeHorizonUrl(horizonUrl);
  } catch {
    return 0;
  }
  const url = `${normalized}/claimable_balances?claimant=${encodeURIComponent(stellarAddress)}&limit=5`;
  const fetcher = fetchFn ?? (await import('node-fetch')).default;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal as unknown as import('node-fetch').RequestInit['signal'],
      });
      if (!response.ok) {
        return 0;
      }
      const data = (await response.json()) as {
        _embedded?: { records?: unknown[] };
        records?: unknown[];
      };
      const records = data._embedded?.records ?? data.records ?? [];
      if (Array.isArray(records)) {
        return records.length;
      }
      return 0;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Auto wallet labels  (Wave #31)
// ---------------------------------------------------------------------------

/**
 * Labels automatically applied to a GitHub issue based on the Stellar
 * wallet state discovered during an account check.
 *
 * - `wallet: funded`           — account exists and XLM balance ≥ reserve.
 * - `wallet: unfunded`         — Horizon returned 404 (account not yet created).
 * - `wallet: trustline-missing`— account funded but missing the required trustline.
 * - `wallet: reserve-low`      — account funded + trustline present but XLM reserve not met.
 * - `wallet: horizon-error`    — Horizon returned a non-404 error; state unknown.
 */
export type WalletLabel =
  | 'wallet: funded'
  | 'wallet: unfunded'
  | 'wallet: trustline-missing'
  | 'wallet: reserve-low'
  | 'wallet: horizon-error';

/**
 * All wallet label strings — useful for bulk removal before re-applying
 * the current state so stale labels never linger on an issue.
 */
export const ALL_WALLET_LABELS: WalletLabel[] = [
  'wallet: funded',
  'wallet: unfunded',
  'wallet: trustline-missing',
  'wallet: reserve-low',
  'wallet: horizon-error',
];

export interface WalletLabelInput {
  /** Whether Horizon returned an active account (HTTP 200). */
  accountFunded: boolean;
  /** Whether the required asset trustline exists on the account. */
  trustlineExists: boolean;
  /** Whether the native XLM balance meets the configured minimum. */
  xlmReserveMet: boolean;
  /** Whether a Horizon error (non-404) occurred during the check. */
  horizonError?: boolean;
}

/**
 * Derive the single wallet label that best describes the current account
 * state. Priority order:
 *
 * 1. `wallet: horizon-error`    — any Horizon error takes precedence.
 * 2. `wallet: unfunded`         — account not found (404).
 * 3. `wallet: trustline-missing`— funded but trustline absent.
 * 4. `wallet: reserve-low`      — funded + trustline but XLM below reserve.
 * 5. `wallet: funded`           — all checks passed.
 */
export function deriveWalletLabel(input: WalletLabelInput): WalletLabel {
  if (input.horizonError) return 'wallet: horizon-error';
  if (!input.accountFunded) return 'wallet: unfunded';
  if (!input.trustlineExists) return 'wallet: trustline-missing';
  if (!input.xlmReserveMet) return 'wallet: reserve-low';
  return 'wallet: funded';
}

/**
 * Options for `applyWalletLabels`.
 */
export interface ApplyWalletLabelsOptions {
  /**
   * Remove all other wallet labels before applying the new one.
   * Default: `true`. Set to `false` to only add (never remove) labels.
   */
  removeStale?: boolean;
}

/**
 * Paginate through all labels on an issue, collecting every page until
 * the API returns fewer than `perPage` results (last page).
 *
 * Uses a fixed page size of 100 (GitHub's maximum) to minimise round-trips.
 * Stops automatically when a page returns fewer items than requested so
 * issues with >100 labels are handled correctly without an extra request.
 */
async function listAllLabelsOnIssue(
  octokit: {
    rest: {
      issues: {
        listLabelsOnIssue: (params: {
          owner: string;
          repo: string;
          issue_number: number;
          per_page: number;
          page: number;
        }) => Promise<{ data: Array<{ name: string }> }>;
      };
    };
  },
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<string[]> {
  const PER_PAGE = 100;
  const names: string[] = [];
  let page = 1;

  for (;;) {
    const response = await octokit.rest.issues.listLabelsOnIssue({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: PER_PAGE,
      page,
    });
    for (const label of response.data) {
      names.push(label.name);
    }
    if (response.data.length < PER_PAGE) {
      break;
    }
    page += 1;
  }

  return names;
}

/**
 * Apply the appropriate wallet label to a GitHub issue via Octokit,
 * optionally removing stale wallet labels first.
 *
 * Conflict resolution: when multiple wallet state labels are present
 * (e.g. from a previous interrupted run), all stale labels are removed
 * before the new one is applied. The target label is derived
 * deterministically by `deriveWalletLabel` using a fixed priority order
 * (horizon-error > unfunded > trustline-missing > reserve-low > funded),
 * so concurrent runs always converge to the same label.
 *
 * Pagination: `listLabelsOnIssue` is paginated in 100-item pages so
 * issues with more than 100 labels are handled correctly.
 *
 * Errors are non-fatal: label failures are caught and returned as a
 * descriptive string so the main check result is never blocked by a
 * labelling permission issue.
 *
 * @param octokit       Authenticated Octokit instance.
 * @param owner         Repository owner.
 * @param repo          Repository name.
 * @param issueNumber   Issue to label.
 * @param input         Wallet state derived from the Horizon check.
 * @param options       Labelling behaviour options.
 * @returns             The label that was applied, or an error string.
 */
export async function applyWalletLabels(
  octokit: {
    rest: {
      issues: {
        addLabels: (params: { owner: string; repo: string; issue_number: number; labels: string[] }) => Promise<unknown>;
        removeLabel: (params: { owner: string; repo: string; issue_number: number; name: string }) => Promise<unknown>;
        listLabelsOnIssue: (params: { owner: string; repo: string; issue_number: number; per_page: number; page: number }) => Promise<{ data: Array<{ name: string }> }>;
      };
    };
  },
  owner: string,
  repo: string,
  issueNumber: number,
  input: WalletLabelInput,
  options: ApplyWalletLabelsOptions = {},
): Promise<{ applied: WalletLabel; removed: string[]; error?: string }> {
  const removeStale = options.removeStale ?? true;
  const targetLabel = deriveWalletLabel(input);
  const removed: string[] = [];

  try {
    // List every current label (paginated) so labels on pages after the
    // first 100 are never missed on heavily-labelled issues (Issue #694).
    const currentNameList = await listAllLabelsOnIssue(octokit, owner, repo, issueNumber);
    const currentNames = new Set(currentNameList);

    if (removeStale) {

      const stale = ALL_WALLET_LABELS.filter(
        (l) => l !== targetLabel && currentNames.has(l),
      );

      // Deterministic conflict resolution: log when multiple stale wallet
      // labels are present so operators can diagnose interrupted prior runs.
      if (stale.length > 1) {
        logger.debug('auto_wallet_labels: multiple stale wallet labels found — removing all before applying target', {
          component: 'horizon',
          staleLabels: stale,
          targetLabel,
        });
      }

      for (const label of stale) {
        try {
          await octokit.rest.issues.removeLabel({
            owner,
            repo,
            issue_number: issueNumber,
            name: label,
          });
          removed.push(label);
        } catch (removeErr) {
          // Non-fatal: log the specific label that failed to remove so
          // operators can diagnose permission issues without the run failing.
          const msg = removeErr instanceof Error ? removeErr.message : String(removeErr);
          logger.debug('auto_wallet_labels: failed to remove stale label (non-fatal)', {
            component: 'horizon',
            label,
            error: msg,
          });
        }
      }
    }

    // Skip re-adding an already-applied label so the operation stays
    // idempotent and never issues a duplicate label attempt for a label that
    // already exists on the issue (Issue #694).
    if (!currentNames.has(targetLabel)) {
      await octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: issueNumber,
        labels: [targetLabel],
      });
    }

    return { applied: targetLabel, removed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { applied: targetLabel, removed, error: message };
  }
}


export interface ReadyLabelInput {
  ready: boolean;
  passLabel?: string;
  failLabel?: string;
}

export async function applyReadyLabels(
  octokit: {
    rest: {
      issues: {
        addLabels: (params: {
          owner: string;
          repo: string;
          issue_number: number;
          labels: string[];
        }) => Promise<unknown>;
        removeLabel: (params: {
          owner: string;
          repo: string;
          issue_number: number;
          name: string;
        }) => Promise<unknown>;
        listLabelsOnIssue: (params: {
          owner: string;
          repo: string;
          issue_number: number;
          per_page: number;
        }) => Promise<{ data: Array<{ name: string }> }>;
      };
    };
  },
  owner: string,
  repo: string,
  issueNumber: number,
  input: ReadyLabelInput,
): Promise<{ applied?: string; removed: string[]; error?: string }> {
  const passLabel = (input.passLabel ?? "").trim();
  const failLabel = (input.failLabel ?? "").trim();
  const targetLabel = input.ready ? passLabel : failLabel;
  const staleLabel = input.ready ? failLabel : passLabel;
  const removed: string[] = [];

  if (!targetLabel && !staleLabel) {
    return { removed: [] };
  }

  try {
    // Paginated: stale labels on later pages must still be found (Issue #694).
    const currentNameList = await listAllLabelsOnIssue(octokit, owner, repo, issueNumber);
    const currentNames = new Set(currentNameList);

    if (
      staleLabel &&
      staleLabel !== targetLabel &&
      currentNames.has(staleLabel)
    ) {
      try {
        await octokit.rest.issues.removeLabel({
          owner,
          repo,
          issue_number: issueNumber,
          name: staleLabel,
        });
        removed.push(staleLabel);
      } catch {
        // Ignore individual removal errors — label state is best-effort.
      }
    }

    if (!targetLabel) {
      return { applied: undefined, removed };
    }

    if (!currentNames.has(targetLabel)) {
      await octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: issueNumber,
        labels: [targetLabel],
      });
    }

    return { applied: targetLabel, removed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { applied: targetLabel || undefined, removed, error: message };
  }
}

/**
 * Fetch the Stellar network passphrase from a Horizon root endpoint.
 */
export async function fetchNetworkPassphrase(
  horizonUrl: string,
  options: FetchAccountOptions = {},
): Promise<string> {
  const fetchImpl = options.fetchFn ?? (await import('node-fetch')).default;
  const timeoutMs = options.timeoutMs || 15000;
  const maxRetries = options.maxRetries ?? 3;

  let attempt = 0;
  const normalizedUrl = horizonUrl.replace(/\/$/, '');

  while (attempt <= maxRetries) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(normalizedUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal as unknown as import('node-fetch').RequestInit['signal'],
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = (await response.json()) as { network_passphrase?: string };
        if (data.network_passphrase) {
          return data.network_passphrase;
        }
        throw new Error('network_passphrase not found in Horizon root response');
      }

      if (response.status !== 429 && response.status < 500) {
        throw new Error(`Horizon returned ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      clearTimeout(timeoutId);
      if (attempt >= maxRetries) {
        throw error;
      }
    }

    attempt += 1;
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
  }

  throw new Error(`Unable to fetch network passphrase from ${normalizedUrl}`);
}

// ---------------------------------------------------------------------------
// Friendbot integration for testnet (Issue #4)
// ---------------------------------------------------------------------------

export interface FriendbotOptions {
  /** Friendbot URL. Must be HTTPS and on the allowlist. */
  friendbotUrl: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Override fetch function (for testing). */
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
}

const DEFAULT_FRIENDBOT_TIMEOUT_MS = 15_000;

const ALLOWED_FRIENDBOT_HOSTS = new Set([
  'friendbot.stellar.org',
  'friendbot-testnet.stellar.org',
  'horizon-testnet.stellar.org',
  'friendbot-futurenet.stellar.org',
  'horizon-futurenet.stellar.org',
]);

/**
 * Check if a friendbot URL is on the allowlist and safe to use.
 * Prevents SSRF attacks by only allowing known testnet friendbot endpoints.
 */
export function isFriendbotAllowed(friendbotUrl: string): boolean {
  if (!friendbotUrl || !friendbotUrl.trim()) {
    return false;
  }
  const raw = friendbotUrl.trim();
  if (raw.includes('..')) {
    return false;
  }
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
    const url = new URL(hasScheme ? raw : `https://${raw}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return false;
    }
    // Disallow non-HTTPS when explicit scheme provided, except allow normalization
    if (hasScheme && url.protocol !== 'https:') {
      return false;
    }
    const hostname = url.hostname.toLowerCase();
    if (!ALLOWED_FRIENDBOT_HOSTS.has(hostname)) {
      return false;
    }
    const pathname = url.pathname.replace(/\/+$/, '');
    if (pathname !== '' && pathname !== '/friendbot') {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect whether a Horizon URL points to testnet or mainnet.
 * Used to enforce friendbot safety rules (never call friendbot on mainnet).
 */
export function isTestnetHorizon(horizonUrl: string): boolean {
  const normalized = horizonUrl.toLowerCase().trim();
  if (normalized.includes('public.stellar.org') || normalized.includes('mainnet')) {
    return false;
  }
  try {
    const url = new URL(normalized.startsWith('http') ? normalized : `https://${normalized}`);
    if (url.hostname === 'horizon.stellar.org') {
      return false;
    }
  } catch {
    // URL parsing failed — not a testnet host pattern, treat as non-testnet.
  }
  return normalized.includes('testnet') || normalized.includes('test') || normalized.includes('futurenet');
}

export interface FriendbotResult {
  success: boolean;
  message: string;
  transactionHash?: string;
}

/**
 * Call Stellar Friendbot to fund a testnet account.
 *
 * Safety rules:
 * - Only works with allowlisted friendbot URLs (SSRF protection)
 * - Only callable when Horizon URL indicates testnet
 * - Fails fast with clear error on mainnet or unknown networks
 *
 * @param stellarAddress The G-address to fund
 * @param options Friendbot configuration
 * @param horizonUrl The Horizon URL (used for network safety check)
 * @returns FriendbotResult with success status and transaction details
 */
export async function callFriendbot(
  stellarAddress: string,
  options: FriendbotOptions,
  horizonUrl: string,
): Promise<FriendbotResult> {
  const { friendbotUrl, timeoutMs = DEFAULT_FRIENDBOT_TIMEOUT_MS, fetchFn } = options;

  // Safety check 1: Only allow testnet
  if (!isTestnetHorizon(horizonUrl)) {
    return {
      success: false,
      message: 'Friendbot is only available for testnet. Cannot fund accounts on public/mainnet.',
    };
  }

  // Safety check 2: SSRF allowlist
  if (!isFriendbotAllowed(friendbotUrl)) {
    return {
      success: false,
      message: `Friendbot URL "${friendbotUrl}" is not on the allowlist. Only official Stellar friendbot endpoints are supported.`,
    };
  }

  // Normalize URL: ensure the /friendbot path is present. Match on the URL
  // path specifically — a substring check misfires for allowlisted hosts
  // whose names contain 'friendbot' (e.g. friendbot-futurenet.stellar.org).
  let fullUrl = friendbotUrl.trim();
  if (!fullUrl.startsWith('http')) {
    fullUrl = `https://${fullUrl}`;
  }
  const parsedFriendbot = new URL(fullUrl);
  if (parsedFriendbot.pathname === '/' || parsedFriendbot.pathname === '') {
    parsedFriendbot.pathname = '/friendbot';
  }

  // Add address parameter
  const urlWithParam = `${parsedFriendbot.origin}${parsedFriendbot.pathname}?addr=${encodeURIComponent(stellarAddress)}`;

  const fetch = fetchFn ?? ((globalThis as unknown as { fetch?: typeof globalThis.fetch }).fetch
    ?? (await import('node-fetch')).default as unknown as typeof globalThis.fetch);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(urlWithParam, {
      method: 'GET',
      signal: controller.signal as AbortSignal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      return {
        success: false,
        message: `Friendbot returned HTTP ${response.status}: ${errorText}`,
      };
    }

    const data = await response.json() as { hash?: string; id?: string };
    const txHash = data.hash || data.id;

    return {
      success: true,
      message: 'Account funded successfully via Friendbot',
      transactionHash: txHash,
    };
  } catch (error) {
    clearTimeout(timer);

    if (
      (error instanceof Error && (error.name === 'AbortError' || error.message.includes('AbortError') || error.name === 'TimeoutError')) ||
      (error as { name?: string })?.name === 'AbortError'
    ) {
      return {
        success: false,
        message: `Friendbot request timed out after ${timeoutMs}ms`,
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Friendbot request failed: ${message}`,
    };
  }
}
/**
 * Lightweight opt-in OpenTelemetry-compatible tracing for TrustBridge Action.
 * (Issue #299)
 *
 * ## Design goals
 * - Default OFF: zero overhead when tracing is not enabled.
 * - No required SaaS or external collector.
 * - Zero new production dependencies: uses only Node.js built-ins.
 * - PII safe: Stellar addresses are redacted to first-4…last-4 before any
 *   span attribute is recorded or exported.
 * - Compatible with the OTel data model (Span, SpanStatus, Attributes) so
 *   a future upgrade to @opentelemetry/sdk-trace-node is a drop-in swap.
 *
 * ## Enabling tracing
 *
 * Set the environment variable before running the action:
 *
 *   OTEL_TRACES_ENABLED=true   # opt in to trace collection
 *   OTEL_TRACES_EXPORTER=log   # (default) emit spans as core.debug JSON lines
 *   OTEL_TRACES_EXPORTER=console  # emit to process.stdout (local dev)
 *   OTEL_TRACES_EXPORTER=none  # collect but do not export (for tests)
 *
 * All options are case-insensitive for the value.
 *
 * ## Instrumented phases
 *
 * | Phase | Span name |
 * |-------|-----------|
 * | Horizon account fetch | `horizon.fetch_account` |
 * | GitHub issue comment post/update | `github.post_comment` |
 * | Dashboard webhook delivery | `webhook.deliver` |
 * | Full action run | `trustbridge.run` |
 *
 * ## PII redaction
 *
 * - `stellar_address` attributes are masked to `first4…last4`.
 * - `horizon_url` attributes have the path stripped (host only).
 * - `webhook_url` attributes have the path stripped.
 * - `github_token` and `webhook_secret` are NEVER placed in any attribute.
 *
 * ## Exporting to a real collector
 *
 * When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, TrustBridge will attempt to
 * export spans via HTTP/JSON OTLP to that endpoint. The payload follows the
 * OTLP/HTTP JSON format so any standard OpenTelemetry collector can receive
 * it. Requires `OTEL_TRACES_EXPORTER=otlp` as well.
 *
 * Example for a local collector:
 * ```yaml
 * env:
 *   OTEL_TRACES_ENABLED: 'true'
 *   OTEL_TRACES_EXPORTER: 'otlp'
 *   OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318'
 * ```
 *
 * See docs/USAGE.md#opentelemetry-tracing for the full guide.
 */

import * as core from '@actions/core';

// ---------------------------------------------------------------------------
// Types — mirror the OTel data model
// ---------------------------------------------------------------------------

/** OTel-compatible span status code. */
export type TraceSpanStatus = 'UNSET' | 'OK' | 'ERROR';

/**
 * A single span record. Mirrors the OpenTelemetry Span data model fields
 * that are relevant to action instrumentation.
 */
export interface TraceSpan {
  /** Span name (e.g. "horizon.fetch_account"). */
  name: string;
  /** Unix timestamp in milliseconds when the span started. */
  startTimeMs: number;
  /** Wall-clock duration of the operation in milliseconds. */
  durationMs: number;
  /** OTel-compatible status. */
  status: TraceSpanStatus;
  /** Structured, PII-safe attributes. */
  attributes: Record<string, string | number | boolean>;
  /** Error message when status is "ERROR", undefined otherwise. */
  error?: string;
  /** Optional parent span name for nesting context. */
  parentName?: string;
}

/** Options for starting a traced operation. */
export interface TraceOptions {
  /** Span name. */
  name: string;
  /** Attributes to attach at span start (must be PII-safe). */
  attributes?: Record<string, string | number | boolean>;
  /** Parent span name for nesting context. */
  parentName?: string;
}

/**
 * Options for tracing a Horizon fetch operation (issue #757).
 * Emits OTel-compatible span attributes for latency and retry counts.
 */
export interface HorizonSpanOptions {
  /** Horizon endpoint URL (path is stripped before recording). */
  horizonUrl: string;
  /** Stellar account being fetched (redacted before recording). */
  accountId?: string;
  /** Number of retry attempts made before the fetch resolved. */
  retryCount?: number;
  /** Parent span name for nesting context. */
  parentName?: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Whether tracing is enabled.
 * Reads `OTEL_TRACES_ENABLED` environment variable.
 * Default: false.
 */
export function isTracingEnabled(): boolean {
  const val = process.env['OTEL_TRACES_ENABLED'] ?? '';
  return val.toLowerCase() === 'true' || val === '1';
}

/**
 * The configured exporter type.
 * Reads `OTEL_TRACES_EXPORTER` environment variable.
 * Default: 'log' (core.debug).
 */
export type TraceExporterType = 'log' | 'console' | 'none' | 'otlp';

export function getExporterType(): TraceExporterType {
  const val = (process.env['OTEL_TRACES_EXPORTER'] ?? 'log').toLowerCase();
  if (val === 'console') return 'console';
  if (val === 'none') return 'none';
  if (val === 'otlp') return 'otlp';
  return 'log';
}

// ---------------------------------------------------------------------------
// In-process span store
// ---------------------------------------------------------------------------

const _traceSpans: TraceSpan[] = [];

/**
 * Return all recorded trace spans (for testing).
 * Returns a shallow copy so callers cannot mutate the internal store.
 */
export function getTraceSpans(): TraceSpan[] {
  return [..._traceSpans];
}

/**
 * Clear all recorded trace spans.
 * Call at the start of each test or action run.
 */
export function clearTraceSpans(): void {
  _traceSpans.length = 0;
}

/** Internal: record a completed span into the store. */
function storeSpan(span: TraceSpan): void {
  try {
    _traceSpans.push(span);
  } catch {
    // Observability must never break the action.
  }
}

// ---------------------------------------------------------------------------
// PII redaction for span attributes
// ---------------------------------------------------------------------------

/**
 * Redact a span attributes record so no PII escapes into exported spans.
 * - Stellar addresses (G…/C…, 56 chars) → first4…last4.
 * - Horizon / webhook URLs → host only (path stripped).
 * - Token / secret fields → [REDACTED].
 */
export function redactSpanAttributes(
  attrs: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {};
  const SECRET_KEYS = new Set(['token', 'secret', 'password', 'api_key', 'private_key', 'github_token', 'webhook_secret', 'webhook_secret_previous']);

  for (const [key, value] of Object.entries(attrs)) {
    if (SECRET_KEYS.has(key.toLowerCase())) {
      safe[key] = '[REDACTED]';
      continue;
    }
    if (typeof value === 'string') {
      // Redact embedded Stellar addresses
      let v = value.replace(/\b[GC][A-Z2-7]{55}\b/g, (addr) => redactStellarAddress(addr));
      // Redact Horizon/webhook URL paths (keep scheme + host only)
      if (key.toLowerCase().includes('url')) {
        v = redactHorizonUrl(v);
      }
      safe[key] = v;
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

// ---------------------------------------------------------------------------
// Horizon error recording without payload bodies (Issue #913)
// ---------------------------------------------------------------------------

/** Span name for a single non-2xx Horizon response. */
export const HORIZON_HTTP_ERROR_SPAN_NAME = 'horizon.http_error';

/**
 * The complete, fixed set of attribute keys a `horizon.http_error` span may
 * carry. Response bodies (`detail`, `title`, `type`, `extras`, …) are never
 * among them: Horizon problem documents can echo account data back, so only
 * the status code and request metadata are recorded. Documented in
 * docs/ARCHITECTURE.md#horizon-error-spans.
 */
export const HORIZON_HTTP_ERROR_SPAN_ATTRIBUTES = [
  'horizon.url',
  'http.response.status_code',
  'horizon.status_class',
  'horizon.retryable',
  'horizon.endpoint_kind',
  'horizon.attempt',
  'horizon.latency_ms',
  'error.type',
] as const;

/** Duck-typed HorizonError (horizon.ts and this module each declare one). */
interface HorizonLikeError {
  name: string;
  message: string;
  statusCode: number;
  retryable?: boolean;
}

function isHorizonLikeError(err: unknown): err is HorizonLikeError {
  return (
    err instanceof Error &&
    typeof (err as Partial<HorizonLikeError>).statusCode === 'number'
  );
}

/** Bucket an HTTP status for low-cardinality span attributes. */
export function horizonStatusClass(statusCode: number): '4xx' | '5xx' | 'transport' | 'other' {
  // 0 and 408 are how horizon.ts encodes transport failures and timeouts.
  if (statusCode === 0 || statusCode === 408) return 'transport';
  if (statusCode >= 400 && statusCode < 500) return '4xx';
  if (statusCode >= 500 && statusCode < 600) return '5xx';
  return 'other';
}

/**
 * Body-free span error message (Issue #913).
 *
 * `HorizonError` messages for non-2xx responses embed the Horizon problem
 * `detail`/`title` (`Horizon request failed (400): <detail>`), and the 404
 * message embeds the account id. For any Horizon-like error with an HTTP
 * status >= 400 the span message is therefore rebuilt from the status code
 * alone. Every other error message is passed through `redactString` so
 * addresses, JWTs and secret assignments are masked.
 */
export function safeSpanErrorMessage(err: unknown): string {
  if (isHorizonLikeError(err) && err.statusCode >= 400) {
    return `Horizon request failed (${err.statusCode})`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return redactString(message);
}

/**
 * Error attributes for a Horizon span: status, class, retryability and
 * error type only — never the message or response body.
 */
export function horizonErrorSpanAttributes(
  err: unknown,
): Record<string, string | number | boolean> {
  if (!isHorizonLikeError(err)) {
    return { 'error.type': err instanceof Error ? err.name : 'Error' };
  }
  return {
    'error.type': err.name,
    'http.response.status_code': err.statusCode,
    'horizon.status_class': horizonStatusClass(err.statusCode),
    'horizon.retryable': err.retryable === true,
  };
}

/** Options for {@link recordHorizonHttpError}. */
export interface HorizonHttpErrorSpanOptions {
  /** Horizon base URL (path stripped before recording). */
  horizonUrl: string;
  /** HTTP status of the non-2xx response. */
  statusCode: number;
  /** Whether the status is retryable (429 / 5xx). */
  retryable: boolean;
  /** `primary` (horizon_url) or `fallback`. */
  endpointKind: 'primary' | 'fallback';
  /** Zero-based attempt index. */
  attempt: number;
  /** Latency of this attempt in milliseconds. */
  latencyMs: number;
  /** Parent span name for nesting context. */
  parentName?: string;
}

/**
 * Record one ERROR span for a non-2xx Horizon response (Issue #913).
 *
 * Called once per failed attempt from `fetchOnce` in src/horizon.ts, before
 * the response body is read, so retried 429/5xx attempts are visible as
 * individual spans for Wave latency incidents. The signature deliberately
 * has no body/detail parameter: only the attributes in
 * {@link HORIZON_HTTP_ERROR_SPAN_ATTRIBUTES} are recorded.
 *
 * No-op when tracing is disabled. Never throws.
 */
export function recordHorizonHttpError(opts: HorizonHttpErrorSpanOptions): void {
  if (!isTracingEnabled()) return;
  try {
    const latencyMs = Number.isFinite(opts.latencyMs) ? Math.max(0, Math.round(opts.latencyMs)) : 0;
    const attributes: Record<string, string | number | boolean> = {
      'horizon.url': opts.horizonUrl,
      'http.response.status_code': opts.statusCode,
      'horizon.status_class': horizonStatusClass(opts.statusCode),
      'horizon.retryable': opts.retryable,
      'horizon.endpoint_kind': opts.endpointKind,
      'horizon.attempt': opts.attempt,
      'horizon.latency_ms': latencyMs,
      'error.type': 'HorizonError',
    };
    const span: TraceSpan = {
      name: HORIZON_HTTP_ERROR_SPAN_NAME,
      startTimeMs: Date.now() - latencyMs,
      durationMs: latencyMs,
      status: 'ERROR',
      attributes: redactSpanAttributes(attributes),
      error: `Horizon request failed (${opts.statusCode})`,
      parentName: opts.parentName,
    };
    storeSpan(span);
    exportSpan(span);
  } catch {
    // Observability must never break the action.
  }
}

// ---------------------------------------------------------------------------
// Span recording
// ---------------------------------------------------------------------------

/**
 * Execute an async operation within a named trace span.
 *
 * When tracing is disabled, `fn` is called directly with zero overhead.
 * When enabled, the span is recorded and exported after `fn` completes.
 *
 * @param opts  Span options (name, attributes, parentName).
 * @param fn    The async operation to trace.
 * @returns     The resolved value from `fn`.
 */
export async function withSpan<T>(
  opts: TraceOptions,
  fn: () => Promise<T>,
): Promise<T> {
  if (!isTracingEnabled()) {
    return fn();
  }

  const startTimeMs = Date.now();
  let status: TraceSpanStatus = 'OK';
  let error: string | undefined;

  try {
    const result = await fn();
    return result;
  } catch (err) {
    status = 'ERROR';
    error = safeSpanErrorMessage(err);
    throw err;
  } finally {
    const durationMs = Date.now() - startTimeMs;
    const safeAttrs = redactSpanAttributes(opts.attributes ?? {});

    const span: TraceSpan = {
      name: opts.name,
      startTimeMs,
      durationMs,
      status,
      attributes: safeAttrs,
      error,
      parentName: opts.parentName,
    };

    storeSpan(span);
    exportSpan(span);
  }
}

/**
 * Execute a Horizon fetch operation within an OTel-compatible span
 * (issue #757). Emits consistent span attributes for latency and retry
 * counts so operators can correlate Wave CI flakes without scraping logs.
 *
 * Attributes recorded on the span:
 * - `horizon.url`        — host-only Horizon endpoint (path stripped).
 * - `stellar_address`    — redacted account id (first4…last4), when provided.
 * - `horizon.retry_count`— number of retries performed (default 0).
 * - `horizon.latency_ms` — wall-clock latency of the fetch in milliseconds.
 *
 * When tracing is disabled, `fn` is called directly with zero overhead and
 * existing auth/pause/happy-path semantics are preserved.
 *
 * @param opts  Horizon span options (url, account, retryCount, parentName).
 * @param fn    The async Horizon fetch operation to trace.
 * @returns     The resolved value from `fn`.
 */
export async function withHorizonSpan<T>(
  opts: HorizonSpanOptions,
  fn: () => Promise<T>,
): Promise<T> {
  if (!isTracingEnabled()) {
    return fn();
  }

  const startTimeMs = Date.now();
  const retryCount = opts.retryCount ?? 0;
  let status: TraceSpanStatus = 'OK';
  let error: string | undefined;
  let errorAttributes: Record<string, string | number | boolean> = {};

  try {
    const result = await fn();
    return result;
  } catch (err) {
    status = 'ERROR';
    // Issue #913: status/type attributes only — never the response body.
    error = safeSpanErrorMessage(err);
    errorAttributes = horizonErrorSpanAttributes(err);
    throw err;
  } finally {
    const durationMs = Date.now() - startTimeMs;

    const attributes: Record<string, string | number | boolean> = {
      'horizon.url': opts.horizonUrl,
      'horizon.retry_count': retryCount,
      'horizon.latency_ms': durationMs,
      ...errorAttributes,
    };
    if (opts.accountId) {
      attributes['stellar_address'] = opts.accountId;
    }

    const span: TraceSpan = {
      name: 'horizon.fetch_account',
      startTimeMs,
      durationMs,
      status,
      attributes: redactSpanAttributes(attributes),
      error,
      parentName: opts.parentName,
    };

    storeSpan(span);
    exportSpan(span);
  }
}

/**
 * Record a synchronous operation within a named trace span.
 *
 * @param opts  Span options.
 * @param fn    Synchronous operation to trace.
 * @returns     The value returned by `fn`.
 */
export function withSpanSync<T>(
  opts: TraceOptions,
  fn: () => T,
): T {
  if (!isTracingEnabled()) {
    return fn();
  }

  const startTimeMs = Date.now();
  let status: TraceSpanStatus = 'OK';
  let error: string | undefined;

  try {
    const result = fn();
    return result;
  } catch (err) {
    status = 'ERROR';
    error = safeSpanErrorMessage(err);
    throw err;
  } finally {
    const durationMs = Date.now() - startTimeMs;
    const safeAttrs = redactSpanAttributes(opts.attributes ?? {});

    const span: TraceSpan = {
      name: opts.name,
      startTimeMs,
      durationMs,
      status,
      attributes: safeAttrs,
      error,
      parentName: opts.parentName,
    };

    storeSpan(span);
    exportSpan(span);
  }
}

// ---------------------------------------------------------------------------
// Span export
// ---------------------------------------------------------------------------

/**
 * Export a completed span to the configured exporter.
 * Never throws — observability must not break the action.
 */
export function exportSpan(span: TraceSpan): void {
  try {
    const exporter = getExporterType();
    switch (exporter) {
      case 'log':
        core.debug(`[TrustBridge][trace] ${JSON.stringify(span)}`);
        break;
      case 'console':
        console.log(`[TrustBridge][trace] ${JSON.stringify(span)}`);
        break;
      case 'none':
        // Collect but do not emit (used in tests to inspect spans without log noise).
        break;
      case 'otlp':
        // OTLP export is fire-and-forget — errors are swallowed so they never
        // affect the action result. The collector must be running at
        // OTEL_EXPORTER_OTLP_ENDPOINT for this to have any effect.
        void exportOtlp(span).catch(() => {
          // Silently ignore export failures.
        });
        break;
    }
  } catch {
    // Swallow all export errors.
  }
}

/**
 * Fire-and-forget OTLP/HTTP JSON export for a single span.
 * Only called when OTEL_TRACES_EXPORTER=otlp and OTEL_EXPORTER_OTLP_ENDPOINT is set.
 */
async function exportOtlp(span: TraceSpan): Promise<void> {
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  if (!endpoint) return;

  // Minimal OTLP/JSON payload for a single span
  const otlpPayload = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'trustbridge-action' } }] },
        scopeSpans: [
          {
            scope: { name: 'trustbridge-action', version: '1' },
            spans: [
              {
                name: span.name,
                kind: 1, // SPAN_KIND_INTERNAL
                startTimeUnixNano: String(span.startTimeMs * 1_000_000),
                endTimeUnixNano: String((span.startTimeMs + span.durationMs) * 1_000_000),
                status: {
                  code: span.status === 'OK' ? 1 : span.status === 'ERROR' ? 2 : 0,
                  message: span.error ?? '',
                },
                attributes: Object.entries(span.attributes).map(([k, v]) => ({
                  key: k,
                  value: typeof v === 'boolean'
                    ? { boolValue: v }
                    : typeof v === 'number'
                      ? { intValue: String(v) }
                      : { stringValue: String(v) },
                })),
              },
            ],
          },
        ],
      },
    ],
  };

  const url = endpoint.replace(/\/$/, '') + '/v1/traces';
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(otlpPayload),
    signal: AbortSignal.timeout(3000),
  });
}

// ---------------------------------------------------------------------------
// Named span helpers for the three instrumented phases
// ---------------------------------------------------------------------------

/**
 * Trace the Horizon account fetch phase.
 * Attributes: endpoint kind (primary/fallback), redacted URL, redacted address.
 */
export async function traceHorizonFetch<T>(
  horizonUrl: string,
  stellarAddress: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withSpan(
    {
      name: 'horizon.fetch_account',
      attributes: {
        'horizon_url': horizonUrl,
        'stellar_address': stellarAddress,
      },
    },
    fn,
  );
}

/**
 * Trace the GitHub issue comment post/update phase.
 * Attributes: comment action (create/update), issue number.
 */
export async function traceCommentPost<T>(
  issueNumber: number | null,
  action: 'create' | 'update' | 'skip',
  fn: () => Promise<T>,
): Promise<T> {
  return withSpan(
    {
      name: 'github.post_comment',
      attributes: {
        'issue_number': issueNumber ?? 0,
        'comment_action': action,
      },
    },
    fn,
  );
}

/**
 * Trace the dashboard webhook delivery phase.
 * Attributes: redacted webhook URL, auth mode.
 */
export async function traceWebhookDeliver<T>(
  webhookUrl: string,
  authMode: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withSpan(
    {
      name: 'webhook.deliver',
      attributes: {
        'webhook_url': webhookUrl,
        'auth_mode': authMode,
      },
    },
    fn,
  );
}

/**
 * Trace the full action run (root span).
 * Attributes: redacted address, reason code, valid flag.
 */
export async function traceActionRun<T>(
  stellarAddress: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withSpan(
    {
      name: 'trustbridge.run',
      attributes: {
        'stellar_address': stellarAddress,
      },
    },
    fn,
  );
}

// ---------------------------------------------------------------------------
// Summary export
// ---------------------------------------------------------------------------

/**
 * Emit a human-readable summary of all collected spans to `core.info`.
 * Called at the end of a run when tracing is enabled.
 * Never throws.
 */
export function emitTraceSummary(): void {
  if (!isTracingEnabled()) return;
  try {
    const spans = getTraceSpans();
    if (spans.length === 0) return;
    const totalMs = spans.reduce((sum, s) => sum + s.durationMs, 0);
    const errorCount = spans.filter((s) => s.status === 'ERROR').length;
    core.info(
      `[TrustBridge][trace] Run complete — ${spans.length} span(s), ` +
      `${totalMs}ms total, ${errorCount} error(s). ` +
      `Set OTEL_TRACES_EXPORTER=otlp + OTEL_EXPORTER_OTLP_ENDPOINT to forward to a collector.`,
    );
  } catch {
    // Never throw from observability.
  }
}
