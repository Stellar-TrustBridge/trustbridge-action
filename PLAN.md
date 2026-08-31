# Implementation Plan — Issues #248, #249, #250, #257

## Branch: `#248_#249_#250_#257`

---

## Issue #248 — Unauthorized AUTH_REQUIRED Trustlines

### Current State
- `unauthorizedTrustlinePolicy` already exists in `CheckConfig` (from `inputs.ts`)
- Three policies: `"fail"` | `"warn"` (default) | `"ignore"`
- `runAccountChecks()` at `src/checks.ts:766` already handles this:
  - `isUnauthorized = trustlineExistsRaw && trustlineAuthorized === false`
  - `authorizationBlocks = isUnauthorized && unauthorizedPolicy === 'fail'`
  - `trustlineExists = trustlineExistsRaw && !authorizationBlocks`
- When `policy=fail`, the trustline check fails and remediation advises issuer authorization
- When `policy=warn` (default), trustline passes but detail notes it's unauthorized
- **Missing**: No `REASON_CODE` for unauthorized trustlines (currently falls through to `FAILED`)
- **Missing**: No `auth_revocable` / clawback-aware messaging
- **Missing**: Documentation in `docs/USAGE.md` and `docs/contract_readiness_checks.md`

### Changes

1. **`src/checks.ts`** — Add `TRUSTLINE_UNAUTHORIZED` reason code:
   - In the `reasonCode` switch (line ~988), add before `FAILED`:
     ```ts
     if (isUnauthorized && !authorizationBlocks) return 'TRUSTLINE_UNAUTHORIZED';
     ```
   - Enhance trustline detail messages to mention `auth_revocable` when issuer has that flag (check `account.flags?.auth_revocable`)
   - Add clawback flag info to trustline detail when `clawbackEnabled && !clawbackStrictMode`

2. **`src/inputs.ts`** — Add `parseUnauthorizedTrustlinePolicy` to exports (already exported)

3. **`__tests__/checks.test.ts`** — Add tests:
   - `policy=fail` → unauthorized trustline → `valid=false`, `trustlineExists=false`, `reasonCode=TRUSTLINE_MISSING`
   - `policy=warn` (default) → unauthorized trustline → `valid=true` but warning in detail
   - `policy=ignore` → unauthorized trustline → `valid=true`, no warning
   - `policy=fail` + `auth_revocable` issuer → appropriate detail message
   - `policy=fail` + clawback → combined messaging

4. **`docs/USAGE.md`** — Add section:
   ```markdown
   ## Unauthorized trustline policy
   ### `unauthorized_trustline_policy`
   ```
   Document fail/warn/ignore behavior, default, and parity note for dashboard.

5. **`docs/contract_readiness_checks.md`** — Expand stub with auth_required section.

---

## Issue #249 — LP Share Trustlines

### Current State
- `HorizonBalance` type includes `HorizonBalanceLiquidityPoolShares` (`asset_type: 'liquidity_pool_shares'`)
- **`isCreditBalance()` at `horizon.ts:1060` already correctly excludes LP shares** — it only returns true for `credit_alphanum4` | `credit_alphanum12`
- `hasTrustline()` at `horizon.ts:1069` uses `isCreditBalance()` as filter, so LP shares are already excluded from trustline matching
- `hasAnyTrustlines` at `checks.ts:790` uses `isCreditBalance(b)`, so LP shares don't count as "has trustlines"
- Existing test at line 341: `does not false-positive hasAnyTrustlines when only LP shares are present` — confirms current behavior
- **Policy**: LP shares are explicitly excluded. The code is correct; we need documentation + additional edge-case tests.

### Changes

1. **`src/checks.ts`** — Add documentation comment at line 790 explaining LP share exclusion:
   ```ts
   // LP shares (liquidity_pool_shares) are explicitly excluded via isCreditBalance().
   // See Issue #249 — LP shares must never be treated as asset trustlines.
   ```

2. **`__tests__/checks.test.ts`** — Add edge-case tests:
   - Account with LP shares where pool_id happens to contain asset code text → still not treated as USDC trustline
   - Account with LP shares + other credit trustlines (not USDC) → `trustlineExists=false`, detail says "not for USDC"
   - Account with LP shares + USDC trustline + other trustlines → `trustlineExists=true` (USDC found correctly)
   - `getAssetBalance` returns '0' when only LP shares exist (no matching credit trustline)

3. **`docs/USAGE.md`** — Add section:
   ```markdown
   ## Liquidity pool share trustlines
   ```
   Document policy: LP shares are never treated as asset trustlines. If you hold LP shares for a pool containing USDC, you still need a direct USDC trustline. Reference `isCreditBalance()` exclusion.

---

## Issue #250 — Muxed (M-) Address Support

### Current State
- `isValidStellarAddress()` only validates G-addresses (`/^G[A-Z2-7]{55}$/`)
- `validateStellarAddress()` throws for non-G addresses
- M-addresses (Stellar muxed accounts) start with `M` and encode a G-address + 64-bit muxed ID
- The StrKey encoding for M-addresses: version byte `0x60` (12 << 3) + 32-byte ed25519 key + 8-byte muxed ID + 2-byte CRC-16
- Total: 1 version + 32 key + 8 id + 2 checksum = 41 bytes → 69 base32 chars (M + 68 base32)
- Wait — actually M-addresses are 69 characters, not 56. Let me verify.
- Horizon requires G-addresses for account lookups
- No M-address handling exists in the codebase

### Changes

