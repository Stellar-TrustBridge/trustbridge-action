import {
  assertValidAssetCode,
  normalizeAssetCode,
  normalizeAssetConfig,
} from '../src/assets';

describe('asset config helpers', () => {
  it('normalizes asset code casing and whitespace', () => {
    expect(normalizeAssetCode(' usdc ')).toBe('USDC');
  });

  it('rejects unsupported asset code formats', () => {
    expect(() => assertValidAssetCode('this-code-is-too-long')).toThrow(/asset_code/);
  });

  it('normalizes full asset config', () => {
    expect(normalizeAssetConfig({ assetCode: ' eurc ', assetIssuer: ' GABC ' })).toEqual({
      assetCode: 'EURC',
      assetIssuer: 'GABC',
    });
  });
});
