# Input Validation Notes

TrustBridge validates inputs before calling Horizon so failures stay clear and cheap.

## Stellar address

- Must be present.
- Must be a 56-character public key.
- Must start with `G`.
- Must only use Stellar base32 characters.
- Must pass StrKey checksum validation (ed25519 version byte + CRC-16/XMODEM), not just the regex shape.

## Reserve amount

`min_xlm_reserve` should be a non-negative numeric string such as `1.5`. Projects can raise this when contributors need extra ledger entries for trustlines, sponsorship, or app-specific requirements. It is applied as a floor over the Stellar protocol minimum computed from the account's `subentry_count`, `num_sponsoring`, and `num_sponsored` — see [README: Sponsor-aware XLM reserve](../README.md#sponsor-aware-xlm-reserve).

## Boolean behavior

`fail_on_missing` accepts common truthy and falsy strings. Unknown values fall back to the default so workflow typos do not silently invert the gate.

`debug_mode` accepts the same boolean-friendly values and enables verbose action logging.

`sticky_comment` accepts the same boolean-friendly values. When true (default), the action updates its previous issue comment in place instead of creating a new one on every run.

## Timeout values

`horizon_timeout_ms` must be a number between `1000` and `60000`. It controls the Horizon request timeout and helps avoid long-running workflows on slow or unreliable network responses.

`wait_until_funded_timeout_ms` must be a number between `0` and `600000`. It bounds the total time spent polling when `wait_until_funded` is enabled.

`wait_until_funded_interval_ms` must be a number between `1000` and `60000`. It controls the delay between funding polls.

## Authentication tokens (Issue #225)

- **`github_token`**: Standard GitHub Actions token (e.g. `${{ secrets.GITHUB_TOKEN }}`) or fine-grained PAT. Requires `issues: write` (or `discussions: write` for discussion events).
- **`github_app_token`**: Pre-minted GitHub App installation token (e.g. generated via `actions/create-github-app-token`) used for cross-repository or organization-wide triage.
- **Precedence**: When `github_app_token` is provided, it takes precedence over `github_token`.
- **Security & Redaction**:
  - Raw private keys (PEM files) must **never** be passed directly into action inputs or environment variables; instead, use an isolated token minting step (`actions/create-github-app-token`).
  - Tokens and private keys are registered as GitHub Actions secrets (`core.setSecret`) and stripped by the logger (`[REDACTED]`) to prevent credential leakage into CI logs.


---

## Horizon SSRF blocklist (Issue #308)

TrustBridge enforces a strict server-side-request-forgery (SSRF) block-list on
every Horizon and RPC URL it accepts — from action inputs, consumer
`.trustbridge.yml` config files, and fallback URL inputs.

### Blocked categories

| Category | Example blocked addresses |
|----------|--------------------------|
| IPv4 loopback | `127.0.0.1`, `127.x.x.x` |
| IPv4 link-local | `169.254.x.x` |
| AWS instance metadata | `169.254.169.254` |
| GCP metadata | `metadata.google.internal` |
| Private class-A | `10.x.x.x` |
| Private class-B | `172.16.x.x` – `172.31.x.x` |
| Private class-C | `192.168.x.x` |
| IPv6 loopback | `::1`, `[::1]` |
| IPv6 link-local | `fe80::`, `[fe80::1]` |
| Bare localhost | `localhost` (any port, any case) |
| `file://` protocol | `file:///etc/passwd` |

### Known bypass patterns and how they are handled

The blocklist is tested against a **fuzz corpus** (`__tests__/ssrf-fuzz.test.ts`)
that generates dozens of host variants per category. Known bypass patterns and
how the implementation handles them:

| Bypass pattern | Example | Defence |
|----------------|---------|---------|
| Credential prefix | `http://user:pass@192.168.1.1/` | URL is credential-stripped before pattern matching |
| Non-standard port | `http://localhost:9999/` | Port is not part of the match; hostname checked independently |
| IPv6 uppercase | `http://[FE80::1]/` | Patterns use case-insensitive flag (`/i`) |
| IPv6 zone ID | `http://[fe80::1%25eth0]/` | Covered by the `fe80:` prefix pattern |
| Trailing dot | `http://localhost./` | URL() normalizes or rejects trailing-dot hostnames |
| Embedded credentials | `http://ignored@10.0.0.1/` | Stripped with `replace(/^(https?:\/\/)[^@/]*@/, '$1')` |
| `172.15.x.x` (public) | `http://172.15.0.1/` | `172.(16-31)` pattern does NOT block 172.15 — correctly allowed |
| Decimal IP (`2130706433`) | `http://2130706433/` | URL() may not normalize; documented gap — use network egress controls for defense-in-depth |
| Hex IP (`0x7f000001`) | `http://0x7f000001/` | Same as decimal — URL() behavior is platform-dependent |

### SSRF fuzz test suite (Issue #308)

`__tests__/ssrf-fuzz.test.ts` provides a generator-based fuzz corpus:

- **IPv4 loopback**: 6 addresses × http/https/port/credential = 24+ cases
- **IPv4 link-local**: 6 addresses × variants = 12+ cases
- **IPv4 class-A**: 6 addresses × variants = 12+ cases
- **IPv4 class-B**: all 16 private subnets (172.16–31) × variants = 32+ cases
- **IPv4 class-C**: 5 addresses × variants = 10+ cases
- **IPv6 loopback**: 6 canonical + abbreviated forms
- **IPv6 link-local**: 6 forms including uppercase and zone ID
- **localhost variants**: 8 forms including case and ports
- **credential bypass**: 7 userinfo@host forms
- **cloud metadata**: 8 forms (AWS, GCP, Azure)
- **file://**: 6 path forms
- **allowlist regression**: 13 legitimate public Horizon endpoints that MUST pass

Run the SSRF fuzz suite independently:

```bash
npm test -- --testPathPattern 'ssrf'
```

The CI `ssrf-audit` job runs this suite on every push and pull request. A
regression that removes or weakens any blocklist entry will break the build
before a release is cut.

### Fail-closed policy

When URL validation fails, the action **fails immediately** with a clear error
message identifying the blocked address. There is no fallback to an unvalidated
URL. Fixture mode (`fixture_mode: true`) bypasses Horizon HTTP calls entirely but
never disables the blocklist for non-fixture runs.
