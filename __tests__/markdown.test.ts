import { escapeMarkdownInline, inlineCode } from '../src/markdown';

describe('markdown helpers', () => {
  it('escapes inline markdown control characters', () => {
    expect(escapeMarkdownInline('USDC_TEST')).toBe('USDC\\_TEST');
  });

  it('wraps text in inline code and escapes backticks', () => {
    expect(inlineCode('A`B')).toBe('`A\\`B`');
  });
});
