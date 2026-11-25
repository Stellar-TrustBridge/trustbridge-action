/** Issue #961 — emoji-free summary mode for enterprise log drains. */
import { stripEmoji, formatJobSummaryMarkdown, formatDigestComment, aggregateDigest } from '../src/summary';
import { parseStrictBooleanInput } from '../src/inputs';

const report = { latencyMs: 12.5, failureCodes: [500], totalRuns: 3, totalErrors: 1, jsonArtifact: '{}' };

describe('stripEmoji', () => {
  it('maps status emoji to stable ASCII tokens', () => {
    expect(stripEmoji('✅ ok ❌ bad ⚠️ warn ⏸️ paused ✓ 💤')).toBe('[PASS] ok [FAIL] bad [WARN] warn [PAUSED] paused [OK] [SNOOZED]');
  });
  it('drops unknown pictographs', () => {
    expect(stripEmoji('ship 🚀 it')).toBe('ship it');
  });
  it('throws on non-string input', () => {
    expect(() => stripEmoji(undefined as unknown as string)).toThrow('stripEmoji expects a string');
  });
});

describe('formatJobSummaryMarkdown emoji modes', () => {
  it('default mode is unchanged', () => {
    expect(formatJobSummaryMarkdown(report).markdown).toMatchSnapshot();
  });
  it('emoji-free mode output is pure ASCII', () => {
    const md = formatJobSummaryMarkdown(report, { emojiFree: true }).markdown;
    expect(md).toMatchSnapshot();
    expect([...md].every((c) => c.charCodeAt(0) < 128)).toBe(true);
  });
  it('rejects malformed reports in both modes', () => {
    expect(() => formatJobSummaryMarkdown(null as never, { emojiFree: true })).toThrow('must be an object');
  });
});

describe('formatDigestComment emoji modes', () => {
  const digest = aggregateDigest([], { now: '2026-01-01T00:00:00.000Z' });
  it('snapshots both modes', () => {
    const withEmoji = formatDigestComment(digest);
    const plain = formatDigestComment(digest, { emojiFree: true });
    expect(withEmoji).toMatchSnapshot('emoji');
    expect(plain).toMatchSnapshot('emoji-free');
    expect(withEmoji).toContain('✅');
    expect(plain).not.toContain('✅');
    expect(plain).toContain('[PASS]');
  });
});

describe('parseStrictBooleanInput', () => {
  it('parses true/false/empty', () => {
    expect(parseStrictBooleanInput('summary_emoji_free', 'TRUE')).toBe(true);
    expect(parseStrictBooleanInput('summary_emoji_free', 'false')).toBe(false);
    expect(parseStrictBooleanInput('summary_emoji_free', '')).toBe(false);
  });
  it('rejects malformed values with a stable error', () => {
    expect(() => parseStrictBooleanInput('summary_emoji_free', 'yes')).toThrow('Invalid summary_emoji_free');
  });
});
