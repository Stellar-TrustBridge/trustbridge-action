import {
  escapeMarkdownInline,
  inlineCode,
  buildOnboardingChecklist,
  extractChecklistState,
  CHECKLIST_TRUSTLINE_KEY,
} from '../src/markdown';
import { ValidationResult } from '../src/checks';

describe('markdown helpers', () => {
  it('escapes inline markdown control characters', () => {
    expect(escapeMarkdownInline('USDC_TEST')).toBe('USDC\\_TEST');
  });

  it('wraps text in inline code and escapes backticks', () => {
    expect(inlineCode('A`B')).toBe('`A\\`B`');
  });
});

describe('buildOnboardingChecklist', () => {
  const baseOptions = { assetCode: 'USDC', minXlmReserve: 1.5 };

  function result(partial: Partial<ValidationResult>): ValidationResult {
    return {
      valid: false,
      accountFunded: false,
      trustlineExists: false,
      xlmBalance: '0',
      xlmReserveMet: false,
      checks: [],
      ...partial,
    };
  }

  it('renders all unchecked boxes when every check fails', () => {
    const markdown = buildOnboardingChecklist(result({}), baseOptions);
    expect(markdown).toMatchSnapshot();
    expect(markdown).toContain('- [ ] **Fund account**');
    expect(markdown).toContain('- [ ] **Add USDC trustline**');
    expect(markdown).toContain('- [ ] **Verify XLM balance**');
  });

  it('renders a partial checklist when only funding and reserve pass', () => {
    const markdown = buildOnboardingChecklist(
      result({
        accountFunded: true,
        trustlineExists: false,
        xlmReserveMet: true,
        xlmBalance: '5.0000000',
      }),
      baseOptions,
    );
    expect(markdown).toMatchSnapshot();
    expect(markdown).toContain('- [x] **Fund account**');
    expect(markdown).toContain('- [ ] **Add USDC trustline**');
    expect(markdown).toContain('- [x] **Verify XLM balance**');
  });

  it('renders all checked boxes when validation fully passes', () => {
    const markdown = buildOnboardingChecklist(
      result({
        valid: true,
        accountFunded: true,
        trustlineExists: true,
        xlmReserveMet: true,
        xlmBalance: '10.5000000',
      }),
      baseOptions,
    );
    expect(markdown).toMatchSnapshot();
    expect(markdown).toContain('- [x] **Fund account**');
    expect(markdown).toContain('- [x] **Add USDC trustline**');
    expect(markdown).toContain('- [x] **Verify XLM balance**');
  });

  it('escapes asset codes with markdown-sensitive characters', () => {
    const markdown = buildOnboardingChecklist(result({}), {
      assetCode: 'USD_C',
      minXlmReserve: 2,
    });
    expect(markdown).toContain('Add USD\\_C trustline');
  });

  it('links FAQ anchors for each step', () => {
    const markdown = buildOnboardingChecklist(result({}), baseOptions);
    // Anchors must match headings in docs/FAQ.md (Issue #328)
    expect(markdown).toContain('#account-not-funded');
    expect(markdown).toContain('#trustline-missing');
    expect(markdown).toContain('#xlm-reserve-too-low');
  });

  // -------------------------------------------------------------------------
  // Issue #311 — previousChecks persistence
  // -------------------------------------------------------------------------

  describe('previousChecks persistence (Issue #311)', () => {
    it('preserves a manually-checked Fund account box when Horizon still returns 404', () => {
      const previousChecks = new Map<string, boolean>([
        ['Fund account', true],
      ]);
      const markdown = buildOnboardingChecklist(
        result({ accountFunded: false }),
        { ...baseOptions, previousChecks },
      );
      // User manually checked this; should survive even though live result is false
      expect(markdown).toContain('- [x] **Fund account**');
      // Other items follow live result (unchecked)
      expect(markdown).toContain('- [ ] **Add USDC trustline**');
      expect(markdown).toContain('- [ ] **Verify XLM balance**');
    });

    it('preserves a manually-checked trustline box when Horizon says no trustline', () => {
      const previousChecks = new Map<string, boolean>([
        [CHECKLIST_TRUSTLINE_KEY, true],
      ]);
      const markdown = buildOnboardingChecklist(
        result({ trustlineExists: false }),
        { ...baseOptions, previousChecks },
      );
      expect(markdown).toContain('- [x] **Add USDC trustline**');
      expect(markdown).toContain('- [ ] **Fund account**');
      expect(markdown).toContain('- [ ] **Verify XLM balance**');
    });

    it('preserves a manually-checked Verify XLM balance box when reserve not met', () => {
      const previousChecks = new Map<string, boolean>([
        ['Verify XLM balance', true],
      ]);
      const markdown = buildOnboardingChecklist(
        result({ xlmReserveMet: false }),
        { ...baseOptions, previousChecks },
      );
      expect(markdown).toContain('- [x] **Verify XLM balance**');
    });

    it('does NOT un-check a live-passing box even if previousChecks says false', () => {
      // Live result passes — previousChecks=false should not override live truth
      const previousChecks = new Map<string, boolean>([
        ['Fund account', false],
      ]);
      const markdown = buildOnboardingChecklist(
        result({ accountFunded: true }),
        { ...baseOptions, previousChecks },
      );
      expect(markdown).toContain('- [x] **Fund account**');
    });

    it('works with no previousChecks (undefined) — behaves identically to original', () => {
      const withoutPrev = buildOnboardingChecklist(result({}), baseOptions);
      const withUndefined = buildOnboardingChecklist(result({}), {
        ...baseOptions,
        previousChecks: undefined,
      });
      expect(withUndefined).toBe(withoutPrev);
    });

    it('preserves all three boxes when all were manually checked and Horizon fails all', () => {
      const previousChecks = new Map<string, boolean>([
        ['Fund account', true],
        [CHECKLIST_TRUSTLINE_KEY, true],
        ['Verify XLM balance', true],
      ]);
      const markdown = buildOnboardingChecklist(result({}), {
        ...baseOptions,
        previousChecks,
      });
      expect(markdown).toContain('- [x] **Fund account**');
      expect(markdown).toContain('- [x] **Add USDC trustline**');
      expect(markdown).toContain('- [x] **Verify XLM balance**');
    });
  });
});

