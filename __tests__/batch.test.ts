import {
  parseBatchAddresses,
  runBatchValidation,
  buildBatchSummary,
  formatBatchSummaryMarkdown,
  BatchAddressResult,
} from '../src/batch';
import { CheckConfig } from '../src/checks';
import * as horizon from '../src/horizon';

jest.mock('../src/horizon', () => ({
  ...jest.requireActual('../src/horizon'),
  fetchAccount: jest.fn(),
}));

const mockFetchAccount = horizon.fetchAccount as jest.MockedFunction<typeof horizon.fetchAccount>;

const DEFAULT_CONFIG: CheckConfig = {
  assetCode: 'USDC',
  assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  minXlmReserve: 1.5,
  horizonUrl: 'https://horizon.stellar.org',
};

// Valid Stellar G-addresses for testing (56 chars, starting with G)
const VALID_ADDR_1 = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const VALID_ADDR_2 = 'GBBD47IF6LWK2P7MDEVSCWR7DPUWV3NY3DTQEVFL4TWVC5GIOTASHEX2';
const VALID_ADDR_3 = 'GCRJWJZ4YJHZ27K5VYXMNQCM5JFY5PN5TKKJ2YGA6SSRUMR7F2W4I62C';

const FUNDED_ACCOUNT = {
  id: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  account_id: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  sequence: '1',
  subentry_count: 2,
  balances: [
    { asset_type: 'native', balance: '10.0' },
    {
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      balance: '100.0',
      limit: '1000000',
      is_authorized: true,
      is_clawback_enabled: false,
    },
  ],
};

describe('parseBatchAddresses', () => {
  it('parses newline-separated addresses', () => {
    const input = `${VALID_ADDR_1}\n${VALID_ADDR_2}\n${VALID_ADDR_3}`;
    const result = parseBatchAddresses(input);
    expect(result).toEqual([VALID_ADDR_1, VALID_ADDR_2, VALID_ADDR_3]);
  });

  it('parses JSON array', () => {
    const input = `["${VALID_ADDR_1}", "${VALID_ADDR_2}"]`;
    const result = parseBatchAddresses(input);
    expect(result).toEqual([VALID_ADDR_1, VALID_ADDR_2]);
  });

  it('parses JSON array and drops empty after trim', () => {
    const input = `["${VALID_ADDR_1}", "  ", "${VALID_ADDR_2}", ""]`;
    const result = parseBatchAddresses(input);
    expect(result).toEqual([VALID_ADDR_1, VALID_ADDR_2]);
  });

  it('deduplicates addresses', () => {
    const input = `${VALID_ADDR_1}\n${VALID_ADDR_2}\n${VALID_ADDR_1}`;
    const result = parseBatchAddresses(input);
    expect(result).toEqual([VALID_ADDR_1, VALID_ADDR_2]);
  });

  it('throws on empty input', () => {
    expect(() => parseBatchAddresses('')).toThrow('stellar_addresses input is empty');
  });

  it('throws on whitespace-only input', () => {
    expect(() => parseBatchAddresses('   \n  \n  ')).toThrow('stellar_addresses input is empty');
  });

  it('handles mixed newline and blank lines', () => {
    const input = `${VALID_ADDR_1}\n\n${VALID_ADDR_2}\n\n`;
    const result = parseBatchAddresses(input);
    expect(result).toEqual([VALID_ADDR_1, VALID_ADDR_2]);
  });
});

describe('buildBatchSummary', () => {
  const results: BatchAddressResult[] = [
    {
      address: VALID_ADDR_1,
      valid: true,
      accountFunded: true,
      trustlineExists: true,
      xlmBalance: '10.0',
      xlmReserveMet: true,
      failureReason: null,
    },
    {
      address: VALID_ADDR_2,
      valid: false,
      accountFunded: false,
      trustlineExists: false,
      xlmBalance: '0',
      xlmReserveMet: false,
      failureReason: 'account not funded',
    },
    {
      address: VALID_ADDR_3,
      valid: false,
      accountFunded: true,
      trustlineExists: false,
      xlmBalance: '5.0',
      xlmReserveMet: true,
      failureReason: 'trustline missing',
    },
  ];

  it('computes correct summary', () => {
    const summary = buildBatchSummary(results);
    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(2);
    expect(summary.failures).toHaveLength(2);
  });

  it('computes failure taxonomy', () => {
    const summary = buildBatchSummary(results);
    expect(summary.failureTaxonomy.accountNotFunded).toBe(1);
    expect(summary.failureTaxonomy.trustlineMissing).toBe(1);
  });
});

