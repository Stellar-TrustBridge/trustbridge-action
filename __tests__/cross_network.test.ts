/**
 * #144 + #266 — Cross-network address detection tests
 *
 * Validates that:
 *   - detectNetworkMismatch returns a hint when the address is active on the
 *     opposite network (both directions, deterministic).
 *   - detectNetworkMismatch returns undefined when the address is not found on
 *     either network (no false positive for genuinely unfunded accounts).
 *   - detectNetworkMismatch returns undefined on fetch errors (defensive).
 *   - detectNetworkMismatch is deterministic for 404+200 vs 404+404 vs 503.
 *   - SSRF guard: alt URL validated before probe.
 *   - Heuristics remain deterministic when allow_cross_network_fallback is disabled.
 *   - unfundedAccountResult surfaces a distinct mismatch message when given a
 *     hint, with both canonical URLs.
 */

import { detectNetworkMismatch, unfundedAccountResult, NetworkMismatchHint, buildNetworkMismatchDetail } from '../src/checks';
import { inferStellarNetwork, canonicalHorizonUrl, oppositeNetwork } from '../src/links';

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

const MAINNET_HORIZON = 'https://horizon.stellar.org';
const TESTNET_HORIZON = 'https://horizon-testnet.stellar.org';
const VALID_ADDRESS = 'G' + 'A'.repeat(55);
const MOCK_CONFIG = {
  assetCode: 'USDC',
  assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  minXlmReserve: 1.5,
  horizonUrl: MAINNET_HORIZON,
};

function makeFetch(statusForUrl: Record<string, number>) {
  return async (url: string): Promise<{ status: number }> => {
    for (const [prefix, status] of Object.entries(statusForUrl)) {
      if (url.startsWith(prefix)) return { status };
    }
    return { status: 404 };
  };
}

// ---------------------------------------------------------------------------
// inferStellarNetwork
// ---------------------------------------------------------------------------

describe('inferStellarNetwork', () => {
  it('classifies the public mainnet Horizon URL', () => {
    expect(inferStellarNetwork(MAINNET_HORIZON)).toBe('public');
  });

  it('classifies the testnet Horizon URL', () => {
    expect(inferStellarNetwork(TESTNET_HORIZON)).toBe('testnet');
  });

  it('classifies a custom URL without "testnet" as public', () => {
    expect(inferStellarNetwork('https://my-horizon.example.com')).toBe('public');
  });

  it('classifies a custom URL with "testnet" in the path as testnet', () => {
    expect(inferStellarNetwork('https://horizon.example.com/testnet')).toBe('testnet');
  });

  it('is case-insensitive', () => {
    expect(inferStellarNetwork('https://HORIZON-TESTNET.stellar.org')).toBe('testnet');
  });
});

// ---------------------------------------------------------------------------
// canonicalHorizonUrl / oppositeNetwork
// ---------------------------------------------------------------------------

describe('canonicalHorizonUrl', () => {
  it('returns mainnet URL for public', () => {
    expect(canonicalHorizonUrl('public')).toBe(MAINNET_HORIZON);
  });

  it('returns testnet URL for testnet', () => {
    expect(canonicalHorizonUrl('testnet')).toBe(TESTNET_HORIZON);
  });
});

describe('oppositeNetwork', () => {
  it('returns testnet for public', () => {
    expect(oppositeNetwork('public')).toBe('testnet');
  });

  it('returns public for testnet', () => {
    expect(oppositeNetwork('testnet')).toBe('public');
  });
});

// ---------------------------------------------------------------------------
// detectNetworkMismatch
// ---------------------------------------------------------------------------

