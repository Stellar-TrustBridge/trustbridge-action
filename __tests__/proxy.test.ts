import {
  getProxyConfig,
  shouldBypassProxy,
  createProxyAgent,
  createProxiedFetch,
  redactProxyUrl,
  getOctokitProxyOptions,
} from '../src/proxy';

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
  });
});
