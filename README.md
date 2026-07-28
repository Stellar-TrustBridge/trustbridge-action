# TrustBridge Action

[![CI](https://github.com/Stellar-TrustBridge/trustbridge-action/actions/workflows/ci.yml/badge.svg)](https://github.com/Stellar-TrustBridge/trustbridge-action/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**TrustBridge Action** is a GitHub Action that validates Stellar accounts before sensitive workflow steps — such as assigning bounty issues, granting repository access, or releasing payments. It queries the [Stellar Horizon API](https://developers.stellar.org/docs/data/apis/horizon), verifies that an account is funded, holds a trustline for a configured asset (USDC by default), and meets a minimum XLM reserve. Results are posted as a formatted comment on the GitHub issue with clear remediation steps.

The issue comment now includes a machine-readable validation gate summary so dashboard jobs and release automation can tell at a glance whether the run is ready or blocked.

---

## Why TrustBridge?

Open-source programs and DAOs often gate contributions on Stellar wallet readiness. Manual verification does not scale. TrustBridge automates the check at the moment an issue is assigned (or on demand), giving contributors immediate feedback and maintainers confidence that payout prerequisites are met.

| Problem | TrustBridge solution |
|--------|----------------------|
| Contributor assigned before wallet is ready | Runs automatically on `issues` → `assigned` |
| Unclear setup instructions | Posts a Markdown comment with ✅/❌ per check and links to Stellar Lab / LOBSTR |
| Silent CI failures | Configurable `fail_on_missing` to fail or warn |
| Custom assets / testnet | All Horizon and asset inputs are configurable |
| Re-runs spam the issue with duplicate comments | `sticky_comment` (default `true`) updates the previous TrustBridge comment in place |

## Release pipeline

The repository ships a dedicated `release` workflow (`.github/workflows/release.yml`) that runs the same lint, test, and build checks used in CI before a tag is considered release-ready. Use the release checklist in [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) before moving a `v*` tag.

---

## Quick start

Add a workflow file (e.g. `.github/workflows/trustbridge.yml`) in the **consumer repository**:

```yaml
name: TrustBridge — Stellar wallet check

on:
  issues:
    types: [assigned]
  workflow_dispatch:
    inputs:
      stellar_address:
        description: 'Stellar G-address to validate'
        required: true

jobs:
  verify-stellar-account:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      contents: read
    steps:
      - name: Resolve Stellar address
        id: address
        run: |
          if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
            echo "address=${{ github.event.inputs.stellar_address }}" >> "$GITHUB_OUTPUT"
          else
            # Example: read from issue body — customize for your project
            echo "address=GYOURCONTRIBUTORADDRESSHERE" >> "$GITHUB_OUTPUT"
          fi

      - name: TrustBridge check
        uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: ${{ steps.address.outputs.address }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          fail_on_missing: true
```

See [docs/USAGE.md](docs/USAGE.md) for advanced patterns (custom assets, testnet, extracting addresses from issue templates).

---

## Inputs

| Input | Required | Default | Description |
| -------- | ---------- | --------- | ------------- |
| `stellar_address_input` | **Yes** | — | Stellar public key (G-address, 56 characters) to validate |
| `github_token` | **Yes** | — | Token with `issues: write` to post comments (`GITHUB_TOKEN` is typical) |
| `horizon_url` | No | `https://horizon.stellar.org` | Horizon API base URL (use testnet URL for testing) |
| `asset_code` | No | `USDC` | Asset code for trustline verification |
| `asset_issuer` | No | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` | Issuer address for the asset |
| `min_xlm_reserve` | No | `1.5` | Minimum native XLM balance required |
| `debug_mode` | No | `false` | Enable extra action logs for troubleshooting |
| `horizon_timeout_ms` | No | `15000` | Horizon request timeout in milliseconds |
| `sticky_comment` | No | `true` | Update TrustBridge's previous issue comment instead of posting a new one each run |
| `wait_until_funded` | No | `false` | Poll Horizon until the account is funded instead of failing on the first 404 |
| `wait_until_funded_timeout_ms` | No | `120000` | Max time to poll for funding, in milliseconds (0-600000) |
| `wait_until_funded_interval_ms` | No | `5000` | Delay between funding polls, in milliseconds (1000-60000) |
| `horizon_url_fallback` | No | _(empty)_ | Optional fallback Horizon URL. When the primary `horizon_url` fails with a retryable non-404 error (429/502/503/504, timeout), TrustBridge retries the full request against this URL. Use for cross-region or multi-provider resilience. |
| `rpc_fallback_url` | No | `""` | Comma-separated secondary Horizon or RPC URLs to fail over to if primary node fails |
| `horizon_cache_ttl_ms` | No | `60000` | In-memory Horizon account cache TTL in milliseconds. Cached results skip the network call entirely within the TTL window. Set to `0` to disable caching. Maximum 3,600,000 ms (1 hour). |
| `use_cache` | No | `false` | Cache successful Horizon account responses in job memory to minimize redundant calls |
| `log_inputs` | No | `false` | Emit a structured JSON log record of all resolved action inputs at run start. Stellar addresses and Horizon URLs are redacted (first-4…last-4) before the record is written to GitHub Actions log output. Useful for auditing which inputs were active during a run. |
| `trustbridge_config_path` | No | `.trustbridge.yml` | Path (relative to repository root, or absolute) to a consumer `trustbridge.yml` config file that can supply defaults for `horizon_url`, `asset_code`, `asset_issuer`, `min_xlm_reserve`, and other inputs. Explicit action inputs always override file values. The file is validated for SSRF-safe URLs, injection-clean strings, and secret field redaction before any value is used. Leave empty to skip the file entirely. |
| `fail_on_missing` | No | `true` | `true` → `core.setFailed()`; `false` → warning only |
| `auto_wallet_labels` | No | `false` | Automatically apply a wallet state label to the issue (`wallet: funded`, `wallet: unfunded`, `wallet: trustline-missing`, `wallet: reserve-low`, `wallet: horizon-error`). Requires `issues: write`. |

Full input semantics and output reference: [docs/USAGE.md](docs/USAGE.md).

---

## Outputs

| Output | Type | Description |
| -------- | ------ | ------------- |
| `trustline_exists` | boolean (string) | `true` if the configured asset trustline exists |
| `xlm_balance` | string | Native XLM balance from Horizon (or `0` / `unknown`) |
| `account_funded` | boolean (string) | `true` if Horizon returned an active account |
| `comment_url` | string | URL to the created issue comment when run in issue context |

Use outputs in downstream steps:

```yaml
- name: TrustBridge check
  id: trustbridge
  uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ steps.address.outputs.address }}
    github_token: ${{ secrets.GITHUB_TOKEN }}

