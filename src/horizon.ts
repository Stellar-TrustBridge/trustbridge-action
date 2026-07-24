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
  ) {
    super(message);
    this.name = 'HorizonError';
  }
}

export interface FetchAccountOptions {
  timeoutMs?: number;
  maxRetries?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 3;

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

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchAccount(
  horizonUrl: string,
  stellarAddress: string,
  options: FetchAccountOptions = {},
): Promise<HorizonAccount> {
  const fetch = (await import('node-fetch')).default;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const normalizedHorizonUrl = normalizeHorizonUrl(horizonUrl);
  if (!normalizedHorizonUrl) {
    throw new HorizonError('horizon_url is required.', 0, false);
  }
  const url = `${normalizedHorizonUrl}/accounts/${stellarAddress}`;

  let attempt = 0;
  let lastError: Error | undefined;

  while (attempt <= maxRetries) {
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

        if (retryable && attempt < maxRetries) {
          const retryAfter = parseRetryAfterMs(response) ?? 1000 * 2 ** attempt;
          await sleep(retryAfter);
          attempt += 1;
          continue;
        }

        throw new HorizonError(
          `Horizon request failed (${response.status}): ${detail}`,
          response.status,
          retryable,
        );
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

      lastError = new HorizonError(message, isAbort ? 408 : 0, true);

      if (attempt < maxRetries) {
        await sleep(1000 * 2 ** attempt);
        attempt += 1;
        continue;
      }

      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new HorizonError('Horizon request failed after retries', 0, true);
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
