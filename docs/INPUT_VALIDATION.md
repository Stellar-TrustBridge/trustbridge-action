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

## Security Policies (SSRF & Input Guardrails)

- **`horizon_url_allowlist`**: Enforces strict URL matching for Horizon endpoints. When set (as a comma-separated list of domains), any `horizon_url` or fallback URL must exactly match one of the allowed hostnames. This provides a strong defense-in-depth layer against Server-Side Request Forgery (SSRF) and prevents the action from inadvertently contacting rogue endpoints even if the SSRF blocklist is bypassed.
- **SSRF Blocklist**: Even without the allowlist, TrustBridge strictly prevents consumer-supplied Horizon and Dashboard URLs from targeting private IP ranges, loopback addresses (127.x.x.x, ::1), cloud metadata endpoints (169.254.x.x), and the `file://` protocol.

## Config & Rosters

- **`trustbridge_config_path`**: Can point to `.github/trustbridge.yml`. Supports repository-level overrides of organization-level policies (`.github/trustbridge.yml`).
- **Dashboard Roster (#317)**: Configured via `dashboard_roster_url`, `dashboard_roster_secret`, and `dashboard_roster_timeout_ms`. Pulls assignee roster dynamically via HTTP GET. The request URL is validated against SSRF blocklist rules and requests include `X-TrustBridge-Signature` (HMAC-SHA256) and `X-TrustBridge-Timestamp` headers when `dashboard_roster_secret` is configured. Expects a JSON dictionary response mapping GitHub logins to Stellar G-addresses (`{ "login": "G..." }`).
- **Soroban Roster (#318)**: Configured via `contract_id`, `soroban_full_roster`, and `soroban_roster_page_limit`. Normal single-address resolution looks up the contract page containing the assignee. Setting `soroban_full_roster: "true"` retrieves the complete roster page-by-page from the contract state, bounded by `soroban_roster_page_limit`.