- name: Continue only if funded
  if: steps.trustbridge.outputs.account_funded == 'true'
  run: echo "Account is active"
```

---

## Consumer trustbridge.yml config file

For repositories that run TrustBridge on many workflows or want to centralise defaults without duplicating inputs across workflow files, place a `.trustbridge.yml` at the repository root:

```yaml
# .trustbridge.yml — TrustBridge consumer config
horizon_url: https://horizon.stellar.org
horizon_url_fallback: https://horizon-alt.stellar.org  # optional
asset_code: USDC
asset_issuer: GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
min_xlm_reserve: '1.5'
fail_on_missing: true
```

Values in the file are applied as **defaults** — any input set explicitly in the workflow step always wins. Unknown keys are silently ignored so the file stays forward-compatible.

### Security guarantees

Every field read from the file is validated through a strict security pipeline before it reaches the action runtime:

| Threat | Defence |
|--------|---------|
| **SSRF via Horizon/RPC URL** | `horizon_url`, `horizon_url_fallback`, and `rpc_fallback_url` are blocked if they target private IPs (10.x, 172.16-31.x, 192.168.x), loopback (127.x, `localhost`), link-local (169.254.x), or cloud-metadata endpoints (`169.254.169.254`, `metadata.google.internal`). `file://` URLs are also rejected. |
| **Shell injection via string fields** | `asset_code`, `asset_issuer`, and `min_xlm_reserve` are rejected if they contain shell meta-characters (`;`, `&`, `\|`, `` ` ``, `$`, `(`, `)`, `<`, `>`, `!`, `\`), newlines, or null bytes. |
| **Secret leakage** | Fields named `github_token`, `api_key`, `secret`, `password`, `token`, `private_key`, and `passphrase` are replaced with `***` in any diagnostic snapshot — their raw values are never logged. |
| **Path traversal** | A `trustbridge_config_path` that resolves outside the workspace root is rejected before the file is read. |
| **YAML bomb / prototype pollution** | The file is parsed with a minimal built-in line-by-line parser that supports only flat key/value pairs — no nested objects, lists, anchors, or aliases. |

If the file fails validation, the action **fails immediately** and surfaces every error so the workflow author can fix them all in one pass.

### Custom config path

Point to a non-default location with the `trustbridge_config_path` input:

```yaml
- uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ steps.address.outputs.address }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    trustbridge_config_path: config/trustbridge.yml
```

Set `trustbridge_config_path: ''` to skip the file entirely and rely only on explicit action inputs.

---

## Soroban contract asset issuers

`asset_issuer` normally holds a classic Stellar issuer address (`G...`). If you pass a Soroban contract address (`C...`) instead — e.g. for a SEP-41 fungible token contract — TrustBridge validates it against the Stellar StrKey contract-address policy (56 characters, `C` prefix, base32 alphabet) before proceeding. An invalid contract address fails the run immediately with a clear error instead of reaching Horizon or being written into the metrics/JSON output. Valid contract addresses are recorded as a metric point (`asset_issuer_contract_validated`) tagged with the contract address, visible in the metrics summary logged under `debug_mode: true`.

---

## Waiting for a contributor to fund their account

By default, TrustBridge checks the account once: if Horizon returns 404 (not funded), the run immediately posts an unfunded result. For workflows where a contributor is expected to fund their wallet moments after assignment (e.g. a bot nudges them to send XLM as part of onboarding), set `wait_until_funded: true` to poll instead of failing on the first miss:

```yaml
with:
  stellar_address_input: ${{ steps.address.outputs.address }}
  github_token: ${{ secrets.GITHUB_TOKEN }}
  wait_until_funded: true
  wait_until_funded_timeout_ms: 120000   # give up after 2 minutes
  wait_until_funded_interval_ms: 5000    # poll every 5 seconds
