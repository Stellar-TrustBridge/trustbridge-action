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
  public retryAfterMs?: number;

  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly retryable: boolean = false,
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

import {
  DEFAULT_RETRY_POLICY,
  retryWithBackoff,
  RetryPolicy,
} from './resilience';

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
  const retryBaseDelayMs = options.retryBaseDelayMs ?? 1000;

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

  return retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });

        if (response.status === 404) {
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
          } catch {
            // ignore JSON parse errors on error responses
          }

          const error = new HorizonError(
            `Horizon request failed (${response.status}): ${detail}`,
            response.status,
            retryable,
          );

          const retryAfter = parseRetryAfterMs(response);
          if (retryable && retryAfter !== null) {
            error.retryAfterMs = retryAfter;
          }

          throw error;
        }

        return (await response.json()) as HorizonAccount;
      } catch (error) {
        if (error instanceof HorizonError) {
          throw error;
        }

        const isAbort = error instanceof Error && error.name === 'AbortError';
        const message = isAbort
          ? `Horizon request timed out after ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : 'Unknown Horizon error';

        throw new HorizonError(message, isAbort ? 408 : 0, true);
      } finally {
        clearTimeout(timer);
      }
    },
    policy,
    (error) => {
      if (error instanceof HorizonError) {
        return error.retryable;
      }
      return true;
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
