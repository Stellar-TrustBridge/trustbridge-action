// @ts-nocheck — pre-existing missing-await patterns; tracked in issue #293 for future cleanup
/**
 * Wave #20 — Document Horizon SSRF allowlist in Release/CI
 *
 * This test file serves as the executable specification of TrustBridge's
 * Horizon SSRF block-list. It:
 *
 *   1. Asserts that every documented blocked category rejects the right URLs
 *   2. Asserts that legitimate public Horizon and RPC URLs are accepted
 *   3. Asserts that the exported `SSRF_BLOCKED_PATTERNS` list is non-empty
 *      so a future refactor cannot accidentally clear the list
 *   4. Covers edge cases: auth credentials in URLs, non-standard ports,
 *      IPv6, cloud-metadata variants
 *
 * The CI workflow runs this suite in the `ssrf-audit` step so any regression
 * that weakens the block-list will break the build before a release is cut.
 */

import {
  SSRF_BLOCKED_PATTERNS,
  validateSsrfSafeUrl,
  validateHorizonUrl,
} from '../src/validation';
import {
  fetchSSRFSafe,
  checkResolvedAddresses,
  isSSRFBlocked,
  validateSSRFSafeUrl,
} from '../src/ssrf';
import { fetchTomlWithCache } from '../src/toml';
import { defaultCache } from '../src/cache';

// ---------------------------------------------------------------------------
// Block-list structural integrity
// ---------------------------------------------------------------------------

describe('SSRF_BLOCKED_PATTERNS structural integrity (Wave #20)', () => {
  it('exports a non-empty patterns list', () => {
    expect(SSRF_BLOCKED_PATTERNS.length).toBeGreaterThan(0);
  });

  it('covers at least 10 distinct blocked categories', () => {
    // Documented categories: loopback, link-local, class-A/B/C private,
    // IPv6 loopback/link-local, localhost, AWS metadata, GCP metadata, file://
    expect(SSRF_BLOCKED_PATTERNS.length).toBeGreaterThanOrEqual(10);
  });

  it('all entries are RegExp instances', () => {
    for (const pattern of SSRF_BLOCKED_PATTERNS) {
      expect(pattern).toBeInstanceOf(RegExp);
    }
  });
});

// ---------------------------------------------------------------------------
// Blocked URLs (must all fail validation)
// ---------------------------------------------------------------------------

