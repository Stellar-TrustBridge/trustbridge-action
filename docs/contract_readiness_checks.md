# Contract Readiness Checks Action

Implements GitHub Action step for automated Soroban contract health and readiness checks.

---

## Authorization Required Trustlines (Issue #248)

When an issuer has `AUTHORIZATION_REQUIRED` enabled on their account, trustlines must be explicitly authorized before they can receive assets. This is a critical readiness check for treasury and payout workflows.

### Behavior

| Scenario | Policy=fail | Policy=warn (default) | Policy=ignore |
|----------|-------------|----------------------|---------------|
| Trustline exists, authorized | Pass | Pass | Pass |
| Trustline exists, **not authorized** | **Fail** | Pass (with warning) | Pass |
| Trustline missing | Fail | Fail | Fail |

### Reason codes

- `TRUSTLINE_UNAUTHORIZED` — Trustline exists but is not authorized by the issuer.
- `TRUSTLINE_MISSING` — Trustline does not exist or is blocked by policy.

### Remediation

When `unauthorized_trustline_policy: fail` and the trustline is unauthorized, the remediation advises:

> Ask the asset issuer to authorize this trustline. The issuer has AUTHORIZATION_REQUIRED enabled, so a Change Trust operation alone is not enough — the issuer must submit a SetTrustLineFlags (or legacy AllowTrust) operation.

### Auth-revocable awareness

When the issuer has `AUTH_REVOCABLE` enabled, the trustline detail message notes that authorized trustlines can be revoked. This is informational only and does not affect the readiness check.

### Clawback awareness

When clawback is enabled on a trustline (non-strict mode), the trustline detail warns that the issuer can reclaim assets at any time.

### Dashboard parity

Dashboard readiness checks should maintain parity with this policy. The `trustlineAuthorized` field in the validation result provides the authorization state for dashboard consumption.

---

## Liquidity Pool Share Exclusion (Issue #249)

Liquidity pool (LP) share trustlines are **never** treated as asset trustlines for readiness checks. This is enforced via `isCreditBalance()`, which only matches `credit_alphanum4` and `credit_alphanum12` balance types.

### Implications

- An account with only LP shares shows "zero trustlines".
- `getAssetBalance()` returns `'0'` when only LP shares exist.
- LP shares for a pool containing USDC do **not** satisfy the USDC trustline requirement.

---

## Muxed Address Support (Issue #250)

Stellar muxed addresses (M-addresses) are accepted and automatically converted to the underlying G-address for Horizon checks.

### Format

- M-addresses are 69 characters: `M` + 68 base32 characters.
- Version byte: `0x60` (12 << 3).
- Encodes: 32-byte ed25519 key + 8-byte muxed ID + CRC-16 checksum.

### Conversion

The M-address is decoded to extract the G-address. All Horizon API calls use the G-address. The muxed ID is preserved in output but not exposed in logs.

---

## Federation Address Resolution (Issue #257)

Optional federation resolution for `user*domain` addresses, using HTTPS stellar.toml with SSRF protection.

### Security

- HTTPS-only enforcement
- SSRF blocklist (private IPs, loopback, metadata)
- Safe redirects (same-origin only)
- 10-second timeout, body size limits
- Domain validation before any fetch

### Policy

- Off by default (`federation_resolution_enabled: false`)
- Full SEP-0002 client functionality is out of scope
