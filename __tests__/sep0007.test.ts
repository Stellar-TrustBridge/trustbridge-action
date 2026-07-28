/**
 * Tests for SEP-0007 wallet deep links in src/links.ts (Issue #44).
 * Covers buildSep0007TxLink and buildSep0007PayLink.
 */

import {
  buildSep0007PayLink,
  buildSep0007TxLink,
  inferStellarNetwork,
} from '../src/links';

const PUBLIC_PASSPHRASE = 'Public Global Stellar Network ; September 2015';
const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
const DEST = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** URLSearchParams encodes spaces as +; decode both % and + encoding. */
function decode(uri: string): string {
  return decodeURIComponent(uri.replace(/\+/g, ' '));
}

// ---------------------------------------------------------------------------
// buildSep0007TxLink
// ---------------------------------------------------------------------------

describe('buildSep0007TxLink', () => {
  it('produces a web+stellar:tx URI', () => {
    const uri = buildSep0007TxLink({ xdr: 'AAAAAQ==' });
    expect(uri).toMatch(/^web\+stellar:tx\?/);
  });

  it('includes the XDR parameter', () => {
    const uri = buildSep0007TxLink({ xdr: 'AAAAAQ==' });
    expect(uri).toContain('xdr=AAAAAQ');
  });

  it('uses the public network passphrase by default', () => {
    const uri = buildSep0007TxLink({ xdr: 'x' });
    expect(decode(uri)).toContain(PUBLIC_PASSPHRASE);
  });

  it('uses the testnet passphrase when network=testnet', () => {
    const uri = buildSep0007TxLink({ xdr: 'x', network: 'testnet' });
    expect(decode(uri)).toContain(TESTNET_PASSPHRASE);
  });

  it('uses a custom network passphrase when provided', () => {
    const custom = 'My Custom Network ; 2024';
    const uri = buildSep0007TxLink({ xdr: 'x', networkPassphrase: custom });
    expect(decode(uri)).toContain(custom);
  });

  it('appends msg when provided', () => {
    const uri = buildSep0007TxLink({ xdr: 'x', msg: 'Add trustline' });
    expect(decode(uri)).toContain('Add trustline');
  });

  it('appends callback when provided', () => {
    const cb = 'https://example.com/callback';
    const uri = buildSep0007TxLink({ xdr: 'x', callback: cb });
    expect(decode(uri)).toContain(cb);
  });

  it('appends origin_domain when provided', () => {
    const uri = buildSep0007TxLink({ xdr: 'x', originDomain: 'trustbridge.example' });
    expect(uri).toContain('origin_domain=');
    expect(decode(uri)).toContain('trustbridge.example');
  });

  it('omits optional fields when not provided', () => {
    const uri = buildSep0007TxLink({ xdr: 'x' });
    expect(uri).not.toContain('msg=');
    expect(uri).not.toContain('callback=');
    expect(uri).not.toContain('origin_domain=');
  });
});

// ---------------------------------------------------------------------------
// buildSep0007PayLink
// ---------------------------------------------------------------------------

describe('buildSep0007PayLink', () => {
  it('produces a web+stellar:pay URI', () => {
    const uri = buildSep0007PayLink({ destination: DEST });
    expect(uri).toMatch(/^web\+stellar:pay\?/);
  });

  it('includes the destination parameter', () => {
    const uri = buildSep0007PayLink({ destination: DEST });
    expect(uri).toContain(`destination=${DEST}`);
  });

  it('uses the public network passphrase by default', () => {
    const uri = buildSep0007PayLink({ destination: DEST });
    expect(decode(uri)).toContain(PUBLIC_PASSPHRASE);
  });

  it('uses the testnet passphrase when network=testnet', () => {
    const uri = buildSep0007PayLink({ destination: DEST, network: 'testnet' });
    expect(decode(uri)).toContain(TESTNET_PASSPHRASE);
  });

  it('appends amount when provided', () => {
    const uri = buildSep0007PayLink({ destination: DEST, amount: '1.5' });
    expect(uri).toContain('amount=1.5');
  });

  it('appends asset_code and asset_issuer when provided', () => {
    const issuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
    const uri = buildSep0007PayLink({ destination: DEST, assetCode: 'USDC', assetIssuer: issuer });
    expect(uri).toContain('asset_code=USDC');
    expect(uri).toContain(`asset_issuer=${issuer}`);
  });

  it('appends memo and memo_type when provided', () => {
    const uri = buildSep0007PayLink({ destination: DEST, memo: 'hello', memoType: 'text' });
    expect(decode(uri)).toContain('memo=hello');
    expect(uri).toContain('memo_type=text');
  });

  it('defaults memo_type to text when memo is given but memoType is omitted', () => {
    const uri = buildSep0007PayLink({ destination: DEST, memo: 'hi' });
    expect(uri).toContain('memo_type=text');
  });

  it('appends msg when provided', () => {
    const uri = buildSep0007PayLink({ destination: DEST, msg: 'Activate account' });
    expect(decode(uri)).toContain('Activate account');
  });

  it('omits optional fields when not provided', () => {
    const uri = buildSep0007PayLink({ destination: DEST });
    expect(uri).not.toContain('amount=');
    expect(uri).not.toContain('asset_code=');
    expect(uri).not.toContain('memo=');
    expect(uri).not.toContain('msg=');
  });
});

// ---------------------------------------------------------------------------
// inferStellarNetwork (existing helper — regression guard)
// ---------------------------------------------------------------------------

describe('inferStellarNetwork', () => {
  it('returns testnet for testnet horizon URL', () => {
    expect(inferStellarNetwork('https://horizon-testnet.stellar.org')).toBe('testnet');
  });

  it('returns public for mainnet horizon URL', () => {
    expect(inferStellarNetwork('https://horizon.stellar.org')).toBe('public');
  });
});
