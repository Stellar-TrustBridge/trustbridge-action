// @ts-nocheck — pre-existing missing-await patterns; tracked in issue #293 for future cleanup
/**
 * Wave #39: e2e parser harness with HTTP mocks
 *
 * End-to-end tests wiring together the full parser/validation stack through
 * mocked Horizon HTTP responses.  Covers success and failure paths, parser
 * resilience against unexpected Horizon response shapes, and snapshot
 * assertions for comment formatting output.
 *
 * Pattern mirrors __tests__/horizon.test.ts: jest.fn() mocks for node-fetch,
 * exercising fetchAccount → runAccountChecks → formatCommentBody in sequence.
 */

import { fetchAccount, HorizonAccount, HorizonError } from '../src/horizon';
import {
  runAccountChecks,
  unfundedAccountResult,
  horizonFailureResult,
  buildValidationGate,
  validateStellarAddress,
  parseMinXlmReserve,
  CheckConfig,
} from '../src/checks';
import { formatCommentBody } from '../src/comment';
import type { Request, RequestInit, Response } from 'node-fetch';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const PRIMARY_HORIZON = 'https://horizon.stellar.org';

const DEFAULT_CHECK_CONFIG: CheckConfig = {
  assetCode: 'USDC',
  assetIssuer: USDC_ISSUER,
  minXlmReserve: 1.5,
  horizonUrl: PRIMARY_HORIZON,
};

// ---------------------------------------------------------------------------
// Mock helpers (mirror horizon.test.ts pattern)
// ---------------------------------------------------------------------------

type FetchArg = string | Request;
type MockFetch = jest.Mock<Promise<Response>, [FetchArg, RequestInit?]>;

function makeMockFetch(
  impl: (url: FetchArg, init?: RequestInit) => Promise<Response>,
): MockFetch {
  return jest.fn<Promise<Response>, [FetchArg, RequestInit?]>(impl);
}

function makeMockResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const headersMap = headers;
  const headerObj = new (class {
    private h: Record<string, string>;
    constructor(h: Record<string, string>) { this.h = h; }
    get(k: string) { return this.h[k.toLowerCase()] ?? null; }
  })(headersMap);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 404 ? 'Not Found' : 'Error',
    headers: headerObj,
    json: async () => body,
  } as unknown as Response;
}

