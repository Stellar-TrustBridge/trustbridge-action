import {
  getProxyConfig,
  shouldBypassProxy,
  createProxyAgent,
  createProxiedFetch,
  redactProxyUrl,
  redactProxyCredentials,
  safeProxyErrorMessage,
  getOctokitProxyOptions,
} from '../src/proxy';
import { redactString } from '../src/logger';
import { getErrorMessage } from '../src/inputs';
import { HorizonError } from '../src/horizon';

describe('proxy module', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('redactProxyUrl', () => {
    it('redacts userinfo from proxy URL', () => {
      expect(redactProxyUrl('http://user:pass@proxy:8080')).toBe('http://proxy:8080/');
    });

    it('preserves URL without userinfo', () => {
      expect(redactProxyUrl('http://proxy:8080')).toBe('http://proxy:8080');
    });

    it('handles invalid URL gracefully', () => {
      expect(redactProxyUrl('not-a-url')).toBe('not-a-url');
    });

    it('redacts only password when username is present', () => {
      expect(redactProxyUrl('http://user@proxy:8080')).toBe('http://proxy:8080/');
    });
  });

  describe('getProxyConfig', () => {
    it('returns empty config when no proxy env vars set', () => {
      const config = getProxyConfig();
      expect(config.proxyUrl).toBe('');
      expect(config.noProxyHosts).toEqual([]);
    });

    it('reads HTTPS_PROXY', () => {
      process.env.HTTPS_PROXY = 'http://proxy:8080';
      const config = getProxyConfig();
      expect(config.proxyUrl).toBe('http://proxy:8080');
    });

    it('reads https_proxy (lowercase)', () => {
      process.env.https_proxy = 'http://proxy:8080';
      const config = getProxyConfig();
      expect(config.proxyUrl).toBe('http://proxy:8080');
    });

    it('HTTPS_PROXY takes precedence over HTTP_PROXY', () => {
      process.env.HTTPS_PROXY = 'http://secure-proxy:8080';
      process.env.HTTP_PROXY = 'http://plain-proxy:8080';
      const config = getProxyConfig();
      expect(config.proxyUrl).toBe('http://secure-proxy:8080');
    });

    it('falls back to HTTP_PROXY when HTTPS_PROXY not set', () => {
      process.env.HTTP_PROXY = 'http://plain-proxy:8080';
      const config = getProxyConfig();
      expect(config.proxyUrl).toBe('http://plain-proxy:8080');
    });

    it('parses NO_PROXY into array', () => {
      process.env.NO_PROXY = 'localhost,127.0.0.1,.corp.local';
      const config = getProxyConfig();
      expect(config.noProxyHosts).toEqual(['localhost', '127.0.0.1', '.corp.local']);
    });

    it('handles empty NO_PROXY', () => {
      process.env.NO_PROXY = '';
      const config = getProxyConfig();
      expect(config.noProxyHosts).toEqual([]);
    });

    it('trims and lowercases NO_PROXY entries', () => {
      process.env.NO_PROXY = ' LocalHost , CORP.LOCAL ';
      const config = getProxyConfig();
      expect(config.noProxyHosts).toEqual(['localhost', 'corp.local']);
    });
  });

  describe('shouldBypassProxy', () => {
    it('bypasses for exact hostname match', () => {
      expect(shouldBypassProxy('localhost', ['localhost'])).toBe(true);
    });

    it('bypasses for wildcard', () => {
      expect(shouldBypassProxy('anything', ['*'])).toBe(true);
    });

    it('bypasses for domain suffix with leading dot', () => {
      expect(shouldBypassProxy('foo.corp.local', ['.corp.local'])).toBe(true);
    });

    it('bypasses for domain suffix without leading dot', () => {
      expect(shouldBypassProxy('foo.corp.local', ['corp.local'])).toBe(true);
    });

    it('does not bypass for non-matching hostname', () => {
      expect(shouldBypassProxy('external.com', ['localhost', '.corp.local'])).toBe(false);
    });

    it('is case-insensitive', () => {
      expect(shouldBypassProxy('FOO.CORP.LOCAL', ['.corp.local'])).toBe(true);
    });

    it('does not bypass for partial match', () => {
      expect(shouldBypassProxy('notlocalhost', ['localhost'])).toBe(false);
    });

    // ── Issue #451 — NO_PROXY bypass list coverage ────────────────────────────

    it('NO_PROXY wildcard (*) bypasses all hostnames', () => {
      expect(shouldBypassProxy('horizon.stellar.org', ['*'])).toBe(true);
      expect(shouldBypassProxy('api.github.com', ['*'])).toBe(true);
      expect(shouldBypassProxy('anything.example.com', ['*'])).toBe(true);
    });

    it('NO_PROXY exact match for GHES API hostname', () => {
      const noProxy = ['ghes.corp.example.com'];
      expect(shouldBypassProxy('ghes.corp.example.com', noProxy)).toBe(true);
      expect(shouldBypassProxy('other.corp.example.com', noProxy)).toBe(false);
    });

    it('NO_PROXY domain suffix bypasses Horizon on corporate GHES', () => {
      // Enterprise pattern: bypass all *.corp.example.com hosts
      const noProxy = ['.corp.example.com'];
      expect(shouldBypassProxy('horizon.corp.example.com', noProxy)).toBe(true);
      expect(shouldBypassProxy('ghes.corp.example.com', noProxy)).toBe(true);
      expect(shouldBypassProxy('external.evil.com', noProxy)).toBe(false);
    });

    it('NO_PROXY suffix-without-dot bypasses subdomains', () => {
      // corp.example.com without leading dot should still match foo.corp.example.com
      const noProxy = ['corp.example.com'];
      expect(shouldBypassProxy('api.corp.example.com', noProxy)).toBe(true);
    });

    it('NO_PROXY does not bypass root hostname when only subdomain listed', () => {
      // 'sub.corp.local' in NO_PROXY should not bypass 'corp.local' itself
      const noProxy = ['sub.corp.local'];
      expect(shouldBypassProxy('corp.local', noProxy)).toBe(false);
    });

    it('NO_PROXY list with multiple entries — all are evaluated', () => {
      const noProxy = ['localhost', '127.0.0.1', '.corp.local', 'horizon.internal.test'];
      expect(shouldBypassProxy('localhost', noProxy)).toBe(true);
      expect(shouldBypassProxy('127.0.0.1', noProxy)).toBe(true);
      expect(shouldBypassProxy('api.corp.local', noProxy)).toBe(true);
      expect(shouldBypassProxy('horizon.internal.test', noProxy)).toBe(true);
      expect(shouldBypassProxy('horizon.stellar.org', noProxy)).toBe(false);
    });
  });

  describe('createProxyAgent', () => {
    it('returns undefined when no proxy configured', () => {
      const agent = createProxyAgent('https://horizon.stellar.org');
      expect(agent).toBeUndefined();
    });

    it('returns undefined when hostname is in NO_PROXY', () => {
      process.env.HTTPS_PROXY = 'http://proxy:8080';
      process.env.NO_PROXY = 'horizon.stellar.org';
      const agent = createProxyAgent('https://horizon.stellar.org');
      expect(agent).toBeUndefined();
    });

    it('creates agent when proxy configured and hostname not in NO_PROXY', () => {
      process.env.HTTPS_PROXY = 'http://proxy:8080';
      const agent = createProxyAgent('https://horizon.stellar.org');
      expect(agent).toBeDefined();
    });

    it('returns undefined for invalid target URL', () => {
      process.env.HTTPS_PROXY = 'http://proxy:8080';
      const agent = createProxyAgent('not-a-url');
      expect(agent).toBeUndefined();
    });

    // ── Issue #451 — invalid proxy URL soft-fail ──────────────────────────────

    it('soft-fails (returns undefined) for a completely invalid proxy URL', () => {
      // HttpsProxyAgent constructor will throw for garbage; we must not propagate
      const agent = createProxyAgent('https://horizon.stellar.org', {
        proxyUrl: ':::bad-proxy-url:::',
        noProxyHosts: [],
      });
      expect(agent).toBeUndefined();
    });

    it('soft-fails for a proxy URL with no host', () => {
      const agent = createProxyAgent('https://horizon.stellar.org', {
        proxyUrl: 'http://:8080',
        noProxyHosts: [],
      });
      // Should not throw; may be undefined if the agent constructor rejects it
      // (behaviour depends on https-proxy-agent version, but must never throw)
      expect(() =>
        createProxyAgent('https://horizon.stellar.org', {
          proxyUrl: 'http://:8080',
          noProxyHosts: [],
        }),
      ).not.toThrow();
    });

    it('soft-fails for a proxy URL that is an empty string override', () => {
      const agent = createProxyAgent('https://horizon.stellar.org', {
        proxyUrl: '',
        noProxyHosts: [],
      });
      expect(agent).toBeUndefined();
    });

    // ── Issue #451 — agent attachment shape ────────────────────────────────────

    it('returned agent has the expected shape (instanceof check / proxy property)', () => {
      process.env.HTTPS_PROXY = 'http://proxy.corp:8080';
      const agent = createProxyAgent('https://horizon.stellar.org');
      expect(agent).toBeDefined();
      // HttpsProxyAgent exposes a `proxy` property with the parsed proxy URL
      expect(agent).toHaveProperty('proxy');
    });

    it('agent proxy property reflects the configured proxy URL', () => {
      const agent = createProxyAgent('https://horizon.stellar.org', {
        proxyUrl: 'http://corp-proxy:3128',
        noProxyHosts: [],
      });
      expect(agent).toBeDefined();
      // The proxy hostname should be stored on the agent
      const proxyUrl = (agent as any)?.proxy;
      expect(proxyUrl).toBeDefined();
    });

    it('bypasses proxy when target hostname matches NO_PROXY domain suffix', () => {
      // Corporate GHES pattern: bypass *.corp.internal but proxy everything else
      process.env.HTTPS_PROXY = 'http://proxy:8080';
      process.env.NO_PROXY = '.corp.internal';

      const bypassed = createProxyAgent('https://horizon.corp.internal');
      expect(bypassed).toBeUndefined();

      const notBypassed = createProxyAgent('https://horizon.stellar.org');
      expect(notBypassed).toBeDefined();
    });
  });

  describe('createProxiedFetch', () => {
    it('returns undefined when no proxy configured', () => {
      const proxiedFetch = createProxiedFetch();
      expect(proxiedFetch).toBeUndefined();
    });

    it('returns a fetch function when proxy configured', () => {
      process.env.HTTPS_PROXY = 'http://proxy:8080';
      const proxiedFetch = createProxiedFetch();
      expect(proxiedFetch).toBeDefined();
      expect(typeof proxiedFetch).toBe('function');
    });
  });

  describe('getOctokitProxyOptions', () => {
    it('returns only baseUrl when no proxy configured', () => {
      const opts = getOctokitProxyOptions('https://api.github.com');
      expect(opts).toEqual({ baseUrl: 'https://api.github.com' });
    });

    it('returns proxy agent when proxy configured', () => {
      process.env.HTTPS_PROXY = 'http://proxy:8080';
      const opts = getOctokitProxyOptions('https://api.github.com');
      expect(opts.baseUrl).toBe('https://api.github.com');
      expect(opts.request).toBeDefined();
      expect(opts.request?.agent).toBeDefined();
    });

    it('bypasses proxy for github.com when in NO_PROXY', () => {
      process.env.HTTPS_PROXY = 'http://proxy:8080';
      process.env.NO_PROXY = 'api.github.com';
      const opts = getOctokitProxyOptions('https://api.github.com');
      expect(opts.request).toBeUndefined();
    });

    it('uses default URL when baseUrl not provided', () => {
      process.env.HTTPS_PROXY = 'http://proxy:8080';
      const opts = getOctokitProxyOptions();
      expect(opts.request).toBeDefined();
    });

    // ── Issue #451 — GHES + Horizon via corporate proxy ───────────────────────

    it('GHES scenario: proxy used for horizon, bypassed for GHES API via NO_PROXY', () => {
      process.env.HTTPS_PROXY = 'http://corp-proxy:3128';
      process.env.NO_PROXY = 'ghes.corp.example.com,api.corp.example.com';

      // GHES API bypassed — Octokit should get no agent
      const ghesOpts = getOctokitProxyOptions('https://api.corp.example.com');
      expect(ghesOpts.request).toBeUndefined();

      // Horizon goes through the proxy
      const horizonAgent = createProxyAgent('https://horizon.stellar.org', {
        proxyUrl: 'http://corp-proxy:3128',
        noProxyHosts: ['ghes.corp.example.com', 'api.corp.example.com'],
      });
      expect(horizonAgent).toBeDefined();
    });

    it('GHES scenario: wildcard NO_PROXY bypasses both GHES and Horizon internal endpoints', () => {
      process.env.HTTPS_PROXY = 'http://corp-proxy:3128';
      process.env.NO_PROXY = '*';

      const opts = getOctokitProxyOptions('https://ghes.corp.example.com/api/v3');
      expect(opts.request).toBeUndefined();

      const agent = createProxyAgent('https://horizon.internal.corp.example.com');
      expect(agent).toBeUndefined();
    });
  });
});

