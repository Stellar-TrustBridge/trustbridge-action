/**
 * Tests for Horizon preflight probe and check script behavior.
 */

import { probeHorizonUrl } from '../src/preflight';
import { redactHorizonUrl } from '../src/logger';

describe('Horizon Check & Probe', () => {
  describe('probeHorizonUrl', () => {
    it('returns ok: true when HEAD returns 200', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });

      const result = await probeHorizonUrl('https://horizon.stellar.org', mockFetch, 1000);
      expect(result).toEqual({ ok: true, reason: 'ok', status: 200 });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://horizon.stellar.org',
        expect.objectContaining({ method: 'HEAD' }),
      );
    });

    it('retries with GET when HEAD returns 405 (Method Not Allowed)', async () => {
      const mockFetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 405,
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

      const result = await probeHorizonUrl('https://horizon.stellar.org', mockFetch, 1000);
      expect(result).toEqual({ ok: true, reason: 'ok', status: 200 });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][1].method).toBe('HEAD');
      expect(mockFetch.mock.calls[1][1].method).toBe('GET');
    });

    it('returns ok: false when HEAD fails with >= 400 status', async () => {
      const mockFetch = jest.fn().mockResolvedValueOnce({
        ok: false,
        status: 503,
      });

      const result = await probeHorizonUrl('https://horizon.stellar.org', mockFetch, 1000);
      expect(result.ok).toBe(false);
      expect(result.status).toBe(503);
    });

    it('returns ok: false on timeout (AbortError)', async () => {
      const mockFetch = jest.fn().mockImplementation(() => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      });

      const result = await probeHorizonUrl('https://horizon.stellar.org', mockFetch, 100);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('timed out');
    });
  });

  describe('URL Redaction Policy', () => {
    it('redacts sensitive account addresses in Horizon URLs', async () => {
      const addr = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
      const url = `https://horizon.stellar.org/accounts/${addr}`;
      const safe = redactHorizonUrl(url);
      expect(safe).not.toContain(addr);
      expect(safe).toContain('GA5Z...KZVN');
    });
  });
});
