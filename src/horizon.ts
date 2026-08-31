import * as tls from 'tls';
import * as crypto from 'crypto';
import { defaultCache, SimpleCache } from './cache';
import { logger, redactHorizonUrl, redactStellarAddress, redactString, LogContext } from './logger';
import { inferStellarNetwork } from './links';
import { globalMetrics } from './metrics';
import { RateBudgetTracker, CircuitBreaker, CircuitOpenError } from './resilience';
import { validateHorizonUrl } from './validation';
import { traceHorizonFetch } from './tracing';

export interface HorizonBalanceNative {
  balance: string;
  asset_type: "native";
  buying_liabilities: string;
  selling_liabilities: string;
}

export interface HorizonBalanceCredit {
  balance: string;
  asset_type: "credit_alphanum4" | "credit_alphanum12";
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
  asset_type: "liquidity_pool_shares";
  liquidity_pool_id: string;
  buying_liabilities: string;
  selling_liabilities: string;
  limit: string;
  is_authorized: boolean;
  is_authorized_to_maintain_liabilities: boolean;
}

export interface HorizonBalanceClaimable {
  asset_type: "claimable_balance_id";
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
    this.name = "HorizonError";
  }
}

export class HorizonRateLimitError extends HorizonError {
  constructor(
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message, 429, true);
    this.name = "HorizonRateLimitError";
  }
}

