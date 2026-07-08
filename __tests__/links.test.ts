import {
  buildAccountViewerLink,
  buildChangeTrustLink,
  buildLobstrLink,
  inferStellarNetwork,
} from '../src/links';

describe('Stellar links', () => {
  it('infers testnet from Horizon URL', () => {
    expect(inferStellarNetwork('https://horizon-testnet.stellar.org')).toBe('testnet');
  });

  it('builds laboratory URLs with network params', () => {
    expect(buildAccountViewerLink('GABC', 'public')).toContain('network=public&account=GABC');
    expect(buildChangeTrustLink('testnet')).toContain('network=testnet');
  });

  it('returns the Lobstr home URL', () => {
    expect(buildLobstrLink()).toBe('https://lobstr.co/');
  });
});
