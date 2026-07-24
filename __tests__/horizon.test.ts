import { HorizonError, isCreditBalance,
  isRetryableStatus,
  parseRetryAfterMs,
  parseHorizonBalance, normalizeHorizonUrl } from '../src/horizon';
import { fetchAccount, HorizonAccount, waitForFundedAccount } from '../src/horizon';

const TEST_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

function makeAccount(): HorizonAccount {
  return {
    id: TEST_ADDRESS,
    account_id: TEST_ADDRESS,
    sequence: '1',
    subentry_count: 0,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [
      {
        balance: '10.0000000',
        asset_type: 'native',
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
      },
    ],
  };
}

describe('normalizeHorizonUrl', () => {
  it('trims whitespace and trailing slashes', () => {
    expect(normalizeHorizonUrl(' https://horizon.stellar.org/// ')).toBe(
      'https://horizon.stellar.org',
    );
  });

  it('returns an empty string for blank values', () => {
    expect(normalizeHorizonUrl('   ')).toBe('');
  });
});

describe('parseRetryAfterMs', () => {
  it('parses seconds-based retry headers', () => {
    const response = { headers: { get: () => '2' } } as unknown as import('node-fetch').Response;
    expect(parseRetryAfterMs(response)).toBe(2000);
  });
});

describe('isRetryableStatus', () => {
  it('flags transient Horizon statuses', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
  });
});

describe('isCreditBalance', () => {
  it('detects credit balances', () => {
    expect(isCreditBalance({ balance: '1', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GISSUER', buying_liabilities: '0', selling_liabilities: '0' })).toBe(true);
    expect(isCreditBalance({ balance: '1', asset_type: 'native', buying_liabilities: '0', selling_liabilities: '0' })).toBe(false);
  });
});

describe('fetchAccount', () => {
  it('fails fast when horizon_url is blank', async () => {
    await expect(fetchAccount('   ', 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF')).rejects.toMatchObject({
      message: 'horizon_url is required.',
      statusCode: 0,
      retryable: false,
    } satisfies Partial<HorizonError>);
  });
});

describe('parseHorizonBalance', () => {
  it('parses numeric balances and falls back to zero', () => {
    expect(parseHorizonBalance('1.5000000')).toBe(1.5);
    expect(parseHorizonBalance('bad')).toBe(0);
  });
});

describe('waitForFundedAccount', () => {
  it('returns the account once a poll succeeds', async () => {
    const account = makeAccount();
    const fetchAccountFn = jest
      .fn()
      .mockRejectedValueOnce(new HorizonError('not found', 404, false))
      .mockRejectedValueOnce(new HorizonError('not found', 404, false))
      .mockResolvedValueOnce(account);

    const onPoll = jest.fn();

    const result = await waitForFundedAccount(
      'https://horizon.stellar.org',
      TEST_ADDRESS,
      { timeoutMs: 5000, pollIntervalMs: 5, onPoll },
      fetchAccountFn,
    );

    expect(result).toBe(account);
    expect(fetchAccountFn).toHaveBeenCalledTimes(3);
    expect(onPoll).toHaveBeenCalledTimes(2);
  });

  it('throws a 404 HorizonError once the timeout budget is exhausted', async () => {
    const fetchAccountFn = jest.fn().mockRejectedValue(new HorizonError('not found', 404, false));

    await expect(
      waitForFundedAccount(
        'https://horizon.stellar.org',
        TEST_ADDRESS,
        { timeoutMs: 20, pollIntervalMs: 5 },
        fetchAccountFn,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rethrows non-404 errors immediately without polling further', async () => {
    const outage = new HorizonError('Horizon request failed (503): maintenance', 503, true);
    const fetchAccountFn = jest.fn().mockRejectedValue(outage);

    await expect(
      waitForFundedAccount(
        'https://horizon.stellar.org',
        TEST_ADDRESS,
        { timeoutMs: 5000, pollIntervalMs: 5 },
        fetchAccountFn,
      ),
    ).rejects.toBe(outage);
    expect(fetchAccountFn).toHaveBeenCalledTimes(1);
  });
});
