/**
 * Tests for #322 — Comment threading / reply mode.
 */
import * as core from '@actions/core';
import {
  CommentMode,
  VALID_COMMENT_MODES,
  resolveCommentMode,
} from '../src/comment';

// Mock @actions/core to silence log output in tests
jest.mock('@actions/core', () => ({
  warning: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  setOutput: jest.fn(),
  setFailed: jest.fn(),
}));

// ── constants ───────────────────────────────────────────────────────────────

describe('VALID_COMMENT_MODES', () => {
  it('contains exactly sticky, new, and reply', () => {
    expect(VALID_COMMENT_MODES).toEqual(expect.arrayContaining(['sticky', 'new', 'reply']));
    expect(VALID_COMMENT_MODES).toHaveLength(3);
  });
});

// ── resolveCommentMode ──────────────────────────────────────────────────────

describe('resolveCommentMode', () => {
  beforeEach(() => {
    (core.warning as jest.Mock).mockClear();
  });

  it("returns 'sticky' when commentMode is 'sticky'", () => {
    expect(resolveCommentMode('sticky', undefined)).toBe<CommentMode>('sticky');
  });

  it("returns 'new' when commentMode is 'new'", () => {
    expect(resolveCommentMode('new', undefined)).toBe<CommentMode>('new');
  });

  it("returns 'reply' when commentMode is 'reply'", () => {
    expect(resolveCommentMode('reply', undefined)).toBe<CommentMode>('reply');
  });

  it('is case-insensitive (STICKY, NEW, REPLY)', () => {
    expect(resolveCommentMode('STICKY', undefined)).toBe<CommentMode>('sticky');
    expect(resolveCommentMode('NEW', undefined)).toBe<CommentMode>('new');
    expect(resolveCommentMode('REPLY', undefined)).toBe<CommentMode>('reply');
  });

  it('trims leading/trailing whitespace from commentMode', () => {
    expect(resolveCommentMode('  sticky  ', undefined)).toBe<CommentMode>('sticky');
    expect(resolveCommentMode('  reply  ', undefined)).toBe<CommentMode>('reply');
  });

  it("returns 'sticky' as default when commentMode is undefined and sticky is undefined", () => {
    expect(resolveCommentMode(undefined, undefined)).toBe<CommentMode>('sticky');
  });

  it("returns 'sticky' as default when commentMode is undefined and sticky is true", () => {
    expect(resolveCommentMode(undefined, true)).toBe<CommentMode>('sticky');
  });

  it("returns 'new' when commentMode is undefined and sticky is false (legacy compat)", () => {
    expect(resolveCommentMode(undefined, false)).toBe<CommentMode>('new');
  });

  it("commentMode takes precedence over sticky boolean", () => {
    // Even with sticky:false, explicit commentMode:'sticky' wins.
    expect(resolveCommentMode('sticky', false)).toBe<CommentMode>('sticky');
    // Even with sticky:true, explicit commentMode:'new' wins.
    expect(resolveCommentMode('new', true)).toBe<CommentMode>('new');
  });

  it("falls back to 'sticky' and emits a warning for an invalid commentMode", () => {
    const result = resolveCommentMode('invalid_mode', undefined);
    expect(result).toBe<CommentMode>('sticky');
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('invalid_mode'),
    );
  });

  it("falls back to 'sticky' and warns for empty string commentMode (treated as no input)", () => {
    // Empty string after trim is falsy — resolveCommentMode treats it as unset.
    const result = resolveCommentMode('', undefined);
    // Empty string is falsy so the branch does not enter the validation path.
    expect(result).toBe<CommentMode>('sticky');
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('emits warning listing valid options for invalid mode', () => {
    resolveCommentMode('email', undefined);
    const warnCall = (core.warning as jest.Mock).mock.calls[0]?.[0] as string;
    expect(warnCall).toContain('sticky');
    expect(warnCall).toContain('new');
    expect(warnCall).toContain('reply');
  });
});