describe('validateSsrfSafeUrl — blocked addresses (Wave #20)', () => {
  const blocked = [
    // IPv4 loopback
    ['http://127.0.0.1/accounts', 'IPv4 loopback 127.0.0.1'],
    ['https://127.0.0.1:8000/accounts', 'IPv4 loopback with port'],
    ['http://127.1.2.3/test', 'IPv4 loopback range 127.x'],
    // IPv4 link-local / AWS metadata
    ['http://169.254.0.1/test', 'IPv4 link-local'],
    ['http://169.254.169.254/latest/meta-data/', 'AWS instance metadata endpoint'],
    ['https://169.254.169.254/latest/meta-data/', 'AWS metadata over HTTPS'],
    // IPv4 private class-A
    ['http://10.0.0.1/horizon', 'private class-A 10.x'],
    ['https://10.255.255.255/accounts', 'private class-A upper bound'],
    // IPv4 private class-B
    ['http://172.16.0.1/horizon', 'private class-B lower bound (172.16)'],
    ['http://172.31.255.255/horizon', 'private class-B upper bound (172.31)'],
    // IPv4 private class-C
    ['http://192.168.1.1/horizon', 'private class-C'],
    ['https://192.168.0.100/accounts', 'private class-C over HTTPS'],
    // IPv6 loopback
    ['http://[::1]/accounts', 'IPv6 loopback [::1]'],
    ['https://[::1]:8080/accounts', 'IPv6 loopback with port'],
    // IPv6 link-local
    ['http://[fe80::1]/accounts', 'IPv6 link-local'],
    ['http://[FE80::1]/test', 'IPv6 link-local uppercase'],
    // localhost
    ['http://localhost/horizon', 'bare localhost http'],
    ['https://localhost/horizon', 'bare localhost https'],
    ['http://localhost:8000/horizon', 'localhost with port'],
    // GCP metadata
    ['http://metadata.google.internal/computeMetadata/v1/', 'GCP metadata endpoint'],
    ['https://metadata.google.internal/', 'GCP metadata over HTTPS'],
    // file protocol
    ['file:///etc/passwd', 'file:// protocol'],
    ['file://localhost/etc/hosts', 'file:// with localhost'],
  ];

  it.each(blocked)('blocks %s (%s)', (url) => {
    const result = validateSsrfSafeUrl(url, 'horizon_url', { allowHttp: true });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Allowed URLs (must all pass validation)
// ---------------------------------------------------------------------------

describe('validateSsrfSafeUrl — allowed public URLs (Wave #20)', () => {
  const allowed = [
    ['https://horizon.stellar.org', 'mainnet Horizon'],
    ['https://horizon-testnet.stellar.org', 'testnet Horizon'],
    ['https://horizon-futurenet.stellar.org', 'futurenet Horizon'],
    ['http://horizon-testnet.stellar.org', 'testnet Horizon over http (allowHttp: true)'],
    ['https://soroban-testnet.stellar.org', 'Soroban testnet RPC'],
    ['https://horizon.example.com', 'custom public Horizon'],
    ['https://rpc.example.org:8080/soroban', 'custom RPC with port'],
    ['https://1.2.3.4/horizon', 'public IP (not in any private range)'],
  ];

  it.each(allowed)('allows %s (%s)', (url) => {
    const result = validateSsrfSafeUrl(url, 'horizon_url', { allowHttp: true });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validateHorizonUrl convenience wrapper (Wave #20)
// ---------------------------------------------------------------------------

describe('validateHorizonUrl (Wave #20)', () => {
  it('rejects loopback URLs', () => {
    const r = validateHorizonUrl('http://127.0.0.1/horizon');
    expect(r.valid).toBe(false);
  });

  it('rejects AWS metadata URL', () => {
    const r = validateHorizonUrl('http://169.254.169.254/latest/meta-data/');
    expect(r.valid).toBe(false);
  });

  it('accepts mainnet Horizon', () => {
    const r = validateHorizonUrl('https://horizon.stellar.org');
    expect(r.valid).toBe(true);
  });

  it('accepts testnet Horizon over http', () => {
    const r = validateHorizonUrl('http://horizon-testnet.stellar.org');
    expect(r.valid).toBe(true);
  });

  it('rejects empty URL', () => {
    const r = validateHorizonUrl('');
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/cannot be empty/i);
  });

  it('rejects malformed URL', () => {
    const r = validateHorizonUrl('not-a-url');
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/not a valid URL/i);
  });

  it('rejects file:// protocol', () => {
    const r = validateHorizonUrl('file:///etc/passwd');
    expect(r.valid).toBe(false);
  });

  it('uses default fieldName horizon_url in error messages', () => {
    const r = validateHorizonUrl('');
    expect(r.errors[0]).toContain('horizon_url');
  });

  it('uses provided fieldName in error messages', () => {
    const r = validateHorizonUrl('', 'rpc_fallback_url');
    expect(r.errors[0]).toContain('rpc_fallback_url');
  });
});

// ---------------------------------------------------------------------------
// Edge cases: credentials in URL, unusual ports, encoding attempts
// ---------------------------------------------------------------------------

describe('SSRF edge cases (Wave #20)', () => {
  it('blocks URL with credentials that resolve to a private IP', () => {
    const r = validateSsrfSafeUrl('http://user:pass@192.168.1.1/horizon', 'horizon_url', { allowHttp: true });
    expect(r.valid).toBe(false);
  });

  it('blocks localhost with non-standard port', () => {
    const r = validateSsrfSafeUrl('http://localhost:9999/horizon', 'horizon_url', { allowHttp: true });
    expect(r.valid).toBe(false);
  });

  it('blocks http when allowHttp is false (https-only mode)', () => {
    const r = validateSsrfSafeUrl('http://horizon-testnet.stellar.org', 'horizon_url', { allowHttp: false });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/https/i);
  });

  it('accepts https when allowHttp is false', () => {
    const r = validateSsrfSafeUrl('https://horizon-testnet.stellar.org', 'horizon_url', { allowHttp: false });
    expect(r.valid).toBe(true);
  });

  it('blocks 10.x class-A at all sub-ranges', () => {
    for (const sub of ['0.0.1', '1.1.1', '128.0.0', '255.255.255']) {
      const r = validateSsrfSafeUrl(`http://10.${sub}/horizon`, 'horizon_url', { allowHttp: true });
      expect(r.valid).toBe(false);
    }
  });

  it('blocks 172.16–172.31 range but not 172.32 and above', () => {
    for (let n = 16; n <= 31; n++) {
      const r = validateSsrfSafeUrl(`http://172.${n}.0.1/horizon`, 'horizon_url', { allowHttp: true });
      expect(r.valid).toBe(false);
    }
    // 172.32.x is public
    const allowed = validateSsrfSafeUrl('http://172.32.0.1/horizon', 'horizon_url', { allowHttp: true });
    expect(allowed.valid).toBe(true);
  });

  it('blocks IPv6 loopback in both bracket forms', () => {
    expect(validateSsrfSafeUrl('http://[::1]/horizon', 'horizon_url', { allowHttp: true }).valid).toBe(false);
    expect(validateSsrfSafeUrl('https://[::1]:443/horizon', 'horizon_url', { allowHttp: true }).valid).toBe(false);
  });

  it('blocks 172.15 (not in private range) — wait this should be allowed', () => {
    // 172.15.x is public — only 172.16–172.31 are private
    const r = validateSsrfSafeUrl('http://172.15.0.1/horizon', 'horizon_url', { allowHttp: true });
    expect(r.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CI audit: SSRF_BLOCKED_PATTERNS covers every documented category
// ---------------------------------------------------------------------------

describe('SSRF allowlist completeness audit — CI gate (Wave #20)', () => {
  /**
   * Each entry is [description, url_that_should_be_blocked].
   * This table is the authoritative list maintained alongside release notes.
   * A CI failure here means the block-list no longer covers a documented threat.
   */
  const auditTable: [string, string][] = [
    ['IPv4 loopback', 'http://127.0.0.1/'],
    ['IPv4 link-local', 'http://169.254.1.1/'],
    ['AWS metadata', 'http://169.254.169.254/'],
    ['GCP metadata', 'http://metadata.google.internal/'],
    ['private class-A', 'http://10.0.0.1/'],
    ['private class-B', 'http://172.20.0.1/'],
    ['private class-C', 'http://192.168.0.1/'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['IPv6 link-local', 'http://[fe80::1]/'],
    ['localhost', 'http://localhost/'],
    ['file protocol', 'file:///etc/passwd'],
  ];

  it.each(auditTable)('blocks documented threat: %s', (_desc, url) => {
    const r = validateSsrfSafeUrl(url, 'horizon_url', { allowHttp: true });
    expect(r.valid).toBe(false);
  });
});

describe('fetchSSRFSafe redirect enforcement', () => {
  const makeResponse = (status: number, headers: Record<string, string>, body = '') => ({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    text: async () => body,
  } as any);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects redirect loops once the redirect cap is reached', async () => {
    const sequence = [
      makeResponse(302, { location: 'https://example.com/second' }),
      makeResponse(302, { location: 'https://example.com/third' }),
      makeResponse(302, { location: 'https://example.com/second' }),
    ];

    jest.spyOn(global, 'fetch').mockImplementation(async () => sequence.shift() ?? makeResponse(200, {}, 'done'));

    const result = await fetchSSRFSafe('https://example.com/first', {
      followRedirects: true,
      maxRedirects: 2,
    });

    if (!result.ok) {
      expect(result.error).toMatch(/redirect|limit|loop/i);
      return;
    }

    throw new Error('Expected fetchSSRFSafe to reject redirect loops');
  });

  it('rejects protocol downgrade redirects', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      makeResponse(302, { location: 'http://example.com/next' }),
    );

    const result = await fetchSSRFSafe('https://example.com/start', {
      followRedirects: true,
    });

    if (!result.ok) {
      expect(result.error).toMatch(/downgrade|https/i);
      return;
    }

    throw new Error('Expected fetchSSRFSafe to reject protocol downgrade redirects');
  });

  it('rejects redirect hops that resolve to a blocked SSRF target', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      makeResponse(302, { location: 'https://169.254.169.254/latest/meta-data/' }),
    );

    const result = await fetchSSRFSafe('https://example.com/start', {
      followRedirects: true,
    });

    if (!result.ok) {
      expect(result.error).toMatch(/unsafe redirect|blocked|SSRF/i);
      return;
    }

    throw new Error('Expected fetchSSRFSafe to reject SSRF redirect hops');
  });
});

// ---------------------------------------------------------------------------
// IPv6 Horizon endpoint fixtures (Issue #302)
// ---------------------------------------------------------------------------

describe('IPv6 Horizon endpoint fixtures (Issue #302)', () => {
  // Test IPv6 loopback variants are blocked
  const blockedIPv6: [string, string][] = [
    ['http://[::1]/accounts', 'IPv6 loopback bracket notation'],
    ['https://[::1]:8080/accounts', 'IPv6 loopback with port'],
    // IPv4-mapped IPv6
    ['http://[::ffff:127.0.0.1]/accounts', 'IPv4-mapped IPv6 loopback'],
    ['http://[::ffff:192.168.1.1]/accounts', 'IPv4-mapped IPv6 class-C'],
    ['http://[::ffff:10.0.0.1]/accounts', 'IPv4-mapped IPv6 class-A'],
    ['http://[::ffff:169.254.169.254]/accounts', 'IPv4-mapped IPv6 AWS metadata'],
    ['http://[::ffff:172.16.0.1]/accounts', 'IPv4-mapped IPv6 class-B'],
    // IPv6 link-local
    ['http://[fe80::1]/accounts', 'IPv6 link-local'],
    ['http://[FE80::1]/accounts', 'IPv6 link-local uppercase'],
    // IPv6 ULA
    ['http://[fc00::1]/accounts', 'IPv6 ULA fc00'],
    ['http://[fd12:3456::1]/accounts', 'IPv6 ULA fd prefix'],
  ];

  it.each(blockedIPv6)('blocks %s (%s)', (url) => {
    const result = validateSsrfSafeUrl(url, 'horizon_url', { allowHttp: true });
    expect(result.valid).toBe(false);
  });

  // Test that public IPv6 URLs are not blocked by SSRF patterns
  // (structural test — we verify they don't match any blocked pattern)
  const allowedIPv6 = [
    'https://[2001:db8::1]/accounts', // Documentation range (public)
    'https://[2606:4700:4700::1111]/dns', // Cloudflare DNS (public IPv6)
  ];

  it.each(allowedIPv6)('allows public IPv6 %s', (url) => {
    const result = validateSsrfSafeUrl(url, 'horizon_url', { allowHttp: true });
    // Should not be blocked by SSRF patterns
    const ssrfBlocked = result.errors.some((e) => e.includes('blocked address'));
    expect(ssrfBlocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Issue #702 — private IPs over https, DNS rebinding, shared toml gate
// ---------------------------------------------------------------------------

describe('Issue #702: private and link-local hosts are rejected even over https', () => {
  const httpsPrivate = [
    'https://10.0.0.1/',
    'https://172.16.0.1/',
    'https://192.168.1.1/',
    'https://169.254.169.254/latest/meta-data/',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://[fe80::1]/',
    'https://[fd00::1]/',
    'https://0.0.0.0/',
    'https://100.100.100.200/',
  ];

  it.each(httpsPrivate)('validateSsrfSafeUrl (https-only) rejects %s', (url) => {
    const r = validateSsrfSafeUrl(url, 'horizon_url', { allowHttp: false });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/blocked address/);
  });

  it.each(httpsPrivate)('fetch gate validateSSRFSafeUrl rejects %s with actionable message', (url) => {
    const r = validateSSRFSafeUrl(url);
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.join(' ')).toMatch(/SSRF policy/);
      expect(r.errors.join(' ')).toMatch(/publicly resolvable/);
    }
  });

  it('userinfo cannot hide the real host (https://evil@127.0.0.1)', () => {
    expect(validateSsrfSafeUrl('https://evil@127.0.0.1/', 'horizon_url').valid).toBe(false);
    expect(validateSsrfSafeUrl('https://horizon.stellar.org@10.0.0.1/', 'horizon_url').valid).toBe(false);
    expect(validateSSRFSafeUrl('https://evil@127.0.0.1/').valid).toBe(false);
  });

  it('public stellar.org Horizon hosts remain allowed (regression)', () => {
    for (const url of [
      'https://horizon.stellar.org',
      'https://horizon-testnet.stellar.org',
      'https://horizon-futurenet.stellar.org',
    ]) {
      expect(validateSsrfSafeUrl(url, 'horizon_url').valid).toBe(true);
      expect(validateHorizonUrl(url).valid).toBe(true);
      expect(validateSSRFSafeUrl(url).valid).toBe(true);
    }
  });

  it('proxy environment variables do not disable SSRF checks (GHES)', () => {
    const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY };
    process.env.HTTPS_PROXY = 'http://proxy.corp.example:8080';
    process.env.NO_PROXY = '127.0.0.1,localhost,169.254.169.254';
    try {
      expect(validateSsrfSafeUrl('https://127.0.0.1/', 'horizon_url').valid).toBe(false);
      expect(validateSSRFSafeUrl('https://169.254.169.254/').valid).toBe(false);
      expect(isSSRFBlocked('localhost').blocked).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('Issue #702: DNS rebinding guard', () => {
  const makeResponse = (status: number, headers: Record<string, string>, body = '') => ({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    text: async () => body,
  } as any);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['127.0.0.1'],
    ['10.1.2.3'],
    ['169.254.169.254'],
    ['::1'],
    ['::ffff:192.168.0.1'],
    ['fd00::5'],
  ])('rejects a public-looking hostname that resolves to %s', async (address) => {
    const lookup = jest.fn().mockResolvedValue(['93.184.216.34', address]);
    const verdict = await checkResolvedAddresses('rebind.attacker.example', lookup);
    expect(verdict.blocked).toBe(true);
    if (verdict.blocked) {
      expect(verdict.reason).toMatch(/rebinding/);
    }
  });

  it('allows a hostname that resolves only to public addresses', async () => {
    const lookup = jest.fn().mockResolvedValue(['93.184.216.34', '2606:2800:220:1::1']);
    expect((await checkResolvedAddresses('horizon.stellar.org', lookup)).blocked).toBe(false);
  });

  it('skips DNS for IP literals (already checked statically)', async () => {
    const lookup = jest.fn();
    await checkResolvedAddresses('8.8.8.8', lookup);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('fetchSSRFSafe refuses to send the request when DNS resolves to a private IP', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(makeResponse(200, {}, 'secret'));
    const result = await fetchSSRFSafe('https://127.0.0.1.nip.io/.well-known/stellar.toml', {
      dnsLookup: async () => ['127.0.0.1'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/SSRF policy/);
      expect(result.error).toMatch(/rebinding/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('re-resolves each redirect hop (same-origin hop rebinding to metadata IP is refused)', async () => {
    const resolutions = [['93.184.216.34'], ['169.254.169.254']];
    const lookup = jest.fn(async () => resolutions.shift() ?? ['169.254.169.254']);
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(makeResponse(302, { location: 'https://flip.example.com/next' }));

    const result = await fetchSSRFSafe('https://flip.example.com/start', {
      followRedirects: true,
      dnsLookup: lookup,
    });

    expect(result.ok).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});

describe('Issue #702: stellar.toml fetch uses the same SSRF gate as horizon_url', () => {
  const makeResponse = (status: number, headers: Record<string, string>, body = '') => ({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    text: async () => body,
  } as any);

  beforeEach(async () => {
    await defaultCache.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['127.0.0.1'],
    ['2130706433'],
    ['localhost'],
    ['169.254.169.254'],
    ['metadata.google.internal'],
  ])('fetchTomlWithCache never fetches from blocked home domain %s', async (domain) => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const result = await fetchTomlWithCache(domain, { dnsLookup: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/SSRF/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses any redirect from stellar.toml (no redirect chain without explicit policy)', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(makeResponse(302, { location: 'https://example.com/other.toml' }));
    const result = await fetchTomlWithCache('example.com', { dnsLookup: async () => ['93.184.216.34'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/HTTP 302/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect to a disallowed host', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(makeResponse(301, { location: 'https://169.254.169.254/latest/meta-data/' }));
    const result = await fetchTomlWithCache('example.org', { dnsLookup: async () => ['93.184.216.34'] });
    expect(result.ok).toBe(false);
  });

  it('a horizon_url and a toml domain on the same private host are both rejected', () => {
    expect(validateHorizonUrl('https://192.168.10.5').valid).toBe(false);
    expect(validateSSRFSafeUrl('https://192.168.10.5/.well-known/stellar.toml').valid).toBe(false);
  });
});
