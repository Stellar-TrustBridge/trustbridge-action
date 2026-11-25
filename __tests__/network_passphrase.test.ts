/**
 * Tests for network passphrase mismatch detection (Issue #2).
 * Covers: passphrase comparison, mismatch detection, comment display, outputs.
 */

import { detectPassphraseMismatch, NetworkPassphraseMismatch } from '../src/checks';
import { formatCommentBody } from '../src/comment';
import { toActionOutputs } from '../src/outputs';
import { ValidationResult } from '../src/checks';
import {
  canonicalHorizonUrl,
  inferStellarNetwork,
  inferStellarNetworkPreset,
  KNOWN_HORIZON_NETWORKS,
  STELLAR_NETWORK_PRESETS,
  StellarNetworkPreset,
} from '../src/links';
import { isFriendbotAllowed, isTestnetHorizon } from '../src/horizon';
import { validateHorizonUrl } from '../src/validation';

describe('detectPassphraseMismatch', () => {
  const testnetPassphrase = 'Test SDF Network ; September 2015';
  const publicPassphrase = 'Public Global Stellar Network ; September 2015';
  const customPassphrase = 'My Custom Network ; 2024';

  const mockFetchPassphrase = (returnValue: string) => async () => returnValue;

  it('returns undefined when passphrases match (explicit input)', async () => {
    const result = await detectPassphraseMismatch(
      'https://horizon-testnet.stellar.org',
      testnetPassphrase,
      mockFetchPassphrase(testnetPassphrase),
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when passphrases match (inferred from URL)', async () => {
    const result = await detectPassphraseMismatch(
      'https://horizon-testnet.stellar.org',
      '', // Empty = infer from URL
      mockFetchPassphrase(testnetPassphrase),
    );
    expect(result).toBeUndefined();
  });

  it('detects mismatch when input says testnet but Horizon is public', async () => {
    const result = await detectPassphraseMismatch(
      'https://horizon.stellar.org',
      testnetPassphrase,
      mockFetchPassphrase(publicPassphrase),
    );
    
    expect(result).toBeDefined();
    expect(result?.expectedPassphrase).toBe(testnetPassphrase);
    expect(result?.actualPassphrase).toBe(publicPassphrase);
    expect(result?.message).toContain('testnet');
    expect(result?.message).toContain('public');
  });

  it('detects mismatch when input says public but Horizon is testnet', async () => {
    const result = await detectPassphraseMismatch(
      'https://horizon-testnet.stellar.org',
      publicPassphrase,
      mockFetchPassphrase(testnetPassphrase),
    );
    
    expect(result).toBeDefined();
    expect(result?.expectedPassphrase).toBe(publicPassphrase);
    expect(result?.actualPassphrase).toBe(testnetPassphrase);
    expect(result?.message).toContain('public');
    expect(result?.message).toContain('testnet');
  });

  it('detects mismatch with custom network passphrases', async () => {
    const result = await detectPassphraseMismatch(
      'https://horizon.example.com',
      customPassphrase,
      mockFetchPassphrase(testnetPassphrase),
    );
    
    expect(result).toBeDefined();
    expect(result?.expectedPassphrase).toBe(customPassphrase);
    expect(result?.actualPassphrase).toBe(testnetPassphrase);
    expect(result?.message).toContain('My Custom Network ; 2024');
    expect(result?.message).toContain('Test SDF Network ; September 2015');
  });

  it('normalizes whitespace when comparing passphrases', async () => {
    const result = await detectPassphraseMismatch(
      'https://horizon-testnet.stellar.org',
      '  Test SDF Network ; September 2015  ',
      mockFetchPassphrase('Test SDF Network ; September 2015'),
    );
    expect(result).toBeUndefined();
  });

  it('is case-sensitive when comparing passphrases', async () => {
    const result = await detectPassphraseMismatch(
      'https://horizon-testnet.stellar.org',
      'test sdf network ; september 2015',
      mockFetchPassphrase(testnetPassphrase),
    );
    expect(result).toBeDefined();
  });

  it('infers testnet passphrase from testnet Horizon URL when input empty', async () => {
    const result = await detectPassphraseMismatch(
      'https://horizon-testnet.stellar.org',
      '',
      mockFetchPassphrase(testnetPassphrase),
    );
    expect(result).toBeUndefined();
  });

  it('infers public passphrase from public Horizon URL when input empty', async () => {
    const result = await detectPassphraseMismatch(
      'https://horizon.stellar.org',
      '',
      mockFetchPassphrase(publicPassphrase),
    );
    expect(result).toBeUndefined();
  });

  it('detects mismatch when inferred passphrase differs from Horizon', async () => {
    // URL suggests testnet, but Horizon reports public
    const result = await detectPassphraseMismatch(
      'https://horizon-testnet.stellar.org',
      '',
      mockFetchPassphrase(publicPassphrase),
    );
    
    expect(result).toBeDefined();
    expect(result?.message).toContain('testnet');
    expect(result?.message).toContain('public');
  });

  it('returns undefined when fetch fails (fail-open)', async () => {
    const mockFail = async () => {
      throw new Error('Network error');
    };
    
    const result = await detectPassphraseMismatch(
      'https://horizon.stellar.org',
      publicPassphrase,
      mockFail,
    );
    
    expect(result).toBeUndefined();
  });

  it('includes remediation guidance in message', async () => {
    const result = await detectPassphraseMismatch(
      'https://horizon.stellar.org',
      testnetPassphrase,
      mockFetchPassphrase(publicPassphrase),
    );
    
    expect(result?.message).toContain('horizon_url');
    expect(result?.message).toContain('network_passphrase');
    expect(result?.message).toContain('match');
  });

  it('explains 404 error consequence in message', async () => {
    const result = await detectPassphraseMismatch(
      'https://horizon.stellar.org',
      testnetPassphrase,
      mockFetchPassphrase(publicPassphrase),
    );
    
    expect(result?.message).toContain('404');
  });
});

// ---------------------------------------------------------------------------
// Comment integration
// ---------------------------------------------------------------------------

describe('formatCommentBody with network passphrase mismatch', () => {
  const baseResult: ValidationResult = {
    valid: false,
    accountFunded: false,
    trustlineExists: false,
    xlmBalance: '0',
    xlmReserveMet: false,
    checks: [],
  };

  const commentConfig = {
    assetCode: 'USDC',
    assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    minXlmReserve: 1.5,
    stellarAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    horizonUrl: 'https://horizon.stellar.org',
  };

  it('includes mismatch banner when mismatch detected', () => {
    const result: ValidationResult = {
      ...baseResult,
      networkPassphraseMismatch: {
        expectedPassphrase: 'Test SDF Network ; September 2015',
        actualPassphrase: 'Public Global Stellar Network ; September 2015',
        message: 'You configured testnet but Horizon URL points to public.',
      },
    };
    
    const comment = formatCommentBody(result, commentConfig);
    
    expect(comment).toContain('Network passphrase mismatch detected');
    expect(comment).toContain('Expected');
    expect(comment).toContain('Horizon reports');
    expect(comment).toContain('Test SDF Network ; September 2015');
    expect(comment).toContain('Public Global Stellar Network ; September 2015');
  });

  it('does not include mismatch banner when no mismatch', () => {
    const result: ValidationResult = {
      ...baseResult,
    };
    
    const comment = formatCommentBody(result, commentConfig);
    
    expect(comment).not.toContain('Network passphrase mismatch detected');
  });

  it('positions mismatch banner after freshness check', () => {
    const result: ValidationResult = {
      ...baseResult,
      ledgerFreshnessResult: {
        fresh: true,
        lagSeconds: 5,
        latestLedger: 12345,
        message: 'Horizon is fresh',
        status: 'ok',
      },
      networkPassphraseMismatch: {
        expectedPassphrase: 'Test SDF Network ; September 2015',
        actualPassphrase: 'Public Global Stellar Network ; September 2015',
        message: 'Mismatch',
      },
    };
    
    const comment = formatCommentBody(result, { ...commentConfig, checkLedgerFreshness: true });
    
    const freshnessPos = comment.indexOf('Ledger freshness');
    const mismatchPos = comment.indexOf('Network passphrase mismatch');
    
    expect(freshnessPos).toBeGreaterThan(-1);
    expect(mismatchPos).toBeGreaterThan(freshnessPos);
  });

  it('uses alert emoji for mismatch banner', () => {
    const result: ValidationResult = {
      ...baseResult,
      networkPassphraseMismatch: {
        expectedPassphrase: 'Test',
        actualPassphrase: 'Public',
        message: 'Mismatch',
      },
    };
    
    const comment = formatCommentBody(result, commentConfig);
    expect(comment).toContain('🚨');
  });

  it('shows both expected and actual passphrases in banner', () => {
    const result: ValidationResult = {
      ...baseResult,
      networkPassphraseMismatch: {
        expectedPassphrase: 'Custom Network A',
        actualPassphrase: 'Custom Network B',
        message: 'Mismatch',
      },
    };
    
    const comment = formatCommentBody(result, commentConfig);
    
    expect(comment).toContain('Custom Network A');
    expect(comment).toContain('Custom Network B');
  });

  it('includes configuration error explanation', () => {
    const result: ValidationResult = {
      ...baseResult,
      networkPassphraseMismatch: {
        expectedPassphrase: 'Test',
        actualPassphrase: 'Public',
        message: 'Mismatch',
      },
    };
    
    const comment = formatCommentBody(result, commentConfig);
    
    expect(comment).toContain('configuration error');
    expect(comment).toContain('404 errors');
  });
});

// ---------------------------------------------------------------------------
// Outputs integration
// ---------------------------------------------------------------------------

describe('toActionOutputs with network passphrase mismatch', () => {
  const baseResult: ValidationResult = {
    valid: false,
    accountFunded: false,
    trustlineExists: false,
    xlmBalance: '0',
    xlmReserveMet: false,
    checks: [],
  };

  it('includes network_passphrase_mismatch output', () => {
    const result: ValidationResult = {
      ...baseResult,
      networkPassphraseMismatch: {
        expectedPassphrase: 'Test SDF Network ; September 2015',
        actualPassphrase: 'Public Global Stellar Network ; September 2015',
        message: 'Mismatch',
      },
    };
    
    const outputs = toActionOutputs(result);
    
    expect(outputs.network_passphrase_mismatch).toBe('true');
    expect(outputs.expected_network_passphrase).toBe('Test SDF Network ; September 2015');
    expect(outputs.actual_network_passphrase).toBe('Public Global Stellar Network ; September 2015');
  });

  it('sets network_passphrase_mismatch to false when no mismatch', () => {
    const result: ValidationResult = {
      ...baseResult,
    };
    
    const outputs = toActionOutputs(result);
    
    expect(outputs.network_passphrase_mismatch).toBe('false');
    expect(outputs.expected_network_passphrase).toBe('');
    expect(outputs.actual_network_passphrase).toBe('');
  });

  it('exposes passphrase strings in outputs for debugging', () => {
    const result: ValidationResult = {
      ...baseResult,
      networkPassphraseMismatch: {
        expectedPassphrase: 'My Custom Network ; 2024',
        actualPassphrase: 'Test SDF Network ; September 2015',
        message: 'Mismatch',
      },
    };
    
    const outputs = toActionOutputs(result);
    
    expect(outputs.expected_network_passphrase).toBe('My Custom Network ; 2024');
    expect(outputs.actual_network_passphrase).toBe('Test SDF Network ; September 2015');
  });

  it('preserves other outputs when mismatch present', () => {
    const result: ValidationResult = {
      ...baseResult,
      accountFunded: true,
      xlmBalance: '5.0',
      networkPassphraseMismatch: {
        expectedPassphrase: 'Test',
        actualPassphrase: 'Public',
        message: 'Mismatch',
      },
    };
    
    const outputs = toActionOutputs(result, 'https://github.com/comment');
    
    expect(outputs.account_funded).toBe('true');
    expect(outputs.xlm_balance).toBe('5.0');
    expect(outputs.comment_url).toBe('https://github.com/comment');
    expect(outputs.network_passphrase_mismatch).toBe('true');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('Network passphrase mismatch edge cases', () => {
  it('handles very long custom passphrases', async () => {
    const longPassphrase = 'A'.repeat(500);
    const result = await detectPassphraseMismatch(
      'https://horizon.example.com',
      longPassphrase,
      async () => 'Test SDF Network ; September 2015',
    );
    
    expect(result).toBeDefined();
    expect(result?.expectedPassphrase).toBe(longPassphrase);
  });

  it('handles passphrases with special characters', async () => {
    const specialPassphrase = 'Network™ ; 2024 (α/β) [test]';
    const result = await detectPassphraseMismatch(
      'https://horizon.example.com',
      specialPassphrase,
      async () => 'Test SDF Network ; September 2015',
    );
    
    expect(result).toBeDefined();
    expect(result?.expectedPassphrase).toBe(specialPassphrase);
  });

  it('does not leak full passphrase in message when very long', async () => {
    const longPassphrase = 'X'.repeat(1000);
    const result = await detectPassphraseMismatch(
      'https://horizon.example.com',
      longPassphrase,
      async () => 'Test SDF Network ; September 2015',
    );
    
    // Message should still be reasonable length
    expect(result?.message.length).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// Issue #707 — network preset defaults for pubnet, testnet and futurenet
// ---------------------------------------------------------------------------
describe('network presets (Issue #707)', () => {
  const PRESETS: Array<[StellarNetworkPreset, string, string, string | null]> = [
    ['public', 'https://horizon.stellar.org', 'Public Global Stellar Network ; September 2015', null],
    ['testnet', 'https://horizon-testnet.stellar.org', 'Test SDF Network ; September 2015', 'https://friendbot.stellar.org'],
    [
      'futurenet',
      'https://horizon-futurenet.stellar.org',
      'Test SDF Future Network ; October 2022',
      'https://friendbot-futurenet.stellar.org',
    ],
  ];

  it.each(PRESETS)('%s preset has the documented Horizon URL, passphrase and Friendbot', (network, horizonUrl, passphrase, friendbotUrl) => {
    expect(STELLAR_NETWORK_PRESETS[network]).toEqual({
      horizonUrl,
      networkPassphrase: passphrase,
      friendbotUrl,
    });
  });

  it.each(PRESETS)('inferStellarNetworkPreset classifies the official %s host', (network, horizonUrl) => {
    expect(inferStellarNetworkPreset(horizonUrl)).toBe(network);
    expect(inferStellarNetworkPreset(`${horizonUrl}/`)).toBe(network);
    expect(inferStellarNetworkPreset(horizonUrl.toUpperCase())).toBe(network);
  });

  it('inferStellarNetwork classifies the official pubnet and testnet hosts', () => {
    expect(inferStellarNetwork('https://horizon.stellar.org')).toBe('public');
    expect(inferStellarNetwork('https://horizon-testnet.stellar.org')).toBe('testnet');
    for (const [url, network] of Object.entries(KNOWN_HORIZON_NETWORKS)) {
      expect(inferStellarNetwork(url)).toBe(network);
      expect(canonicalHorizonUrl(network)).toBe(url);
    }
  });

  it('pubnet and testnet presets agree with the canonical link helpers', () => {
    expect(canonicalHorizonUrl('public')).toBe(STELLAR_NETWORK_PRESETS.public.horizonUrl);
    expect(canonicalHorizonUrl('testnet')).toBe(STELLAR_NETWORK_PRESETS.testnet.horizonUrl);
  });

  it('infers the network from a custom testnet horizon_url when the host says so', () => {
    expect(inferStellarNetworkPreset('https://horizon-testnet.example.com')).toBe('testnet');
    expect(inferStellarNetworkPreset('https://my-futurenet-mirror.example.com')).toBe('futurenet');
    // Hosts that carry no network hint default to public.
    expect(inferStellarNetworkPreset('https://horizon.example.com')).toBe('public');
  });

  it.each(PRESETS)('official %s Horizon host passes the SSRF allowlist', (_network, horizonUrl) => {
    expect(validateHorizonUrl(horizonUrl).valid).toBe(true);
  });

  it.each(PRESETS)('%s preset Friendbot compatibility matches the network guard', (_network, horizonUrl, _passphrase, friendbotUrl) => {
    if (friendbotUrl === null) {
      expect(isTestnetHorizon(horizonUrl)).toBe(false);
    } else {
      expect(isTestnetHorizon(horizonUrl)).toBe(true);
      expect(isFriendbotAllowed(friendbotUrl)).toBe(true);
    }
  });

  it.each(PRESETS)('infers the %s passphrase from the preset Horizon when network_passphrase is empty', async (_network, horizonUrl, passphrase) => {
    const result = await detectPassphraseMismatch(horizonUrl, '', async () => passphrase);
    expect(result).toBeUndefined();
  });

  it('flags a futurenet Horizon paired with a testnet passphrase', async () => {
    const result = await detectPassphraseMismatch(
      'https://horizon-futurenet.stellar.org',
      'Test SDF Network ; September 2015',
      async () => 'Test SDF Future Network ; October 2022',
    );
    expect(result).toBeDefined();
    expect(result?.actualPassphrase).toBe('Test SDF Future Network ; October 2022');
  });

  it('flags a pubnet Horizon paired with the futurenet passphrase', async () => {
    const result = await detectPassphraseMismatch(
      'https://horizon.stellar.org',
      'Test SDF Future Network ; October 2022',
      async () => 'Public Global Stellar Network ; September 2015',
    );
    expect(result).toBeDefined();
  });
});
