import * as fs from 'fs';
import * as path from 'path';
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

describe('inferStellarNetwork edge cases', () => {
  it('infers public from mainnet Horizon URL', () => {
    expect(inferStellarNetwork('https://horizon.stellar.org')).toBe('public');
  });

  it('infers testnet from a testnet passphrase signal', () => {
    expect(inferStellarNetwork('Test SDF Network ; September 2015')).toBe('testnet');
  });

  it('infers public from a mainnet passphrase signal', () => {
    expect(inferStellarNetwork('Public Global Stellar Network ; September 2015')).toBe('public');
  });

  it('is case-insensitive for URL and passphrase signals', () => {
    expect(inferStellarNetwork('HTTPS://HORIZON-TESTNET.STELLAR.ORG')).toBe('testnet');
    expect(inferStellarNetwork('test sdf network ; september 2015')).toBe('testnet');
  });

  it('defaults to public for unknown or ambiguous inputs', () => {
    expect(inferStellarNetwork('')).toBe('public');
    expect(inferStellarNetwork('https://example.com')).toBe('public');
    expect(inferStellarNetwork('some random string')).toBe('public');
  });

  it('prefers the testnet signal when both are present', () => {
    expect(
      inferStellarNetwork('https://horizon-testnet.stellar.org Public Global Stellar Network'),
    ).toBe('testnet');
  });
});

describe('SEP-0010 dashboard URL rejection', () => {
  it('rejects dashboard URLs for account viewer links', () => {
    expect(() => buildAccountViewerLink('GABC', 'public', 'https://dashboard.stellar.org')).toThrow();
  });

  it('rejects dashboard URLs for change trust links', () => {
    expect(() => buildChangeTrustLink('testnet', 'https://dashboard.stellar.org')).toThrow();
  });
});

describe('FAQ anchor map completeness', () => {
  const faqPath = path.join(__dirname, '..', 'docs', 'FAQ.md');
  const faq = fs.readFileSync(faqPath, 'utf8');

  const headings = faq
    .split('\n')
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-'),
    );

  it('exposes an anchor for every FAQ heading', () => {
    expect(headings.length).toBeGreaterThan(0);
    for (const anchor of headings) {
      expect(faq).toContain(`#${anchor}`);
    }
  });
});
