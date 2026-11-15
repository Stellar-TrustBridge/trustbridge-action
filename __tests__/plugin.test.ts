/**
 * Tests for the CheckPlugin interface, PluginRegistry, runPlugins(),
 * and the three corePlugins reference implementations.
 */
import { CheckPlugin, CheckPluginContext, PluginRegistry, defaultRegistry } from '../src/plugin';
import { runPlugins, DEFAULT_PLUGIN_TIMEOUT_MS } from '../src/pluginRunner';
import {
  accountFundedPlugin,
  trustlinePlugin,
  xlmReservePlugin,
  corePlugins,
} from '../src/corePlugins';
import * as corePluginsModule from '../src/corePlugins';
import { HorizonAccount } from '../src/horizon';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const TEST_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

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

function makeCtx(
  accountOverride: HorizonAccount | null = makeAccount(),
  configOverride = baseConfig,
): CheckPluginContext {
  return {
    account: accountOverride,
    config: configOverride,
    stellarAddress: TEST_ADDRESS,
  };
}

function makeRegistry(...plugins: CheckPlugin[]): PluginRegistry {
  const r = new PluginRegistry();
  plugins.forEach((p) => r.register(p));
  return r;
}

// ---------------------------------------------------------------------------
// PluginRegistry
// ---------------------------------------------------------------------------