// ---------------------------------------------------------------------------
// extractChecklistState (Issue #311)
// ---------------------------------------------------------------------------

describe('extractChecklistState', () => {
  // Helper: build a minimal comment body containing an onboarding checklist
  function makeBody(
    fund: boolean,
    trustline: boolean,
    reserve: boolean,
    assetCode = 'USDC',
  ): string {
    return [
      '## TrustBridge — Stellar Account Check',
      '',
      '### Onboarding checklist',
      '',
      '_Complete these steps in order._',
      '',
      `- [${fund ? 'x' : ' '}] **Fund account** — Activate the account with XLM.`,
      `- [${trustline ? 'x' : ' '}] **Add ${assetCode} trustline** — Configure the asset trustline.`,
      `- [${reserve ? 'x' : ' '}] **Verify XLM balance** — Meet the reserve.`,
      '',
      '### Another section',
      '',
      '- [ ] **Some unrelated item**',
    ].join('\n');
  }

  it('extracts all unchecked state from a fully unchecked checklist', () => {
    const state = extractChecklistState(makeBody(false, false, false));
    expect(state.get('Fund account')).toBe(false);
    expect(state.get(CHECKLIST_TRUSTLINE_KEY)).toBe(false);
    expect(state.get('Verify XLM balance')).toBe(false);
  });

  it('extracts all checked state from a fully checked checklist', () => {
    const state = extractChecklistState(makeBody(true, true, true));
    expect(state.get('Fund account')).toBe(true);
    expect(state.get(CHECKLIST_TRUSTLINE_KEY)).toBe(true);
    expect(state.get('Verify XLM balance')).toBe(true);
  });

  it('extracts partial checked state', () => {
    const state = extractChecklistState(makeBody(true, false, true));
    expect(state.get('Fund account')).toBe(true);
    expect(state.get(CHECKLIST_TRUSTLINE_KEY)).toBe(false);
    expect(state.get('Verify XLM balance')).toBe(true);
  });

  it('returns empty map for empty string', () => {
    expect(extractChecklistState('').size).toBe(0);
  });

  it('returns empty map when Onboarding checklist header is absent', () => {
    const body = '- [x] **Fund account** — something\n';
    // No "### Onboarding checklist" header → should not match
    expect(extractChecklistState(body).size).toBe(0);
  });

  it('does not read items from sections after the checklist', () => {
    const body = makeBody(false, false, false);
    const state = extractChecklistState(body);
    // The "Some unrelated item" from "### Another section" should not be in the map
    expect(state.has('Some unrelated item')).toBe(false);
    expect(state.size).toBe(3);
  });

  it('handles different asset codes in trustline label', () => {
    const state = extractChecklistState(makeBody(false, true, false, 'yXLM'));
    expect(state.get(CHECKLIST_TRUSTLINE_KEY)).toBe(true);
  });

  it('handles asset codes with escaped markdown characters', () => {
    // buildOnboardingChecklist escapes USD_C → USD\_C, but GitHub renders it
    // as USD_C to viewers. The raw body has USD\_C — this should still match.
    const body = makeBody(false, true, false, 'USD\\_C');
    const state = extractChecklistState(body);
    // USD\_C is ASCII printable — the trustline key should be extracted
    expect(state.get(CHECKLIST_TRUSTLINE_KEY)).toBe(true);
  });

  it('rejects trustline labels with non-ASCII characters (injection guard)', () => {
    const maliciousBody = [
      '### Onboarding checklist',
      '',
      // Attempt to inject a multi-line label with a control character
      '- [x] **Add USDC\u0001 trustline** — Configure.',
    ].join('\n');
    const state = extractChecklistState(maliciousBody);
    // Control char in label — should not produce a trustline entry
    expect(state.has(CHECKLIST_TRUSTLINE_KEY)).toBe(false);
  });

  it('returns a new Map on each call (no shared state)', () => {
    const body = makeBody(true, true, true);
    const s1 = extractChecklistState(body);
    const s2 = extractChecklistState(body);
    expect(s1).not.toBe(s2);
    s1.set('Fund account', false);
    expect(s2.get('Fund account')).toBe(true);
  });

  it('is safe when called with null-like value (type coercion guard)', () => {
    // Should not throw even with unexpected inputs
    expect(() => extractChecklistState(undefined as unknown as string)).not.toThrow();
    expect(extractChecklistState(undefined as unknown as string).size).toBe(0);
  });

  it('round-trips: build then extract produces consistent state', () => {
    // Build a checklist via buildOnboardingChecklist, then extract from it
    const rendered = buildOnboardingChecklist(
      {
        valid: false,
        accountFunded: true,
        trustlineExists: false,
        xlmBalance: '5',
        xlmReserveMet: true,
        checks: [],
      },
      { assetCode: 'USDC', minXlmReserve: 1.5 },
    );
    const state = extractChecklistState(rendered);
    expect(state.get('Fund account')).toBe(true);
    expect(state.get(CHECKLIST_TRUSTLINE_KEY)).toBe(false);
    expect(state.get('Verify XLM balance')).toBe(true);
  });

  it('round-trips with a non-trivial asset code (e.g. yXLM)', () => {
    const rendered = buildOnboardingChecklist(
      {
        valid: false,
        accountFunded: false,
        trustlineExists: true,
        xlmBalance: '0',
        xlmReserveMet: false,
        checks: [],
      },
      { assetCode: 'yXLM', minXlmReserve: 1.5 },
    );
    const state = extractChecklistState(rendered);
    expect(state.get(CHECKLIST_TRUSTLINE_KEY)).toBe(true);
    expect(state.get('Fund account')).toBe(false);
    expect(state.get('Verify XLM balance')).toBe(false);
  });
});
