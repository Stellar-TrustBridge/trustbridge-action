# Error handling

How **trustbridge-action** behaves when things go wrong — Horizon outages, bad input, empty trustlines, and GitHub API failures.

Related docs: [README](../README.md) · [Architecture](ARCHITECTURE.md) · [Usage](USAGE.md)

---

## Summary matrix

| Condition | HTTP / cause | Retries | Outputs | Comment | Workflow |
|-----------|--------------|---------|---------|---------|----------|
| Invalid G-address | Input validation | No | Not set (run fails early) | Not posted | `setFailed` |
| Account not found | Horizon 404 | No (unless `wait_until_funded`) | `account_funded=false`, others false/0 | Posted with activation steps | per `fail_on_missing` |
| Account not found, `wait_until_funded: true` | Horizon 404 repeated | Polls every `wait_until_funded_interval_ms` until funded or `wait_until_funded_timeout_ms` elapses | Same as above if timeout reached | Same as above | per `fail_on_missing` |
| Missing trustline | Horizon 200, no matching balance | No | `account_funded=true`, `trustline_exists=false` | Posted with Lab/LOBSTR links | per `fail_on_missing` |
| Zero trustlines | Horizon 200, native only | No | Same as missing trustline | Specific “zero trustlines” message | per `fail_on_missing` |
| Low XLM reserve | Horizon 200, native &lt; min | No | `xlm_balance` set, reserve fail | Posted with amount to send | per `fail_on_missing` |
| Rate limited | Horizon 429 | Yes (≤3) | If exhausted: failure result | Posted if reachable | per `fail_on_missing` |
| Service unavailable | Horizon 503/502/504 | Yes (≤3) | If exhausted: failure result | Posted | per `fail_on_missing` |
| Timeout | AbortController 15s | Yes (≤3) | If exhausted: `xlm_balance=unknown` | Posted | per `fail_on_missing` |
| Comment API failure | GitHub 403/422/etc. | No | Still set from checks | Not posted | Check result still applies |
| No issue context | workflow_dispatch without issue | No | Set normally | Skipped (warning) | per check result |

---

## Input validation errors

### Invalid Stellar address

**Rule:** Must match `/^G[A-Z2-7]{55}$/`.

Examples that fail:

- Empty string
- Ethereum-style `0x...` addresses
- Wrong length or invalid base32 characters (`0`, `1`, `8`, `9`, `l`)

**Behavior:** Throws before any Horizon call. The action run fails immediately; no outputs or comments.

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
2. Retries up to **3** times
3. If still failing → `horizonFailureResult`

**Operator tip:** For high-volume orgs, consider self-hosted Horizon or caching.

### 503 / 502 / 504 — Service degradation

Same retry policy as 429. Public Horizon occasionally returns 503 during maintenance.

### Timeout

Default **15 seconds** per attempt. Network partitions or slow Horizon nodes trigger abort + retry.

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

---

## GitHub comment failures

If `issues.createComment` fails (permissions, issue locked, etc.):

- Error is logged as **`core.warning`**
- Outputs are still written
- Pass/fail logic still runs

Ensure `permissions.issues: write` is set and the token is valid.

---

## fail_on_missing behavior

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
