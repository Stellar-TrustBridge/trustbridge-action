import { escapeMarkdownInline, inlineCode, wrapMarkdownTableCell } from '../src/markdown';

describe('markdown helpers', () => {
  it('escapes inline markdown control characters', () => {
    expect(escapeMarkdownInline('USDC_TEST')).toBe('USDC\\_TEST');
  });

  it('wraps text in inline code and escapes backticks', () => {
    expect(inlineCode('A`B')).toBe('`A\\`B`');
  });

  it('wraps long table cell text without letting pipes create columns', () => {
    expect(wrapMarkdownTableCell('alpha beta|gamma delta', 10))
      .toBe('alpha<br>beta&#124;gamma<br>delta');
  });

  it('breaks oversized words and rejects invalid column widths', () => {
    expect(wrapMarkdownTableCell('abcdefghijk', 4)).toBe('abcd<br>efgh<br>ijk');
    expect(() => wrapMarkdownTableCell('reason', 0)).toThrow('positive integer');
  });
});
