import { HorizonError, isCreditBalance,
  isRetryableStatus,
  parseRetryAfterMs,
  parseHorizonBalance, normalizeHorizonUrl } from '../src/horizon';
import { fetchAccount } from '../src/horizon';

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
    const response = { headers: { get: () => '2' } };
    expect(parseRetryAfterMs(response as any)).toBe(2000);
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


describe('fetchAccount with resilience policy', () => {
  it('accepts maxRetries and retryBaseDelayMs options', async () => {
    await expect(
      fetchAccount('   ', 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', {
        maxRetries: 2,
        retryBaseDelayMs: 500,
      }),
    ).rejects.toMatchObject({
      message: 'horizon_url is required.',
      statusCode: 0,
      retryable: false,
    });
  });
});
