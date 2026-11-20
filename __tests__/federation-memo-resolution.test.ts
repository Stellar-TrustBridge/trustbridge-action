/**
 * @file federation-memo-resolution.test.ts
 *
 * End-to-end tests for federation memo handling in `resolveFederationAddress`.
 *
 * These tests live in a separate file so the module-level `jest.mock` for
 * `../src/ssrf` does not interfere with the other federation tests in
 * `federation.test.ts`, which also use `jest.mock` with different factories
 * inside test bodies.
 *
 * Coverage goals (issue #883):
 * - `memoRequired` is `false` when no memo fields are returned.
 * - `memoRequired` is `true` and `memoType`/`memo` are populated for each
 *   valid memo type (`text`, `id`, `hash`).
 * - `resolveFederationAddress` returns `null` for each memo failure path:
 *   `MEMO_REQUIRED` (memo_type present, memo absent) and `MEMO_TYPE_MISMATCH`
 *   (bad id format, bad hash format, unrecognized memo_type).
 */

// Module-level mock — hoisted by Jest's babel transform so it applies to
// all requires/imports of '../src/ssrf' in this test file and the modules
// it loads.
jest.mock('../src/ssrf', () => ({
  fetchSSRFSafe: jest.fn(),
}));

import { resolveFederationAddress, FederationResolution } from '../src/federation';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A valid, funded Stellar G-address used in all fixture JSON bodies. */
const VALID_G_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** stellar.toml stub with one FEDERATION_SERVER entry. */
const TOML_WITH_FEDERATION_SERVER = `
[[FEDERATION_SERVER]]
forward_url = "https://federation.example.com/federation"
`;

/**
 * Build a mock federation JSON response.
 * `account_id` is always VALID_G_ADDRESS; additional fields can be injected
 * via `overrides` to simulate memo fields returned by the federation server.
 */
function makeFederationJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ account_id: VALID_G_ADDRESS, ...overrides });
}

/**
 * Prime the fetchSSRFSafe mock for the two sequential calls that
 * `resolveFederationAddress` makes:
 * 1. Fetch `https://<domain>/.well-known/stellar.toml`
 * 2. Fetch the federation server URL with `?type=name&addr=...`
 */
