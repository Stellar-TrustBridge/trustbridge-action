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
