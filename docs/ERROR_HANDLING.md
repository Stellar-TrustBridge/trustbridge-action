# Error handling

How **trustbridge-action** behaves when things go wrong — Horizon outages, bad input, empty trustlines, and GitHub API failures.

Related docs: [README](../README.md) · [Architecture](ARCHITECTURE.md) · [Usage](USAGE.md)

---

## Summary matrix

| Condition | HTTP / cause | Retries | Outputs | Comment | Workflow |
|-----------|--------------|---------|---------|---------|----------|
| Invalid G-address | Input validation | No | Not set (run fails early) | Not posted | `setFailed` |
| **Missing issues:write** | **Preflight 401/403** | **No** | **Not set (run fails before Horizon)** | **Not posted** | **`setFailed` with clear guidance** |
| **Issue not found (preflight)** | **Preflight 404** | **No** | **Not set** | **Not posted** | **`setFailed`** |
| Account not found | Horizon 404 | No (unless `wait_until_funded`) | `account_funded=false`, others false/0 | Posted with activation steps | per `fail_on_missing` |
| Account not found, `wait_until_funded: true` | Horizon 404 repeated | Polls every `wait_until_funded_interval_ms` until funded or `wait_until_funded_timeout_ms` elapses | Same as above if timeout reached | Same as above | per `fail_on_missing` |
| **Cross-network mismatch** | **Horizon 404 + active on alt network** | **No** | **`account_funded=false`** | **Posted with mismatch guidance** | **per `fail_on_missing`** |
| Missing trustline | Horizon 200, no matching balance | No | `account_funded=true`, `trustline_exists=false` | Posted with Lab/LOBSTR links | per `fail_on_missing` |
| Zero trustlines | Horizon 200, native only | No | Same as missing trustline | Specific “zero trustlines” message | per `fail_on_missing` |
| Low XLM reserve | Horizon 200, native &lt; min | No | `xlm_balance` set, reserve fail | Posted with amount to send | per `fail_on_missing` |
| Rate limited | Horizon 429 | Yes (≤3) | If exhausted: failure result | Posted if reachable | per `fail_on_missing` |
| Service unavailable | Horizon 503/502/504 | Yes (≤3) | If exhausted: failure result | Posted | per `fail_on_missing` |
| Timeout | AbortController 15s | Yes (≤3) | If exhausted: `xlm_balance=unknown` | Posted | per `fail_on_missing` |
| TLS/certificate failure | Handshake/cert error connecting to `horizon_url` | No (not retryable — see below) | `xlm_balance=unknown`, distinct "Horizon TLS / certificate verification" check | Posted, attributes failure to the endpoint not the account | per `fail_on_missing` |
| Unauthorized trustline | Horizon 200, trustline exists, `is_authorized: false` | No | Per `unauthorized_trustline_policy` — `fail` clears `trustline_exists` | Posted with issuer-authorization remediation/warning | per `fail_on_missing` (when policy is `fail`) |
| Clawback-enabled trustline | Horizon 200, trustline exists, `is_clawback_enabled: true` | No | Warns by default; fails if `clawback_strict_mode: true` | Posted with clawback warning | per `fail_on_missing` (when strict mode is on) |
| Unsafe `horizon_url`/`horizon_url_fallback`/`rpc_fallback_url` | SSRF-unsafe target or non-HTTPS scheme | No | Not set (run fails early) | Not posted | `setFailed` |
| Comment API failure | GitHub 403/422/etc. | No | Still set from checks | Not posted | Check result still applies |
| No issue context | workflow_dispatch without issue | No | Set normally | Skipped (warning) | per check result |

---

<!-- ERROR_CATALOG_BEGIN -->
## Structured Error Catalog

Machine-readable catalog of all `reason_code` values that TrustBridge sets on the `reason_code` output.
This section is verified by `scripts/check-error-catalog.js` on every CI run — removing or renaming a
code here will fail the build.