```

Only a Horizon 404 ("account not found") triggers a poll. Rate limits, timeouts, and other Horizon errors are not treated as "not yet funded" — they surface immediately as a failure result so a Horizon outage can't turn into a silent multi-minute hang.

---

## Auto wallet labels (Wave #31)

When `auto_wallet_labels: true` is set, TrustBridge applies a single state label to the issue after every check run:

| Label | When applied |
|-------|-------------|
| `wallet: funded` | Account active, trustline present, XLM reserve met |
| `wallet: unfunded` | Horizon returned 404 — account not yet created |
| `wallet: trustline-missing` | Account active but missing the required asset trustline |
| `wallet: reserve-low` | Account active + trustline present, but XLM balance below reserve |
| `wallet: horizon-error` | Non-404 Horizon error; wallet state could not be determined |

Stale wallet labels (from previous runs) are automatically removed before the new label is applied, so an issue always shows exactly one wallet state. Label failures (e.g. missing `issues: write` permission) are non-fatal — they emit a `core.warning` and do not block the validation result or comment.

```yaml
- name: TrustBridge check
  uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ steps.address.outputs.address }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    auto_wallet_labels: true
```

The label is derived from `deriveWalletLabel` in `src/horizon.ts` using this priority order: `horizon-error` → `unfunded` → `trustline-missing` → `reserve-low` → `funded`.

## Octokit metrics and JSON artifact (Wave #37)

Every GitHub API call made during a run (issue comment create/update, wallet label apply/remove) is instrumented by `OctokitMetrics` in `src/metrics.ts`. Each call records:

- Operation name (`issues.createComment`, `issues.addLabels`, etc.)
- HTTP status code and classified outcome (`success`, `auth_error`, `not_found`, `rate_limited`, `server_error`, `network_error`, `unknown`)
- Wall-clock latency in milliseconds
- Retry count
- ISO-8601 start timestamp
- Error message on failure

When `debug_mode: true` is set, the full JSON summary is emitted to `core.debug()` and is visible in the Actions log. The summary shape:

```json
{
  "totalCalls": 2,
  "successCount": 2,
  "failureCount": 0,
  "totalLatencyMs": 312,
  "averageLatencyMs": 156,
  "totalRetries": 0,
  "outcomeBreakdown": {
    "success": 2, "auth_error": 0, "not_found": 0,
    "rate_limited": 0, "server_error": 0, "network_error": 0, "unknown": 0
  },
  "operations": [
    { "operation": "issues.createComment", "statusCode": 201, "latencyMs": 180, "outcome": "success", ... },
    { "operation": "issues.addLabels",     "statusCode": 200, "latencyMs": 132, "outcome": "success", ... }
  ]
}
```

`403` responses with `x-ratelimit-remaining: 0` are classified as `rate_limited` (not `auth_error`) so dashboards can distinguish token exhaustion from permission failures.

## Resilience: circuit breaker, GitHub Check Run annotations, and Horizon mock matrix

### Circuit breaker (Wave #26)

The `CircuitBreaker` class in `src/resilience.ts` wraps any async operation with the standard three-state circuit-breaker pattern:

| State | Behavior |
|-------|----------|
| **closed** | Normal operation. Consecutive failures are counted. |
| **open** | Fast-fail. Requests throw `CircuitOpenError` immediately. A recovery timer controls transition to `half-open`. |
| **half-open** | A single probe request is allowed. Success (repeated `successThreshold` times) closes the circuit; failure re-opens it. |

State transitions are emitted as **GitHub Check Run annotations** (`core.warning` on open, `core.notice` on closed/half-open) so circuit trips and recoveries appear in the Actions summary panel without requiring `debug_mode: true`.

```typescript
import { CircuitBreaker } from './src/resilience';

