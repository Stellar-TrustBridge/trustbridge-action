import { describe, it, expect } from 'vitest';
import { resolveAssets, validateAssetsForPreset } from '../src/assets';

describe('assets resolution', () => {
  it('resolves default assets for the public network preset', () => {
    const assets = resolveAssets({ network: 'public' });
    expect(assets.network).toBe('public');
    expect(assets.assets).toBeDefined();
  });

  it('resolves default assets for the testnet network preset', () => {
    const assets = resolveAssets({ network: 'testnet' });
    expect(assets.network).toBe('testnet');
    expect(assets.assets).toBeDefined();
  });

  it('resolves custom assets for the custom network preset', () => {
    const assetsJson = JSON.stringify({ native: 'XLM', tokens: ['USDC'] });
    const assets = resolveAssets({ network: 'custom', assetsJson });
    expect(assets.network).toBe('custom');
    expect(assets.assets).toEqual({ native: 'XLM', tokens: ['USDC'] });
  });
});

describe('network preset matrix', () => {
  const presets = ['public', 'testnet', 'custom'] as const;

  it.each(presets)('accepts a representative assets_json for the %s preset', (network) => {
    const assetsJson = JSON.stringify({ native: 'XLM', tokens: ['USDC'] });
    const result = validateAssetsForPreset({ network, assetsJson });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects an unknown network preset with a clear error', () => {
    const result = validateAssetsForPreset({ network: 'mainnet' as never, assetsJson: '{}' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Unsupported network preset: mainnet');
  });

  it('rejects malformed assets_json with a clear error', () => {
    const result = validateAssetsForPreset({ network: 'public', assetsJson: '{not json' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Invalid assets_json: must be valid JSON');
  });

  it('rejects custom preset without assets_json with a clear error', () => {
    const result = validateAssetsForPreset({ network: 'custom' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('assets_json is required for the custom network preset');
  });
});

describe('assets_json schema validation before Horizon calls', () => {
  it('rejects a non-object assets_json payload', () => {
    const result = validateAssetsForPreset({ network: 'public', assetsJson: '"XLM"' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Invalid assets_json: must be a JSON object');
  });

  it('rejects an array assets_json payload', () => {
    const result = validateAssetsForPreset({ network: 'public', assetsJson: '["XLM"]' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Invalid assets_json: must be a JSON object');
  });

  it('rejects a non-string native field and points to the offending field', () => {
    const assetsJson = JSON.stringify({ native: 42, tokens: ['USDC'] });
    const result = validateAssetsForPreset({ network: 'public', assetsJson });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Invalid assets_json: field "native" must be a string');
  });

  it('rejects a non-array tokens field and points to the offending field', () => {
    const assetsJson = JSON.stringify({ native: 'XLM', tokens: 'USDC' });
    const result = validateAssetsForPreset({ network: 'public', assetsJson });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Invalid assets_json: field "tokens" must be an array of strings');
  });

  it('rejects non-string entries inside tokens and points to the offending field', () => {
    const assetsJson = JSON.stringify({ native: 'XLM', tokens: ['USDC', 7] });
    const result = validateAssetsForPreset({ network: 'public', assetsJson });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Invalid assets_json: field "tokens" must be an array of strings');
  });

  it('rejects unknown top-level fields and points to the offending field', () => {
    const assetsJson = JSON.stringify({ native: 'XLM', tokens: ['USDC'], bogus: true });
    const result = validateAssetsForPreset({ network: 'public', assetsJson });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Invalid assets_json: unknown field "bogus"');
  });

  it('fails fast without issuing Horizon calls for invalid assets_json', () => {
    const calls: string[] = [];
    const horizon = { fetchAssets: (id: string) => calls.push(id) };
    const result = validateAssetsForPreset({ network: 'public', assetsJson: '{not json' });
    expect(result.valid).toBe(false);
    if (result.valid) {
      horizon.fetchAssets('USDC');
    }
    expect(calls).toEqual([]);
  });
});
