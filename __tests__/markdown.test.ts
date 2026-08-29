import { escapeMarkdownInline, inlineCode, buildOnboardingChecklist } from '../src/markdown';
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

  it('FAQ links point to docs/FAQ.md, not a non-existent TROUBLESHOOTING.md', () => {
    const markdown = buildOnboardingChecklist(result({}), baseOptions);
    expect(markdown).not.toContain('TROUBLESHOOTING.md');
    expect(markdown).toContain('docs/FAQ.md');
  });
});
