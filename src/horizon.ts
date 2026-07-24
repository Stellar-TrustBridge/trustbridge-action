import { logger } from './logger';
import {
  retryWithBackoff,
  RetryPolicy,
  DEFAULT_RETRY_POLICY,
  calculateBackoffDelay,
  addJitter,
  sleep,
} from './resilience';

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
}

export type HorizonBalance = HorizonBalanceNative | HorizonBalanceCredit;

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
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'HorizonError';
  }
}

export interface FetchAccountOptions {
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;

export function normalizeHorizonUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
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

export async function fetchAccount(
  horizonUrl: string,
  stellarAddress: string,
  options: FetchAccountOptions = {},
): Promise<HorizonAccount> {
  const fetch = (await import('node-fetch')).default;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const normalizedHorizonUrl = normalizeHorizonUrl(horizonUrl);
  if (!normalizedHorizonUrl) {
    throw new HorizonError('horizon_url is required.', 0, false);
  }
  const url = `${normalizedHorizonUrl}/accounts/${stellarAddress}`;

  const policy: RetryPolicy = {
    ...DEFAULT_RETRY_POLICY,
    maxRetries,
    initialDelayMs: retryBaseDelayMs,
    timeoutMs,
  };

  logger.debug('Initiating Horizon account fetch', {
    component: 'horizon',
    horizonUrl: normalizedHorizonUrl,
    stellarAddress,
    maxRetries: policy.maxRetries,
    timeoutMs: policy.timeoutMs,
  });

  let lastRetryAfterMs: number | undefined;

  return await retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), policy.timeoutMs);

      try {
        logger.debug('Making Horizon request', {
          component: 'horizon',
        });

        const response = await fetch(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });

        logger.debug('Received Horizon response', {
          component: 'horizon',
          status: response.status,
        });

        if (response.status === 404) {
          logger.debug('Account not found on Horizon', {
            component: 'horizon',
            stellarAddress,
          });
          throw new HorizonError(
            `Account ${stellarAddress} was not found on Horizon (not funded or activated).`,
            404,
            false,
          );
        }

        if (!response.ok) {
          const retryable = isRetryableStatus(response.status);
          const retryAfter = parseRetryAfterMs(response);
          let detail = response.statusText;
          try {
            const body = (await response.json()) as HorizonErrorResponse;
            if (body.detail) {
              detail = body.detail;
            } else if (body.title) {
              detail = body.title;
            }
          } catch {
            // ignore JSON parse errors on error responses
          }

          logger.debug('Horizon request failed', {
            component: 'horizon',
            status: response.status,
            detail,
            retryable,
            retryAfterMs: retryAfter,
          });

          throw new HorizonError(
            `Horizon request failed (${response.status}): ${detail}`,
            response.status,
            retryable,
            retryAfter ?? undefined,
          );
        }

        logger.debug('Successfully fetched Horizon account', {
          component: 'horizon',
        });
        return (await response.json()) as HorizonAccount;
      } catch (error) {
        if (error instanceof HorizonError) {
          throw error;
        }

        const isAbort = error instanceof Error && error.name === 'AbortError';
        const message = isAbort
          ? `Horizon request timed out after ${policy.timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : 'Unknown Horizon error';

        logger.debug('Horizon request failed', {
          component: 'horizon',
          error: message,
        });

        throw new HorizonError(message, isAbort ? 408 : 0, true);
      } finally {
        clearTimeout(timer);
      }
    },
    policy,
    (error, attempt) => {
      if (!(error instanceof HorizonError)) {
        return false;
      }

      if (!error.retryable) {
        return false;
      }

      if (error.retryAfterMs !== undefined) {
        logger.debug('Using Retry-After header for delay', {
          component: 'horizon',
          attempt,
          retryAfterMs: error.retryAfterMs,
        });
        lastRetryAfterMs = error.retryAfterMs;
      }

      return true;
    },
    // Custom sleep that uses Retry-After if available
    async (attempt, delayMs) => {
      let sleepMs = lastRetryAfterMs;
      lastRetryAfterMs = undefined;
      if (sleepMs === undefined) {
        const backoffDelay = calculateBackoffDelay(attempt, policy);
        sleepMs = addJitter(backoffDelay);
      }

      logger.debug('Waiting before retry', {
        component: 'horizon',
        attempt,
        sleepMs,
      });

      await sleep(sleepMs);
    },
  );
}

export function isCreditBalance(balance: HorizonBalance): balance is HorizonBalanceCredit {
  return balance.asset_type !== 'native';
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

export function parseHorizonBalance(balance: string): number {
  const parsed = Number(balance);
  return Number.isFinite(parsed) ? parsed : 0;
}
