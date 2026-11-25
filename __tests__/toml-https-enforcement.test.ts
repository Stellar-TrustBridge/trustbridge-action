/** Issue #960 — stellar.toml HTTPS-only enforcement on pubnet. */
import { enforceTomlTransport, fetchTomlWithCache, TOML_HTTPS_REQUIRED_REASON } from '../src/toml';
import * as ssrf from '../src/ssrf';

describe('enforceTomlTransport', () => {
  it('accepts bare domains and https:// on pubnet (happy path)', () => {
    expect(enforceTomlTransport('example.com', { network: 'public' })).toEqual({ ok: true, domain: 'example.com', upgraded: false });
    expect(enforceTomlTransport('https://example.com/', { network: 'public' })).toEqual({ ok: true, domain: 'example.com', upgraded: false });
  });

  it('rejects http:// on pubnet even with the testnet override', () => {
    const d = enforceTomlTransport('http://example.com', { network: 'public', allowInsecureTestnet: true });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.reasonCode).toBe(TOML_HTTPS_REQUIRED_REASON);
      expect(d.error).toContain('pubnet');
    }
  });

  it('rejects http:// on testnet without the override', () => {
    const d = enforceTomlTransport('http://example.com', { network: 'testnet' });
    expect(d.ok).toBe(false);
  });

  it('rejects non-http schemes even on testnet with the override', () => {
    expect(enforceTomlTransport('ftp://example.com', { network: 'testnet', allowInsecureTestnet: true }).ok).toBe(false);
  });

  it('upgrades http:// on testnet with the override', () => {
    expect(enforceTomlTransport('http://example.com', { network: 'testnet', allowInsecureTestnet: true })).toEqual({
      ok: true,
      domain: 'example.com',
      upgraded: true,
    });
  });

  it('treats an unset network as pubnet', () => {
    expect(enforceTomlTransport('http://example.com', { allowInsecureTestnet: true }).ok).toBe(false);
  });
});

describe('fetchTomlWithCache HTTPS enforcement', () => {
  afterEach(() => jest.restoreAllMocks());

  it('never touches the network for http:// on pubnet', async () => {
    const spy = jest.spyOn(ssrf, 'fetchSSRFSafe');
    const res = await fetchTomlWithCache('http://pubnet-http.example', { network: 'public', cacheTtlMs: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(TOML_HTTPS_REQUIRED_REASON);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fetches over https:// when testnet override upgrades http://', async () => {
    const spy = jest.spyOn(ssrf, 'fetchSSRFSafe').mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'text/plain' },
      text: async () => 'VERSION="2.0.0"',
    } as never);
    const res = await fetchTomlWithCache('http://testnet-http.example', {
      network: 'testnet',
      allowInsecureTestnet: true,
      cacheTtlMs: 0,
    });
    expect(res.ok).toBe(true);
    expect(spy.mock.calls[0][0]).toBe('https://testnet-http.example/.well-known/stellar.toml');
  });
});
