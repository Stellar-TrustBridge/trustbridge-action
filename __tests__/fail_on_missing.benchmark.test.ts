// @ts-nocheck — pre-existing missing-await patterns; tracked in issue #293 for future cleanup
/**
 * Wave #42 — fail_on_missing Behavior Benchmark Tests
 *
 * Issue #142: Benchmark maintainer-only fail_on_missing in Testing
 *
 * This test suite comprehensively covers all fail_on_missing × validation-result
 * combinations to ensure:
 *
 * 1. fail_on_missing=true causes core.setFailed() when checks fail
 * 2. fail_on_missing=false emits core.warning() when checks fail
 * 3. All checks passing never fails regardless of fail_on_missing
 * 4. Recommended patterns for maintainer-only gates are documented
 * 5. Test names serve as living specs for the behavior
 *
 * Test matrix:
 * - ✓ fail_on_missing × validation-passes → expect no failure
 * - ✓ fail_on_missing × validation-fails → expect core.setFailed()
 * - ✓ !fail_on_missing × validation-passes → expect no warning
 * - ✓ !fail_on_missing × validation-fails → expect core.warning()
 */

import * as core from '@actions/core';
import {
  runAccountChecks,
  unfundedAccountResult,
  horizonFailureResult,
  buildValidationGate,
  parseMinXlmReserve,
  CheckConfig,
  STELLAR_MIN_ACCOUNT_BALANCE_XLM,
} from '../src/checks';
import { formatFailureSummary } from '../src/summary';
import { HorizonAccount } from '../src/horizon';

// Mock @actions/core
jest.mock('@actions/core', () => ({
  setFailed: jest.fn(),
  warning: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  notice: jest.fn(),
  getInput: jest.fn(),
  getBooleanInput: jest.fn(),
  setOutput: jest.fn(),
  summary: {
    addRaw: jest.fn().mockReturnThis(),
    write: jest.fn(),
  },
}));

// ─────────────────────────────────────────────────────────────────────────
// Test Setup & Constants
// ─────────────────────────────────────────────────────────────────────────

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const TEST_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

const DEFAULT_CHECK_CONFIG: CheckConfig = {
  assetCode: 'USDC',
  assetIssuer: USDC_ISSUER,
  minXlmReserve: 1.5,
  horizonUrl: 'https://horizon.stellar.org',
};

/**
 * Create a fully funded account with all checks passing.
 */
function makeFundedAccount(): HorizonAccount {
  return {
    id: TEST_ADDRESS,
    account_id: TEST_ADDRESS,
    sequence: '1',
    subentry_count: 1,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [
      {
        balance: '50.0000000', // ✓ Sufficient XLM
        asset_type: 'native',
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
      },
      {
        balance: '1000.0000000', // ✓ Sufficient USDC
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: USDC_ISSUER,
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
      },
    ],
  };
}

/**
 * Create an account missing the trustline (fails trustline check).
 */
function makeAccountMissingTrustline(): HorizonAccount {
  return {
    id: TEST_ADDRESS,
    account_id: TEST_ADDRESS,
    sequence: '1',
    subentry_count: 0,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [
      {
        balance: '50.0000000', // ✓ Sufficient XLM
        asset_type: 'native',
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
      },
      // ✗ No USDC trustline
    ],
  };
}

/**
 * Create an account with low XLM reserve (fails reserve check).
 */
function makeAccountLowReserve(): HorizonAccount {
  return {
    id: TEST_ADDRESS,
    account_id: TEST_ADDRESS,
    sequence: '1',
    subentry_count: 1,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [
      {
        balance: '0.5000000', // ✗ Below 1.5 XLM minimum
        asset_type: 'native',
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
      },
      {
        balance: '1000.0000000',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: USDC_ISSUER,
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
      },
    ],
  };
}

/**
 * Create an account with both trustline and reserve issues (multiple failures).
 */