const breaker = new CircuitBreaker({ failureThreshold: 5, recoveryTimeoutMs: 30_000 });
const result = await breaker.execute(() => fetchAccount(horizonUrl, address));
```

You can supply a custom `onStateChange` handler to integrate with external monitoring:

```typescript
const breaker = new CircuitBreaker({
  failureThreshold: 3,
  onStateChange: (from, to, reason) => myMonitor.record({ from, to, reason }),
});
```

### Check Run annotation helpers (Wave #26)

Four convenience helpers emit structured resilience events as Check Run annotations visible in the Actions summary:

| Helper | Level | When to use |
|--------|-------|-------------|
| `annotateRetry(attempt, delayMs, reason)` | `notice` | A retry has been scheduled |
| `annotateRateLimit(waitMs)` | `warning` | Horizon returned 429 |
| `annotateFallback(fallbackUrl, reason)` | `warning` | RPC fallback activated |
| `annotateCircuitOpen(consecutiveFailures)` | `error` | Circuit breaker opened |

### Horizon HTTP mock matrix (Wave #36)

`HttpMockMatrix` in `src/resilience.ts` provides deterministic per-scenario mock `fetch` functions for use in tests and local development — no live Horizon endpoint required:

```typescript
import { HttpMockMatrix } from './src/resilience';
import { fetchAccount } from './src/horizon';

// Test the rate-limit → retry path:
const fetchFn = HttpMockMatrix.build('flaky_then_success', { flakyFailCount: 2 });
const account = await fetchAccount(PRIMARY, address, { fetchFn, maxRetries: 3, cacheTtlMs: 0 });

