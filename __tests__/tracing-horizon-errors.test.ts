/**
 * Issue #913 — span error recording for Horizon non-2xx responses without
 * payload bodies.
 *
 * Proves that:
 * 1. A successful fetch records no `horizon.http_error` span.
 * 2. A 400 whose problem document echoes the account id records an ERROR
 *    span with the fixed attribute set and no body text.
 * 3. A 404 records a status-only span (the HorizonError message embeds the
 *    account id; the span does not).
 * 4. Retried 503 attempts each record a span, flagged retryable.
 * 5. Generic wrappers (`withHorizonSpan`, `withSpan`) never copy a Horizon
 *    error message (which embeds the body detail) into the span.
 * 6. Tracing disabled → zero spans.
 *
 * Validate with: npm test -- --testPathPattern tracing-horizon-errors
 */

import type { Response } from 'node-fetch';
import { fetchAccount, HorizonError } from '../src/horizon';
import {
  clearTraceSpans,
  getTraceSpans,
  HORIZON_HTTP_ERROR_SPAN_ATTRIBUTES,
  HORIZON_HTTP_ERROR_SPAN_NAME,
  horizonStatusClass,
  recordHorizonHttpError,
  safeSpanErrorMessage,
  withHorizonSpan,
  withSpan,
} from '../src/tracing';

const ADDRESS = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const HORIZON = 'https://horizon-testnet.stellar.org';
const SECRET_DETAIL = `Account ${ADDRESS} has balance 1234.5678 and signer GBSECRET`;

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

function mockFetch(...responses: Array<[number, unknown]>) {
  let call = 0;
  return jest.fn(async () => {
    const [status, body] = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return mockResponse(status, body);
  });
}

function errorSpans() {
  return getTraceSpans().filter((s) => s.name === HORIZON_HTTP_ERROR_SPAN_NAME);
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  clearTraceSpans();
  process.env['OTEL_TRACES_ENABLED'] = 'true';
  process.env['OTEL_TRACES_EXPORTER'] = 'none';
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('fetchAccount → horizon.http_error spans', () => {
  it('happy path: a 200 records no error span', async () => {
    const fetchFn = mockFetch([200, { account_id: ADDRESS, balances: [], subentry_count: 0 }]);
    await fetchAccount(HORIZON, ADDRESS, { maxRetries: 0, cacheTtlMs: 0, fetchFn });
    expect(errorSpans()).toHaveLength(0);
  });

  it('400 with a body that echoes account data records only the fixed attribute set', async () => {
    const fetchFn = mockFetch([400, { type: 'bad_request', title: 'Bad Request', status: 400, detail: SECRET_DETAIL }]);
    await expect(
      fetchAccount(HORIZON, ADDRESS, { maxRetries: 0, cacheTtlMs: 0, fetchFn }),
    ).rejects.toMatchObject({ statusCode: 400 });

    const spans = errorSpans();
    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span.status).toBe('ERROR');
    expect(span.error).toBe('Horizon request failed (400)');
    expect(Object.keys(span.attributes).sort()).toEqual([...HORIZON_HTTP_ERROR_SPAN_ATTRIBUTES].sort());
    expect(span.attributes).toMatchObject({
      'http.response.status_code': 400,
      'horizon.status_class': '4xx',
      'horizon.retryable': false,
      'horizon.endpoint_kind': 'primary',
      'horizon.attempt': 0,
      'error.type': 'HorizonError',
    });

    const serialized = JSON.stringify(span);
    expect(serialized).not.toContain(ADDRESS);
    expect(serialized).not.toContain('1234.5678');
    expect(serialized).not.toContain('GBSECRET');
    expect(serialized).not.toContain('Bad Request');
  });

  it('404 records a status-only span without the account id', async () => {
    const fetchFn = mockFetch([404, { status: 404, detail: SECRET_DETAIL }]);
    await expect(
      fetchAccount(HORIZON, ADDRESS, { maxRetries: 0, cacheTtlMs: 0, fetchFn }),
    ).rejects.toMatchObject({ statusCode: 404 });

    const spans = errorSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].error).toBe('Horizon request failed (404)');
    expect(spans[0].attributes['http.response.status_code']).toBe(404);
    expect(JSON.stringify(spans[0])).not.toContain(ADDRESS);
  });

  it('each retried 503 attempt records a retryable 5xx span', async () => {
    const fetchFn = mockFetch([503, { detail: SECRET_DETAIL }], [503, { detail: SECRET_DETAIL }]);
    await expect(
      fetchAccount(HORIZON, ADDRESS, {
        maxRetries: 1,
        retryBaseDelayMs: 0,
        cacheTtlMs: 0,
        fetchFn,
      }),
    ).rejects.toMatchObject({ statusCode: 503 });

    const spans = errorSpans();
    expect(spans).toHaveLength(2);
    expect(spans.map((s) => s.attributes['horizon.attempt'])).toEqual([0, 1]);
    for (const span of spans) {
      expect(span.attributes['horizon.retryable']).toBe(true);
      expect(span.attributes['horizon.status_class']).toBe('5xx');
      expect(JSON.stringify(span)).not.toContain('1234.5678');
    }
  });

  it('records nothing when tracing is disabled', async () => {
    delete process.env['OTEL_TRACES_ENABLED'];
    const fetchFn = mockFetch([400, { detail: SECRET_DETAIL }]);
    await expect(
      fetchAccount(HORIZON, ADDRESS, { maxRetries: 0, cacheTtlMs: 0, fetchFn }),
    ).rejects.toBeInstanceOf(Error);
    expect(getTraceSpans()).toHaveLength(0);
  });
});