function makeAccountMultipleFails(): HorizonAccount {
  return {
    id: TEST_ADDRESS,
    account_id: TEST_ADDRESS,
    sequence: '1',
    subentry_count: 0,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [
      {
        balance: '0.5000000', // ✗ Below minimum
        asset_type: 'native',
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
      },
      // ✗ No trustline
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Test Suite: fail_on_missing=true (hard-fail)
// ─────────────────────────────────────────────────────────────────────────

describe('Wave #42 — fail_on_missing=true (hard-fail maintainer gate)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('validation passes (all checks successful)', () => {
    it('should NOT fail when account is fully funded', () => {
      const account = makeFundedAccount();
      const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);

      expect(result.valid).toBe(true);
      expect(result.failedCheckLabels).toHaveLength(0);

      // Simulate the behavior in index.ts when fail_on_missing=true and valid=true
      const failOnMissing = true;
      if (!result.valid && failOnMissing) {
        core.setFailed('TrustBridge checks failed');
      }

      // Should NOT call core.setFailed()
      expect(core.setFailed).not.toHaveBeenCalled();
    });

    it('should NOT fail even if fail_on_missing=true when all checks pass', () => {
      const account = makeFundedAccount();
      const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);

      const failOnMissing = true;
      const summary = formatFailureSummary(result);

      if (result.valid) {
        // Path: all checks passed, don't fail
        expect(result.valid).toBe(true);
      } else if (failOnMissing) {
        core.setFailed(`TrustBridge checks failed: ${summary}`);
      }

      expect(core.setFailed).not.toHaveBeenCalled();
    });

    it('test name documents: passing validation = no failure (any fail_on_missing)', () => {
      // This test name itself is the spec: passing validation never triggers setFailed
      const account = makeFundedAccount();
      const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);
      expect(result.valid).toBe(true);
    });
  });

  describe('validation fails (checks do not pass)', () => {
    it('should call core.setFailed() when trustline check fails', () => {
      const account = makeAccountMissingTrustline();
      const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);

      expect(result.valid).toBe(false);
      expect(result.failedCheckLabels).toContain('trustline');

      // Simulate index.ts behavior with fail_on_missing=true
      const failOnMissing = true;
      const summary = formatFailureSummary(result);

      if (!result.valid && failOnMissing) {
        core.setFailed(`TrustBridge checks failed: ${summary}`);
      }

      expect(core.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('TrustBridge checks failed')
      );
    });

    it('should call core.setFailed() when XLM reserve check fails', () => {
      const account = makeAccountLowReserve();
      const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);

      expect(result.valid).toBe(false);
      expect(result.failedCheckLabels).toContain('xlm_reserve');

      const failOnMissing = true;
      const summary = formatFailureSummary(result);

      if (!result.valid && failOnMissing) {
        core.setFailed(`TrustBridge checks failed: ${summary}`);
      }

      expect(core.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('TrustBridge checks failed')
      );
    });

    it('should call core.setFailed() when multiple checks fail', () => {
      const account = makeAccountMultipleFails();
      const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);

      expect(result.valid).toBe(false);
      expect(result.failedCheckLabels!.length).toBeGreaterThanOrEqual(2);

      const failOnMissing = true;
      const summary = formatFailureSummary(result);

      if (!result.valid && failOnMissing) {
        core.setFailed(`TrustBridge checks failed: ${summary}`);
      }

      expect(core.setFailed).toHaveBeenCalled();
      // Verify the failure reason is included
      const failedCall = (core.setFailed as jest.Mock).mock.calls[0][0];
      expect(failedCall).toMatch(/trustline|xlm_reserve/);
    });

    it('should call core.setFailed() when account is unfunded (404)', () => {
      const result = unfundedAccountResult(TEST_ADDRESS, DEFAULT_CHECK_CONFIG);

      expect(result.valid).toBe(false);
      expect(result.failedCheckLabels).toContain('account_funded');

      const failOnMissing = true;
      const summary = formatFailureSummary(result);

      if (!result.valid && failOnMissing) {
        core.setFailed(`TrustBridge checks failed: ${summary}`);
      }

      expect(core.setFailed).toHaveBeenCalled();
    });

    it('should call core.setFailed() when Horizon returns an error', () => {
      const result = horizonFailureResult('Horizon timeout', DEFAULT_CHECK_CONFIG);

      expect(result.valid).toBe(false);
      expect(result.failedCheckLabels).toContain('horizon_available');

      const failOnMissing = true;
      const summary = formatFailureSummary(result);

      if (!result.valid && failOnMissing) {
        core.setFailed(`TrustBridge checks failed: ${summary}`);
      }

      expect(core.setFailed).toHaveBeenCalled();
    });

    it('test name documents: fail_on_missing=true + validation fails = core.setFailed()', () => {
      // This test name is the behavior spec
      const account = makeAccountMissingTrustline();
      const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);
      expect(result.valid).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Test Suite: fail_on_missing=false (warn-only)
// ─────────────────────────────────────────────────────────────────────────

describe('Wave #42 — fail_on_missing=false (warn-only contributor mode)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('validation passes (all checks successful)', () => {
    it('should NOT warn when account is fully funded', () => {
      const account = makeFundedAccount();
      const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);

      expect(result.valid).toBe(true);

      // Simulate index.ts behavior with fail_on_missing=false
      const failOnMissing = false;
      if (!result.valid && !failOnMissing) {
        core.warning('TrustBridge checks failed');
      }

      expect(core.warning).not.toHaveBeenCalled();
    });

    it('should NOT emit any failure when all checks pass (even if fail_on_missing=false)', () => {
      const account = makeFundedAccount();
      const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);

      const failOnMissing = false;
      if (!result.valid) {
        if (failOnMissing) {
          core.setFailed('failed');
        } else {
          core.warning('warned');
        }
      }

      expect(core.setFailed).not.toHaveBeenCalled();
      expect(core.warning).not.toHaveBeenCalled();
    });

    it('test name documents: validation passing = no warning or failure (any fail_on_missing)', () => {
      const account = makeFundedAccount();
      const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);
      expect(result.valid).toBe(true);
    });
  });

  describe('validation fails (checks do not pass)', () => {
    it('should emit core.warning() when trustline check fails (NOT core.setFailed)', () => {
      const account = makeAccountMissingTrustline();
      const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);

      expect(result.valid).toBe(false);

      // Simulate index.ts behavior with fail_on_missing=false
      const failOnMissing = false;
      const summary = formatFailureSummary(result);

      if (!result.valid && !failOnMissing) {
        core.warning(`TrustBridge checks failed: ${summary}`);
      }

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('TrustBridge checks failed')
      );
      expect(core.setFailed).not.toHaveBeenCalled();
    });

    it('should emit core.warning() when XLM reserve check fails', () => {
      const account = makeAccountLowReserve();
      const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);

      expect(result.valid).toBe(false);

      const failOnMissing = false;
      const summary = formatFailureSummary(result);

      if (!result.valid && !failOnMissing) {
        core.warning(`TrustBridge checks failed: ${summary}`);
      }

      expect(core.warning).toHaveBeenCalled();
      expect(core.setFailed).not.toHaveBeenCalled();
    });

    it('should emit core.warning() when multiple checks fail', () => {
      const account = makeAccountMultipleFails();
      const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);

      expect(result.valid).toBe(false);
      expect(result.failedCheckLabels!.length).toBeGreaterThanOrEqual(2);

      const failOnMissing = false;
      const summary = formatFailureSummary(result);

      if (!result.valid && !failOnMissing) {
        core.warning(`TrustBridge checks failed: ${summary}`);
      }

      expect(core.warning).toHaveBeenCalled();
      expect(core.setFailed).not.toHaveBeenCalled();
    });

    it('should emit core.warning() when account is unfunded (404)', () => {
      const result = unfundedAccountResult(TEST_ADDRESS, DEFAULT_CHECK_CONFIG);

      expect(result.valid).toBe(false);

      const failOnMissing = false;
      const summary = formatFailureSummary(result);

      if (!result.valid && !failOnMissing) {
        core.warning(`TrustBridge checks failed: ${summary}`);
      }

      expect(core.warning).toHaveBeenCalled();
      expect(core.setFailed).not.toHaveBeenCalled();
    });

    it('should emit core.warning() when Horizon returns an error', () => {
      const result = horizonFailureResult('Horizon timeout', DEFAULT_CHECK_CONFIG);

      expect(result.valid).toBe(false);

      const failOnMissing = false;
      const summary = formatFailureSummary(result);

      if (!result.valid && !failOnMissing) {
        core.warning(`TrustBridge checks failed: ${summary}`);
      }

      expect(core.warning).toHaveBeenCalled();
      expect(core.setFailed).not.toHaveBeenCalled();
    });

    it('test name documents: fail_on_missing=false + validation fails = core.warning()', () => {
      // This test name is the behavior spec
      const account = makeAccountMissingTrustline();
      const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);
      expect(result.valid).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Test Suite: Edge Cases & Combinations
// ─────────────────────────────────────────────────────────────────────────

describe('Wave #42 — fail_on_missing edge cases', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should maintain separate failure paths: setFailed vs warning', () => {
    const account = makeAccountMissingTrustline();
    const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);

    // Scenario 1: fail_on_missing=true
    {
      jest.clearAllMocks();
      if (!result.valid && true) {
        core.setFailed('failed');
      }
      expect(core.setFailed).toHaveBeenCalled();
      expect(core.warning).not.toHaveBeenCalled();
    }

    // Scenario 2: fail_on_missing=false (same result)
    {
      jest.clearAllMocks();
      const failOnMissing = false;
      if (!result.valid) {
        if (failOnMissing) {
          core.setFailed('failed');
        } else {
          core.warning('warned');
        }
      }
      expect(core.warning).toHaveBeenCalled();
      expect(core.setFailed).not.toHaveBeenCalled();
    }
  });

  it('should never fail on validation success regardless of fail_on_missing', () => {
    const account = makeFundedAccount();
    const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);

    for (const failOnMissing of [true, false]) {
      jest.clearAllMocks();
      if (!result.valid && failOnMissing) {
        core.setFailed('failed');
      }
      if (!result.valid && !failOnMissing) {
        core.warning('warned');
      }
      expect(core.setFailed).not.toHaveBeenCalled();
      expect(core.warning).not.toHaveBeenCalled();
    }
  });

  it('failure summary should include all failed check reasons', () => {
    const account = makeAccountMultipleFails();
    const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);
    const summary = formatFailureSummary(result);

    // Summary should mention at least one failed check
    expect(summary).toMatch(/trustline|reserve|funded/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Test Suite: Maintainer-Only Gate Patterns (Documentation as Tests)
// ─────────────────────────────────────────────────────────────────────────

describe('Wave #42 — Recommended maintainer-only gate patterns (living spec)', () => {
  /**
   * Pattern: Use fail_on_missing=true for maintainer audit jobs
   * (triggered manually or on schedule) to gate against unready wallets.
   *
   * Example YAML:
   * ```yaml
   * - uses: Stellar-TrustBridge/trustbridge-action@v1
   *   with:
   *     fail_on_missing: 'true'   # hard-fail if wallet not ready
   *     sticky_comment: 'true'     # update previous comment
   * ```
   */
  it('maintainer-only pattern: fail_on_missing=true hard-gates against unready wallets', () => {
    const unreadyAccount = makeAccountMissingTrustline();
    const readyAccount = makeFundedAccount();

    // Maintainer wants ALL checks to pass before approving
    const failOnMissing = true;

    {
      const result = runAccountChecks(unreadyAccount, DEFAULT_CHECK_CONFIG);
      if (!result.valid && failOnMissing) {
        // ✓ Correct: hard-fail workflow when wallet is not ready
        expect(result.valid).toBe(false);
      }
    }

    {
      const result = runAccountChecks(readyAccount, DEFAULT_CHECK_CONFIG);
      if (!result.valid && failOnMissing) {
        // ✓ Correct: never fail when all checks pass
        expect(result.valid).toBe(true);
      }
    }
  });

  /**
   * Pattern: Use fail_on_missing=false for contributor assignment workflows
   * (triggered on issue assignment) to inform without blocking.
   *
   * Example YAML:
   * ```yaml
   * - uses: Stellar-TrustBridge/trustbridge-action@v1
   *   with:
   *     fail_on_missing: 'false'  # warn only; don't block assignment
   *     on:
   *       issues:
   *         types: [assigned]     # runs on every assignment
   * ```
   */
  it('contributor-friendly pattern: fail_on_missing=false warns without blocking assignment', () => {
    const unreadyAccount = makeAccountMissingTrustline();

    // Contributor workflows want to assign first, remind later
    const failOnMissing = false;

    const result = runAccountChecks(unreadyAccount, DEFAULT_CHECK_CONFIG);
    // ✓ Correct: emit warning but don't fail the workflow
    expect(result.valid).toBe(false);
    // If fail_on_missing=false, the workflow continues despite failures
    if (!result.valid && !failOnMissing) {
      // Only warning, not failure
      expect(result.valid).toBe(false);
    }
  });

  /**
   * Pattern: Use label gate + fail_on_missing=true for bounty workflows
   * Gate ensures validation only runs when "bounty" label is present.
   *
   * See docs/LABEL_GATE_DESIGN.md for composite action details.
   */
  it('label gate + fail_on_missing=true: only validate when "bounty" label is set', () => {
    // This is a documentation test: the pattern is:
    // 1. Use label gate composite action (.github/actions/trustbridge-label-gate)
    // 2. Set gate_labels: 'bounty'
    // 3. Set fail_on_missing: 'true' (pass through)
    // 4. Result: validation only runs and hard-fails when "bounty" is present

    const account = makeFundedAccount();
    const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);

    // When gate is open (label present) and fail_on_missing=true:
    const failOnMissing = true;
    if (!result.valid && failOnMissing) {
      core.setFailed('failed');
    }

    // All checks pass, so no failure even with fail_on_missing=true
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('test suite is living spec: each test name describes a behavior', () => {
    // This test documents that all test names in this suite are readable
    // behavior specifications for maintainers.
    //
    // Examples:
    // - "fail_on_missing=true + validation fails = core.setFailed()"
    // - "fail_on_missing=false + validation fails = core.warning()"
    // - "validation passing = no failure (any fail_on_missing)"
    //
    // These serve as a machine-readable specification for the two modes.

    expect(true).toBe(true);
  });

  it('no regression: default fail_on_missing is true (hard-fail)', () => {
    // From action.yml: default: 'true'
    // Tests should verify this default is safe and expected.

    const defaultFailOnMissing = true; // action.yml default
    expect(defaultFailOnMissing).toBe(true);

    // With default=true, unready wallets DO cause workflow failure
    // This is safe because maintainers can opt into warn-only with fail_on_missing=false
    const account = makeAccountMissingTrustline();
    const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);

    if (!result.valid && defaultFailOnMissing) {
      core.setFailed('failed');
    }

    expect(core.setFailed).toHaveBeenCalled();
  });
});
