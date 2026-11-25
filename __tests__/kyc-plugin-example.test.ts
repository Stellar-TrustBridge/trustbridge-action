/**
 * Tests for docs/examples/kyc-plugin.ts
 *
 * Covers:
 *  - Pass / fail output shapes for every KycStatus value
 *  - No PII (API key, raw address) in detail or remediation strings
 *  - Markdown escape hardening for injected referenceToken and kycUrl values
 *  - Provider error recovery
 *  - Optional behaviour: plugin absent from registry leaves core checks intact
 */

import { createKycPlugin, KycLookupFn, KycStatus } from '../docs/examples/kyc-plugin';
import { PluginRegistry, CheckPluginContext } from '../src/plugin';
import { runPlugins } from '../src/pluginRunner';
import { corePlugins } from '../src/corePlugins';
import { HorizonAccount } from '../src/horizon';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  setOutput: jest.fn(),
  getInput: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const FAKE_API_KEY = 'sk_test_THIS_IS_NOT_A_REAL_KEY';
const KYC_URL = 'https://kyc.example.test/verify';

const baseConfig = {
  assetCode: 'USDC',
  assetIssuer: USDC_ISSUER,
  minXlmReserve: 1.5,
  horizonUrl: 'https://horizon.stellar.org',
};

function makeAccount(overrides: Partial<HorizonAccount> = {}): HorizonAccount {
  return {
    id: TEST_ADDRESS,
    account_id: TEST_ADDRESS,
    sequence: '1',
    subentry_count: 1,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [
      {
        balance: '10.0000000',
        asset_type: 'native',
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
      },
      {
        balance: '100.0000000',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: USDC_ISSUER,
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
      },
    ],
    ...overrides,
  };
}

function makeCtx(account: HorizonAccount | null = makeAccount()): CheckPluginContext {
  return { account, config: baseConfig, stellarAddress: TEST_ADDRESS };
}

/** Build a lookup function that always returns the given status. */
function stubLookup(status: KycStatus['status'], referenceToken?: string): KycLookupFn {
  return (_address: string, _apiKey: string): KycStatus => ({ status, referenceToken });
}

/** Build a lookup function that always throws. */
function throwingLookup(message = 'provider unavailable'): KycLookupFn {
  return () => { throw new Error(message); };
}

/** Create a plugin with sensible defaults. */
function makePlugin(
  lookupFn: KycLookupFn,
  overrides: { apiKey?: string; kycUrl?: string } = {},
) {
  return createKycPlugin({
    lookupFn,
    apiKey: overrides.apiKey ?? FAKE_API_KEY,
    kycUrl: overrides.kycUrl ?? KYC_URL,
  });
}

// ---------------------------------------------------------------------------
// createKycPlugin — return shape
// ---------------------------------------------------------------------------