// Test the primary-outage → fallback path:
const fetchFn2 = HttpMockMatrix.buildFallbackMatrix('server_error', 'success', PRIMARY);
const account2 = await fetchAccount(PRIMARY, address, { fetchFn: fetchFn2, horizonUrlFallback: FALLBACK });
```

Available scenarios:

| Scenario | Status | Notes |
|----------|--------|-------|
| `success` | 200 | Returns default or custom `accountPayload` |
| `not_found` | 404 | Triggers unfunded-account path |
| `rate_limit` | 429 | Includes `Retry-After` header (default `0` for instant test retries) |
| `server_error` | 503 | Retryable |
| `bad_gateway` | 502 | Retryable |
| `gateway_timeout` | 504 | Retryable |
| `timeout` | — | Rejects with `AbortError` when `AbortSignal` fires |
| `network_error` | — | Rejects with `ECONNREFUSED` |
| `flaky_then_success` | mixed | Fails `flakyFailCount` times then succeeds |
| `always_fail` | 503 | Never succeeds |

Use `HttpMockMatrix.buildFallbackMatrix(primaryScenario, fallbackScenario, primaryUrl)` to route different scenarios to primary vs. fallback URLs in a single mock.

## Resilience: in-memory cache and RPC fallback

TrustBridge ships with two opt-in resilience features that reduce round-trips to Horizon and survive single-region outages. Both are fully compatible with `wait_until_funded` and retry-on-rate-limit logic.

### In-memory Horizon account cache

Within a single GitHub Actions job, account lookups are cached in memory by default (60 s TTL, configurable via `horizon_cache_ttl_ms`). Subsequent checks for the same `(horizon_url, stellar_address)` pair return the cached response without issuing another HTTP call:

```yaml
with:
  # ...other inputs...
  horizon_cache_ttl_ms: 120000   # cache for 2 minutes within this job
```

Setting `horizon_cache_ttl_ms: 0` disables the cache entirely so every check reaches Horizon live.

### Horizon RPC fallback URL

For high-reliability workflows, point `horizon_url_fallback` at a second Horizon endpoint (e.g. a different region or an alternative provider):

```yaml
with:
  horizon_url: https://horizon.stellar.org
  horizon_url_fallback: https://horizon-alt.stellar.org   # e.g. Cloudflare, self-hosted
```

When the primary endpoint exhausts its retries on a retryable error (429 / 502 / 503 / 504 / network timeout), TrustBridge transparently re-runs the same request against the fallback URL before surfacing a failure. Account-not-found (404) is **not** retried on the fallback — a missing account on primary is treated as a missing account everywhere, consistent with `wait_until_funded` semantics. Caching is shared between primary and fallback (the cache key is keyed on primary URL), so a fallback success populates the cache for subsequent lookups.

---

## Structured input logging

When `log_inputs: true` is set, TrustBridge emits a single `core.info` line at run start containing a JSON record of every resolved action input:

```
[TrustBridge] action inputs: {"horizonUrl":"https://horizon.stellar.org","stellarAddress":"GAAA...AWHF",...}
```

Every Stellar address (`G…` / `C…`) and every Horizon/RPC URL that embeds an account path is redacted to its first-4 / last-4 characters (`GAAA...AWHF`) before the record is written. Non-sensitive scalar fields — `assetCode`, `minXlmReserve`, timeout values, boolean flags — are emitted verbatim. The record is always visible (not gated on `debug_mode`) whenever the opt-in is set, making it safe for audit trails and run comparisons without leaking contributor account data.

```yaml
with:
  stellar_address_input: ${{ steps.address.outputs.address }}
  github_token: ${{ secrets.GITHUB_TOKEN }}
  log_inputs: true   # emit redacted JSON artifact of all resolved inputs