| `reason_code` | Class / source | Retryable | Description |
|---------------|---------------|-----------|-------------|
| `SUCCESS` | `validAccountResult` · `src/checks.ts` | n/a | All checks passed: account funded, trustline present, XLM reserve met. |
| `ACCOUNT_NOT_FUNDED` | `unfundedAccountResult` · `src/checks.ts` | Yes (with `wait_until_funded`) | Horizon returned 404 — the account has not been activated on-ledger yet. |
| `TRUSTLINE_MISSING` | `validAccountResult` · `src/checks.ts` | No | Account is funded but does not hold the configured asset trustline. |
| `RESERVE_TOO_LOW` | `validAccountResult` · `src/checks.ts` | No | Account is funded and has the trustline but native XLM balance is below the required reserve. |
| `TRUSTLINE_LIMIT_TOO_LOW` | `validAccountResult` · `src/checks.ts` | No | Account has the trustline but its configured limit is below `min_trustline_limit`. |
| `FAILED` | `validAccountResult` · `src/checks.ts` | No | Generic failure — one or more checks failed but no more-specific code applies. |
| `HORIZON_ERROR` | `horizonFailureResult` · `src/checks.ts` | Yes (≤ 3 retries) | Horizon returned a non-404 HTTP error (502, 503, 504, etc.) or an unclassified failure. |
| `HORIZON_TIMEOUT` | `horizonFailureResult` · `src/checks.ts` | Yes (≤ 3 retries) | Horizon request timed out (AbortController fired after `horizon_timeout_ms`). |
| `TLS_ERROR` | `tlsFailureResult` · `src/checks.ts` | No | TLS handshake or certificate verification failed for `horizon_url`; connection was never established. |
| `RATE_LIMIT_EXHAUSTED` | `HorizonRateLimitError` · `src/horizon.ts` | No (budget exhausted) | Horizon returned HTTP 429 and all retry attempts were exhausted (or `retry_max_total_wait_ms` budget was exceeded). |

### Notes

- The `reason_code` output is always set, even when `fail_on_missing: false`.
- Downstream steps can branch on `steps.<id>.outputs.reason_code` to implement custom logic per failure mode.
- Codes in the `HORIZON_*` and `TLS_ERROR` family indicate infrastructure problems, not wallet configuration issues — contributors should not be asked to take action on these.
- `RATE_LIMIT_EXHAUSTED` is distinct from `HORIZON_ERROR`: it specifically indicates the 429-retry budget was consumed, which may indicate high org-wide concurrency. Consider `rpc_fallback_url` or a self-hosted Horizon node.

<!-- ERROR_CATALOG_END -->

---

## Input validation errors

### Invalid Stellar address

**Rule:** Must match `/^G[A-Z2-7]{55}$/` **and** pass full StrKey validation — the ed25519 public-key version byte and a matching CRC-16/XMODEM checksum over the decoded payload. A string that matches the regex but has a corrupted checksum (e.g. a single mistyped character) still fails.

Examples that fail:

