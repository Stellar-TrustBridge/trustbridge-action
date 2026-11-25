import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isUrlAllowed, assertUrlAllowed } from '../src/ssrf';
import { resolveFederationTarget } from '../src/federation';

describe('federation SSRF regression', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('blocked hosts and link-local addresses', () => {
    const blocked = [
      'http://localhost/federation',
      'http://127.0.0.1/federation',
      'http://127.0.0.1:8080/federation',
      'http://[::1]/federation',
      'http://169.254.169.254/latest/meta-data/',
      'http://169.254.1.1/federation',
      'http://10.0.0.1/federation',
      'http://192.168.1.1/federation',
      'http://172.16.0.1/federation',
      'http://0.0.0.0/federation',
      'http://metadata.google.internal/computeMetadata/v1/',
    ];

    it.each(blocked)('rejects %s via ssrf allowlist', (url) => {
      expect(isUrlAllowed(url)).toBe(false);
      expect(() => assertUrlAllowed(url)).toThrow();
    });

    it.each(blocked)('rejects %s during federation resolution', async (url) => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      await expect(resolveFederationTarget(url)).rejects.toThrow();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('bad schemes', () => {
    const badSchemes = [
      'file:///etc/passwd',
      'ftp://example.com/federation',
      'gopher://example.com/federation',
      'data:text/plain,hello',
      'javascript:alert(1)',
      'ws://example.com/federation',
    ];

    it.each(badSchemes)('rejects %s via ssrf allowlist', (url) => {
      expect(isUrlAllowed(url)).toBe(false);
      expect(() => assertUrlAllowed(url)).toThrow();
    });

    it.each(badSchemes)('rejects %s during federation resolution', async (url) => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      await expect(resolveFederationTarget(url)).rejects.toThrow();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('allowlisted resolutions still succeed', () => {
    const allowed = [
      'https://example.com/federation',
      'https://trustbridge.example.org/.well-known/federation',
      'https://sub.example.com/federation',
    ];

    it.each(allowed)('allows %s via ssrf allowlist', (url) => {
      expect(isUrlAllowed(url)).toBe(true);
      expect(() => assertUrlAllowed(url)).not.toThrow();
    });

    it.each(allowed)('resolves %s through mocked fetch', async (url) => {
      const payload = { issuer: 'https://example.com', keys: [] };
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      });
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      const result = await resolveFederationTarget(url);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0]).toBe(url);
      expect(result).toBeDefined();
    });
  });
});
