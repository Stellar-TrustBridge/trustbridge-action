/**
 * Custom asset-code normalization tests (Issue #968).
 *
 * Exotic-but-valid Stellar asset codes (mixed case, digits, 4/12-char codes)
 * must be canonicalized before they are compared to Horizon balances. Invalid
 * codes must still fail fast, and normalization must never weaken the issuer
 * match.
 */
import {
  assertValidAssetCode,
  assetCodesEqual,
  normalizeAssetCode,
  normalizeAssetConfig,
  parseAssetsJson,
  dedupeAssets,
} from '../src/assets';
import { checkMultiAssetTrustlines, checkTrustlineExists, runMultiAssetChecks } from '../src/checks';
import {
  findTrustlineBalance,
  getAssetBalance,
  hasTrustline,
  type HorizonAccount,
} from '../src/horizon';

const ISSUER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const OTHER_ISSUER = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF';

const EXOTIC_CODES = [
  { raw: ' yXlm ', expected: 'YXLM' },
  { raw: 'usd1', expected: 'USD1' },
  { raw: 'a1b2c3', expected: 'A1B2C3' },
  { raw: ' AbC123 ', expected: 'ABC123' },
  { raw: '123456789012', expected: '123456789012' },
] as const;

function accountWithCodes(codes: string[]): HorizonAccount {
  return {
    account_id: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    balances: [
      { asset_type: 'native', balance: '10.0000000' },
      ...codes.map((asset_code) => ({
        asset_type: 'credit_alphanum12',
        asset_code,
        asset_issuer: ISSUER,
        balance: '1.0000000',
        limit: '1000000',
        is_authorized: true,
        is_clawback_enabled: false,
      })),
    ],
  } as unknown as HorizonAccount;
}

describe('custom asset code normalization (Issue #968)', () => {
  it('canonicalizes exotic alphanumeric codes and whitespace', () => {
    for (const { raw, expected } of EXOTIC_CODES) {
      expect(normalizeAssetCode(raw)).toBe(expected);
      expect(() => assertValidAssetCode(raw)).not.toThrow();
      expect(normalizeAssetConfig({ assetCode: raw, assetIssuer: ` ${ISSUER} ` })).toEqual({
        assetCode: expected,
        assetIssuer: ISSUER,
      });
    }
  });

  it('compares normalized codes case-insensitively', () => {
    expect(assetCodesEqual(' yXlm ', 'YXLM')).toBe(true);
    expect(assetCodesEqual('usd1', 'USD1')).toBe(true);
    expect(assetCodesEqual('USDC', 'USDT')).toBe(false);
  });

  it('finds Horizon trustlines when the configured code differs in case', () => {
    const account = accountWithCodes(['YXLM', 'USD1', 'A1B2C3']);

    expect(hasTrustline(account, ' yXlm ', ISSUER)).toBe(true);
    expect(findTrustlineBalance(account, ' yXlm ', ISSUER)?.asset_code).toBe('YXLM');
    expect(getAssetBalance(account, ' yXlm ', ISSUER)).toBe('1.0000000');
    expect(checkTrustlineExists(account, ' usd1 ', ISSUER)).toBe(true);
  });

  it('normalizes codes in multi-asset helpers before comparing', () => {
    const account = accountWithCodes(['YXLM', 'USD1', 'A1B2C3']);

    const gate = checkMultiAssetTrustlines(account, [
      { assetCode: ' usd1 ', assetIssuer: ISSUER, required: true },
    ]);
    // Display strings stay exactly as the caller wrote them; only the
    // comparison is canonicalized.
    expect(gate[0]).toMatchObject({ asset: ' usd1 ', exists: true });

    const extra = runMultiAssetChecks(account, [
      { assetCode: ' a1b2c3 ', assetIssuer: ISSUER },
    ]);
    expect(extra.allTrustlinesExist).toBe(true);
    expect(extra.results[0]).toMatchObject({ assetCode: ' a1b2c3 ', trustlineExists: true });

    const parsed = parseAssetsJson(JSON.stringify([
      { code: ' yXlm ', issuer: ISSUER },
      { code: 'YXLM', issuer: ISSUER },
    ]));
    expect(dedupeAssets(parsed)).toHaveLength(1);
  });

  it('rejects invalid characters in custom asset codes', () => {
    for (const code of ['US-DC', 'US DC', '€URC', '']) {
      expect(() => assertValidAssetCode(code)).toThrow(/asset_code/);
    }
    expect(() => normalizeAssetConfig({ assetCode: 'US-DC', assetIssuer: ISSUER })).toThrow(
      /asset_code/,
    );
  });

  it('rejects asset codes longer than 12 characters', () => {
    expect(() => assertValidAssetCode('ABCDEFGHIJKLM')).toThrow(/asset_code/);
    expect(() => parseAssetsJson(JSON.stringify([
      { code: 'ABCDEFGHIJKLM', issuer: ISSUER },
    ]))).toThrow(/asset_code/);
  });

  it('keeps issuer matching strict after code normalization', () => {
    const account = accountWithCodes(['YXLM']);
    expect(hasTrustline(account, ' yXlm ', OTHER_ISSUER)).toBe(false);
    expect(checkTrustlineExists(account, ' yXlm ', OTHER_ISSUER)).toBe(false);
  });
});