- Empty string
- Ethereum-style `0x...` addresses
- Wrong length or invalid base32 characters (`0`, `1`, `8`, `9`, `l`)
- Correct shape and length but an invalid StrKey checksum (e.g. a typo'd character)

**Behavior:** Throws before any Horizon call. The action run fails immediately; no outputs or comments.

### Invalid or malicious Horizon URL (`horizon_url`)

**Rules:**

- Must use `https://` by default (`http://` allowed only if `allowHttp` option is enabled).
- Must not contain embedded credentials (e.g. `https://user:pass@horizon.stellar.org` is rejected).
- Must not contain path traversal fragments (e.g. `/../`, `/./`, `%2e%2e`, `%2E%2E`, `\..`).
- Must not target private IP ranges or metadata endpoints (SSRF protection).

Examples that fail:

- `https://user:pass@horizon.stellar.org`
- `https://horizon.stellar.org/../admin`
- `https://horizon.stellar.org/%2e%2e/`
- `file:///etc/passwd`
- `http://169.254.169.254/latest/meta-data`

**Behavior:** Disallowed `horizon_url` inputs are rejected early during validation (`validateHorizonUrl`), throwing a `HorizonError` before any network calls are dispatched. Metrics reporting host tags use clean, normalized host keys.

---

## Horizon errors

### 404 — Account not funded

Stellar accounts must receive a minimum XLM funding transaction before they exist on ledger.

**User message:** Account not found — may not be funded or activated.

**Remediation includes:**

1. Send ≥ 1 XLM to activate
2. Add USDC (or configured asset) trustline
3. Estimated cost ~1.5 XLM

### 429 — Rate limiting

Horizon may return `Retry-After`. The client:

1. Waits for `Retry-After` or exponential backoff (1s, 2s, 4s)
2. Enforces a sleep cap: `retry_max_delay_ms` (per retry) and `retry_max_total_wait_ms` (total across retries). If exceeded, throws a distinct rate limit error immediately.
3. Retries up to **3** times
4. If still failing → `horizonFailureResult`

**Operator tip:** For high-volume orgs or mass assignments (Waves), consider configuring `horizon_max_requests` to cap the total requests per run. Once this budget is exhausted, the action will fail fast with a `RateBudgetExhaustedError` rather than stampeding the public Horizon API. Consider self-hosted Horizon or caching for extremely high concurrency workflows.

### 503 / 502 / 504 — Service degradation

Same retry policy as 429. Public Horizon occasionally returns 503 during maintenance.

### Timeout

Default **15 seconds** per attempt. Network partitions or slow Horizon nodes trigger abort + retry.

### TLS / certificate verification failure

Raised when the TLS handshake to `horizon_url` itself fails — expired certificate, self-signed certificate, hostname mismatch, or an untrusted CA. Not retried (retrying the same misconfigured endpoint cannot succeed) and, when a fallback URL is configured, the action falls through to it just like any other primary-endpoint failure.

**User message:** A distinct "Horizon TLS / certificate verification" check — never phrased as an account or trustline problem, since the account was never reached. Only the sanitized, single-line error is included; no stack trace or raw internal detail is posted to the comment.

**Common cause:** a private/enterprise Horizon mirror with a self-signed or internally-issued certificate that the Actions runner does not trust. See [Private Horizon mirrors](USAGE.md#private-horizon-mirrors) for setup guidance — TrustBridge never disables certificate verification to work around this.

### Unsafe or non-HTTPS `horizon_url` / `horizon_url_fallback` / `rpc_fallback_url`

Rejected before any connection is attempted if the URL targets a private IP, loopback, link-local address, a cloud metadata endpoint, uses `file://`, or does not use `https://`. The run fails immediately (same as invalid input) — no Horizon call is ever made.

### Waiting for funding (`wait_until_funded`)

When `wait_until_funded: true`, a 404 no longer resolves immediately to the unfunded result. Instead the action sleeps `wait_until_funded_interval_ms` and retries, up to a `wait_until_funded_timeout_ms` budget. Any non-404 error breaks out of the polling loop immediately and is handled the same as a normal Horizon failure — polling only ever waits on "not found," never on outages or rate limits.

---

## Validation failures (200 OK)

### Trustline missing

Two sub-cases:

1. **Zero trustlines** — only native XLM in `balances`
2. **Other assets only** — trustlines exist but not for configured `asset_code` + `asset_issuer`

Messages differ so contributors know whether to add vs fix the asset.

### Insufficient XLM

Native balance is parsed as a string from Horizon (7 decimal places) and compared numerically to `min_xlm_reserve`.

Remediation calculates approximate additional XLM needed.

> **Balance string format and safe parsing rules for release scripts:**
> See [DECIMAL_PRECISION.md](DECIMAL_PRECISION.md) for a full explanation of
> why Horizon returns balances as strings, stroop vs decimal XLM, `min_xlm_reserve`
> validation rules, and safe parsing patterns to avoid rounding bugs in downstream
> payout automation.

---

## issues:write preflight failures (#145)

The preflight runs before Horizon to catch permission problems early.

### 401 — Invalid or expired token

The token is not recognized by GitHub. Either the token value is wrong or it has expired.

**User message:** `GitHub token is not authorized (401). Ensure the token is valid...`

**Fix:** Re-generate the PAT or verify `secrets.GITHUB_TOKEN` is correctly referenced.

### 403 — Missing issues:write permission

The token exists but does not have permission to read/write issues.

**User message:** `GitHub token lacks issues: write permission (403). Add permissions: issues: write...`

**Fix:**
```yaml
permissions:
  issues: write
  contents: read
```

### 404 — Issue not found

The issue number from the event payload does not resolve to an open issue.

**User message:** `Issue #N was not found (404).`

**Fix:** Confirm the action is triggered by an `issues` event with an open issue.

### Non-issue context (no preflight run)

On `workflow_dispatch` and other non-issue events, TrustBridge skips both the preflight and comment posting. Checks still run and outputs are set.

---

## Cross-network mismatch (#144)

When a Stellar address returns 404 on the configured Horizon endpoint, TrustBridge silently checks whether the same address is active on the **opposite** network (mainnet ↔ testnet) using a 5-second probe.

If the address is found on the other network, the error message and remediation steps are augmented with clear guidance:

- Which network the address is active on
- The Horizon URL for that network
- Two remediation options: fund on the correct network, or switch `horizon_url`

This check adds at most ~5 seconds when a 404 is received and is silent on success (no hint appended for genuinely unfunded accounts).

---

## GitHub comment failures

If `issues.createComment` fails (permissions, issue locked, etc.):

- Error is logged as **`core.warning`**
- Outputs are still written
- Pass/fail logic still runs

### Permission matrix

| Token type | `issues: write` set? | Comment succeeds? |
|-----------|---------------------|------------------|
| `GITHUB_TOKEN` (default branch, `issues` trigger) | ✅ Yes | ✅ Yes |
| `GITHUB_TOKEN` (fork pull request) | N/A — restricted token | ❌ No (403) |
| `GITHUB_TOKEN` (org restricts default to read-only) | ❌ Not set | ❌ No (403) |
| Fine-grained PAT with Issues: read+write | ✅ Yes | ✅ Yes |
| GitHub App token with Issues permission | ✅ Yes | ✅ Yes |
| `GITHUB_TOKEN` (GHES, admin restricts scopes) | ❌ Depends | ❌ Possibly (403) |

### Common 403 / 404 errors

| HTTP status | GitHub message | Root cause | Fix |
|-------------|---------------|-----------|-----|
| 403 | `Resource not accessible by integration` | `issues: write` not granted | Add `permissions: issues: write` to the job, or use a PAT |
| 403 | `Resource not accessible by integration` (fork PR) | Fork PRs receive a read-only token | Store a PAT with Issues write scope as `secrets.MY_TOKEN` and pass it via `github_token` |
| 404 | `Not Found` | Issue doesn't exist or issues are disabled on the repo | Verify the issue number and that the repo has issues enabled |
| 422 | `Validation Failed` | Comment body exceeds GitHub's size limit | Enable `debug_mode: true` and check the generated comment body |

Ensure `permissions: issues: write` is set in the job and the token is valid. For fork pull requests or organizations with restrictive token policies, supply a fine-grained PAT or GitHub App token instead of `GITHUB_TOKEN`.

---

## Cancellation (workflow cancellation / AbortSignal)

When a GitHub Actions workflow is cancelled (e.g. by clicking **Cancel** in the UI, a `concurrency` group eviction, or a dependent job failure), the runner sends a SIGTERM to the running Node process. TrustBridge uses an internal `AbortController` to stop in-flight Horizon requests and polling loops promptly when this happens.

### How it works

| Stage | Behaviour on cancellation |
|-------|--------------------------|
| **Pre-flight check** (before any Horizon call) | Signal detected immediately; run exits without posting a comment. |
| **In-flight Horizon request** | The per-request `AbortController` is chained to the job signal. The current HTTP request is aborted; no retry is attempted. |
| **Retry backoff sleep** | Not aborted (short, ≤ 30 s max). The signal is checked again at the top of the next attempt loop before issuing another request. |
| **`wait_until_funded` polling loop** | Signal checked before each poll and also during the inter-poll sleep. Polling stops as soon as the signal fires. |
| **Comment posting** | If cancellation is detected before results are produced, no issue comment is posted. If a result was already produced before cancellation was detected, comment posting proceeds normally. |

### Error classification

A job-cancellation abort is intentionally classified as a **non-retryable error with status code 0** (distinct from a Horizon 404 "account not funded"). This prevents the action from:

- Emitting a misleading "account not funded" comment when the run was only stopped by the runner.
- Treating a cancelled run as a check failure that blocks the contributor.

A `core.warning` is emitted noting that the run was cancelled, and the action exits with code 0 (no `setFailed`).

---

| Value | Checks fail | Step result |
|-------|-------------|-------------|
| `true` (default) | Any check fails | `failure` |
| `false` | Any check fails | `success` with warning annotation |

Outputs reflect actual check state regardless of `fail_on_missing`.

---

## Debugging checklist

1. **Verify address** — [Stellar Expert](https://stellar.expert/explorer/public) or Horizon `GET /accounts/{id}`
2. **Confirm Horizon URL** — mainnet vs testnet mismatch is a common error
3. **Check asset issuer** — USDC mainnet issuer must match exactly
4. **Review Action logs** — Horizon errors are logged via `core.error` before result synthesis
5. **Permissions** — re-run with Actions debug logging if comments do not appear

---

## Reporting bugs

If behavior differs from this matrix, open an issue with:

- Horizon URL and network
- Redacted Stellar address (or testnet account)
- Action log excerpt
- Expected vs actual comment/output

See [CONTRIBUTING.md](../CONTRIBUTING.md).

---

[← Back to README](../README.md)