describe('PluginRegistry', () => {
  it('starts empty', () => {
    const r = new PluginRegistry();
    expect(r.size).toBe(0);
    expect(r.list()).toEqual([]);
  });

  it('registers a plugin and returns it via list()', () => {
    const r = new PluginRegistry();
    r.register(accountFundedPlugin);
    expect(r.size).toBe(1);
    expect(r.list()[0]).toBe(accountFundedPlugin);
  });

  it('preserves insertion order', () => {
    const r = makeRegistry(accountFundedPlugin, trustlinePlugin, xlmReservePlugin);
    const ids = r.list().map((p) => p.id);
    expect(ids).toEqual([
      'trustbridge/account-funded',
      'trustbridge/trustline',
      'trustbridge/xlm-reserve',
    ]);
  });

  it('silently ignores duplicate ids (first-wins)', () => {
    const duplicate: CheckPlugin = {
      id: 'trustbridge/account-funded',
      label: 'Duplicate',
      run: () => ({ passed: false, detail: 'dup' }),
    };
    const r = new PluginRegistry();
    r.register(accountFundedPlugin);
    r.register(duplicate);

    expect(r.size).toBe(1);
    expect(r.list()[0].label).toBe('Account funded');
  });

  it('unregisters a plugin by id and returns true', () => {
    const r = makeRegistry(accountFundedPlugin);
    expect(r.unregister('trustbridge/account-funded')).toBe(true);
    expect(r.size).toBe(0);
  });

  it('returns false when unregistering a non-existent id', () => {
    const r = new PluginRegistry();
    expect(r.unregister('does-not-exist')).toBe(false);
  });

  it('clear() removes all plugins', () => {
    const r = makeRegistry(accountFundedPlugin, trustlinePlugin);
    r.clear();
    expect(r.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// defaultRegistry isolation
// ---------------------------------------------------------------------------

describe('defaultRegistry', () => {
  afterEach(() => {
    defaultRegistry.clear();
  });

  it('is a PluginRegistry instance', () => {
    expect(defaultRegistry).toBeInstanceOf(PluginRegistry);
  });

  it('can register and list plugins', () => {
    defaultRegistry.register(accountFundedPlugin);
    expect(defaultRegistry.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runPlugins — empty registry
// ---------------------------------------------------------------------------

describe('runPlugins with empty registry', () => {
  it('returns valid=true with no checks', () => {
    const r = new PluginRegistry();
    const result = runPlugins(makeCtx(), r);
    expect(result.valid).toBe(true);
    expect(result.checks).toHaveLength(0);
    expect(result.remediation).toBeUndefined();
  });

  it('sets accountFunded from ctx.account when no account-funded plugin', () => {
    const r = new PluginRegistry();
    expect(runPlugins(makeCtx(makeAccount()), r).accountFunded).toBe(true);
    expect(runPlugins(makeCtx(null), r).accountFunded).toBe(false);
  });

  it('sets xlmBalance from native balance entry', () => {
    const r = new PluginRegistry();
    const result = runPlugins(makeCtx(makeAccount()), r);
    expect(result.xlmBalance).toBe('10.0000000');
  });

  it('sets xlmBalance to unknown when account is null', () => {
    const r = new PluginRegistry();
    const result = runPlugins(makeCtx(null), r);
    expect(result.xlmBalance).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// runPlugins — single passing plugin
// ---------------------------------------------------------------------------

describe('runPlugins with a single passing plugin', () => {
  const passingPlugin: CheckPlugin = {
    id: 'test/always-pass',
    label: 'Always pass',
    run: () => ({ passed: true, detail: 'All good.' }),
  };

  it('produces valid=true, one check, no remediation', () => {
    const r = makeRegistry(passingPlugin);
    const result = runPlugins(makeCtx(), r);

    expect(result.valid).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toEqual({ passed: true, label: 'Always pass', detail: 'All good.' });
    expect(result.remediation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runPlugins — failure and remediation propagation
// ---------------------------------------------------------------------------

describe('runPlugins failure and remediation propagation', () => {
  const failingPlugin: CheckPlugin = {
    id: 'test/always-fail',
    label: 'Always fail',
    run: () => ({
      passed: false,
      detail: 'Something went wrong.',
      remediation: 'Fix it by doing X.',
    }),
  };

  it('sets valid=false when any plugin fails', () => {
    const r = makeRegistry(failingPlugin);
    expect(runPlugins(makeCtx(), r).valid).toBe(false);
  });

  it('includes the failed check detail in checks array', () => {
    const r = makeRegistry(failingPlugin);
    const result = runPlugins(makeCtx(), r);
    expect(result.checks[0].passed).toBe(false);
    expect(result.checks[0].detail).toBe('Something went wrong.');
  });

  it('propagates remediation from failing plugin', () => {
    const r = makeRegistry(failingPlugin);
    expect(runPlugins(makeCtx(), r).remediation).toBe('Fix it by doing X.');
  });

  it('joins multiple remediation strings with double newline', () => {
    const fail2: CheckPlugin = {
      id: 'test/fail-2',
      label: 'Fail 2',
      run: () => ({ passed: false, detail: 'Also broken.', remediation: 'Fix Y too.' }),
    };
    const r = makeRegistry(failingPlugin, fail2);
    const result = runPlugins(makeCtx(), r);
    expect(result.remediation).toBe('Fix it by doing X.\n\nFix Y too.');
  });

  it('omits remediation from plugins that pass', () => {
    const passingWithRemediation: CheckPlugin = {
      id: 'test/pass-with-note',
      label: 'Pass',
      run: () => ({ passed: true, detail: 'OK', remediation: 'Should not appear' }),
    };
    const r = makeRegistry(passingWithRemediation);
    expect(runPlugins(makeCtx(), r).remediation).toBeUndefined();
  });

  it('omits remediation when failing plugin provides none', () => {
    const silentFail: CheckPlugin = {
      id: 'test/silent-fail',
      label: 'Silent fail',
      run: () => ({ passed: false, detail: 'Nope.' }),
    };
    const r = makeRegistry(silentFail);
    expect(runPlugins(makeCtx(), r).remediation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runPlugins — error resilience
// ---------------------------------------------------------------------------

describe('runPlugins error resilience', () => {
  it('catches a throwing plugin and marks its check as failed', () => {
    const throwingPlugin: CheckPlugin = {
      id: 'test/throws',
      label: 'Throws',
      run: () => { throw new Error('boom'); },
    };
    const r = makeRegistry(throwingPlugin);
    const result = runPlugins(makeCtx(), r);

    expect(result.valid).toBe(false);
    expect(result.checks[0].passed).toBe(false);
    expect(result.checks[0].detail).toContain('boom');
  });

  it('still runs subsequent plugins after one throws', () => {
    const throwingPlugin: CheckPlugin = {
      id: 'test/throws',
      label: 'Throws',
      run: () => { throw new Error('boom'); },
    };
    const okPlugin: CheckPlugin = {
      id: 'test/ok',
      label: 'OK',
      run: () => ({ passed: true, detail: 'Fine.' }),
    };
    const r = makeRegistry(throwingPlugin, okPlugin);
    const result = runPlugins(makeCtx(), r);

    expect(result.checks).toHaveLength(2);
    expect(result.checks[1].passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runPlugins — well-known id suffix derivation
// ---------------------------------------------------------------------------

describe('runPlugins well-known id suffix derivation', () => {
  it('derives accountFunded=true from a passing account-funded plugin', () => {
    const p: CheckPlugin = {
      id: 'custom/account-funded',
      label: 'Funded',
      run: () => ({ passed: true, detail: 'yes' }),
    };
    const r = makeRegistry(p);
    expect(runPlugins(makeCtx(null), r).accountFunded).toBe(true);
  });

  it('derives trustlineExists=true from a passing trustline plugin', () => {
    const p: CheckPlugin = {
      id: 'custom/trustline',
      label: 'TL',
      run: () => ({ passed: true, detail: 'has tl' }),
    };
    const r = makeRegistry(p);
    expect(runPlugins(makeCtx(), r).trustlineExists).toBe(true);
  });

  it('derives xlmReserveMet=true from a passing xlm-reserve plugin', () => {
    const p: CheckPlugin = {
      id: 'custom/xlm-reserve',
      label: 'Reserve',
      run: () => ({ passed: true, detail: 'met' }),
    };
    const r = makeRegistry(p);
    expect(runPlugins(makeCtx(), r).xlmReserveMet).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// corePlugins — accountFundedPlugin
// ---------------------------------------------------------------------------

describe('accountFundedPlugin', () => {
  it('has stable id and label', () => {
    expect(accountFundedPlugin.id).toBe('trustbridge/account-funded');
    expect(accountFundedPlugin.label).toBe('Account funded');
  });

  it('passes when account is present', () => {
    const r = accountFundedPlugin.run(makeCtx(makeAccount()));
    expect(r.passed).toBe(true);
    expect(r.remediation).toBeUndefined();
  });

  it('fails when account is null', () => {
    const r = accountFundedPlugin.run(makeCtx(null));
    expect(r.passed).toBe(false);
    expect(r.remediation).toBeDefined();
    expect(r.remediation).toContain('1 XLM');
  });

  it('detail contains the stellar address', () => {
    const r = accountFundedPlugin.run(makeCtx(makeAccount()));
    expect(r.detail).toContain(TEST_ADDRESS);
  });
});

// ---------------------------------------------------------------------------
// corePlugins — trustlinePlugin
// ---------------------------------------------------------------------------

describe('trustlinePlugin', () => {
  it('has stable id and label', () => {
    expect(trustlinePlugin.id).toBe('trustbridge/trustline');
    expect(trustlinePlugin.label).toBe('Trustline');
  });

  it('passes when the account holds the target trustline', () => {
    const r = trustlinePlugin.run(makeCtx(makeAccount()));
    expect(r.passed).toBe(true);
    expect(r.remediation).toBeUndefined();
  });

  it('fails when no trustlines exist', () => {
    const account = makeAccount({
      balances: [
        { balance: '10.0000000', asset_type: 'native',
          buying_liabilities: '0.0000000', selling_liabilities: '0.0000000' },
      ],
    });
    const r = trustlinePlugin.run(makeCtx(account));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/zero trustlines/i);
    expect(r.remediation).toMatch(/Stellar Laboratory/i);
  });

  it('fails with a specific message when other trustlines exist but not USDC', () => {
    const account = makeAccount({
      balances: [
        { balance: '10.0000000', asset_type: 'native',
          buying_liabilities: '0.0000000', selling_liabilities: '0.0000000' },
        { balance: '5.0', asset_type: 'credit_alphanum4',
          asset_code: 'EURT', asset_issuer: 'GCQTGZQQ5G4PTM2RNQRAXRJJEL5CQ5Z2OY5SUJRE763CPEKE6EJUMCU',
          buying_liabilities: '0.0000000', selling_liabilities: '0.0000000' },
      ],
    });
    const r = trustlinePlugin.run(makeCtx(account));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/not for \*\*USDC\*\*/i);
  });

  it('fails gracefully when account is null', () => {
    const r = trustlinePlugin.run(makeCtx(null));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/cannot verify/i);
    expect(r.remediation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// corePlugins — xlmReservePlugin
// ---------------------------------------------------------------------------

describe('xlmReservePlugin', () => {
  it('has stable id and label', () => {
    expect(xlmReservePlugin.id).toBe('trustbridge/xlm-reserve');
    expect(xlmReservePlugin.label).toBe('XLM reserve');
  });

  it('passes when balance meets the minimum', () => {
    const r = xlmReservePlugin.run(makeCtx(makeAccount()));
    expect(r.passed).toBe(true);
    expect(r.remediation).toBeUndefined();
  });

  it('fails when balance is below minimum', () => {
    const account = makeAccount({
      balances: [
        { balance: '1.0000000', asset_type: 'native',
          buying_liabilities: '0.0000000', selling_liabilities: '0.0000000' },
      ],
    });
    const r = xlmReservePlugin.run(makeCtx(account));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/below the required/i);
    expect(r.remediation).toMatch(/Send at least/i);
  });

  it('fails gracefully when account is null', () => {
    const r = xlmReservePlugin.run(makeCtx(null));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/fund the account/i);
  });
});

// ---------------------------------------------------------------------------
// corePlugins — full pipeline via runPlugins
// ---------------------------------------------------------------------------

describe('corePlugins full pipeline', () => {
  it('all pass for a healthy account', () => {
    const r = makeRegistry(...corePlugins);
    const result = runPlugins(makeCtx(makeAccount()), r);

    expect(result.valid).toBe(true);
    expect(result.accountFunded).toBe(true);
    expect(result.trustlineExists).toBe(true);
    expect(result.xlmReserveMet).toBe(true);
    expect(result.checks).toHaveLength(4);
    expect(result.remediation).toBeUndefined();
  });

  it('fails all three for a null (unfunded) account', () => {
    const r = makeRegistry(...corePlugins);
    const result = runPlugins(makeCtx(null), r);

    expect(result.valid).toBe(false);
    expect(result.accountFunded).toBe(false);
    expect(result.trustlineExists).toBe(false);
    expect(result.xlmReserveMet).toBe(false);
    expect(result.remediation).toBeDefined();
  });

  it('fails only trustline and reserve checks when account is funded but missing trustline + low balance', () => {
    const account = makeAccount({
      balances: [
        { balance: '0.5000000', asset_type: 'native',
          buying_liabilities: '0.0000000', selling_liabilities: '0.0000000' },
      ],
    });
    const r = makeRegistry(...corePlugins);
    const result = runPlugins(makeCtx(account), r);

    expect(result.accountFunded).toBe(true);
    expect(result.trustlineExists).toBe(false);
    expect(result.xlmReserveMet).toBe(false);
    expect(result.valid).toBe(false);
    // remediation from both failing plugins
    expect(result.remediation).toMatch(/Stellar Laboratory/i);
    expect(result.remediation).toMatch(/Send at least/i);
  });

  it('exports exactly four core plugins in order', () => {
    expect(corePlugins).toHaveLength(4);
    expect(corePlugins.map((p) => p.id)).toEqual([
      'trustbridge/account-funded',
      'trustbridge/trustline',
      'trustbridge/xlm-reserve',
      'trustbridge/home-domain',
    ]);
  });
});

// ---------------------------------------------------------------------------
// corePlugins parity with docs/PLUGIN_ARCHITECTURE.md (Issue #469)
// ---------------------------------------------------------------------------

describe('corePlugins parity with PLUGIN_ARCHITECTURE.md', () => {
  const DOC_PATH = path.resolve(__dirname, '..', 'docs', 'PLUGIN_ARCHITECTURE.md');

  /** Rows of the table between the core-plugins markers: [export, id, label]. */
  function documentedCorePlugins(): Array<{ exportName: string; id: string; label: string }> {
    const doc = fs.readFileSync(DOC_PATH, 'utf8');
    const block = doc.match(/<!-- core-plugins:start -->([\s\S]*?)<!-- core-plugins:end -->/);
    if (!block) throw new Error('core-plugins table markers missing from PLUGIN_ARCHITECTURE.md');
    return block[1]
      .split('\n')
      .filter((line) => /^\|\s*`/.test(line))
      .map((line) => {
        const [exportName, id, label] = line
          .split('|')
          .slice(1, -1)
          .map((cell) => cell.trim().replace(/^`|`$/g, ''));
        return { exportName, id, label };
      });
  }

  /** Every `*Plugin` export of src/corePlugins.ts. */
  function exportedPluginNames(): string[] {
    return Object.keys(corePluginsModule).filter((k) => k.endsWith('Plugin'));
  }

  it('documents at least one core plugin', () => {
    expect(documentedCorePlugins().length).toBeGreaterThan(0);
  });

  it('documented ids and labels match corePlugins in order', () => {
    const documented = documentedCorePlugins().map(({ id, label }) => ({ id, label }));
    expect(corePlugins.map(({ id, label }) => ({ id, label }))).toEqual(documented);
  });

  it('documented export names resolve to the same plugin objects as corePlugins', () => {
    const exportsByName = corePluginsModule as unknown as Record<string, CheckPlugin>;
    const documented = documentedCorePlugins().map((row) => exportsByName[row.exportName]);
    expect(documented).toEqual(corePlugins);
  });

  it('every exported *Plugin is registered in corePlugins and documented', () => {
    const documentedNames = documentedCorePlugins().map((row) => row.exportName);
    const exportsByName = corePluginsModule as unknown as Record<string, CheckPlugin>;
    for (const name of exportedPluginNames()) {
      expect(documentedNames).toContain(name);
      expect(corePlugins).toContain(exportsByName[name]);
    }
  });

  it('core plugin ids are unique', () => {
    const ids = corePlugins.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// Security: plugins must not receive or process untrusted strings as code
// ---------------------------------------------------------------------------

describe('security: plugin context isolation', () => {
  it('ctx.config is a frozen-compatible read-only object (no mutation)', () => {
    // Plugins receive ctx by reference. Verify that mutating the returned
    // result does not affect the original config — the contract is enforced
    // by TypeScript's `readonly` modifier, verified here at the shape level.
    const ctx = makeCtx();
    const originalAssetCode = ctx.config.assetCode;

    accountFundedPlugin.run(ctx);
    trustlinePlugin.run(ctx);
    xlmReservePlugin.run(ctx);

    expect(ctx.config.assetCode).toBe(originalAssetCode);
  });

  it('plugin detail escapes Markdown-injectable characters from asset code', () => {
    // Simulate a plugin receiving a malicious asset code that tries to inject
    // Markdown formatting. The plugin MUST escape it before embedding in detail.
    // escapeMarkdownInline escapes: ` * _ { } [ ] ( ) # + . ! | > ~ -
    const maliciousCode = 'USDC*bold*[link](https://evil.example)';
    const ctx = makeCtx(makeAccount(), { ...baseConfig, assetCode: maliciousCode });

    const result = trustlinePlugin.run(ctx);

    // Raw Markdown link injection must not appear verbatim
    expect(result.detail).not.toContain('[link](https://evil.example)');
    // Asterisks must be escaped
    expect(result.detail).toContain('\\*bold\\*');
  });

  it('escapes backtick injection in asset issuer detail', () => {
    const maliciousIssuer = 'GENUINE` [evil](https://evil.example) `END';
    // Account has a different trustline so the "has trustlines but not for X" path is taken
    // — which embeds the issuer via inlineCode(), escaping the backtick.
    const account = makeAccount({
      balances: [
        { balance: '10.0000000', asset_type: 'native',
          buying_liabilities: '0.0000000', selling_liabilities: '0.0000000' },
        { balance: '5.0', asset_type: 'credit_alphanum4',
          asset_code: 'EURT',
          asset_issuer: 'GCQTGZQQ5G4PTM2RNQRAXRJJEL5CQ5Z2OY5SUJRE763CPEKE6EJUMCU',
          buying_liabilities: '0.0000000', selling_liabilities: '0.0000000' },
      ],
    });
    const ctx = makeCtx(account, { ...baseConfig, assetIssuer: maliciousIssuer });

    const result = trustlinePlugin.run(ctx);
    // The raw backtick-injection pattern must not appear verbatim
    expect(result.detail).not.toContain('GENUINE` [evil]');
    // The backtick must be escaped
    expect(result.detail).toContain('\\`');
  });

  it('plugin run() receives only typed context — no process.env access needed', () => {
    // Verify the plugin interface shape: run() takes only CheckPluginContext.
    // This test documents the contract rather than enforcing runtime sandboxing,
    // which is a code-review concern.
    const ctx = makeCtx();
    expect(() => accountFundedPlugin.run(ctx)).not.toThrow();
    expect(() => trustlinePlugin.run(ctx)).not.toThrow();
    expect(() => xlmReservePlugin.run(ctx)).not.toThrow();
  });

  it('escapes external plugin label, detail, and remediation to prevent Markdown injection', () => {
    const maliciousPlugin: CheckPlugin = {
      id: 'external/malicious',
      label: 'Malicious **bold**',
      run: () => ({
        passed: false,
        detail: 'Look at my [link](javascript:alert(1))',
        remediation: 'Run this `rm -rf /`',
      }),
    };
    const r = makeRegistry(maliciousPlugin);
    const result = runPlugins(makeCtx(), r);

    expect(result.checks[0].label).toContain('\\*\\*bold\\*\\*');
    expect(result.checks[0].detail).toContain('\\[link\\]\\(javascript:alert\\(1\\)\\)');
    expect(result.remediation).toContain('\\`rm -rf /\\`');
  });

  it('does not escape core plugin outputs to preserve rich formatting', () => {
    const coreLikePlugin: CheckPlugin = {
      id: 'trustbridge/test-core',
      label: 'Core label',
      run: () => ({
        passed: false,
        detail: 'Core **detail**',
        remediation: 'Core [link](https://example.com)',
      }),
    };
    const r = makeRegistry(coreLikePlugin);
    const result = runPlugins(makeCtx(), r);

    expect(result.checks[0].detail).toBe('Core **detail**');
    expect(result.remediation).toBe('Core [link](https://example.com)');
  });
});

// ---------------------------------------------------------------------------
// Sandbox resource limits — wall-clock timeout & fail-closed isolation (#797)
// ---------------------------------------------------------------------------

describe('sandbox resource limits: wall-clock timeout and fail-closed isolation (#797)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('exports DEFAULT_PLUGIN_TIMEOUT_MS = 5000 as documented in PLUGIN_ARCHITECTURE.md', () => {
    expect(DEFAULT_PLUGIN_TIMEOUT_MS).toBe(5000);
  });

  it('passes when a plugin completes within the configured timeoutMs budget (happy path)', () => {
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    const fastPlugin: CheckPlugin = {
      id: 'custom/fast-check',
      label: 'Fast check',
      run: () => {
        now += 25; // 25ms elapsed <= 100ms timeoutMs
        return { passed: true, detail: 'Completed within budget' };
      },
    };

    const r = makeRegistry(fastPlugin);
    const result = runPlugins(makeCtx(), r, { timeoutMs: 100 });

    expect(result.valid).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toEqual({
      passed: true,
      label: 'Fast check',
      detail: 'Completed within budget',
    });
    expect(result.remediation).toBeUndefined();
  });

  it('fails closed when a plugin exceeds timeoutMs and still runs subsequent plugins (failure path)', () => {
    let now = 10_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    const slowPlugin: CheckPlugin = {
      id: 'acme/slow-check',
      label: 'Slow check',
      run: () => {
        now += 150; // 150ms elapsed > 50ms timeoutMs
        return { passed: true, detail: 'Should be discarded on timeout' };
      },
    };

    const healthyPlugin: CheckPlugin = {
      id: 'trustbridge/account-funded',
      label: 'Account funded',
      run: () => {
        now += 5; // 5ms elapsed <= 50ms timeoutMs
        return { passed: true, detail: 'Account is funded.' };
      },
    };

    const r = makeRegistry(slowPlugin, healthyPlugin);
    const result = runPlugins(makeCtx(), r, { timeoutMs: 50 });

    expect(result.valid).toBe(false);
    expect(result.checks).toHaveLength(2);
    expect(result.checks[0].passed).toBe(false);
    expect(result.checks[0].detail).toContain('timed out after 50ms');
    expect(result.remediation).toContain('Contact the plugin author to fix');
    // Isolation boundary: subsequent core plugin still runs and passes
    expect(result.checks[1]).toEqual({
      passed: true,
      label: 'Account funded',
      detail: 'Account is funded.',
    });
    expect(result.accountFunded).toBe(true);
  });
});
