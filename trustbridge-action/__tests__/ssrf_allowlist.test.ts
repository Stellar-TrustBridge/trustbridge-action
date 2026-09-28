import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isAllowedUrl, assertAllowedUrl, SsrfError } from '../src/ssrf';
import { resolveFederationTarget } from '../src/federation';

/**
 * Regression tests for SSRF enforcement in federation resolution.
 *
 * ssrf.ts is the single enforcement point for host/scheme allowlisting;
 * federation.ts must delegate to it rather than re-implementing checks.
 */

describe('ssrf allowlist: blocked hosts and schemes', () => {
  const blockedUrls = [
    // loopback
    'http://127.0.0.1/fed',
    'http://localhost/fed',
    'http://[::1]/fed',
    // link-local (IPv4 + IPv6)
    'http://169.254.169.254/latest/meta-data/',
    'http://169.254.0.1/fed',
    'http://[fe80::1]/fed',
    // private ranges
    'http://10.0.0.1/fed',
    'http://192.168.1.1/fed',
    'http://172.16.0.1/fed',
    // bad schemes
    'file:///etc/passwd',
    'gopher://example.com/fed',
    'ftp://example.com/fed',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
  ];

  it.each(blockedUrls)('rejects blocked target %s', (url) => {
    expect(isAllowedUrl(url)).toBe(false);
    expect(() => assertAllowedUrl(url)).toThrow(SsrfError);
  });

  it('rejects malformed URLs', () => {
    expect(isAllowedUrl('not a url')).toBe(false);
    expect(isAllowedUrl('')).toBe(false);
  });
});

describe('ssrf allowlist: allowlisted resolutions succeed', () => {
  const allowedUrls = [
    'https://federation.example.com/actor',
    'https://trustbridge.dev/.well-known/webfinger',
    'https://sub.example.org/fed/inbox',
  ];

  it.each(allowedUrls)('allows allowlisted target %s', (url) => {
    expect(isAllowedUrl(url)).toBe(true);
    expect(() => assertAllowedUrl(url)).not.toThrow();
  });
});

describe('federation resolution enforces ssrf allowlist', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects blocked hosts before any network call', async () => {
    await expect(resolveFederationTarget('http://169.254.169.254/fed')).rejects.toThrow(SsrfError);
    await expect(resolveFederationTarget('http://127.0.0.1/fed')).rejects.toThrow(SsrfError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects bad schemes before any network call', async () => {
    await expect(resolveFederationTarget('file:///etc/passwd')).rejects.toThrow(SsrfError);
    await expect(resolveFederationTarget('gopher://example.com/fed')).rejects.toThrow(SsrfError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves allowlisted targets via mocked fetch', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'https://federation.example.com/actor' }),
    });

    const result = await resolveFederationTarget('https://federation.example.com/actor');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://federation.example.com/actor',
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(result).toEqual({ id: 'https://federation.example.com/actor' });
  });
});
