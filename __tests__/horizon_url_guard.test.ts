import { validateHorizonUrl } from '../src/validation';
import { normalizeHorizonUrl } from '../src/horizon';
import { normalizeMetricHost } from '../src/metrics';

describe('Issue #95 - Horizon URL Path Traversal Guard & Metrics Normalization', () => {
  describe('validateHorizonUrl', () => {
    it('rejects embedded credentials in horizon_url', () => {
      const result1 = validateHorizonUrl('https://user:pass@horizon.stellar.org');
      expect(result1.valid).toBe(false);
      expect(result1.errors[0]).toContain('embedded credentials');

      const result2 = validateHorizonUrl('https://admin@horizon.stellar.org');
      expect(result2.valid).toBe(false);
      expect(result2.errors[0]).toContain('embedded credentials');
    });

    it('rejects path traversal attempts in horizon_url', () => {
      const invalidUrls = [
        'https://horizon.stellar.org/../admin',
        'https://horizon.stellar.org/accounts/..',
        'https://horizon.stellar.org/foo/bar/../baz',
        'https://horizon.stellar.org/%2e%2e/admin',
        'https://horizon.stellar.org/%2E%2E/admin',
        'https://horizon.stellar.org/..',
        'https://horizon.stellar.org/./test',
      ];

      for (const url of invalidUrls) {
        const result = validateHorizonUrl(url);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('path traversal') || e.includes('invalid path'))).toBe(true);
      }
    });

    it('rejects invalid or non-http(s) protocols', () => {
      const result1 = validateHorizonUrl('file:///etc/passwd');
      expect(result1.valid).toBe(false);
      expect(result1.errors[0]).toContain('protocol');

      const result2 = validateHorizonUrl('ftp://horizon.stellar.org');
      expect(result2.valid).toBe(false);
      expect(result2.errors[0]).toContain('protocol');

      // http is allowed by default for testnet/private mirrors; require https explicitly.
      const result3 = validateHorizonUrl('http://horizon.stellar.org', 'horizon_url', { allowHttp: false });
      expect(result3.valid).toBe(false);
      expect(result3.errors[0]).toContain('https');
    });

    it('allows http when allowHttp option is set to true', () => {
      const result = validateHorizonUrl('http://horizon-testnet.stellar.org', 'horizon_url', { allowHttp: true });
      expect(result.valid).toBe(true);
    });

    it('accepts valid public Horizon URLs', () => {
      const validUrls = [
        'https://horizon.stellar.org',
        'https://horizon-testnet.stellar.org',
        'https://horizon.stellar.org/',
        'https://horizon.stellar.org/v1',
      ];

      for (const url of validUrls) {
        const result = validateHorizonUrl(url);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }
    });
  });

  describe('normalizeHorizonUrl', () => {
    it('normalizes valid Horizon URLs correctly without trailing slash', () => {
      expect(normalizeHorizonUrl('https://horizon.stellar.org/')).toBe('https://horizon.stellar.org');
      expect(normalizeHorizonUrl('https://horizon.stellar.org')).toBe('https://horizon.stellar.org');
      expect(normalizeHorizonUrl('https://horizon.stellar.org/v1/')).toBe('https://horizon.stellar.org/v1');
    });

    it('throws when normalizeHorizonUrl encounters malformed or malicious URLs', () => {
      expect(() => normalizeHorizonUrl('https://user:pass@horizon.stellar.org')).toThrow();
      expect(() => normalizeHorizonUrl('https://horizon.stellar.org/../admin')).toThrow();
      expect(() => normalizeHorizonUrl('file:///etc/passwd')).toThrow();
    });
  });

  describe('normalizeMetricHost', () => {
    it('extracts clean normalized host keys for metrics', () => {
      expect(normalizeMetricHost('https://horizon.stellar.org/accounts')).toBe('horizon.stellar.org');
      expect(normalizeMetricHost('https://horizon-testnet.stellar.org:443/')).toBe('horizon-testnet.stellar.org');
    });

    it('returns fallback string for malformed inputs', () => {
      expect(normalizeMetricHost('not-a-url')).toBe('unknown_host');
    });
  });
});