describe('formatBatchSummaryMarkdown', () => {
  it('renders success message when all pass', () => {
    const summary = {
      total: 2,
      passed: 2,
      failed: 0,
      failures: [],
      failureTaxonomy: {
        accountNotFunded: 0,
        trustlineMissing: 0,
        reserveInsufficient: 0,
        horizonError: 0,
        invalidAddress: 0,
      },
    };
    const md = formatBatchSummaryMarkdown(summary, 'USDC');
    expect(md).toContain('All addresses passed');
  });

  it('renders failure table when some fail', () => {
    const summary = {
      total: 3,
      passed: 1,
      failed: 2,
      failures: [
        { address: VALID_ADDR_1, reason: 'account not funded' },
        { address: VALID_ADDR_2, reason: 'trustline missing' },
      ],
      failureTaxonomy: {
        accountNotFunded: 1,
        trustlineMissing: 1,
        reserveInsufficient: 0,
        horizonError: 0,
        invalidAddress: 0,
      },
    };
    const md = formatBatchSummaryMarkdown(summary, 'USDC');
    expect(md).toContain('2 of 3 addresses failed');
    expect(md).toContain('account not funded');
    expect(md).toContain('USDC trustline missing');
    
    // Check that per-address outcomes are listed (shortened addresses)
    expect(md).toContain('GA5ZSE…KZVN'); // VALID_ADDR_1
    expect(md).toContain('GBBD47…HEX2'); // VALID_ADDR_2
  });
});

describe('runBatchValidation', () => {
  const VALID_ADDR = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

  beforeEach(() => {
    mockFetchAccount.mockReset();
  });

  it('validates multiple addresses sequentially', async () => {
    const account1 = {
      ...FUNDED_ACCOUNT,
      id: VALID_ADDR,
      account_id: VALID_ADDR,
      balances: [
        { asset_type: 'native', balance: '10.0' },
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
          balance: '100.0',
          limit: '1000000',
          is_authorized: true,
          is_clawback_enabled: false,
        },
      ],
    };
    mockFetchAccount.mockResolvedValue(account1 as any);

    const results = await runBatchValidation(
      [VALID_ADDR, VALID_ADDR],
      DEFAULT_CONFIG,
      'https://horizon.stellar.org',
      { requestDelayMs: 0 },
    );

    expect(results).toHaveLength(2);
    expect(results[0].valid).toBe(true);
    expect(results[1].valid).toBe(true);
    expect(mockFetchAccount).toHaveBeenCalledTimes(2);
  });

  it('handles unfunded account (404)', async () => {
    mockFetchAccount.mockRejectedValue(
      new horizon.HorizonError('Not found', 404),
    );

    const results = await runBatchValidation(
      [VALID_ADDR],
      DEFAULT_CONFIG,
      'https://horizon.stellar.org',
      { requestDelayMs: 0 },
    );

    expect(results).toHaveLength(1);
    expect(results[0].valid).toBe(false);
    expect(results[0].failureReason).toContain('not funded');
  });

  it('handles Horizon error', async () => {
    mockFetchAccount.mockRejectedValue(
      new horizon.HorizonError('Server error', 500),
    );

    const results = await runBatchValidation(
      [VALID_ADDR],
      DEFAULT_CONFIG,
      'https://horizon.stellar.org',
      { requestDelayMs: 0 },
    );

    expect(results).toHaveLength(1);
    expect(results[0].valid).toBe(false);
    expect(results[0].failureReason).toContain('Horizon error');
  });

  it('handles mixed valid and invalid addresses', async () => {
    mockFetchAccount.mockImplementation(async (url, address) => {
      if (address === VALID_ADDR_1) {
        return {
          ...FUNDED_ACCOUNT,
          id: VALID_ADDR_1,
          account_id: VALID_ADDR_1,
        } as any;
      }
      throw new horizon.HorizonError('Not found', 404);
    });

    const results = await runBatchValidation(
      [VALID_ADDR_1, 'INVALID_FORMAT', VALID_ADDR_3],
      DEFAULT_CONFIG,
      'https://horizon.stellar.org',
      { requestDelayMs: 0 },
    );

    expect(results).toHaveLength(3);
    
    // First address valid
    expect(results[0].address).toBe(VALID_ADDR_1);
    expect(results[0].valid).toBe(true);

    // Second address invalid format (fails before Horizon fetch)
    expect(results[1].address).toBe('INVALID_FORMAT');
    expect(results[1].valid).toBe(false);
    expect(results[1].failureReason).toContain('Invalid Stellar address format');

    // Third address fails at Horizon (404)
    expect(results[2].address).toBe(VALID_ADDR_3);
    expect(results[2].valid).toBe(false);
    expect(results[2].failureReason).toContain('not funded');
  });
});
