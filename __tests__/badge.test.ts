/**
 * Tests for badge snippet generation (Issue #139).
 * Covers: state determination, URL generation, Markdown generation,
 * and safety (no PII or tokens in output).
 *
 * Issue #762: golden tests for pass/fail/skipped states and
 * accessibility-friendly alt text in markdown embeds.
 */

import {
  determineBadgeState,
  generateBadgeUrl,
  generateBadgeMarkdown,
  generateBadgeSnippets,
  BadgeState,
} from '../src/badge';
import { ValidationResult } from '../src/checks';

const passResult: ValidationResult = {
  valid: true,
  accountFunded: true,
  trustlineExists: true,
  xlmBalance: '5.0000000',
  xlmReserveMet: true,
  checks: [
    { passed: true, label: 'Account funded', detail: 'OK' },
    { passed: true, label: 'USDC trustline', detail: 'OK' },
    { passed: true, label: 'XLM reserve', detail: 'OK' },
  ],
};

const failResult: ValidationResult = {
  valid: false,
  accountFunded: false,
  trustlineExists: false,
  xlmBalance: '0',
  xlmReserveMet: false,
  checks: [
    { passed: false, label: 'Account funded', detail: 'Not found' },
    { passed: false, label: 'USDC trustline', detail: 'N/A' },
    { passed: false, label: 'XLM reserve', detail: 'N/A' },
  ],
};

const skippedResult: ValidationResult = {
  valid: false,
  accountFunded: false,
  trustlineExists: false,
  xlmBalance: '0',
  xlmReserveMet: false,
  checks: [
    { passed: false, label: 'Account funded', detail: 'Skipped' },
    { passed: false, label: 'USDC trustline', detail: 'Skipped' },
    { passed: false, label: 'XLM reserve', detail: 'Skipped' },
  ],
};

// ---------------------------------------------------------------------------
// determineBadgeState
// ---------------------------------------------------------------------------

