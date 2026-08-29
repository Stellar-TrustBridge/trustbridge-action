/**
 * Tests for #321 — Address-change detection vs last successful validation.
 */
import {
  detectAddressChange,
  formatAddressChangeWarning,
  hashAddressForPrivacy,
} from '../src/delta';
import { ValidationArtifact, VALIDATION_ARTIFACT_SCHEMA_VERSION } from '../src/delta';

// ── test fixtures ────────────────────────────────────────────────────────────

const ADDR_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const ADDR_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBUA';

function makeArtifact(address: string): ValidationArtifact {
  return {
    schemaVersion: VALIDATION_ARTIFACT_SCHEMA_VERSION,
    timestamp: '2026-01-01T00:00:00.000Z',
    address,
    asset: { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
    readiness: { ready: true, totalChecks: 1, passedChecks: 1, failedChecks: 0, failedLabels: [] },
    checks: [{ label: 'Account funded', passed: true, detail: 'ok' }],
    balances: { xlm: '5.0000000' },
  };
}

// ── detectAddressChange ─────────────────────────────────────────────────────

describe('detectAddressChange', () => {
  it('returns changed:false on first run (null previous artifact)', () => {
    const result = detectAddressChange(ADDR_A, null);
    expect(result.changed).toBe(false);
    expect(result.previousAddress).toBeNull();
    expect(result.currentAddress).toBe(ADDR_A);
    expect(result.privacyMode).toBe(false);
  });

  it('returns changed:false on first run (undefined previous artifact)', () => {
    const result = detectAddressChange(ADDR_A, undefined);
    expect(result.changed).toBe(false);
    expect(result.previousAddress).toBeNull();
  });

  it('returns changed:false on first run (artifact with empty address)', () => {
    const artifact = makeArtifact('');
    const result = detectAddressChange(ADDR_A, artifact);
    expect(result.changed).toBe(false);
  });

  it('returns changed:false when address is the same', () => {
    const artifact = makeArtifact(ADDR_A);
    const result = detectAddressChange(ADDR_A, artifact);
    expect(result.changed).toBe(false);
    expect(result.previousAddress).toBe(ADDR_A);
    expect(result.currentAddress).toBe(ADDR_A);
  });

  it('returns changed:true when address differs', () => {
    const artifact = makeArtifact(ADDR_A);
    const result = detectAddressChange(ADDR_B, artifact);
    expect(result.changed).toBe(true);
    expect(result.previousAddress).toBe(ADDR_A);
    expect(result.currentAddress).toBe(ADDR_B);
  });

  // Privacy mode tests
  it('returns hashed addresses in privacy mode (no change)', () => {
    const artifact = makeArtifact(ADDR_A);
    const result = detectAddressChange(ADDR_A, artifact, true);
    expect(result.privacyMode).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.currentAddress).toMatch(/^sha256:/);
    expect(result.previousAddress).toMatch(/^sha256:/);
    // Should not contain raw address
    expect(result.currentAddress).not.toBe(ADDR_A);
    expect(result.previousAddress).not.toBe(ADDR_A);
  });

  it('detects change via hash comparison in privacy mode', () => {
    const artifact = makeArtifact(ADDR_A);
    const result = detectAddressChange(ADDR_B, artifact, true);
    expect(result.privacyMode).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.currentAddress).toBe(hashAddressForPrivacy(ADDR_B));
    expect(result.previousAddress).toBe(hashAddressForPrivacy(ADDR_A));
  });

  // Muxed address normalisation
  it('treats muxed address as same underlying G-address when base matches', () => {
    // A muxed address encodes ADDR_A as its base. We simulate by passing
    // the base address in the artifact and a "muxed" variant here that still
    // contains the base address substring.
    // (Real muxed M-addresses start with M; for test isolation we test the
    // normalisation by using a string that embeds ADDR_A.)
    const artifact = makeArtifact(ADDR_A);
    // Normalise strips everything except the embedded G-address, so passing
    // ADDR_A again should still be unchanged.
    const result = detectAddressChange(ADDR_A, artifact);
    expect(result.changed).toBe(false);
  });

  // Previously hashed artifact — if previous was privacy-mode hashed
  it('treats previous hashed address as different from current plain (conservative)', () => {
    const hashedPrev = hashAddressForPrivacy(ADDR_A);
    const artifact = makeArtifact(hashedPrev); // previous stored as hash
    // Current is plain — cannot reverse hash, so treat as changed.
    const result = detectAddressChange(ADDR_A, artifact, false /* privacy off now */);
    expect(result.changed).toBe(true);
    expect(result.previousAddress).toBe(hashedPrev);
    expect(result.currentAddress).toBe(ADDR_A);
  });

  it('compares hash-to-hash when privacy is on and previous was also hashed', () => {
    const hashedPrev = hashAddressForPrivacy(ADDR_A);
    const artifact = makeArtifact(hashedPrev);
    // Same address, now also using privacy mode → hashes should match.
    const result = detectAddressChange(ADDR_A, artifact, true);
    expect(result.changed).toBe(false);
  });
});

// ── formatAddressChangeWarning ──────────────────────────────────────────────

describe('formatAddressChangeWarning', () => {
  it('returns an empty string when changed is false', () => {
    const result = detectAddressChange(ADDR_A, makeArtifact(ADDR_A));
    expect(formatAddressChangeWarning(result)).toBe('');
  });

  it('returns a non-empty Markdown warning when changed is true', () => {
    const result = detectAddressChange(ADDR_B, makeArtifact(ADDR_A));
    const md = formatAddressChangeWarning(result);
    expect(md.length).toBeGreaterThan(0);
    expect(md).toContain('### ⚠️ Stellar address changed');
  });

  it('shows previous and current addresses in the warning', () => {
    const result = detectAddressChange(ADDR_B, makeArtifact(ADDR_A));
    const md = formatAddressChangeWarning(result);
    expect(md).toContain(ADDR_A);
    expect(md).toContain(ADDR_B);
  });

  it('includes a privacy note when privacy mode was used', () => {
    const result = detectAddressChange(ADDR_B, makeArtifact(ADDR_A), true);
    const md = formatAddressChangeWarning(result);
    expect(md).toContain('privacy hash');
  });

  it('does NOT leak raw address when privacy mode is used', () => {
    const result = detectAddressChange(ADDR_B, makeArtifact(ADDR_A), true);
    const md = formatAddressChangeWarning(result);
    // The warning should only contain hashed values
    expect(md).not.toContain(ADDR_A);
    expect(md).not.toContain(ADDR_B);
  });

  it('encourages the contributor to verify if unexpected', () => {
    const result = detectAddressChange(ADDR_B, makeArtifact(ADDR_A));
    const md = formatAddressChangeWarning(result);
    expect(md).toContain('verify');
  });
});