describe('createKycPlugin return shape', () => {
  it('returns a CheckPlugin with stable id and label', () => {
    const p = makePlugin(stubLookup('approved'));
    expect(p.id).toBe('consumer/kyc-check');
    expect(p.label).toBe('KYC verified');
  });

  it('exposes a run() function', () => {
    const p = makePlugin(stubLookup('approved'));
    expect(typeof p.run).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Pass path — approved
// ---------------------------------------------------------------------------

describe('KYC status: approved', () => {
  it('returns passed=true', () => {
    const p = makePlugin(stubLookup('approved'));
    expect(p.run(makeCtx()).passed).toBe(true);
  });

  it('detail contains the Stellar address as inline code', () => {
    const p = makePlugin(stubLookup('approved'));
    const { detail } = p.run(makeCtx());
    expect(detail).toContain(`\`${TEST_ADDRESS}\``);
  });

  it('no remediation on approval', () => {
    const p = makePlugin(stubLookup('approved'));
    expect(p.run(makeCtx()).remediation).toBeUndefined();
  });

  it('embeds a pseudonymous reference token when present', () => {
    const p = makePlugin(stubLookup('approved', 'ref-abc-123'));
    const { detail } = p.run(makeCtx());
    expect(detail).toContain('ref-abc-123');
  });
});

// ---------------------------------------------------------------------------
// Fail paths
// ---------------------------------------------------------------------------

describe('KYC status: pending', () => {
  it('returns passed=false', () => {
    const p = makePlugin(stubLookup('pending'));
    expect(p.run(makeCtx()).passed).toBe(false);
  });

  it('detail mentions in-progress status', () => {
    const p = makePlugin(stubLookup('pending'));
    expect(p.run(makeCtx()).detail).toMatch(/in progress/i);
  });

  it('remediation contains the KYC URL', () => {
    const p = makePlugin(stubLookup('pending'));
    const { remediation } = p.run(makeCtx());
    expect(remediation).toBeDefined();
    expect(remediation).toContain('kyc.example.test');
  });
});

describe('KYC status: rejected', () => {
  it('returns passed=false', () => {
    const p = makePlugin(stubLookup('rejected'));
    expect(p.run(makeCtx()).passed).toBe(false);
  });

  it('detail does not contain a rejection reason (could be PII)', () => {
    const p = makePlugin(stubLookup('rejected'));
    const { detail } = p.run(makeCtx());
    // Rejection reasons from the provider may contain PII — must not appear
    expect(detail).not.toMatch(/reason|document|mismatch/i);
  });

  it('remediation points to the KYC URL', () => {
    const p = makePlugin(stubLookup('rejected'));
    expect(p.run(makeCtx()).remediation).toContain('kyc.example.test');
  });
});

describe('KYC status: not_found', () => {
  it('returns passed=false', () => {
    const p = makePlugin(stubLookup('not_found'));
    expect(p.run(makeCtx()).passed).toBe(false);
  });

  it('detail says no record found', () => {
    const p = makePlugin(stubLookup('not_found'));
    expect(p.run(makeCtx()).detail).toMatch(/no kyc record found/i);
  });

  it('remediation tells contributor to complete KYC', () => {
    const p = makePlugin(stubLookup('not_found'));
    const { remediation } = p.run(makeCtx());
    expect(remediation).toMatch(/complete kyc/i);
    expect(remediation).toContain('kyc.example.test');
  });
});

// ---------------------------------------------------------------------------
// Provider error recovery
// ---------------------------------------------------------------------------

describe('provider error recovery', () => {
  it('returns passed=false when lookupFn throws', () => {
    const p = makePlugin(throwingLookup());
    expect(p.run(makeCtx()).passed).toBe(false);
  });

  it('detail is a safe generic message — no raw error internals', () => {
    const p = makePlugin(throwingLookup('internal_connection_refused'));
    const { detail } = p.run(makeCtx());
    // Should not leak internal error messages into the public comment
    expect(detail).not.toContain('internal_connection_refused');
    expect(detail).toMatch(/provider error|could not be completed/i);
  });

  it('remediation points to KYC URL even on error', () => {
    const p = makePlugin(throwingLookup());
    const { remediation } = p.run(makeCtx());
    expect(remediation).toContain('kyc.example.test');
  });

  it('emits a core.warning on provider error', () => {
    const { warning } = jest.requireMock('@actions/core') as { warning: jest.Mock };
    warning.mockClear();
    const p = makePlugin(throwingLookup('boom'));
    p.run(makeCtx());
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('warning never contains the API key', () => {
    const { warning } = jest.requireMock('@actions/core') as { warning: jest.Mock };
    warning.mockClear();
    const p = makePlugin(throwingLookup('error'), { apiKey: FAKE_API_KEY });
    p.run(makeCtx());
    const calls = warning.mock.calls.flat().join(' ');
    expect(calls).not.toContain(FAKE_API_KEY);
  });
});

// ---------------------------------------------------------------------------
// No-secret / no-PII guarantees
// ---------------------------------------------------------------------------

describe('no secrets or PII in comment output', () => {
  const statuses: KycStatus['status'][] = ['approved', 'pending', 'rejected', 'not_found'];

  for (const status of statuses) {
    it(`API key never appears in detail for status=${status}`, () => {
      const p = makePlugin(stubLookup(status));
      const { detail } = p.run(makeCtx());
      expect(detail).not.toContain(FAKE_API_KEY);
    });

    it(`API key never appears in remediation for status=${status}`, () => {
      const p = makePlugin(stubLookup(status));
      const { remediation } = p.run(makeCtx());
      if (remediation) {
        expect(remediation).not.toContain(FAKE_API_KEY);
      }
    });
  }

  it('lookup function is never called with undefined apiKey', () => {
    const calls: string[] = [];
    const trackingLookup: KycLookupFn = (_addr, key) => {
      calls.push(key);
      return { status: 'approved' };
    };
    const p = createKycPlugin({ lookupFn: trackingLookup, apiKey: FAKE_API_KEY });
    p.run(makeCtx());
    expect(calls[0]).toBe(FAKE_API_KEY);
  });
});

// ---------------------------------------------------------------------------
// Markdown escape hardening
// ---------------------------------------------------------------------------

describe('Markdown escape hardening', () => {
  it('escapes Markdown-injectable characters in referenceToken', () => {
    // A token containing brackets and backticks could break comment structure
    const maliciousToken = 'ref`[injection](https://evil.example)';
    const p = makePlugin(stubLookup('approved', maliciousToken));
    const { detail } = p.run(makeCtx());

    // The raw injection must not survive into the comment
    expect(detail).not.toContain('[injection](https://evil.example)');
    // Backtick must be escaped
    expect(detail).toContain('\\`');
  });

  it('escapes Markdown-injectable characters in kycUrl', () => {
    const maliciousUrl = 'https://kyc.example.test/verify?ref=*bold*[link](evil)';
    const p = makePlugin(stubLookup('not_found'), { kycUrl: maliciousUrl });
    const { remediation } = p.run(makeCtx());

    // Raw asterisk injection must be escaped
    expect(remediation).not.toContain('[link](evil)');
    expect(remediation).toContain('\\[link\\]');
  });

  it('wraps Stellar address in inline code backticks', () => {
    const p = makePlugin(stubLookup('approved'));
    const { detail } = p.run(makeCtx());
    // Should appear as `GAAA...` not as raw text
    expect(detail).toContain(`\`${TEST_ADDRESS}\``);
  });

  it('escapes backtick in Stellar address inside inlineCode', () => {
    // A backtick in the address would break the code span
    const trickyAddress = 'GADDR`INJECTED';
    const ctx: CheckPluginContext = {
      account: makeAccount({ account_id: trickyAddress, id: trickyAddress }),
      config: baseConfig,
      stellarAddress: trickyAddress,
    };
    const p = makePlugin(stubLookup('approved'));
    const { detail } = p.run(ctx);
    // Raw backtick-then-INJECTED must not appear
    expect(detail).not.toContain('GADDR`INJECTED');
    expect(detail).toContain('\\`');
  });
});

// ---------------------------------------------------------------------------
// Optional behaviour — plugin absent leaves core checks intact
// ---------------------------------------------------------------------------

describe('optional behaviour — KYC plugin absent', () => {
  it('core checks still produce valid=true for a healthy account without KYC plugin', () => {
    const registry = new PluginRegistry();
    corePlugins.forEach(p => registry.register(p));
    // KYC plugin deliberately NOT registered

    const result = runPlugins(makeCtx(makeAccount()), registry);

    expect(result.valid).toBe(true);
    expect(result.checks).toHaveLength(4);
    expect(result.checks.map(c => c.label)).not.toContain('KYC verified');
  });

  it('registering KYC plugin adds a fourth check', () => {
    const registry = new PluginRegistry();
    corePlugins.forEach(p => registry.register(p));
    registry.register(makePlugin(stubLookup('approved')));

    const result = runPlugins(makeCtx(makeAccount()), registry);

    expect(result.checks).toHaveLength(5);
    expect(result.checks.map(c => c.label)).toContain('KYC verified');
    const kyc = result.checks.find(c => c.label === 'KYC verified');
    expect(kyc?.passed).toBe(true);
  });

  it('KYC failure blocks the overall result even when core checks pass', () => {
    const registry = new PluginRegistry();
    corePlugins.forEach(p => registry.register(p));
    registry.register(makePlugin(stubLookup('rejected')));

    const result = runPlugins(makeCtx(makeAccount()), registry);

    expect(result.valid).toBe(false);
    // Core checks still individually pass
    expect(result.accountFunded).toBe(true);
    expect(result.trustlineExists).toBe(true);
    expect(result.xlmReserveMet).toBe(true);
  });

  it('KYC remediation is appended to overall remediation', () => {
    const registry = new PluginRegistry();
    corePlugins.forEach(p => registry.register(p));
    registry.register(makePlugin(stubLookup('not_found')));

    const result = runPlugins(makeCtx(makeAccount()), registry);

    expect(result.remediation).toBeDefined();
    expect(result.remediation).toContain('kyc.example.test');
  });
});