export class HorizonTlsError extends HorizonError {
  constructor(
    message: string,
    public readonly originalCode?: string,
  ) {
    super(message, 0, false);
    this.name = "HorizonTlsError";
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
 * Node/OpenSSL error codes that indicate a TLS handshake or certificate
 * verification failure, as opposed to a generic connection/network error.
 */
const TLS_ERROR_CODES = new Set<string>([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_UNTRUSTED",
  "CERT_CHAIN_TOO_LONG",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_CRL",
  "HOSTNAME_MISMATCH",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
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

export type FetchLike = (
  url: string | import("node-fetch").Request,
  init?: import("node-fetch").RequestInit,
) => Promise<import("node-fetch").Response>;

export interface FetchAccountOptions {
  timeoutMs?: number;
  maxRetries?: number;
  horizonUrlFallback?: string;
  fallbackUrls?: string[];
  useCache?: boolean;
  cacheTtlMs?: number;
  cache?: SimpleCache;
  fetchFn?: FetchLike;
  /**
   * Optional AbortSignal from a parent controller (e.g. job cancellation).
   * When the signal fires, in-flight and pending requests are aborted
   * immediately; no misleading "account not funded" result is produced.
   */
  signal?: AbortSignal;
  horizonMaxRequests?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  retryMaxTotalWaitMs?: number;
  rateBudgetTracker?: RateBudgetTracker;
  /**
   * Optional circuit breaker for Horizon fetches (Issue #209).
   * When the circuit is open, requests are fast-failed without reaching
   * the network. Cache hits bypass the circuit breaker.
   */
  circuitBreaker?: CircuitBreaker;
  /**
   * By default, a fallback URL that resolves to a *different* Stellar
   * network than the primary `horizon_url` (public vs testnet, inferred
   * from the URL) is never used — a G-address is valid on every network,
   * so a cross-network fallback can silently return funded/trustline/
   * reserve data for the wrong ledger instead of failing loudly. Set this
   * to `true` to opt into cross-network fallback anyway (e.g. deliberate
   * multi-network setups).
   */
  allowCrossNetworkFallback?: boolean;
  /**
   * Alias for `allowCrossNetworkFallback` kept for older call sites / tests.
   * Prefer `allowCrossNetworkFallback`.
   */
  allowCrossNetworkFailover?: boolean;
  /** Optional secondary Horizon URL used for same-network failover. */
  secondaryHorizonUrl?: string;
  /**
   * Optional SHA-256 certificate fingerprint to pin the Horizon TLS cert.
   * When set, a pre-flight TLS probe is performed before the first fetch.
   * Mismatch throws HorizonPinMismatchError immediately (not retried).
   * Leave empty (default) to use standard WebPKI certificate validation only.
   * (Issue #303)
   */
  pinFingerprint?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
const DEFAULT_RETRY_MAX_TOTAL_WAIT_MS = 120_000;

export function normalizeHorizonUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return "";
  }
  // Horizon endpoints may use http on private/testnet mirrors; still enforce
  // credential + traversal guards via validateHorizonUrl.
  const validation = validateHorizonUrl(trimmed, "horizon_url", {
    allowHttp: true,
  });
  if (!validation.valid) {
    throw new HorizonError(
      `Invalid horizon_url: ${validation.errors.join("; ")}`,
      400,
      false,
    );
  }
  // Re-check raw traversal after allowing http, since URL() would otherwise normalize it.
  if (
    /(?:^|\/)(?:\.\.|%2e%2e)(?:\/|$)/i.test(trimmed) ||
    /\/\.\//.test(trimmed)
  ) {
    throw new HorizonError(
      "Invalid horizon_url: path traversal segments are not allowed",
      400,
      false,
    );
  }
  const parsed = new URL(trimmed);
  const cleanPath =
    parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
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
    return "••• (set debug_mode: true to reveal)";
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503 || status === 502 || status === 504;
}

/**
 * Performs a TLS pre-flight check to verify the server certificate fingerprint.
 * Only runs for HTTPS URLs; HTTP URLs are silently skipped.
 *
 * @param horizonUrl - The Horizon URL to check (must be https:)
 * @param expectedFingerprint - SHA-256 fingerprint in colon-separated uppercase hex (e.g. 'AA:BB:...')
 * @throws {HorizonPinMismatchError} When the actual fingerprint does not match `expectedFingerprint`.
 * @throws {HorizonTlsError} When the TLS connection or certificate retrieval fails.
 * (Issue #303)
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

  const host = parsed.hostname;
  const port = parseInt(parsed.port || '443', 10);
  const normalizedExpected = expectedFingerprint.toUpperCase().replace(/\s/g, '');

  return new Promise<void>((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host }, () => {
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

        if (normalizedActual !== normalizedExpected) {
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
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function buildCacheKey(
  normalizedHorizonUrl: string,
  stellarAddress: string,
): string {
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
  outcome: "hit" | "miss",
  normalizedHorizonUrl: string,
  stellarAddress: string,
): void {
  globalMetrics.recordMetric(`horizon_cache_${outcome}`, 1, "count", {
    horizonUrl: redactHorizonUrl(normalizedHorizonUrl),
    stellarAddress: redactStellarAddress(stellarAddress),
  });
  globalMetrics.incrementCounter(`horizon_cache_${outcome}`);
}

function safeHorizonContext(
  base: Omit<LogContext, "stellarAddress" | "horizonUrl"> & {
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
    hasNativeBalance: account.balances.some((b) => b.asset_type === "native"),
    creditTrustlineCount: account.balances.filter((b) => isCreditBalance(b))
      .length,
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
  endpointKind: "primary" | "fallback",
  retryMaxDelayMs: number,
  retryMaxTotalWaitMs: number,
  parentSignal?: AbortSignal,
  rateBudgetTracker?: RateBudgetTracker,
  circuitBreaker?: CircuitBreaker,
  retryBaseDelayMs: number = DEFAULT_RETRY_BASE_DELAY_MS,
): Promise<FetchOnceResult> {
  const normalizedHorizonUrl = normalizeHorizonUrl(targetHorizonUrl);
  const url = `${normalizedHorizonUrl}/accounts/${stellarAddress}`;
  const safeUrlForLog = redactHorizonUrl(url);

  let attempt = 0;
  let totalWaitMs = 0;
  let lastError: Error | undefined;

  while (attempt <= maxRetries) {
    // Bail out immediately if the job was cancelled before this attempt.
    if (parentSignal?.aborted) {
      throw new HorizonError(
        "Horizon request aborted (job cancelled).",
        0,
        false,
      );
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
              method: "GET",
              headers: { Accept: "application/json" },
              signal: controller.signal,
            }),
          )
        : await fetch(url, {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: controller.signal,
          });

      const latencyMs = Date.now() - requestStartedAt;

      if (response.status === 404) {
        logger.debug(
          "Horizon account not found (404)",
          safeHorizonContext({
            component: "horizon",
            stellarAddress,
            horizonUrl: targetHorizonUrl,
            endpointKind,
            status: 404,
            latencyMs,
            attempt,
          }),
        );
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
              errorDetail: redactString(detail),
              errorType: body.type ? redactString(body.type) : undefined,
              errorTitle: body.title ? redactString(body.title) : undefined,
            }),
          );
        } catch {
          logger.debug(
            "Horizon error response missing JSON body",
            safeHorizonContext({
              component: "horizon",
              stellarAddress,
              horizonUrl: targetHorizonUrl,
              endpointKind,
              status: response.status,
              retryable,
              latencyMs,
              attempt,
              statusText: response.statusText,
            }),
          );
        }

        if (retryable && attempt < maxRetries) {
          const retryAfterHeader = parseRetryAfterMs(response);
          // Issue #218: Honor Retry-After on 429s, capped at retryMaxDelayMs.
          // When the header is missing or the value exceeds the cap, fall back
          // to exponential backoff so the action never waits unbounded.
          let retryAfter: number;
          if (retryAfterHeader !== null) {
            retryAfter = Math.min(retryAfterHeader, retryMaxDelayMs);
          } else {
            retryAfter = Math.min(
              retryBaseDelayMs * 2 ** attempt,
              retryMaxDelayMs,
            );
          }

          if (totalWaitMs + retryAfter > retryMaxTotalWaitMs) {
            throw new HorizonRateLimitError(
              `Horizon rate limit exceeded (total wait ${totalWaitMs + retryAfter}ms exceeds cap of ${retryMaxTotalWaitMs}ms). Please try again later.`,
              retryAfter,
            );
          }

          totalWaitMs += retryAfter;

          logger.debug(
            "Horizon retry scheduled",
            safeHorizonContext({
              component: "horizon",
              stellarAddress,
              horizonUrl: targetHorizonUrl,
              endpointKind,
              status: response.status,
              retryable,
              latencyMs,
              attempt,
              retryAfterMs: retryAfter,
              retryAfterFromHeader: retryAfterHeader !== null,
              retryAfterCapped:
                retryAfterHeader !== null && retryAfterHeader > retryMaxDelayMs,
              nextAttempt: attempt + 1,
            }),
          );
          await cancellableSleep(retryAfter, parentSignal);
          // If the job was cancelled during the sleep, bail out on the next
          // iteration's pre-flight check rather than issuing another request.
          attempt += 1;
          continue;
        }

        logger.debug(
          "Horizon non-retryable HTTP error (exhausted retries)",
          safeHorizonContext({
            component: "horizon",
            stellarAddress,
            horizonUrl: targetHorizonUrl,
            endpointKind,
            status: response.status,
            retryable,
            latencyMs,
            attempt,
            final: true,
          }),
        );

        throw new HorizonError(
          `Horizon request failed (${response.status}): ${detail}`,
          response.status,
          retryable,
        );
      }

      const parsed = (await response.json()) as HorizonAccount;
      logger.debug(
        "Horizon fetch success",
        safeHorizonContext({
          component: "horizon",
          stellarAddress,
          horizonUrl: targetHorizonUrl,
          endpointKind,
          status: response.status,
          latencyMs,
          attempt,
          ...safeAccountSummary(parsed),
        }),
      );
      return {
        account: parsed,
        statusCode: response.status,
        latencyMs,
        attempts: attempt + 1,
      };
    } catch (error) {
      if (
        error instanceof HorizonError ||
        (error instanceof Error && error.name === "RateBudgetExhaustedError")
      ) {
        throw error;
      }

      // Issue #209: CircuitOpenError means the circuit breaker is open.
      // Treat as non-retryable — the breaker will transition to half-open
      // after its recovery timeout.
      if (error instanceof CircuitOpenError) {
        logger.debug(
          "Horizon request blocked by circuit breaker",
          safeHorizonContext({
            component: "horizon",
            stellarAddress,
            horizonUrl: targetHorizonUrl,
            endpointKind,
            attempt,
            final: true,
          }),
        );
        throw new HorizonError(
          `Horizon request blocked by circuit breaker: ${error.message}`,
          0,
          false,
        );
      }

      const tlsCode = tlsErrorCode(error);
      if (tlsCode) {
        const tlsLatencyMs = Date.now() - requestStartedAt;
        logger.debug(
          "Horizon TLS/certificate verification failed",
          safeHorizonContext({
            component: "horizon",
            stellarAddress,
            horizonUrl: targetHorizonUrl,
            endpointKind,
            tlsErrorCode: tlsCode,
            latencyMs: tlsLatencyMs,
            attempt,
            final: true,
          }),
        );
        // Not retryable: retrying against the same endpoint cannot fix a
        // bad certificate, so fail fast instead of burning the retry budget.
        throw new HorizonTlsError(
          "TLS/certificate verification failed while connecting to the configured Horizon endpoint. " +
            "This is a transport-layer problem with the endpoint itself, not with the Stellar account being checked.",
          tlsCode,
        );
      }

      const isAbort = error instanceof Error && error.name === "AbortError";
      // If the parent job signal fired, propagate as a non-retryable cancellation.
      const isJobCancelled = isAbort && parentSignal?.aborted;
      const message = isJobCancelled
        ? "Horizon request aborted (job cancelled)."
        : isAbort
          ? `Horizon request timed out after ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : "Unknown Horizon error";

      const latencyMs = Date.now() - requestStartedAt;

      logger.debug(
        "Horizon transport error",
        safeHorizonContext({
          component: "horizon",
          stellarAddress,
          horizonUrl: targetHorizonUrl,
          endpointKind,
          kind: isJobCancelled ? "cancelled" : isAbort ? "timeout" : "network",
          latencyMs,
          attempt,
          timeoutMs,
          errorMessage: redactString(message),
        }),
      );

      // Job cancellation is non-retryable — throw immediately.
      if (isJobCancelled) {
        throw new HorizonError(message, 0, false);
      }

      lastError = new HorizonError(message, isAbort ? 408 : 0, true);

      if (attempt < maxRetries) {
        const backoffMs = Math.min(
          retryBaseDelayMs * 2 ** attempt,
          retryMaxDelayMs,
        );

        if (totalWaitMs + backoffMs > retryMaxTotalWaitMs) {
          throw lastError;
        }

        totalWaitMs += backoffMs;

        logger.debug(
          "Horizon transport retry scheduled",
          safeHorizonContext({
            component: "horizon",
            stellarAddress,
            horizonUrl: targetHorizonUrl,
            endpointKind,
            kind: isAbort ? "timeout" : "network",
            latencyMs,
            attempt,
            retryAfterMs: backoffMs,
            nextAttempt: attempt + 1,
          }),
        );
        await cancellableSleep(backoffMs, parentSignal);
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
          kind: isAbort ? "timeout" : "network",
          latencyMs,
          attempt,
          final: true,
        }),
      );

      throw lastError;
    } finally {
      clearTimeout(timer);
      if (parentSignal && parentAbortHandler) {
        parentSignal.removeEventListener("abort", parentAbortHandler);
      }
    }
  }

  logger.debug(
    "Horizon retry loop exited without result (fallback throw)",
    safeHorizonContext({
      component: "horizon",
      stellarAddress,
      horizonUrl: targetHorizonUrl,
      endpointKind,
      maxAttempts: maxRetries + 1,
    }),
  );

  throw (
    lastError ??
    new HorizonError("Horizon request failed after retries", 0, true)
  );
}

export async function fetchAccount(
  horizonUrl: string,
  stellarAddress: string,
  options: FetchAccountOptions = {},
): Promise<HorizonAccount> {
  return traceHorizonFetch(horizonUrl, stellarAddress, async () => {
    const fetch: FetchLike =
      options.fetchFn ?? (await import('node-fetch')).default;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
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
      throw primaryError;
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
  });
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
      throw new HorizonError("Polling aborted (job cancelled).", 0, false);
    }

    attempt += 1;

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

/** Allowlist of known-safe friendbot endpoints. */
const FRIENDBOT_ALLOWLIST = [
  'https://friendbot.stellar.org',
  'https://horizon-testnet.stellar.org/friendbot',
  'friendbot-testnet.stellar.org', // Domain-only variant
];

/**
 * Check if a friendbot URL is on the allowlist and safe to use.
 * Prevents SSRF attacks by only allowing known testnet friendbot endpoints.
 */
export function isFriendbotAllowed(friendbotUrl: string): boolean {
  const normalized = friendbotUrl.toLowerCase().trim();
  
  // Check exact match
  if (FRIENDBOT_ALLOWLIST.includes(normalized)) {
    return true;
  }
  
  // Check domain match (with or without https://)
  for (const allowed of FRIENDBOT_ALLOWLIST) {
    if (normalized === allowed || normalized === `https://${allowed}`) {
      return true;
    }
  }
  
  // Check if it's a subdomain path
  try {
    const url = new URL(normalized.startsWith('http') ? normalized : `https://${normalized}`);
    const allowedDomains = FRIENDBOT_ALLOWLIST.map(a => a.replace(/^https?:\/\//, ''));
    
    for (const domain of allowedDomains) {
      if (url.hostname === domain || url.hostname.endsWith(`.${domain}`)) {
        return true;
      }
    }
  } catch {
    // Invalid URL, not allowed
    return false;
  }
  
  return false;
}

/**
 * Detect whether a Horizon URL points to testnet or mainnet.
 * Used to enforce friendbot safety rules (never call friendbot on mainnet).
 */
export function isTestnetHorizon(horizonUrl: string): boolean {
  const normalized = horizonUrl.toLowerCase();
  return normalized.includes('testnet') || normalized.includes('test');
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
  
  // Normalize URL
  let fullUrl = friendbotUrl.trim();
  if (!fullUrl.startsWith('http')) {
    fullUrl = `https://${fullUrl}`;
  }
  
  // Ensure /friendbot path if missing
  if (!fullUrl.includes('/friendbot')) {
    fullUrl = fullUrl.replace(/\/$/, '') + '/friendbot';
  }
  
  // Add address parameter
  const urlWithParam = `${fullUrl}?addr=${encodeURIComponent(stellarAddress)}`;
  
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
    
    if (error instanceof Error && error.name === 'AbortError') {
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
export function isCreditBalance(
  balance: HorizonBalance,
): balance is HorizonBalanceCredit {
  return (
    balance.asset_type === "credit_alphanum4" ||
    balance.asset_type === "credit_alphanum12"
  );
}

export function getNativeBalance(account: HorizonAccount): string {
  const native = account.balances.find((b) => b.asset_type === "native");
  return native?.balance ?? "0";
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
  return findTrustlineBalance(account, assetCode, assetIssuer)?.balance ?? "0";
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
  return balance?.limit ? balance.limit : "0";
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

  const str = absStroops.toString().padStart(8, "0");
  const intPart = str.slice(0, -7);
  const fracPart = str.slice(-7);

  const cleanFrac = fracPart.replace(/0+$/, "");
  return `${isNegative ? "-" : ""}${intPart}.${cleanFrac.padEnd(7, "0")}`;
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
  const validation = validateHorizonUrl(horizonUrl, "horizon_url", {
    allowHttp: true,
  });
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
  const fetcher = fetchFn ?? createProxiedFetch() ?? (await import('node-fetch')).default;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal:
          controller.signal as unknown as import("node-fetch").RequestInit["signal"],
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
  | "wallet: funded"
  | "wallet: unfunded"
  | "wallet: trustline-missing"
  | "wallet: reserve-low"
  | "wallet: horizon-error";

/**
 * All wallet label strings — useful for bulk removal before re-applying
 * the current state so stale labels never linger on an issue.
 */
export const ALL_WALLET_LABELS: WalletLabel[] = [
  "wallet: funded",
  "wallet: unfunded",
  "wallet: trustline-missing",
  "wallet: reserve-low",
  "wallet: horizon-error",
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
  if (input.horizonError) return "wallet: horizon-error";
  if (!input.accountFunded) return "wallet: unfunded";
  if (!input.trustlineExists) return "wallet: trustline-missing";
  if (!input.xlmReserveMet) return "wallet: reserve-low";
  return "wallet: funded";
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
 * Apply the appropriate wallet label to a GitHub issue via Octokit,
 * optionally removing stale wallet labels first.
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
  input: WalletLabelInput,
  options: ApplyWalletLabelsOptions = {},
): Promise<{ applied: WalletLabel; removed: string[]; error?: string }> {
  const removeStale = options.removeStale ?? true;
  const targetLabel = deriveWalletLabel(input);
  const removed: string[] = [];

  try {
    if (removeStale) {
      // Fetch current labels to avoid 404s on removeLabel for non-present labels.
      const currentLabelsResponse = await octokit.rest.issues.listLabelsOnIssue(
        {
          owner,
          repo,
          issue_number: issueNumber,
          per_page: 100,
        },
      );
      const currentNames = currentLabelsResponse.data.map((l) => l.name);

      const stale = ALL_WALLET_LABELS.filter(
        (l) => l !== targetLabel && currentNames.includes(l),
      );

      for (const label of stale) {
        try {
          await octokit.rest.issues.removeLabel({
            owner,
            repo,
            issue_number: issueNumber,
            name: label,
          });
          removed.push(label);
        } catch {
          // Ignore individual remove failures — the add still proceeds.
        }
      }
    }

    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: issueNumber,
      labels: [targetLabel],
    });

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
    const currentLabelsResponse = await octokit.rest.issues.listLabelsOnIssue({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    });
    const currentNames = new Set(currentLabelsResponse.data.map((l) => l.name));

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
  const fetchImpl = options.fetchFn ?? createProxiedFetch() ?? (await import('node-fetch')).default;  const timeoutMs = options.timeoutMs || 15000;
  const maxRetries = options.maxRetries ?? 3;

  let attempt = 0;
  const normalizedUrl = horizonUrl.replace(/\/$/, "");

  while (attempt <= maxRetries) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(normalizedUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal:
          controller.signal as unknown as import("node-fetch").RequestInit["signal"],
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = (await response.json()) as { network_passphrase?: string };
        if (data.network_passphrase) {
          return data.network_passphrase;
        }
        throw new Error(
          "network_passphrase not found in Horizon root response",
        );
      }

      if (response.status !== 429 && response.status < 500) {
        throw new Error(
          `Horizon returned ${response.status} ${response.statusText}`,
        );
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