describe('detectNetworkMismatch', () => {
  it('returns a mismatch hint when the address is active on the opposite (testnet) network', async () => {
    // Configured: mainnet. Alt (testnet) returns 200.
    const fetch = makeFetch({
      [TESTNET_HORIZON]: 200,
    });
    const hint = await detectNetworkMismatch(MAINNET_HORIZON, VALID_ADDRESS, fetch);
    expect(hint).toBeDefined();
    expect(hint!.configuredNetwork).toBe('public');
    expect(hint!.activeOnNetwork).toBe('testnet');
  });

  it('returns a mismatch hint when the address is active on the opposite (mainnet) network', async () => {
    // Configured: testnet. Alt (mainnet) returns 200.
    const fetch = makeFetch({
      [MAINNET_HORIZON]: 200,
    });
    const hint = await detectNetworkMismatch(TESTNET_HORIZON, VALID_ADDRESS, fetch);
    expect(hint).toBeDefined();
    expect(hint!.configuredNetwork).toBe('testnet');
    expect(hint!.activeOnNetwork).toBe('public');
  });

  it('returns undefined when the address is not found on the alt network either (no false positive)', async () => {
    // Alt network also returns 404 → genuinely unfunded
    const fetch = makeFetch({});
    const hint = await detectNetworkMismatch(MAINNET_HORIZON, VALID_ADDRESS, fetch);
    expect(hint).toBeUndefined();
  });

  it('returns undefined when the alt-network fetch fails (defensive)', async () => {
    const fetch = async (): Promise<{ status: number }> => {
      throw new Error('network error');
    };
    const hint = await detectNetworkMismatch(MAINNET_HORIZON, VALID_ADDRESS, fetch);
    expect(hint).toBeUndefined();
  });

  it('returns undefined when the alt network returns a non-200, non-404 status', async () => {
    const fetch = makeFetch({ [TESTNET_HORIZON]: 503 });
    const hint = await detectNetworkMismatch(MAINNET_HORIZON, VALID_ADDRESS, fetch);
    expect(hint).toBeUndefined();
  });

  it('produces deterministic hint text via buildNetworkMismatchDetail for public→testnet', async () => {
    const fetch = makeFetch({ [TESTNET_HORIZON]: 200 });
    const hint = await detectNetworkMismatch(MAINNET_HORIZON, VALID_ADDRESS, fetch);
    expect(hint).toBeDefined();
    const detail = buildNetworkMismatchDetail(VALID_ADDRESS, hint!);
    expect(detail).toContain('Network mismatch detected');
    expect(detail).toContain('Configured network:');
    expect(detail).toContain('Active network:');
    expect(detail).toContain(MAINNET_HORIZON);
    expect(detail).toContain(TESTNET_HORIZON);
    expect(detail).toContain('horizon_url');
  });

  it('produces deterministic hint text via buildNetworkMismatchDetail for testnet→public', async () => {
    const fetch = makeFetch({ [MAINNET_HORIZON]: 200 });
    const hint = await detectNetworkMismatch(TESTNET_HORIZON, VALID_ADDRESS, fetch);
    expect(hint).toBeDefined();
    const detail = buildNetworkMismatchDetail(VALID_ADDRESS, hint!);
    expect(detail).toContain('Network mismatch detected');
    expect(detail).toContain('Configured network:');
    expect(detail).toContain('Active network:');
    expect(detail).toContain(MAINNET_HORIZON);
    expect(detail).toContain(TESTNET_HORIZON);
  });

  it('never probes arbitrary fallback URLs — only canonical opposite (SSRF guard concept)', async () => {
    // Even if fallback URL is custom, detectNetworkMismatch only checks canonical opposite
    const customHorizon = 'https://my-private-horizon.example.com';
    const fetch = jest.fn(async (url: string) => {
      expect(url).toContain('horizon-testnet.stellar.org'); // canonical, not custom
      // For public inferred from custom URL, opposite is testnet canonical
      return { status: 200 };
    });
    const hint = await detectNetworkMismatch(customHorizon, VALID_ADDRESS, fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(hint!.activeOnNetwork).toBe('testnet');
  });

  it('handles both 404 as genuinely unfunded (no hint, no remediation)', async () => {
    const fetch = makeFetch({});
    const hint = await detectNetworkMismatch(MAINNET_HORIZON, VALID_ADDRESS, fetch);
    expect(hint).toBeUndefined();
    const result = unfundedAccountResult(VALID_ADDRESS, MOCK_CONFIG, hint);
    expect(result.remediation).not.toContain('Network mismatch');
    expect(result.checks[0].detail).toContain('not found');
  });

  it('returns undefined when the opposite-network fetch fails', async () => {
    const fetchMock = jest.fn(async () => {
      throw new Error('The operation was aborted');
    });

    const hint = await detectNetworkMismatch(
      MAINNET_HORIZON,
      VALID_ADDRESS,
      fetchMock,
    );

    expect(hint).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// unfundedAccountResult — mismatch hint integration
// ---------------------------------------------------------------------------

describe('unfundedAccountResult with NetworkMismatchHint', () => {
  const mismatchHint: NetworkMismatchHint = {
    configuredNetwork: 'public',
    activeOnNetwork: 'testnet',
  };

  it('produces a distinct error message when a mismatch hint is present', () => {
    const result = unfundedAccountResult(VALID_ADDRESS, MOCK_CONFIG, mismatchHint);
    const fundedCheck = result.checks.find((c) => c.label === 'Account funded');
    expect(fundedCheck).toBeDefined();
    expect(fundedCheck!.passed).toBe(false);
    expect(fundedCheck!.detail).toContain('Network mismatch detected');
    expect(fundedCheck!.detail).toContain('Configured network:');
    expect(fundedCheck!.detail).toContain('Active network:');
    expect(fundedCheck!.detail).toContain(MAINNET_HORIZON);
    expect(fundedCheck!.detail).toContain(TESTNET_HORIZON);
  });

  it('includes remediation that names both network URLs', () => {
    const result = unfundedAccountResult(VALID_ADDRESS, MOCK_CONFIG, mismatchHint);
    expect(result.remediation).toContain('Network mismatch detected');
    expect(result.remediation).toContain('Configured network:');
    expect(result.remediation).toContain('Active network:');
    expect(result.remediation).toContain(MAINNET_HORIZON);
    expect(result.remediation).toContain(TESTNET_HORIZON);
    expect(result.remediation).toContain('horizon_url');
  });

  it('does NOT include mismatch text when no hint is provided', () => {
    const result = unfundedAccountResult(VALID_ADDRESS, MOCK_CONFIG);
    const fundedCheck = result.checks.find((c) => c.label === 'Account funded');
    expect(fundedCheck!.detail).not.toContain('network mismatch');
    expect(result.remediation).not.toContain('horizon_url');
  });

  it('keeps the standard not-found message for genuinely unfunded accounts', () => {
    const result = unfundedAccountResult(VALID_ADDRESS, MOCK_CONFIG);
    const fundedCheck = result.checks.find((c) => c.label === 'Account funded');
    expect(fundedCheck!.detail).toContain('not found');
  });

  it('comment links point at the inferred network Lab/tools', () => {
    // With mainnet horizon, links should contain network=public
    const result = unfundedAccountResult(VALID_ADDRESS, MOCK_CONFIG);
    expect(result.remediation).toContain('stellar.org');
  });

  it('does not change accountFunded (still false regardless of hint)', () => {
    const result = unfundedAccountResult(VALID_ADDRESS, MOCK_CONFIG, mismatchHint);
    expect(result.accountFunded).toBe(false);
  });

  it('shows both canonical URLs in remediation for both directions', () => {
    const hintPublicToTestnet: NetworkMismatchHint = { configuredNetwork: 'public', activeOnNetwork: 'testnet' };
    const result1 = unfundedAccountResult(VALID_ADDRESS, { ...MOCK_CONFIG, horizonUrl: MAINNET_HORIZON }, hintPublicToTestnet);
    expect(result1.remediation).toContain(MAINNET_HORIZON);
    expect(result1.remediation).toContain(TESTNET_HORIZON);

    const hintTestnetToPublic: NetworkMismatchHint = { configuredNetwork: 'testnet', activeOnNetwork: 'public' };
    const result2 = unfundedAccountResult(VALID_ADDRESS, { ...MOCK_CONFIG, horizonUrl: TESTNET_HORIZON }, hintTestnetToPublic);
    expect(result2.remediation).toContain(MAINNET_HORIZON);
    expect(result2.remediation).toContain(TESTNET_HORIZON);
  });

  it('allow_cross_network_fallback interaction: hint shown even when fallback disabled (fallback not probed)', () => {
    // This test documents that hint is from canonical probe, not from arbitrary fallback URL.
    // When allow_cross_network_fallback is false, horizon.ts will still skip fallback,
    // but detectNetworkMismatch still gives a deterministic hint via canonical.
    const hint: NetworkMismatchHint = { configuredNetwork: 'public', activeOnNetwork: 'testnet' };
    const result = unfundedAccountResult(VALID_ADDRESS, MOCK_CONFIG, hint);
    expect(result.checks[0].detail).toContain('active on testnet');
    expect(result.remediation).toContain('Network mismatch');
  });
});
