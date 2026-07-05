import { HorizonError, isCreditBalance, normalizeHorizonUrl } from '../src/horizon';
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