describe('generic span wrappers never copy Horizon bodies', () => {
  it('withHorizonSpan records status attributes and a status-only message', async () => {
    const err = new HorizonError(`Horizon request failed (400): ${SECRET_DETAIL}`, 400, false);
    await expect(
      withHorizonSpan({ horizonUrl: HORIZON, accountId: ADDRESS }, async () => { throw err; }),
    ).rejects.toBe(err);

    const [span] = getTraceSpans();
    expect(span.status).toBe('ERROR');
    expect(span.error).toBe('Horizon request failed (400)');
    expect(span.attributes).toMatchObject({
      'error.type': 'HorizonError',
      'http.response.status_code': 400,
      'horizon.status_class': '4xx',
      'horizon.retryable': false,
    });
    expect(JSON.stringify(span)).not.toContain('1234.5678');
    expect(JSON.stringify(span)).not.toContain(ADDRESS);
  });

  it('withSpan masks addresses in non-HTTP error messages', async () => {
    await expect(
      withSpan({ name: 'test.op' }, async () => { throw new Error(`timeout fetching ${ADDRESS}`); }),
    ).rejects.toThrow();
    const [span] = getTraceSpans();
    expect(span.error).toContain('timeout fetching');
    expect(span.error).not.toContain(ADDRESS);
  });
});

describe('helpers', () => {
  it.each([
    [400, '4xx'],
    [429, '4xx'],
    [503, '5xx'],
    [0, 'transport'],
    [408, 'transport'],
    [302, 'other'],
  ] as const)('horizonStatusClass(%d) → %s', (status, expected) => {
    expect(horizonStatusClass(status)).toBe(expected);
  });

  it('safeSpanErrorMessage keeps plain messages', () => {
    expect(safeSpanErrorMessage(new Error('network down'))).toBe('network down');
  });

  it('recordHorizonHttpError never throws on odd input', () => {
    expect(() =>
      recordHorizonHttpError({
        horizonUrl: `${HORIZON}/accounts/${ADDRESS}`,
        statusCode: 500,
        retryable: true,
        endpointKind: 'fallback',
        attempt: 2,
        latencyMs: Number.NaN,
      }),
    ).not.toThrow();
    const [span] = getTraceSpans();
    expect(String(span.attributes['horizon.url'])).not.toContain(ADDRESS);
  });
});