function primeResolve(federationJson: string): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { fetchSSRFSafe } = require('../src/ssrf') as { fetchSSRFSafe: jest.Mock };
  fetchSSRFSafe
    .mockResolvedValueOnce({
      ok: true,
      text: jest.fn().mockResolvedValue(TOML_WITH_FEDERATION_SERVER),
    })
    .mockResolvedValueOnce({
      ok: true,
      text: jest.fn().mockResolvedValue(federationJson),
    });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('resolveFederationAddress — memo handling', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { fetchSSRFSafe } = require('../src/ssrf') as { fetchSSRFSafe: jest.Mock };
    fetchSSRFSafe.mockReset();
  });

  // -------------------------------------------------------------------------
  // Happy path: no memo
  // -------------------------------------------------------------------------
  it('returns a resolution with memoRequired=false when no memo fields are present', async () => {
    primeResolve(makeFederationJson());
    const result = await resolveFederationAddress('alice*example.com');
    expect(result).not.toBeNull();
    const res = result as FederationResolution;
    expect(res.gAddress).toBe(VALID_G_ADDRESS);
    expect(res.memoRequired).toBe(false);
    expect(res.memoType).toBeUndefined();
    expect(res.memo).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Happy path: text memo
  // -------------------------------------------------------------------------
  it('returns memoRequired=true with memoType=text for a valid text memo', async () => {
    primeResolve(makeFederationJson({ memo_type: 'text', memo: 'invoice-99' }));
    const result = await resolveFederationAddress('alice*example.com');
    expect(result).not.toBeNull();
    const res = result as FederationResolution;
    expect(res.memoRequired).toBe(true);
    expect(res.memoType).toBe('text');
    expect(res.memo).toBe('invoice-99');
  });

  // -------------------------------------------------------------------------
  // Happy path: id memo
  // -------------------------------------------------------------------------
  it('returns memoRequired=true with memoType=id for a valid numeric id memo', async () => {
    primeResolve(makeFederationJson({ memo_type: 'id', memo: '12345' }));
    const result = await resolveFederationAddress('alice*example.com');
    expect(result).not.toBeNull();
    const res = result as FederationResolution;
    expect(res.memoRequired).toBe(true);
    expect(res.memoType).toBe('id');
    expect(res.memo).toBe('12345');
  });

  // -------------------------------------------------------------------------
  // Happy path: hash memo
  // -------------------------------------------------------------------------
  it('returns memoRequired=true with memoType=hash for a valid 64-hex-char hash memo', async () => {
    const validHash = 'ab'.repeat(32); // 64 hex chars
    primeResolve(makeFederationJson({ memo_type: 'hash', memo: validHash }));
    const result = await resolveFederationAddress('alice*example.com');
    expect(result).not.toBeNull();
    const res = result as FederationResolution;
    expect(res.memoRequired).toBe(true);
    expect(res.memoType).toBe('hash');
    expect(res.memo).toBe(validHash);
  });

  // -------------------------------------------------------------------------
  // Failure path: MEMO_REQUIRED — memo_type present, memo absent
  // -------------------------------------------------------------------------
  it('returns null when memo_type="text" is present but memo is absent (MEMO_REQUIRED)', async () => {
    primeResolve(makeFederationJson({ memo_type: 'text' }));
    const result = await resolveFederationAddress('alice*example.com');
    expect(result).toBeNull();
  });

  it('returns null when memo_type="id" is present but memo is absent (MEMO_REQUIRED)', async () => {
    primeResolve(makeFederationJson({ memo_type: 'id' }));
    const result = await resolveFederationAddress('alice*example.com');
    expect(result).toBeNull();
  });

  it('returns null when memo_type="hash" is present but memo is absent (MEMO_REQUIRED)', async () => {
    primeResolve(makeFederationJson({ memo_type: 'hash' }));
    const result = await resolveFederationAddress('alice*example.com');
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Failure path: MEMO_TYPE_MISMATCH — id memo with non-numeric value
  // -------------------------------------------------------------------------
  it('returns null when memo_type="id" but memo is not a decimal integer (MEMO_TYPE_MISMATCH)', async () => {
    primeResolve(makeFederationJson({ memo_type: 'id', memo: 'not-a-number' }));
    const result = await resolveFederationAddress('alice*example.com');
    expect(result).toBeNull();
  });

  it('returns null when memo_type="id" but memo is a float string (MEMO_TYPE_MISMATCH)', async () => {
    primeResolve(makeFederationJson({ memo_type: 'id', memo: '3.14' }));
    const result = await resolveFederationAddress('alice*example.com');
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Failure path: MEMO_TYPE_MISMATCH — hash memo with wrong format
  // -------------------------------------------------------------------------
  it('returns null when memo_type="hash" but memo is too short (MEMO_TYPE_MISMATCH)', async () => {
    primeResolve(makeFederationJson({ memo_type: 'hash', memo: 'tooshort' }));
    const result = await resolveFederationAddress('alice*example.com');
    expect(result).toBeNull();
  });

  it('returns null when memo_type="hash" but memo contains non-hex chars (MEMO_TYPE_MISMATCH)', async () => {
    primeResolve(makeFederationJson({ memo_type: 'hash', memo: 'z'.repeat(64) }));
    const result = await resolveFederationAddress('alice*example.com');
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Failure path: MEMO_TYPE_MISMATCH — unrecognized memo_type
  // -------------------------------------------------------------------------
  it('returns null when memo_type is an unrecognized value (MEMO_TYPE_MISMATCH)', async () => {
    primeResolve(makeFederationJson({ memo_type: 'return', memo: 'some-value' }));
    const result = await resolveFederationAddress('alice*example.com');
    expect(result).toBeNull();
  });

  it('returns null when memo_type="none" (not a Stellar type, MEMO_TYPE_MISMATCH)', async () => {
    primeResolve(makeFederationJson({ memo_type: 'none', memo: 'some-value' }));
    const result = await resolveFederationAddress('alice*example.com');
    expect(result).toBeNull();
  });
});