describe('determineBadgeState', () => {
  it('returns pass when result.valid is true', () => {
    expect(determineBadgeState(passResult)).toBe('pass');
  });

  it('returns fail when result.valid is false', () => {
    expect(determineBadgeState(failResult)).toBe('fail');
  });

  it('returns pass for all checks passed', () => {
    const result: ValidationResult = {
      valid: true,
      accountFunded: true,
      trustlineExists: true,
      xlmBalance: '10.0',
      xlmReserveMet: true,
      checks: [
        { passed: true, label: 'Check 1', detail: 'OK' },
        { passed: true, label: 'Check 2', detail: 'OK' },
      ],
    };
    expect(determineBadgeState(result)).toBe('pass');
  });

  it('returns fail for any check failed', () => {
    const result: ValidationResult = {
      valid: false,
      accountFunded: true,
      trustlineExists: false,
      xlmBalance: '5.0',
      xlmReserveMet: false,
      checks: [
        { passed: true, label: 'Check 1', detail: 'OK' },
        { passed: false, label: 'Check 2', detail: 'FAIL' },
      ],
    };
    expect(determineBadgeState(result)).toBe('fail');
  });

  it('returns fail for skipped result (not valid)', () => {
    expect(determineBadgeState(skippedResult)).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// generateBadgeUrl
// ---------------------------------------------------------------------------

describe('generateBadgeUrl', () => {
  it('generates URL with pass state', () => {
    const url = generateBadgeUrl('pass');
    expect(url).toContain('img.shields.io/badge');
    expect(url).toContain('brightgreen');
    expect(url).toContain('Ready');
  });

  it('generates URL with fail state', () => {
    const url = generateBadgeUrl('fail');
    expect(url).toContain('img.shields.io/badge');
    expect(url).toContain('red');
    expect(url).toContain('Not%20Ready');
  });

  it('generates URL with pending state', () => {
    const url = generateBadgeUrl('pending');
    expect(url).toContain('img.shields.io/badge');
    expect(url).toContain('yellow');
    expect(url).toContain('Pending');
  });

  it('generates URL with skipped state', () => {
    const url = generateBadgeUrl('skipped');
    expect(url).toContain('img.shields.io/badge');
    expect(url).toContain('lightgrey');
    expect(url).toContain('Skipped');
  });

  it('uses custom label when provided', () => {
    const url = generateBadgeUrl('pass', 'stellar-wallet');
    expect(url).toContain('stellar-wallet');
  });

  it('URL-encodes label with spaces', () => {
    const url = generateBadgeUrl('pass', 'my label');
    expect(url).toContain('my%20label');
  });

  it('URL-encodes special characters in label', () => {
    const url = generateBadgeUrl('pass', 'label/with-special');
    expect(url).toContain('label%2Fwith-special');
  });

  it('generates valid HTTPS URL', () => {
    const url = generateBadgeUrl('pass');
    expect(url).toMatch(/^https:\/\/img\.shields\.io\/badge\/.*/);
  });

  it('does not contain PII or sensitive data', () => {
    const url = generateBadgeUrl('pass');
    // Should only contain state info, no addresses or balances
    expect(url).not.toContain('G');
    expect(url).not.toContain('0x');
    expect(url).not.toContain('USDC');
    expect(url).not.toContain('5.0');
  });
});

// ---------------------------------------------------------------------------
// generateBadgeMarkdown
// ---------------------------------------------------------------------------

describe('generateBadgeMarkdown', () => {
  it('generates valid Markdown image link for pass state', () => {
    const markdown = generateBadgeMarkdown('pass');
    // Verify structure: [![alt](imageUrl)](linkUrl)
    expect(markdown).toContain('[![');
    expect(markdown).toContain('](https://img.shields.io/badge/');
    expect(markdown).toContain(')](https://github.com/Stellar-TrustBridge/trustbridge-action)');
    expect(markdown).toContain('TrustBridge');
    expect(markdown).toContain('github.com/Stellar-TrustBridge/trustbridge-action');
  });

  it('generates valid Markdown image link for fail state', () => {
    const markdown = generateBadgeMarkdown('fail');
    expect(markdown).toContain('TrustBridge');
    expect(markdown).toContain('https://img.shields.io/badge');
    expect(markdown).toContain('github.com/Stellar-TrustBridge/trustbridge-action');
  });

  it('generates valid Markdown image link for skipped state', () => {
    const markdown = generateBadgeMarkdown('skipped');
    expect(markdown).toContain('[![');
    expect(markdown).toContain('lightgrey');
    expect(markdown).toContain('Skipped');
    expect(markdown).toContain('github.com/Stellar-TrustBridge/trustbridge-action');
  });

  it('includes alt text for accessibility', () => {
    const markdown = generateBadgeMarkdown('pass');
    expect(markdown).toContain('[TrustBridge');
  });

  it('includes descriptive alt text for each state', () => {
    expect(generateBadgeMarkdown('pass')).toMatch(/\[!\[TrustBridge[^\]]*Ready[^\]]*\]/);
    expect(generateBadgeMarkdown('fail')).toMatch(/\[!\[TrustBridge[^\]]*Not Ready[^\]]*\]/);
    expect(generateBadgeMarkdown('skipped')).toMatch(/\[!\[TrustBridge[^\]]*Skipped[^\]]*\]/);
  });

  it('links to TrustBridge repository', () => {
    const markdown = generateBadgeMarkdown('pass');
    expect(markdown).toContain('https://github.com/Stellar-TrustBridge/trustbridge-action');
  });

  it('uses custom label when provided', () => {
    const markdown = generateBadgeMarkdown('pass', 'my-badge');
    expect(markdown).toContain('my-badge');
  });

  it('produces valid Markdown without newlines', () => {
    const markdown = generateBadgeMarkdown('pass');
    expect(markdown).not.toContain('\n');
  });

  it('does not contain PII', () => {
    const markdown = generateBadgeMarkdown('fail');
    expect(markdown).not.toContain('G');
    expect(markdown).not.toContain('XLM');
    expect(markdown).not.toContain('5.0');
  });
});

// ---------------------------------------------------------------------------
// generateBadgeSnippets
// ---------------------------------------------------------------------------

describe('generateBadgeSnippets', () => {
  it('returns both markdown and url for pass result', () => {
    const snippets = generateBadgeSnippets(passResult);
    expect(snippets).toHaveProperty('markdown');
    expect(snippets).toHaveProperty('url');
    expect(snippets.markdown).toContain('brightgreen');
    expect(snippets.url).toContain('brightgreen');
  });

  it('returns both markdown and url for fail result', () => {
    const snippets = generateBadgeSnippets(failResult);
    expect(snippets).toHaveProperty('markdown');
    expect(snippets).toHaveProperty('url');
    expect(snippets.markdown).toContain('red');
    expect(snippets.url).toContain('red');
  });

  it('returns both markdown and url for skipped result', () => {
    const snippets = generateBadgeSnippets(skippedResult);
    expect(snippets).toHaveProperty('markdown');
    expect(snippets).toHaveProperty('url');
    expect(snippets.markdown).toContain('lightgrey');
    expect(snippets.url).toContain('lightgrey');
  });

  it('markdown URL matches url field', () => {
    const snippets = generateBadgeSnippets(passResult);
    // Extract URL from markdown (between first ](  and )()
    const markdownMatch = snippets.markdown.match(/\]\((https:\/\/[^)]+)\)/);
    expect(markdownMatch).toBeTruthy();
    expect(markdownMatch![1]).toBe(snippets.url);
  });

  it('uses custom label for both markdown and url', () => {
    const snippets = generateBadgeSnippets(passResult, 'custom-label');
    expect(snippets.markdown).toContain('custom-label');
    expect(snippets.url).toContain('custom-label');
  });

  it('reflects pass state correctly', () => {
    const snippets = generateBadgeSnippets(passResult);
    expect(snippets.markdown).toContain('Ready');
    expect(snippets.url).toContain('Ready');
    expect(snippets.markdown).toContain('brightgreen');
    expect(snippets.url).toContain('brightgreen');
  });

  it('reflects fail state correctly', () => {
    const snippets = generateBadgeSnippets(failResult);
    expect(snippets.markdown).toContain('Not%20Ready');
    expect(snippets.url).toContain('Not%20Ready');
    expect(snippets.markdown).toContain('red');
    expect(snippets.url).toContain('red');
  });

  it('reflects skipped state correctly', () => {
    const snippets = generateBadgeSnippets(skippedResult);
    expect(snippets.markdown).toContain('Skipped');
    expect(snippets.url).toContain('Skipped');
    expect(snippets.markdown).toContain('lightgrey');
    expect(snippets.url).toContain('lightgrey');
  });

  it('does not leak PII in snippets', () => {
    const snippets = generateBadgeSnippets(failResult);
    expect(snippets.markdown).not.toContain('G');
    expect(snippets.url).not.toContain('G');
    expect(snippets.markdown).not.toContain('XLM');
    expect(snippets.url).not.toContain('XLM');
  });
});