1. **`src/checks.ts`** — Add M-address support:
   - Add `MUXED_ADDRESS_REGEX = /^M[A-Z2-7]{68}$/` (M + 68 base32 chars = 69 total per SEP-0023)
   - Add `isMuxedAddress(address: string): boolean` — regex + base32 decode + CRC-16 validation
   - Add `decodeMuxedAddress(mAddress: string): { gAddress: string; muxedId: bigint } | null`
     - Base32 decode the M-address (43 bytes: 1 version + 32 key + 8 id + 2 checksum)
     - Verify version byte is `0x60` (12 << 3)
     - Extract 32-byte ed25519 key (bytes 1-32) and 8-byte muxed ID (bytes 33-40, big-endian per SEP-0023)
     - Validate CRC-16/XMODEM checksum (bytes 41-42)
     - Re-encode ed25519 key as G-address: version byte `0x30` + 32-byte key + CRC-16
     - Return `{ gAddress, muxedId }`
   - Add `convertMuxedToGAddress(address: string): string` — extracts G-address from M-address, throws on invalid
   - Update `validateStellarAddress()` to accept M-addresses
   - Update `extractStellarAddressFromText()` to also scan for M-addresses with regex `/\bM[A-Z2-7]{68}\b/g`

2. **`src/index.ts`** — Add M-address conversion in the address resolution pipeline:
   - After address is resolved (from assignee map, issue body, or direct input)
   - If M-address detected, convert to G-address for Horizon lookup
   - Preserve original M-address in comment output (G-address for all Horizon calls)
   - Don't log muxed ID in privacy-sensitive contexts

3. **`__tests__/checks.test.ts`** — Add tests:
   - Valid M-address → converts to correct G-address
   - Invalid M-address (bad checksum) → rejected
   - M-address with valid G-address extraction → Horizon gets G-address
   - Comment output shows G-address for checks

4. **`docs/USAGE.md`** — Add section:
   ```markdown
   ## Muxed (M-) address support
   ```
   Document that M-addresses are accepted, converted to G-addresses for Horizon checks, and the original M-address is preserved in output.

---

## Issue #257 — Federation Address Resolution

### Current State
- `src/toml.ts` already fetches `stellar.toml` with SSRF protection
- `src/ssrf.ts` has full SSRF-safe fetch with HTTPS-only, redirect control, size limits, timeouts
- No federation protocol implementation exists
- Federation format: `user*domain` where domain hosts `https://domain/.well-known/stellar.toml`
- The TOML contains `[[FEDERATION_SERVER]]` with `auth_domain` and `forward_url`

### Changes

1. **New file: `src/federation.ts`** — Federation resolver:
   - `isFederationAddress(input: string): boolean` — detects `user*domain` format
   - `parseFederationAddress(input: string): { username: string; domain: string } | null`
   - `resolveFederationAddress(input: string): Promise<{ gAddress: string; memo?: string } | null>`
     - Validate username: alphanumeric + limited special chars, max 32 chars
     - Validate domain: valid hostname, not private/loopback (SSRF check)
     - Fetch `https://domain/.well-known/stellar.toml` using `fetchSSRFSafe()` from `ssrf.ts`
     - Parse TOML for `[[FEDERATION_SERVER]]` → `auth_domain` + `forward_url`
     - If `forward_url` is set, fetch `forward_url?type=name&addr=user*domain` using `fetchSSRFSafe()`
     - Parse JSON response: `{ account_id, memo_type, memo }`
     - Validate `account_id` is a valid G-address
     - Return `{ gAddress, memo }` or null on failure
   - All fetches use HTTPS-only, safe redirects, 10s timeout, 256KB body limit

2. **`src/validation.ts`** — Add federation input validation:
   - `validateFederationAddress(input: string): ValidationResult`
   - Validate username format (no shell chars, no `*` in wrong position)
   - Validate domain is not private/loopback

3. **`src/inputs.ts`** — Add `federation_resolution_enabled` input:
   - Parse boolean, default `false` (off by default per issue requirement)

4. **`action.yml`** — Add new input:
   ```yaml
   federation_resolution_enabled:
     description: >-
       Enable optional federation (user*domain) address resolution. When true,
       addresses in "user*domain" format are resolved via HTTPS stellar.toml
       federation protocol. Default false.
     required: false
     default: 'false'
   ```

5. **`src/index.ts`** — Add federation resolution in address pipeline:
   - After initial address resolution
   - If `federation_resolution_enabled` and input matches federation format
   - Resolve federation → get G-address + optional memo
   - Use G-address for Horizon checks
   - Surface memo in comment output if present

6. **`__tests__/federation.test.ts`** — New test file:
   - Valid federation address parsing
   - Invalid username (too long, special chars)
   - Invalid domain (private IP, localhost)
   - Successful federation resolution (mock TOML + federation server)
   - Federation resolution failure (network error, invalid response)
   - SSRF protection (blocked domain, non-HTTPS)
   - TOML without federation server
   - Federation server returns invalid G-address

7. **`docs/USAGE.md`** — Add section:
   ```markdown
   ## Federation address resolution
   ```
   Document federation format, how it works, security measures, and that it's off by default.

---

## Verification Plan

### After each issue:
```bash
npm test -- --testPathPattern 'checks' && npm run build
npm test -- --testPathPattern 'validation|ssrf' && npm run build
```

### After all issues:
```bash
npm test && npm run build
```

### Final checks:
- `dist/` updated via `npm run build`
- All existing tests pass
- New tests cover each issue's requirements
- Documentation updated in `docs/USAGE.md` and `docs/contract_readiness_checks.md`
