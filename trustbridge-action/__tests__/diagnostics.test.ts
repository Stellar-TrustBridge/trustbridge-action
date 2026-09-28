import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runDiagnostics, formatDiagnostics } from '../src/diagnostics';
import { ERROR_HANDLING, USAGE } from '../src/constants';

describe('diagnostics', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('sponsorship diagnostics', () => {
    it('reports a healthy sponsorship path when a sponsor is configured', async () => {
      process.env.SPONSOR_SECRET = 'test-sponsor-secret';
      process.env.SPONSOR_PUBLIC_KEY = 'test-sponsor-public-key';

      const result = await runDiagnostics({ checkSponsorship: true });
      const sponsorship = result.checks.find((c) => c.name === 'sponsorship');

      expect(sponsorship).toBeDefined();
      expect(sponsorship?.status).toBe('ok');
      expect(sponsorship?.message).toBe(USAGE.sponsorshipHealthy);
    });

    it('reports a missing-sponsor diagnostic when no sponsor is configured', async () => {
      delete process.env.SPONSOR_SECRET;
      delete process.env.SPONSOR_PUBLIC_KEY;

      const result = await runDiagnostics({ checkSponsorship: true });
      const sponsorship = result.checks.find((c) => c.name === 'sponsorship');

      expect(sponsorship).toBeDefined();
      expect(sponsorship?.status).toBe('error');
      expect(sponsorship?.message).toBe(ERROR_HANDLING.missingSponsor);
    });

    it('reports a partial coverage diagnostic when only some sponsor config is present', async () => {
      process.env.SPONSOR_SECRET = 'test-sponsor-secret';
      delete process.env.SPONSOR_PUBLIC_KEY;

      const result = await runDiagnostics({ checkSponsorship: true });
      const sponsorship = result.checks.find((c) => c.name === 'sponsorship');

      expect(sponsorship).toBeDefined();
      expect(sponsorship?.status).toBe('warn');
      expect(sponsorship?.message).toBe(ERROR_HANDLING.partialSponsorCoverage);
    });

    it('formats sponsorship diagnostics without performing live network calls', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch' as never);
      process.env.SPONSOR_SECRET = 'test-sponsor-secret';
      process.env.SPONSOR_PUBLIC_KEY = 'test-sponsor-public-key';

      const result = await runDiagnostics({ checkSponsorship: true });
      const formatted = formatDiagnostics(result);

      expect(formatted).toContain('sponsorship');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