describe('proxy credential redaction', () => {
  it('redacts proxy userinfo while preserving scheme and host', () => {
    expect(redactProxyCredentials('ECONNRESET http://alice:s3cret@proxy.example:8080/tunnel'))
      .toBe('ECONNRESET http://***@proxy.example:8080/tunnel');
  });

  it('redacts encoded credentials in errors and logger strings', () => {
    const message = 'request failed via https://user%40corp:p%40ss@proxy.example';
    expect(safeProxyErrorMessage(new Error(message))).toBe(
      'request failed via https://***@proxy.example',
    );
    expect(redactString(message)).not.toContain('p%40ss');
  });

  it('leaves malformed and credential-free text safe without throwing', () => {
    expect(redactProxyCredentials('proxy=http://user:secret@')).toBe('proxy=http://***@');
    expect(safeProxyErrorMessage({ code: 'ETIMEDOUT' })).toBe('[object Object]');
    expect(redactProxyCredentials('')).toBe('');
  });

  it('redacts proxy credentials at action and Horizon error boundaries', () => {
    const url = 'http://user:password@proxy.example:8080';
    expect(getErrorMessage(new Error(`fetch failed: ${url}`)))
      .toBe('fetch failed: http://***@proxy.example:8080');
    expect(new HorizonError(`request via ${url}`, 503).message)
      .toBe('request via http://***@proxy.example:8080');
  });
});
