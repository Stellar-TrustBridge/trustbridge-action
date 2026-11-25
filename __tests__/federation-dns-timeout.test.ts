/**
 * Tests for Issue #906 — federation DNS timeout separate from HTTP timeout.
 *
 * Covers:
 * - Happy path: defaults apply, the DNS answer is pinned into fetchSSRFSafe,
 *   and the HTTP timeout is passed through independently.
 * - Failure path: a hung resolver fails with TOML_DNS_TIMEOUT within the DNS
 *   budget and never reaches the HTTP fetch.
 * - Failure path: an HTTP timeout surfaces as FEDERATION_TIMEOUT (not a DNS
 *   code), so one knob cannot starve or mask the other.
 * - Failure path: NXDOMAIN at the federation stage → FEDERATION_NXDOMAIN.
 * - Malformed timeout values fall back to the documented defaults.
 */

jest.mock('../src/ssrf', () => ({
  fetchSSRFSafe: jest.fn(),
  defaultSSRFDnsLookup: jest.fn().mockResolvedValue(['93.184.216.34']),
}));

import {
  FEDERATION_DNS_TIMEOUT_MS,
  FEDERATION_HTTP_TIMEOUT_MS,
  FEDERATION_MAX_TIMEOUT_MS,
  resolveFederationAddress,
  resolveFederationTimeouts,
  resolveHostWithTimeout,
} from '../src/federation';
import { logger } from '../src/logger';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { fetchSSRFSafe } = require('../src/ssrf') as { fetchSSRFSafe: jest.Mock };
const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

const VALID_G_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const TOML = `
[[FEDERATION_SERVER]]
forward_url = "https://federation.example.com/federation"
`;

function loggedCodes(): string[] {
  return warnSpy.mock.calls.map((c) => (c[1] as { code?: string } | undefined)?.code ?? '');
}

beforeEach(() => {
  fetchSSRFSafe.mockReset();
  warnSpy.mockClear();
});

describe('resolveFederationTimeouts', () => {
  it('uses independent documented defaults', () => {
    expect(resolveFederationTimeouts()).toEqual({
      dnsTimeoutMs: FEDERATION_DNS_TIMEOUT_MS,
      httpTimeoutMs: FEDERATION_HTTP_TIMEOUT_MS,
    });
    expect(FEDERATION_DNS_TIMEOUT_MS).toBe(5_000);
    expect(FEDERATION_HTTP_TIMEOUT_MS).toBe(10_000);
  });

  it('accepts each knob independently', () => {
    expect(resolveFederationTimeouts({ dnsTimeoutMs: 250 })).toEqual({
      dnsTimeoutMs: 250,
      httpTimeoutMs: FEDERATION_HTTP_TIMEOUT_MS,
    });
    expect(resolveFederationTimeouts({ httpTimeoutMs: 3000 })).toEqual({
      dnsTimeoutMs: FEDERATION_DNS_TIMEOUT_MS,
      httpTimeoutMs: 3000,
    });
  });

  it('falls back to defaults for malformed values with an INVALID_TIMEOUT warning', () => {
    const t = resolveFederationTimeouts({
      dnsTimeoutMs: -1,
      httpTimeoutMs: FEDERATION_MAX_TIMEOUT_MS + 1,
    });
    expect(t).toEqual({ dnsTimeoutMs: FEDERATION_DNS_TIMEOUT_MS, httpTimeoutMs: FEDERATION_HTTP_TIMEOUT_MS });
    expect(resolveFederationTimeouts({ dnsTimeoutMs: Number.NaN }).dnsTimeoutMs).toBe(FEDERATION_DNS_TIMEOUT_MS);
    expect(loggedCodes()).toContain('INVALID_TIMEOUT');
  });
});

