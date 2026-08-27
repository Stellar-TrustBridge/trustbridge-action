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

