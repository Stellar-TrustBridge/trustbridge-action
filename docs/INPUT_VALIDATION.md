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

## `unauthorized_trustline_policy` (Issue #729)

Controls what happens when a trustline **exists** but the issuer has set `AUTHORIZATION_REQUIRED` and has not authorized the account yet (`is_authorized: false`). The value is trimmed, lowercased and must be one of `warn`, `fail` or `ignore`; an empty value falls back to `warn`, and anything else fails fast with:

```
unauthorized_trustline_policy must be one of "fail", "warn", or "ignore". Received: "<value>"
```

| Value | Trustline check | `ready` | `reason_code` | Comment banner | SARIF |
| --- | --- | --- | --- | --- | --- |
| `warn` (default) | passes | `true` | `SUCCESS` | `> ⚠️ **Issuer authorization required**` with "this does **not** fail the run" | trustline result stays at `note` under `TB002` |
| `fail` | fails | `false` | `TRUSTLINE_UNAUTHORIZED` | `> 🚫 **Issuer authorization required**` with "Blocking — … `reason_code: TRUSTLINE_UNAUTHORIZED`" | trustline result promoted to `error` under `TB006` |
| `ignore` | passes | `true` | `SUCCESS` | none — the banner is omitted entirely | no authorization finding |

Notes:

- **`warn` is the safe default.** It surfaces the risk in the comment without turning an existing green workflow red. Only `fail` marks the run as failed, and only when `fail_on_missing`/gate semantics say so.
- **The two modes are worded differently on purpose** — triage distinguishes a blocking policy failure from an informational warning by the glyph (🚫 vs ⚠️), the heading, and the `reason_code` bullet, not by re-reading a sentence inside a ✅ bullet.
- **`reason_code` is never `TRUSTLINE_MISSING` for this case.** The trustline exists on-chain; the fix is an issuer `SetTrustLineFlags` (or legacy `AllowTrust`) operation, not another Change Trust.
- **`ignore`** reproduces the pre-#72 behaviour: no additional check, no banner, no SARIF finding.
- The effective policy is echoed on the validation result as `unauthorizedTrustlinePolicy` so the comment and SARIF renderers never re-derive it from a check detail string.

```yaml
- uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: G...
    github_token: ${{ secrets.GITHUB_TOKEN }}
    unauthorized_trustline_policy: fail   # or: warn (default)
```

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

## Comment & Posting Modes (#456)

TrustBridge separates the comment threading behavior from the overall comment posting strategy:

- **`comment_mode`**: Controls how comments are placed on issues or pull requests. Allowed values:
  - `sticky` (default): Edits/updates the existing TrustBridge bot comment in-place.
  - `new`: Posts a new standalone comment on each run.
  - `reply`: Posts as a reply or new comment without replacing earlier comments.
- **`posting_mode`**: Controls whether comments are posted to GitHub. Allowed values:
  - `post` (default): Post or update comments via GitHub API.
  - `dry-run`: Generate comment markdown and populate outputs, but skip calling GitHub API (useful for PRs from forks or read-only runs).
  - `off`: Disable comment generation and posting entirely.

For backwards compatibility, if `posting_mode` is omitted, the action falls back to checking `comment_mode` if it was set to `post`, `dry-run`, or `off`.

## Friendbot Funding for Test Networks (#459)

- **`use_friendbot`**: When `true`, automatically invokes Stellar Friendbot to fund new accounts on testnet/futurenet when Horizon returns a 404 (not found). Blocked on mainnet.
- **`friendbot_url`**: Custom Friendbot endpoint (defaults to `https://friendbot.stellar.org`). Validated against an SSRF allowlist (`friendbot.stellar.org`, `friendbot-futurenet.stellar.org`, `horizon-testnet.stellar.org/friendbot`, `friendbot-testnet.stellar.org`).
- **`friendbot_timeout_ms`**: Friendbot request timeout in milliseconds (default: `15000`).

## Cache Backend Selection (#461)

- **`use_cache`**: Enables runner in-memory cache for Horizon account checks.
- **`use_actions_cache_backend`**: Opts into the persistent GitHub Actions Cache Service backend (`@actions/cache`) to reuse check results across matrix legs and workflow runs. Falls back gracefully to runner memory cache if cache operations encounter service issues.
- **`horizon_cache_ttl_ms`**: Time-to-live for cached account data in milliseconds (default: `60000`).