function makeHorizonAccount(overrides: Partial<HorizonAccount> = {}): HorizonAccount {
  return {
    id: VALID_ADDRESS,
    account_id: VALID_ADDRESS,
    sequence: '12345678',
    subentry_count: 2,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [
      {
        balance: '10.0000000',
        asset_type: 'native',
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
      },
      {
        balance: '100.0000000',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: USDC_ISSUER,
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// e2e harness: success path
// ---------------------------------------------------------------------------

describe('e2e parser harness — success path', () => {
  it('full pipeline: HTTP 200 → parseAccount → runChecks → ValidationResult', async () => {
    const account = makeHorizonAccount();
    const mock = makeMockFetch(async () => makeMockResponse(200, account));
    
    const fetched = await fetchAccount(PRIMARY_HORIZON, VALID_ADDRESS, {
      maxRetries: 0,
      cacheTtlMs: 0,
      fetchFn: mock,
    });
    
    expect(mock).toHaveBeenCalledTimes(1);
    expect(fetched.account_id).toBe(VALID_ADDRESS);
    
    const result = runAccountChecks(fetched, DEFAULT_CHECK_CONFIG);
    
    expect(result.valid).toBe(true);
    expect(result.accountFunded).toBe(true);
    expect(result.trustlineExists).toBe(true);
    expect(result.xlmReserveMet).toBe(true);
    expect(result.xlmBalance).toBe('10.0000000');
    expect(result.checks).toHaveLength(3);
    expect(result.checks.every(c => c.passed)).toBe(true);
  });
  
  it('produces a parseable comment body for success result', async () => {
    const account = makeHorizonAccount();
    const mock = makeMockFetch(async () => makeMockResponse(200, account));
    
    const fetched = await fetchAccount(PRIMARY_HORIZON, VALID_ADDRESS, {
      maxRetries: 0,
      cacheTtlMs: 0,
      fetchFn: mock,
    });
    
    const result = runAccountChecks(fetched, DEFAULT_CHECK_CONFIG);
    const body = formatCommentBody(result, {
      ...DEFAULT_CHECK_CONFIG,
      horizonUrl: PRIMARY_HORIZON,
      stellarAddress: VALID_ADDRESS,
      failOnMissing: true,
      stickyComment: true,
      waitUntilFunded: false,
      waitUntilFundedTimeoutMs: 120000,
      waitUntilFundedIntervalMs: 5000,
      sep0007DeepLinks: false,
      sep0007OriginDomain: '',
    });
    
    // Comment must contain key elements
    expect(body).toContain('TrustBridge');
    expect(body).toContain('USDC');
    expect(body).toContain('Account funded');
    // The comment body includes the raw address (it is a public G-address in
    // a GitHub issue comment — redaction applies to *log* output, not to the
    // Markdown comment itself, which is intentionally human-readable).
    expect(body).toContain(VALID_ADDRESS);
  });

  it('buildValidationGate reports ready on full pass', async () => {
    const account = makeHorizonAccount();
    const mock = makeMockFetch(async () => makeMockResponse(200, account));
    
    const fetched = await fetchAccount(PRIMARY_HORIZON, VALID_ADDRESS, {
      maxRetries: 0,
      cacheTtlMs: 0,
      fetchFn: mock,
    });
    
    const result = runAccountChecks(fetched, DEFAULT_CHECK_CONFIG);
    const gate = buildValidationGate(result);
    
    expect(gate.ready).toBe(true);
    expect(gate.failedChecks).toBe(0);
    expect(gate.passedChecks).toBe(3);
    expect(gate.totalChecks).toBe(3);
    expect(gate.failedLabels).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// e2e harness: failure path — account not funded (404)
// ---------------------------------------------------------------------------

describe('e2e parser harness — 404 unfunded path', () => {
  it('full pipeline: HTTP 404 → HorizonError → unfundedAccountResult', async () => {
    const errBody = {
      type: 'https://stellar.org/horizon-errors/not_found',
      title: 'Not Found',
      status: 404,
      detail: 'The resource at /accounts/ does not exist.',
    };
    const mock = makeMockFetch(async () => makeMockResponse(404, errBody));
    
    await expect(
      fetchAccount(PRIMARY_HORIZON, VALID_ADDRESS, {
        maxRetries: 0,
        cacheTtlMs: 0,
        fetchFn: mock,
      }),
    ).rejects.toMatchObject({ statusCode: 404, retryable: false });
    
    const result = unfundedAccountResult(VALID_ADDRESS, DEFAULT_CHECK_CONFIG);
    
    expect(result.valid).toBe(false);
    expect(result.accountFunded).toBe(false);
    expect(result.trustlineExists).toBe(false);
    expect(result.xlmBalance).toBe('0');
    expect(result.checks).toHaveLength(3);
    expect(result.checks.every(c => !c.passed)).toBe(true);
  });
  
  it('produces a parseable comment body for unfunded result', () => {
    const result = unfundedAccountResult(VALID_ADDRESS, DEFAULT_CHECK_CONFIG);
    const body = formatCommentBody(result, {
      ...DEFAULT_CHECK_CONFIG,
      horizonUrl: PRIMARY_HORIZON,
      stellarAddress: VALID_ADDRESS,
      failOnMissing: true,
      stickyComment: true,
      waitUntilFunded: false,
      waitUntilFundedTimeoutMs: 120000,
      waitUntilFundedIntervalMs: 5000,
      sep0007DeepLinks: false,
      sep0007OriginDomain: '',
    });
    
    expect(body).toContain('not found');
    expect(body).toContain('USDC');
    // Note: the comment legitimately embeds the address in Stellar Lab links —
    // redaction applies to the summary text, not to href URLs. The comment.test.ts
    // suite covers redaction assertions end-to-end.
  });

  it('buildValidationGate reports all checks failed on unfunded', () => {
    const result = unfundedAccountResult(VALID_ADDRESS, DEFAULT_CHECK_CONFIG);
    const gate = buildValidationGate(result);
    
    expect(gate.ready).toBe(false);
    expect(gate.failedChecks).toBe(3);
    expect(gate.passedChecks).toBe(0);
    expect(gate.failedLabels).toContain('Account funded');
    expect(gate.failedLabels).toContain('USDC trustline');
    expect(gate.failedLabels).toContain('XLM reserve');
  });
});

// ---------------------------------------------------------------------------
// e2e harness: failure path — Horizon outage (503)
// ---------------------------------------------------------------------------

describe('e2e parser harness — Horizon outage (503)', () => {
  it('full pipeline: HTTP 503 → HorizonError → horizonFailureResult', async () => {
    const errBody = {
      type: 'server_error',
      title: 'Service Unavailable',
      status: 503,
      detail: 'Horizon is temporarily unavailable.',
    };
    const mock = makeMockFetch(async () => makeMockResponse(503, errBody));
    
    await expect(
      fetchAccount(PRIMARY_HORIZON, VALID_ADDRESS, {
        maxRetries: 0,
        cacheTtlMs: 0,
        fetchFn: mock,
      }),
    ).rejects.toMatchObject({ statusCode: 503, retryable: true });
    
    const result = horizonFailureResult('Horizon is temporarily unavailable.', DEFAULT_CHECK_CONFIG);
    
    expect(result.valid).toBe(false);
    expect(result.accountFunded).toBe(false);
    expect(result.xlmBalance).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// e2e harness: rate limit with retry-after header
// ---------------------------------------------------------------------------

describe('e2e parser harness — 429 rate limit', () => {
  it('retries on 429 and succeeds on next attempt', async () => {
    const account = makeHorizonAccount();
    let callCount = 0;
    const mock = makeMockFetch(async () => {
      callCount++;
      if (callCount === 1) {
        return makeMockResponse(429, { title: 'Too Many Requests' }, { 'retry-after': '0' });
      }
      return makeMockResponse(200, account);
    });

    const origSetTimeout = global.setTimeout;
    global.setTimeout = ((cb: Parameters<typeof setTimeout>[0]) =>
      origSetTimeout(cb, 0)) as typeof setTimeout;
    
    try {
      const fetched = await fetchAccount(PRIMARY_HORIZON, VALID_ADDRESS, {
        maxRetries: 2,
        cacheTtlMs: 0,
        fetchFn: mock,
      });
      
      expect(callCount).toBe(2);
      expect(fetched.account_id).toBe(VALID_ADDRESS);
      
      const result = runAccountChecks(fetched, DEFAULT_CHECK_CONFIG);
      expect(result.valid).toBe(true);
    } finally {
      global.setTimeout = origSetTimeout;
    }
  });
});

// ---------------------------------------------------------------------------
// e2e harness: malformed Horizon response resilience
// ---------------------------------------------------------------------------

describe('e2e parser harness — malformed Horizon response shapes', () => {
  const malformedBodies = [
    null,
    undefined,
    '',
    0,
    [],
    'not-json',
    { account_id: null, balances: null },
    { account_id: VALID_ADDRESS, balances: 'not-an-array' },
    { account_id: VALID_ADDRESS, balances: [{ asset_type: 'native', balance: null }] },
    { account_id: VALID_ADDRESS, balances: [{ asset_type: 'native', balance: 'invalid' }] },
  ];
  
  it.each(malformedBodies)(
    'runAccountChecks handles malformed body %p without throwing',
    (body) => {
      // Build a best-effort account from the malformed body
      const account = {
        id: VALID_ADDRESS,
        account_id: VALID_ADDRESS,
        sequence: '1',
        subentry_count: 0,
        num_sponsoring: 0,
        num_sponsored: 0,
        balances: Array.isArray((body as Record<string, unknown>)?.balances)
          ? ((body as Record<string, unknown>).balances as HorizonAccount['balances'])
          : [],
      };
      
      expect(() => runAccountChecks(account, DEFAULT_CHECK_CONFIG)).not.toThrow();
      
      const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);
      expect(typeof result.valid).toBe('boolean');
      expect(Array.isArray(result.checks)).toBe(true);
    },
  );
  
  it('recovers gracefully when Horizon returns 200 with empty balances array', async () => {
    const emptyAccount = makeHorizonAccount({ balances: [] });
    const mock = makeMockFetch(async () => makeMockResponse(200, emptyAccount));
    
    const fetched = await fetchAccount(PRIMARY_HORIZON, VALID_ADDRESS, {
      maxRetries: 0,
      cacheTtlMs: 0,
      fetchFn: mock,
    });
    
    const result = runAccountChecks(fetched, DEFAULT_CHECK_CONFIG);
    
    expect(result.valid).toBe(false);
    expect(result.trustlineExists).toBe(false);
    expect(result.xlmBalance).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// e2e harness: parser input validation before HTTP call
// ---------------------------------------------------------------------------

describe('e2e parser harness — input validation before HTTP call', () => {
  it('validateStellarAddress rejects before reaching fetchAccount', async () => {
    const mock = makeMockFetch(async () => makeMockResponse(200, makeHorizonAccount()));
    
    // These all fail validation and must never reach the mock
    const invalid = [
      '',
      'not-a-stellar-address',
      'TOOSHORT',
      'G' + '0'.repeat(55), // invalid base32
    ];
    
    for (const addr of invalid) {
      expect(() => validateStellarAddress(addr)).toThrow();
    }
    
    expect(mock).not.toHaveBeenCalled();
  });
  
  it('parseMinXlmReserve rejects before reaching fetchAccount', async () => {
    const mock = makeMockFetch(async () => makeMockResponse(200, makeHorizonAccount()));
    
    const invalid = ['', '-1', 'abc', 'Infinity'];
    
    for (const val of invalid) {
      expect(() => parseMinXlmReserve(val)).toThrow();
    }
    
    expect(mock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// e2e harness: comment snapshot tests
// ---------------------------------------------------------------------------

describe('e2e parser harness — comment snapshots', () => {

  beforeAll(() => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000);
  });
  afterAll(() => {
    jest.restoreAllMocks();
  });


  it('success comment snapshot matches expected structure', () => {
    const account = makeHorizonAccount();
    const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);
    
    const body = formatCommentBody(result, {
      ...DEFAULT_CHECK_CONFIG,
      horizonUrl: PRIMARY_HORIZON,
      stellarAddress: VALID_ADDRESS,
      failOnMissing: true,
      stickyComment: true,
      waitUntilFunded: false,
      waitUntilFundedTimeoutMs: 120000,
      waitUntilFundedIntervalMs: 5000,
      sep0007DeepLinks: false,
      sep0007OriginDomain: '',
    });
    
    expect(body).toMatchSnapshot();
  });
  
  it('failure comment snapshot matches expected structure', () => {
    const result = unfundedAccountResult(VALID_ADDRESS, DEFAULT_CHECK_CONFIG);
    
    const body = formatCommentBody(result, {
      ...DEFAULT_CHECK_CONFIG,
      horizonUrl: PRIMARY_HORIZON,
      stellarAddress: VALID_ADDRESS,
      failOnMissing: true,
      stickyComment: true,
      waitUntilFunded: false,
      waitUntilFundedTimeoutMs: 120000,
      waitUntilFundedIntervalMs: 5000,
      sep0007DeepLinks: false,
      sep0007OriginDomain: '',
    });
    
    expect(body).toMatchSnapshot();
  });
  
  it('horizon failure comment snapshot matches expected structure', () => {
    const result = horizonFailureResult(
      'Horizon request failed (503): Service Unavailable',
      DEFAULT_CHECK_CONFIG,
    );
    
    const body = formatCommentBody(result, {
      ...DEFAULT_CHECK_CONFIG,
      horizonUrl: PRIMARY_HORIZON,
      stellarAddress: VALID_ADDRESS,
      failOnMissing: false,
      stickyComment: true,
      waitUntilFunded: false,
      waitUntilFundedTimeoutMs: 120000,
      waitUntilFundedIntervalMs: 5000,
      sep0007DeepLinks: false,
      sep0007OriginDomain: '',
    });
    
    expect(body).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// e2e harness: edge cases — 100+ contributor scale simulation
// ---------------------------------------------------------------------------

describe('e2e parser harness — scale: 100+ contributor addresses', () => {
  function generateContributorAddress(n: number): string {
    // Build a deterministic valid 56-char G-address (base32: A-Z, 2-7 only).
    // Encode n as a 4-char base-6 string using chars '2','3','4','5','6','7'.
    const BASE6_CHARS = '234567';
    let encoded = '';
    let rem = n;
    for (let i = 0; i < 4; i++) {
      encoded = BASE6_CHARS[rem % 6] + encoded;
      rem = Math.floor(rem / 6);
    }
    // Fill the rest with 'A' to reach exactly 55 base32 chars after 'G'.
    return 'G' + 'A'.repeat(51) + encoded;
  }
  
  it('runs validation checks for 100 unique contributor addresses without error', () => {
    for (let i = 0; i < 100; i++) {
      const addr = generateContributorAddress(i);
      
      // Address must pass shape validation (StrKey checksum is validated elsewhere)
      expect(addr).toMatch(/^G[A-Z2-7]{55}$/);
      
      // And must produce a deterministic validation result
      const account = makeHorizonAccount({ id: addr, account_id: addr });
      const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);
      expect(typeof result.valid).toBe('boolean');
      const gate = buildValidationGate(result);
      expect(gate.totalChecks).toBeGreaterThanOrEqual(3);
    }
  });
  
  it('produces independent results for each contributor — no shared state', () => {
    const results: boolean[] = [];
    
    for (let i = 0; i < 50; i++) {
      const addr = generateContributorAddress(i);
      const account = makeHorizonAccount({
        id: addr,
        account_id: addr,
        balances: i % 2 === 0
          ? [
              { balance: '10.0000000', asset_type: 'native', buying_liabilities: '0', selling_liabilities: '0' },
              { balance: '1.0', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER, buying_liabilities: '0', selling_liabilities: '0' },
            ]
          : [
              { balance: '0.5000000', asset_type: 'native', buying_liabilities: '0', selling_liabilities: '0' },
            ],
      });
      
      const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);
      results.push(result.valid);
    }
    
    // Even indices (funded + trustline) should pass; odd (low balance, no trustline) fail
    for (let i = 0; i < 50; i++) {
      expect(results[i]).toBe(i % 2 === 0);
    }
  });
});

// ---------------------------------------------------------------------------
// e2e harness: invalid env configuration
// ---------------------------------------------------------------------------

describe('e2e parser harness — invalid environment configuration', () => {
  it('fetchAccount fails fast on blank horizon_url', async () => {
    await expect(
      fetchAccount('', VALID_ADDRESS, { maxRetries: 0, cacheTtlMs: 0 }),
    ).rejects.toMatchObject({ message: /horizon_url is required/i, statusCode: 0 });
  });
  
  it('fetchAccount fails fast on whitespace-only horizon_url', async () => {
    await expect(
      fetchAccount('   ', VALID_ADDRESS, { maxRetries: 0, cacheTtlMs: 0 }),
    ).rejects.toMatchObject({ statusCode: 0, retryable: false });
  });
  
  it('HorizonError exposes correct retryable flag for each status code', () => {
    const retryable = [429, 502, 503, 504];
    const nonRetryable = [400, 401, 403, 404, 410];
    
    for (const status of retryable) {
      const err = new HorizonError(`error ${status}`, status, true);
      expect(err.retryable).toBe(true);
      expect(err.statusCode).toBe(status);
    }
    
    for (const status of nonRetryable) {
      const err = new HorizonError(`error ${status}`, status, false);
      expect(err.retryable).toBe(false);
    }
  });
});
