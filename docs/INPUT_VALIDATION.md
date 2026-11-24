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

### Host normalization and denied hostnames (Issue #702)

`horizon_url`, its fallbacks, and every SEP-0001 `stellar.toml` / federation fetch go through the same SSRF gate (`isSSRFBlocked` in `src/ssrf.ts`). Before matching, the host is normalized with the WHATWG URL parser, so alternate encodings resolve to the address they really point at:

- userinfo is ignored for matching (`https://horizon.stellar.org@127.0.0.1` targets `127.0.0.1`) and is rejected on its own;
- decimal / octal / hex / short-form IPv4 (`2130706433`, `0177.0.0.1`, `0x7f.1`, `127.1`) become dotted quads;
- IDNA mapping is applied (full-width digits `１２７.０.０.１`, ideographic full stops `127。0。0。1`, `ⓛocalhost`);
- trailing dots and IPv6 zone IDs are stripped (`localhost.`, `fe80::1%eth0`);
- IPv4 addresses embedded in IPv6 (`::ffff:7f00:1`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`) are unpacked and checked as IPv4.

The scheme does not matter: these hosts are rejected over `https://` too.

| Category | Denied examples |
|----------|-----------------|
| Loopback | `127.0.0.0/8`, `::1`, `0:0:0:0:0:0:0:1`, `localhost`, `*.localhost`, `2130706433`, `0x7f000001` |
| Unspecified | `0.0.0.0/8`, `0`, `::` |
| RFC 1918 private | `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `3232235521`, `0xc0a80001` |
| Link-local / cloud metadata | `169.254.0.0/16` (`169.254.169.254`, `2852039166`, `0xa9.0xfe.0xa9.0xfe`), `fe80::/10`, `metadata.google.internal`, `metadata`, `instance-data` |
| Carrier-grade NAT | `100.64.0.0/10` (includes Alibaba metadata `100.100.100.200`) |
| Other non-public IPv4 | `192.0.0.0/24`, `198.18.0.0/15`, `224.0.0.0/4` multicast, `240.0.0.0/4` reserved |
| Other non-public IPv6 | `fc00::/7` ULA, `ff00::/8` multicast, `::ffff:<private v4>`, `64:ff9b::<private v4>`, `2002:<private v4>::` |

Rejections name the normalized host and the category, for example:

```
horizon_url targets a blocked address (private IP, loopback, or metadata endpoint): "https://2130706433/" normalizes to "127.0.0.1" (loopback). Use a publicly resolvable hostname; see docs/INPUT_VALIDATION.md.
```

**DNS rebinding.** A public-looking name can resolve to a private address (`127.0.0.1.nip.io`, or an attacker domain whose A record flips between requests). `fetchSSRFSafe` (used for `stellar.toml` and federation) resolves the host before every request and every redirect hop, and refuses to connect if *any* returned address falls in a denied range. Redirects from `stellar.toml` are refused outright; federation follows at most 3 same-origin HTTPS hops, each validated again.

**IDNA homographs.** Look-alike names such as `һorizon.stellar.org` (Cyrillic `һ`) are converted to punycode (`xn--orizon-vgg.stellar.org`). They are public names, so the blocklist does not stop them, but they never match a `horizon_url_allowlist` entry for the real host. Use the allowlist when you need to pin exact hosts.

**Proxies (GHES).** `HTTPS_PROXY` / `NO_PROXY` only change transport. They never turn off the SSRF gate, and listing a private host in `NO_PROXY` does not make it reachable.

### Self-hosted Horizon: safe patterns

Because private addresses are always denied, a self-hosted Horizon must be reachable at a **public DNS name over HTTPS**:

1. Put Horizon behind a reverse proxy or load balancer with a public DNS record and a valid TLS certificate (for example `https://horizon.example.org`). Restrict access with firewall rules, mTLS at the proxy, or an IP allowlist for GitHub-hosted runner ranges, not by using a private IP.
2. Set `horizon_url_allowlist` to that exact host so typos or injected config cannot point the action anywhere else.
3. Do **not** publish a public DNS name whose A/AAAA record points at an RFC 1918 or loopback address. TrustBridge treats that as DNS rebinding and refuses the fetch.
4. On GHES or self-hosted runners that can only reach Horizon on a private network, run the action against a public mirror, or expose Horizon through an egress proxy with a public name. There is intentionally no input that disables the SSRF gate.

## Config & Rosters

- **`trustbridge_config_path`**: Path to the repository-level config file (default `.trustbridge.yml`). See [Configuration precedence (Issue #850)](#configuration-precedence-issue-850) for exactly how (and whether) it, an org-level `.github/trustbridge.yml`, and `TRUSTBRIDGE_*` environment variables combine with `action.yml` inputs.
- **Dashboard Roster (#317)**: Configured via `dashboard_roster_url`, `dashboard_roster_secret`, and `dashboard_roster_timeout_ms`. Pulls assignee roster dynamically via HTTP GET. The request URL is validated against SSRF blocklist rules and requests include `X-TrustBridge-Signature` (HMAC-SHA256) and `X-TrustBridge-Timestamp` headers when `dashboard_roster_secret` is configured. Expects a JSON dictionary response mapping GitHub logins to Stellar G-addresses (`{ "login": "G..." }`).
- **Soroban Roster (#318)**: Configured via `contract_id`, `soroban_full_roster`, and `soroban_roster_page_limit`. Normal single-address resolution looks up the contract page containing the assignee. Setting `soroban_full_roster: "true"` retrieves the complete roster page-by-page from the contract state, bounded by `soroban_roster_page_limit`.

### Configuration precedence (Issue #850)

TrustBridge has three distinct configuration layers, implemented by two separate modules. This section documents exactly what the code does today — including the parts that are implemented as a tested library function but are **not yet called** from the action's main run (`src/index.ts`). Treat anything below marked "not wired" as a documented limitation, not an aspirational description.

**The layers, highest precedence first, as the code actually resolves a single input `X`:**

1. **Explicit `with: X: ...`** in the calling workflow. Read via `core.getInput('X')`.
2. **`TRUSTBRIDGE_X` environment variable** (`src/inputs.ts`, `resolveInput()` / `TRUSTBRIDGE_ENV_MAP`, Issue #147) — used only when `with:` resolves to an empty string. Covers a fixed allowlist of inputs (never `github_token` or `stellar_address_input` — secrets and the address are never read from env). See `__tests__/inputs_env.test.ts` for the full, well-covered precedence suite for this layer.
3. **Consumer config file(s)** (`src/configReader.ts`, Issue #45) — `.trustbridge.yml` (repository-level, path configurable via `trustbridge_config_path`) and `.github/trustbridge.yml` (org/repo-wide default). `readTrustbridgeConfigs()` reads both and merges them with **repo overriding org** for any key both declare (`__tests__/configReader.test.ts` → `readTrustbridgeConfigs — org/repo layering`). `mergeConsumerConfig()` then layers the merged file config under any input *not* already present in an `explicitInputs` set, for exactly 8 fields: `horizon_url`, `horizon_url_fallback`, `rpc_fallback_url`, `asset_code`, `asset_issuer`, `min_xlm_reserve`, `min_asset_balance`, `fail_on_missing`.
4. **`action.yml` `default:`** — used when none of the above produced a value.

**Known limitation — layers 2 and 3 are not wired into the main run.** `src/index.ts` resolves every input directly as `core.getInput('X') || '<default>'`; it never calls `resolveInput()` or `mergeConsumerConfig()`/`readTrustbridgeConfigs()`. It does call `readTrustbridgeConfig()` once, but **only to validate** `.trustbridge.yml` and fail the job (`core.setFailed`) when it's malformed — the parsed values are discarded, never merged into the resolved inputs. In practice, today, only layers 1 and 4 (and env, indirectly: the GitHub Actions runner itself injects `action.yml` defaults into `INPUT_*` before the process starts) take effect for a real run; `TRUSTBRIDGE_*` env vars and `.trustbridge.yml`/`.github/trustbridge.yml` values are validated but not applied. `resolveInput`, `mergeConsumerConfig`, and `readTrustbridgeConfigs` are fully implemented and unit-tested library functions, ready for a caller to adopt; wiring them into `index.ts`'s input resolution is a separate, larger change (it touches the resolution of every covered input and several values derived from them) and is intentionally out of scope here.

**Conflict resolution when the same key has the wrong type.** `.trustbridge.yml`'s minimal YAML parser (`parseSimpleYaml`) infers a JS type per value — an unquoted `2.5` becomes a number, unquoted `true`/`false` becomes a boolean, anything else (including a quoted `"2.5"` or `"false"`) stays a string. `validateTrustbridgeConfig` then type-checks every field against its declared type (string fields: `asset_code`, `asset_issuer`, `min_xlm_reserve`, `min_asset_balance`; boolean: `fail_on_missing`) **before** any value is extracted. A type mismatch — e.g. `min_xlm_reserve: 2.5` (unquoted, parses as a number) instead of `min_xlm_reserve: "2.5"` — fails the whole config closed with a stable, field-named error (`"min_xlm_reserve must be a string"`, `"fail_on_missing must be a boolean (true or false)"`), not a silent drop or an implicit coercion. See `__tests__/configReader.test.ts` → `readTrustbridgeConfig — type conflicts fail closed with a stable error` for the full regression suite (both directions: the quoted/unquoted form that's accepted, and the one that fails).

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


## Unauthorized trustline decision table (Issue #866)

`unauthorized_trustline_policy` evaluates the present trustline state. It does
not infer authorization from `auth_immutable`, `auth_revocable`, or clawback
flags; those issuer flags explain what may happen next, while
`is_authorized: false` is the actionable account state.

| Account/trustline state | `fail` | `warn` | `ignore` |
|---|---|---|---|
| No trustline | `TRUSTLINE_MISSING` | `TRUSTLINE_MISSING` | `TRUSTLINE_MISSING` |
| Trustline, authorized or authorization field absent | pass | pass | pass |
| Trustline, `is_authorized: false` | fail, `TRUSTLINE_UNAUTHORIZED` | pass with warning, `SUCCESS` | pass silently, `SUCCESS` |
| Unauthorized + `auth_immutable: true` | still `TRUSTLINE_UNAUTHORIZED`; issuer approval is the remediation | warning remains actionable | ignored by policy |
| Unauthorized + clawback enabled + strict clawback | authorization wins: `TRUSTLINE_UNAUTHORIZED` | warning mode remains non-blocking; strict clawback may add its own check | authorization is ignored; strict clawback may still block |

The precedence is deliberate: a trustline that exists but is unauthorized must
never be reported as missing. Stable remediation is to ask the issuer to
submit `SetTrustLineFlags` (or legacy `AllowTrust`); adding another Change
Trust operation is not the fix.

## Mutually exclusive inputs

Issue #951. Some boolean inputs contradict each other. Before doing any network work, the action checks every pair in `INPUT_CONFLICT_MATRIX` (`src/inputs.ts`). If both inputs in a pair are true (`true`/`1`/`yes`, case-insensitive), the step fails at once. Each conflict is logged as an `INPUT_CONFLICT: <a> and <b> cannot both be true. …` error annotation. Unset, empty, or unrecognised values never count as true, so they never trigger a conflict.

| Pair | Why it is rejected |
| --- | --- |
| `preflight_only` + `wait_until_funded` | Preflight exits before any Horizon call, so polling could never run. |
| `preflight_only` + `use_friendbot` | Preflight exits before any Horizon call, so Friendbot could never be invoked. |
| `fixture_mode` + `wait_until_funded` | A static fixture never changes, so polling until funded would never succeed. |
| `fixture_mode` + `use_friendbot` | Fixture mode makes no network calls, so funding would not be reflected. |

`INPUT_CONFLICT` is an error-message prefix, not a `reason_code` output, because the run fails before validation starts. To fix a conflict, disable one input in the pair. `__tests__/inputs-conflict-matrix.test.ts` checks that this table, the matrix, and `action.yml` stay in sync.