```

---

## Debug logging and redaction

When `debug_mode: true` is set, TrustBridge emits detailed `core.debug` lines covering every stage of the Horizon client:

| Debug event | Description |
|-------------|-------------|
| `Horizon cache lookup start` / `Horizon cache hit` / `Horizon cache miss` / `Horizon cache populate after… success` / `Horizon cache disabled (ttl=0)` | Caching pipeline. Cache keys, stats entries, and summary payloads are all redacted. |
| `Horizon fetch start` / `Horizon fetch success` | Fetch lifecycle, tagged with `endpointKind=primary\|fallback`. URL path and context addresses are masked. |
| `Horizon account not found (404)` | 404 response (never retried, never falls back). |
| `Horizon error response parsed` / `Horizon error response missing JSON body` | Non-2xx responses. Upstream `detail`, `title`, `type` strings are scanned and redacted before logging. |
| `Horizon retry scheduled` / `Horizon transport retry scheduled` | Transient HTTP or transport errors scheduled for retry. |
| `Horizon non-retryable HTTP error (exhausted retries)` / `Horizon transport error (exhausted retries)` | Primary endpoint giving up. |
| `Horizon RPC fallback: primary exhausted, switching to fallback URL` | Start of fallback attempt. Primary error message and both URLs are redacted. |
| `Horizon RPC fallback succeeded` / `Horizon RPC fallback exhausted` | Fallback outcome. Both primary and fallback status/message fields are redacted on exhaustion. |

**Redaction policy.** Every Stellar G-address / C-address, every Horizon account URL, every cache key that embeds an address, and every free-form upstream string that could contain an address is run through the `StructuredLogger` redaction pipeline before any line reaches GitHub Actions log output. The policy is: addresses are masked to `first4…last4` (e.g. `GA5Z…KZVN`), hostnames and paths are preserved so operators can verify *which* Horizon instance was called without leaking contributor account data. Sensitive account fields — raw balance numbers, sequence numbers, sponsor counts, the full `balances` array — are never placed in debug context; only aggregate structural summaries (`balancesCount`, `creditTrustlineCount`, `hasNativeBalance`, `subentryCount`) are emitted alongside the redacted address. Refer to [src/logger.ts](src/logger.ts) (`redactStellarAddress`, `redactHorizonUrl`, `redactContext`, `redactString`) and the safe-context helpers in [src/horizon.ts](src/horizon.ts) (`safeHorizonContext`, `safeAccountSummary`) for the exact implementations.

---

## Example issue comment

When checks fail, TrustBridge posts a comment like:

```markdown
## TrustBridge — Stellar Account Check

Checked account: `GABC...XYZ`
Horizon: `https://horizon.stellar.org`
Asset: **USDC** · Issuer: `GA5ZSEJ...KZVN`

### Results

- ❌ **Account funded** — Account `GABC...` was **not found** on Horizon...
- ❌ **USDC trustline** — Cannot verify trustline until the account exists.
- ❌ **XLM reserve** — Cannot verify XLM balance...

### Balances

- **XLM balance:** `0 XLM`
- **Minimum required:** `1.5 XLM`

### Setup cost estimate

- Stellar minimum account balance: **1 XLM**
- Base reserve per trustline: **0.5 XLM**
- Typical minimum to fund account + one trustline: **~1.5 XLM**

### Add a trustline