describe('resolveHostWithTimeout', () => {
  it('returns the resolved addresses', async () => {
    const r = await resolveHostWithTimeout('example.com', 100, async () => ['1.1.1.1']);
    expect(r).toMatchObject({ ok: true, addresses: ['1.1.1.1'] });
  });

  it('reports a hung resolver as timeout', async () => {
    const r = await resolveHostWithTimeout('example.com', 20, () => new Promise<string[]>(() => undefined));
    expect(r).toMatchObject({ ok: false, kind: 'timeout' });
  });

  it('reports resolver errors and empty answers as nxdomain', async () => {
    const err = await resolveHostWithTimeout('nope.invalid', 100, async () => {
      throw new Error('getaddrinfo ENOTFOUND nope.invalid');
    });
    expect(err).toMatchObject({ ok: false, kind: 'nxdomain' });
    const empty = await resolveHostWithTimeout('empty.example', 100, async () => []);
    expect(empty).toMatchObject({ ok: false, kind: 'nxdomain' });
  });
});

describe('resolveFederationAddress with separate DNS / HTTP timeouts', () => {
  it('happy path: pins the DNS answer and passes the HTTP timeout to each fetch', async () => {
    const dnsLookup = jest.fn().mockResolvedValue(['93.184.216.34']);
    fetchSSRFSafe
      .mockResolvedValueOnce({ ok: true, text: jest.fn().mockResolvedValue(TOML) })
      .mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValue(JSON.stringify({ account_id: VALID_G_ADDRESS })),
      });

    const result = await resolveFederationAddress('alice*example.com', {
      dnsTimeoutMs: 1000,
      httpTimeoutMs: 4321,
      dnsLookup,
    });

    expect(result).toEqual({ gAddress: VALID_G_ADDRESS, memoRequired: false });
    expect(dnsLookup).toHaveBeenCalledWith('example.com');
    expect(dnsLookup).toHaveBeenCalledWith('federation.example.com');
    expect(fetchSSRFSafe).toHaveBeenCalledTimes(2);
    for (const call of fetchSSRFSafe.mock.calls) {
      const opts = call[1] as { timeoutMs: number; dnsLookup: (h: string) => Promise<string[]> };
      expect(opts.timeoutMs).toBe(4321);
      await expect(opts.dnsLookup('ignored')).resolves.toEqual(['93.184.216.34']);
    }
  });

  it('failure path: DNS timeout fails fast with TOML_DNS_TIMEOUT and skips the HTTP fetch', async () => {
    const start = Date.now();
    const result = await resolveFederationAddress('alice*example.com', {
      dnsTimeoutMs: 30,
      httpTimeoutMs: 10_000,
      dnsLookup: () => new Promise<string[]>(() => undefined),
    });
    expect(result).toBeNull();
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(fetchSSRFSafe).not.toHaveBeenCalled();
    expect(loggedCodes()).toContain('TOML_DNS_TIMEOUT');
  });

  it('failure path: HTTP timeout surfaces as FEDERATION_TIMEOUT, not a DNS code', async () => {
    fetchSSRFSafe
      .mockResolvedValueOnce({ ok: true, text: jest.fn().mockResolvedValue(TOML) })
      .mockResolvedValueOnce({ ok: false, error: 'Request timed out' });

    const result = await resolveFederationAddress('alice*example.com', {
      dnsTimeoutMs: 1000,
      httpTimeoutMs: 50,
      dnsLookup: async () => ['93.184.216.34'],
    });
    expect(result).toBeNull();
    const codes = loggedCodes();
    expect(codes).toContain('FEDERATION_TIMEOUT');
    expect(codes).not.toContain('FEDERATION_DNS_TIMEOUT');
    expect(codes).not.toContain('TOML_DNS_TIMEOUT');
  });

  it('failure path: federation host NXDOMAIN → FEDERATION_NXDOMAIN', async () => {
    fetchSSRFSafe.mockResolvedValueOnce({ ok: true, text: jest.fn().mockResolvedValue(TOML) });
    const dnsLookup = jest.fn(async (host: string) => {
      if (host === 'federation.example.com') throw new Error('getaddrinfo ENOTFOUND');
      return ['93.184.216.34'];
    });

    const result = await resolveFederationAddress('alice*example.com', { dnsLookup });
    expect(result).toBeNull();
    expect(fetchSSRFSafe).toHaveBeenCalledTimes(1);
    expect(loggedCodes()).toContain('FEDERATION_NXDOMAIN');
  });
});