- [View account on Stellar Laboratory](https://laboratory.stellar.org/...)
- [Open Transaction Builder (Change Trust)](https://laboratory.stellar.org/#txbuilder?network=public)
- [LOBSTR wallet](https://lobstr.co/)

### Remediation

Activate `GABC...` by sending at least **1 XLM**...

### Configuration summary

| Input | Value |
| --- | --- |
| `fail_on_missing` | `true` — step fails on missing checks |
| `sticky_comment` | `true` — upserts prior comment |
| `wait_until_funded` | `false` (default) |

### Action outputs reference

_Use these output names in downstream workflow steps via `steps.<id>.outputs.<name>`._

| Output | Value in this run | Description |
| --- | --- | --- |
| `account_funded` | `false` | Whether the account exists on the Stellar network (from `action.yml`) |
| `trustline_exists` | `false` | Whether the **USDC** trustline is configured (from `action.yml`) |
| `xlm_balance` | `0` | Native XLM balance reported by Horizon (from `action.yml`) |
| `comment_url` | _set after posting_ | URL of this issue comment (from `action.yml`) |

---
_Posted by [trustbridge-action](https://github.com/Stellar-TrustBridge/trustbridge-action)_
```

---

## How it works

```mermaid
flowchart TD
  A[GitHub issues.assigned or workflow_dispatch] --> B[Read action inputs]
  B --> C{Valid G-address?}
  C -->|No| D[Fail fast]
  C -->|Yes| E[GET Horizon /accounts/{address}]
  E --> F{Response}
  F -->|404, wait_until_funded=false| G[Unfunded account result]
  F -->|404, wait_until_funded=true| W{Timeout budget left?}
  W -->|Yes| WS[Sleep poll interval] --> E
  W -->|No| G
  F -->|429/503/timeout| H[Retry with backoff]
  H --> E
  F -->|200| I[Run trustline + XLM checks]
  G --> J[Format Markdown comment]
  I --> J
  J --> K[Post issue comment]
  K --> L{All checks pass?}
  L -->|Yes| M[Success + set outputs]
  L -->|No| N{fail_on_missing?}
  N -->|true| O[setFailed]
  N -->|false| P[warning]
```

Deep dive: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Repository layout

```
trustbridge-action/
├── action.yml              # Action metadata and inputs/outputs
├── src/
│   ├── index.ts            # Entrypoint — orchestrates the run
│   ├── horizon.ts          # Horizon HTTP client
│   ├── checks.ts           # Validation logic
│   └── comment.ts          # Issue comment formatting
├── __tests__/              # Jest unit tests
├── docs/                   # Extended documentation
├── .github/workflows/ci.yml
├── README.md
└── CONTRIBUTING.md
```

Details: [docs/STRUCTURE.md](docs/STRUCTURE.md).

---

## Development

```bash
git clone https://github.com/Stellar-TrustBridge/trustbridge-action.git
cd trustbridge-action
npm ci
npm test               # unit tests
npm run test:coverage  # unit tests + Jest coverage gate + comment golden snapshot verification
npm run lint           # ESLint
npm run build          # compile TypeScript → dist/
```

### Comment Golden Snapshots & Coverage Gates

- **Comment Golden Snapshots**: TrustBridge enforces golden snapshots for Markdown issue comments (`__tests__/comment.test.ts`) across success and failure paths to prevent formatting regressions during active Waves and release cycles.
- **Jest Coverage Gate**: Enforces strict statement, branch, function, and line coverage thresholds for `src/horizon.ts` (fetch, retries, caching, RPC fallback) and globally in `jest.config.js`.

Contributing guidelines: [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Error handling

TrustBridge handles common failure modes from Horizon and invalid input:

| Scenario | Behavior |
|----------|----------|
| Invalid G-address | Fails before Horizon call |
| Account not found (404) | `account_funded=false`, remediation comment. 404 is **not** retried or fallen back. |
| Horizon 429 / 502 / 503 / 504 / timeout | Per-endpoint exponential backoff retries. If `horizon_url_fallback` is set and primary exhausts retries, transparently retries against fallback. |
| Cached account lookup | Returns cached response (no HTTP call); cache keys, stats, and summaries are redacted in debug output. |
| Account with zero trustlines | Trustline check fails with specific message |
| Comment post failure | Warning logged; check result still applied |

Full matrix: [docs/ERROR_HANDLING.md](docs/ERROR_HANDLING.md).

---

## Documentation index

| Document | Purpose |
|----------|---------|
| [README.md](README.md) | Overview, quick start, inputs/outputs (this file) |
| [docs/USAGE.md](docs/USAGE.md) | Workflow recipes and configuration examples |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, data flow, module responsibilities |
| [docs/STRUCTURE.md](docs/STRUCTURE.md) | File and directory reference |
| [docs/ERROR_HANDLING.md](docs/ERROR_HANDLING.md) | Error cases and retry behavior |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute, PR checklist, release process |

---

## License

MIT — see [LICENSE](LICENSE).

---

## Acknowledgments

Built for the Stellar open-source ecosystem. Horizon data provided by the [Stellar Development Foundation](https://stellar.org). Wallet setup links reference [Stellar Laboratory](https://laboratory.stellar.org) and [LOBSTR](https://lobstr.co/).
