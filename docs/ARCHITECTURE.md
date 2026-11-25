# Architecture

This document describes the internal structure of the TrustBridge Action and how its components interact. For operational guidance and FAQs, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

## Logging and Stellar address masking

The action emits diagnostics through `src/logger.ts`. Before any line reaches the Actions log, the logger runs a redaction pass so that Stellar addresses are not leaked into CI logs, which may be retained and shared by reviewers.

### Redacted patterns

Redaction is driven by two regular expressions in `src/logger.ts`:

- `STELLAR_ADDRESS_REGEX` — matches standard Stellar account (`G...`) and contract (`C...`) addresses (56-character StrKey encodings).
- `MUXED_ADDRESS_REGEX` — matches muxed account (`M...`) addresses, which embed a 64-bit memo ID alongside the underlying `G` address.

When a match is found, the address is replaced with a masked placeholder (e.g. `GABC...WXYZ` style truncation) so operators can still correlate log lines without exposing the full value. The redaction helpers are applied to every `core.info`, `core.debug`, `core.warning`, and `core.error` call routed through the logger.

### Context key allowlist

The logger accepts a structured context object (`LogContext`). By default, `redactContext` processes every key it is given: address-bearing keys are masked, known secret-shaped keys become `[REDACTED]`, and every other string is passed through the pattern-based redactor — no key is dropped, only values are made safe. This is deliberate so adding a new, ad-hoc context key at a call site never silently loses that field from the log.

**Strict mode (Issue #858):** `redactContext(context, { strict: true })` additionally drops any key not in `LOG_CONTEXT_KEY_ALLOWLIST` (`operation`, `status`, `count`, `durationMs`, the keys `LogContext` itself declares, and every address-bearing key with a defined redaction policy) — an unreviewed field is absent from the log entirely rather than present in redacted form. `extraAllowedKeys` extends the allowlist for a specific call site. Strict mode is opt-in per call, not a global default, so existing call sites are unaffected until a caller deliberately adopts it for a context it has fully audited.

### Exceptions

- **Comment bodies** posted to GitHub are *not* passed through the logger redactor. Comments are user-facing output and may legitimately contain full addresses (for example, a confirmation of the account that was funded). Review comment templates before enabling them in public repos.
- **Webhook payloads** received from GitHub are logged only after passing through the same redaction helpers; raw payloads are never emitted directly.
- **Federation responses** may contain addresses in free-form fields. These are redacted when logged, but partial addresses embedded in error messages are only masked if they match the regexes above — malformed or truncated addresses may slip through, so avoid logging raw error strings from federation calls.

### Example

Before redaction:

```
Funding account GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV
```

After redaction:

```
Funding account GABC...STUV
```

### Behavioral contract

`__tests__/logger.test.ts` is the authoritative specification for redaction behavior. It covers `G`, `C`, and `M` address masking, context allowlist enforcement, and the comment-body exception. Any change to `src/logger.ts` must keep these tests green; treat them as the source of truth when in doubt.

### privacy_mode

`privacy_mode` is a separate control from log redaction and affects *outputs* (comments and webhook responses) rather than the Actions log itself:

- When `privacy_mode` is enabled, generated comment bodies omit full addresses and use masked forms, and webhook responses redact address fields.
- When disabled, comments and webhook responses may include full addresses, while the Actions log remains redacted regardless.

### ValidationResult

Produced by `checks.ts`:

```typescript
interface ValidationResult {
  valid: boolean;
  accountFunded: boolean;
  trustlineExists: boolean;
  xlmBalance: string;
  xlmReserveMet: boolean;
  checks: CheckResultItem[];
  remediation?: string;
  reserveRequirement?: ReserveRequirement; // sponsor-aware reserve math (see § 3)
}
```

Each `CheckResultItem` maps to one ✅/❌ line in the issue comment.

---

## Metrics label cardinality and PII policy

`src/metrics.ts` is the only place the Action records numeric metrics (`MetricsCollector.recordMetric`/`recordContractMetric`). Wave orgs scrape or upload its JSON artifact (`toJSON()`, `buildJobSummary().jsonArtifact`) into shared Prometheus instances, so a tag value is effectively a public Prometheus label: it must be drawn from a small, fixed set, never from per-account or per-user data.

### Allowed tag keys

| Tag key | Values | Cardinality |
|---|---|---|
| `contractAddress` | A 12-hex-character SHA-256 prefix of the Soroban contract address (`hashAddressForMetrics`), never the raw address | Bounded in practice (one run touches O(1) contracts), and non-reversible even so |
| `outcome` (home domain check) | `valid` \| `mismatch` \| `missing` \| `skipped` | 4 |
| `mode` (home domain check) | `warn` \| `strict` \| `fail` | 3 |
| `preset` / `network` (campaign preset) | Fixed preset ids / `pubnet` \| `testnet` | Small, closed set |
| `endpointKind` (Horizon latency histogram) | `primary` \| `fallback` | 2 |
| `outcome` (job outcome) | `pass` \| `fail` \| `skipped` | 3 |
| `check` (skipped check) | `CHECK_KINDS` in `src/metrics.ts` | 9 |

No other tag key may carry a Stellar address (`G`/`C`/`M`...) or a GitHub login/actor. `recordMetric()` rejects any call that sets the `contractAddress` tag directly — `MetricsCollector.recordContractMetric()` is the only path that may populate it, and it hashes the address with `hashAddressForMetrics()` (bounded 12-character output, sha256-derived, non-reversible) before the value ever reaches a `MetricPoint`.

### Enforcement

`__tests__/metrics.test.ts` asserts `recordMetric()` throws on a raw `contractAddress` tag (valid or not), that `recordContractMetric()` never stores the raw address, and that neither `toJSON()` nor `buildJobSummary().jsonArtifact` ever contain a raw G-/C-address after a contract metric is recorded.


### Job outcome counters

`run()` in `src/index.ts` records exactly one job outcome per run through
`MetricsCollector.recordJobOutcome()`. It is first-wins: a second call (for
example from the top-level error handler after a verdict) is ignored, so the
three outcome counters always sum to 1 per job.

| Outcome | When |
|---|---|
| `pass` | Validation ran and every check passed (`ready = true`). |
| `fail` | Validation ran and at least one check failed, or `run()` threw before a verdict. |
| `skipped` | The milestone gate skipped validation (`reason_code = MILESTONE_GATE_SKIPPED`). |

The same call counts skipped checks. A check row is skipped when it was not
evaluated: its detail starts with `Cannot verify` or `Check skipped` (missing
prerequisite, Horizon unreachable, circuit open, rate budget exhausted).
`listSkippedCheckKinds()` in `src/summary.ts` maps each skipped row to a
fixed check kind. Check labels can contain the operator's asset code, so they
are never used as metric labels. The kinds are `horizon_available`,
`account_funded`, `trustline`, `xlm_reserve`, `asset_balance`,
`trustline_limit`, `clawback`, `home_domain` and `other`, where `other`
catches any label that does not match.

| Prometheus name | Type | Label | JSON artifact source |
|---|---|---|---|
| `trustbridge_job_outcome_total` | counter | `outcome` | `counters.job_outcome_<outcome>`, `metrics[name=job_outcome]` |
| `trustbridge_check_skipped_total` | counter | `check` | `counters.check_skipped_<kind>`, `metrics[name=check_skipped]` |

The names are exported as `JOB_OUTCOME_PROMETHEUS_METRICS`. Exporters that
turn the JSON artifact into Prometheus series must use these names. The
artifact also carries `jobOutcome: { outcome, skippedChecks }`, and the Job
Summary table shows a `Job outcome` row. Example pass-rate query:

```promql
sum(rate(trustbridge_job_outcome_total{outcome="pass"}[1d]))
  / sum(rate(trustbridge_job_outcome_total{outcome=~"pass|fail"}[1d]))
```

`__tests__/job-outcome-metrics.test.ts` checks that the outcomes are mutually
exclusive, that repeated calls do not count twice, that an unknown outcome is
rejected, and that unknown check kinds become `other`.
---

## Check rules

### 1. Account funded

- **Pass:** Horizon returns HTTP 200 with account record.
- **Fail:** Horizon returns HTTP 404 (account not activated).

### 2. Asset trustline

- **Pass:** `balances` contains an entry where `asset_code` and `asset_issuer` match inputs (non-native).
- **Fail:** No matching entry. Message distinguishes **zero trustlines** vs **other trustlines present**.

### 3. XLM reserve

- **Pass:** Native balance ≥ `required`, where `required = max(protocolMinimum, min_xlm_reserve)`.
- **Fail:** Balance below `required`; remediation includes delta to send.

`protocolMinimum` is computed from the account itself — `(2 + subentry_count + num_sponsoring − num_sponsored) × 0.5 XLM` (CAP-0033) — so `min_xlm_reserve` acts as a floor override rather than the sole threshold. This makes the check accurate for accounts with sponsored trustlines (which don't count against the sponsoree's own reserve) as well as accounts with several unsponsored subentries. Default `1.5` for `min_xlm_reserve` reflects Stellar protocol economics: **1 XLM** minimum account balance + **0.5 XLM** base reserve per trustline subentry — the unsponsored one-subentry case.

---

## Horizon client design

`horizon.ts` implements:

| Feature | Implementation |
|---------|----------------|
| Timeout | `AbortController` per request (15s default) |
| Retries | Up to 3 on 429, 502, 503, 504, timeout |
| Backoff | Exponential (1s, 2s, 4s) or `Retry-After` header |
| 404 | Non-retryable `HorizonError` → unfunded path; never cached |
| URL normalization | Strips trailing slashes from `horizon_url` |
| Cache | Optional in-memory TTL cache (`use_cache` + `horizon_cache_ttl_ms`, default disabled), keyed on `(horizon_url, stellar_address)`. 404s are never cached as funded. |
| RPC fallback | On retry exhaustion, fails over to `horizon_url_fallback`/`rpc_fallback_url`. Refused by default when the fallback resolves to a different Stellar network than the primary — see `allow_cross_network_fallback`. |
| Latency histogram | Every fetch attempt (success, 404, exhausted-retries) records its wall-clock latency into `globalHorizonHistogram` (`HorizonLatencyHistogram` in `metrics.ts`), bucketed by `[50, 100, 250, 500, 1000, 2500, 5000, +Inf]` ms and labelled `primary` or `fallback`. The snapshot is included in the Job Summary JSON artifact under `horizonFetchLatencyHistogram`. No raw addresses or URLs are stored — only the endpoint kind tag and the numeric value. |

Errors are classified as **retryable** vs **terminal** to avoid masking real problems with infinite loops.

### Horizon error spans

When tracing is enabled (`OTEL_TRACES_ENABLED=true`), every non-2xx Horizon response — including the `404` unfunded path and each retried `429`/`5xx` attempt — records one `ERROR` span named `horizon.http_error` via `recordHorizonHttpError` in `src/tracing.ts` (Issue #913). The span is recorded in `fetchOnce` **before** the response body is read.

**Policy: response bodies are never attached to spans.** Horizon problem documents (`detail`, `title`, `type`, `extras`) can echo account data, so a `horizon.http_error` span carries exactly these attributes and nothing else (`HORIZON_HTTP_ERROR_SPAN_ATTRIBUTES`):

| Attribute | Example | Notes |
|-----------|---------|-------|
| `horizon.url` | `https://horizon.stellar.org` | Host only; paths and account segments stripped by `redactSpanAttributes` |
| `http.response.status_code` | `503` | |
| `horizon.status_class` | `5xx` | `4xx`, `5xx`, `transport`, or `other` |
| `horizon.retryable` | `true` | `true` for `429` / `5xx` |
| `horizon.endpoint_kind` | `primary` | `primary` or `fallback` |
| `horizon.attempt` | `0` | Zero-based attempt index |
| `horizon.latency_ms` | `412` | Attempt latency |
| `error.type` | `HorizonError` | |

The span `error` (and the OTLP status message) is always `Horizon request failed (<status>)`.

The same rule applies to the generic wrappers: `withSpan`, `withSpanSync`, `withHorizonSpan` and `traceHorizonFetch` record `safeSpanErrorMessage(err)` instead of the raw message. For a `HorizonError` with status `>= 400` that is the status-only message above (the raw message embeds the Horizon `detail`, or the account id for a `404`). Any other error message goes through `redactString`, so addresses, JWTs and secret assignments are masked. `withHorizonSpan` also adds `error.type`, `http.response.status_code`, `horizon.status_class` and `horizon.retryable` on failure. `__tests__/tracing-horizon-errors.test.ts` locks the attribute set.

---

## Circuit breaker half-open probe budget (Issue #888)

`CircuitBreaker` in `src/resilience.ts` enforces a configurable limit on
the number of **concurrent** probe calls while the circuit is in the
`half-open` state.

### Why this matters

Without a probe budget, every caller that checks `getState()` after the
recovery timeout sees `half-open` and proceeds to call `execute()`. Under
Wave batch peaks — where dozens of addresses are validated in parallel —
all of them can stampede a Horizon endpoint that is only starting to
recover, overwhelming it and triggering a fresh outage cycle.

### How it works

```
CircuitBreakerOptions.halfOpenMaxProbes  (default: 1)
```

`execute()` tracks `halfOpenProbesInFlight`. When the count is already at
`halfOpenMaxProbes`, any additional caller receives `CircuitOpenError`
immediately — fast-fail, identical to fully-open behavior — and the
rejection is counted in `halfOpenProbeBudgetExhaustedCount`.

The in-flight counter is decremented in a `finally` block when each probe
resolves (success) or rejects (failure). A probe failure also re-opens the
circuit and resets the counter; a probe success that meets `successThreshold`
closes the circuit and resets the counter. Both transitions also zero the
exhaustion count so the next half-open period starts fresh.

### Observability

| Surface | What it shows |
|---|---|
| `getStats().halfOpenProbesInFlight` | Concurrently executing probes right now |
| `getStats().halfOpenProbeBudgetExhaustedCount` | Calls fast-failed due to budget exhaustion since last half-open entry |
| `getStats().halfOpenMaxProbes` | Configured budget |
| `getOpenMetrics().halfOpenProbeStats` | All four values as a nested object for Job Summary export |
| `onProbeBudgetExhausted(inFlight, maxProbes)` | Optional callback — default emits `core.warning` as a GitHub Check Run annotation |

### Backward compatibility

The default (`halfOpenMaxProbes: 1`) matches the previous undocumented
behavior where only a single probe was practically in flight at a time
(because the breaker was typically used with sequential callers). No
existing test needed changes to accommodate the new field.

Set `halfOpenMaxProbes: Infinity` to restore the pre-#888 behavior with
no limit.

Enforced by `__tests__/resilience.test.ts` — `CircuitBreaker — half-open probe budget (Issue #888)` suite (16 tests).

---

## Circuit breaker wall-clock open-state expiry (Issue #920)

The open → half-open transition in `CircuitBreaker` (`src/resilience.ts`)
is driven **only by elapsed wall-clock time**, never by how many calls were
fast-failed while open. Under Wave burst traffic hundreds of callers can hit
an open circuit within a second; counting those attempts toward recovery
would reopen the circuit (and stampede Horizon) far too early.

### Clock

```
CircuitBreakerOptions.now  (default: () => Date.now())
```

Every expiry decision reads this clock. Tests inject a fake clock and step
it explicitly, so no real time passes and no timer mocking is needed
(`__tests__/circuit-wall-clock.test.ts`). If the clock moves backwards while
the circuit is open (VM suspend, NTP correction), the cooldown restarts from
the new reading instead of expiring early.

`recoveryTimeoutMs` and `maxRetryAfterMs` must be finite numbers ≥ 0;
anything else throws a `RangeError` at construction
(`CircuitBreaker option recoveryTimeoutMs must be a finite number of
milliseconds >= 0 (received …)`). A non-function `now` throws a `TypeError`.

### Interaction with Retry-After

When Horizon answers a retryable status (429/502/503/504) with a valid
`Retry-After`, `fetchAccount` (`src/horizon.ts`) passes the parsed delay to
`circuitBreaker.noteRetryAfter(ms)`. The breaker records a deadline of
`now + min(ms, maxRetryAfterMs)`:

| Breaker state | Effect of a pending Retry-After deadline |
|---|---|
| `closed` | None — calls still flow; the retry loop already sleeps for Retry-After (capped by `retry_max_delay_ms`). The deadline is remembered in case the circuit opens before it passes. |
| `open` | The circuit stays open until **both** `recoveryTimeoutMs` has elapsed since it opened **and** the Retry-After deadline has passed. A shorter Retry-After never shortens the recovery timeout. |
| `half-open` | Probes are fast-failed with `CircuitOpenError` until the deadline passes. A deferred probe does not count against `halfOpenMaxProbes`. |

Rules:

- `maxRetryAfterMs` (default `300000`, 5 minutes) caps the deadline so a
  hostile or misconfigured Horizon cannot pin the circuit open.
- Negative, `NaN`, infinite, or unparsable `Retry-After` values are ignored
  (the same values `parseRetryAfterMs` already treats as absent).
- A later, shorter Retry-After never shortens an existing deadline.
- `reset()` clears the deadline together with the rest of the state.
- A failed half-open probe re-opens the circuit and restarts the full
  `recoveryTimeoutMs` from the failure time.

### Observability

`getRemainingCooldownMs()` returns how long until the next probe may run
(0 when closed). `CircuitOpenError.remainingCooldownMs` and
`HorizonCircuitOpenError.remainingCooldownMs` carry the same value at the
moment a call was blocked, so callers can say "retry in ~Ns" without
guessing the recovery timeout.

```bash
npx jest __tests__/circuit-wall-clock.test.ts __tests__/resilience.test.ts
```

---

## Batch concurrency cap (Issue #852)

`runBatchValidation` (`src/batch.ts`) is the only place the Action fans
Horizon work out across more than one address — `checks-run.ts` creates
exactly one GitHub Check Run per invocation and has no address loop to
bound. Batch mode was, and remains by default, **fully sequential**:
"Sequential execution keeps request pressure on Horizon predictable and
avoids triggering rate limits." That default is preserved exactly; this
section documents the bounded-concurrency option layered on top of it.

| Option (`BatchRunOptions`) | Default | Effect |
|---|---|---|
| `maxConcurrency` | `1` (`MIN_BATCH_CONCURRENCY`) | Number of addresses validated against Horizon in parallel. Clamped to `[1, MAX_BATCH_CONCURRENCY]` (20). `1` is exactly the original sequential loop. |
| `requestDelayMs` | `200` | Delay each worker waits before its own 2nd+ request. Applies per worker, so raising `maxConcurrency` does not defeat per-worker pacing. |
| `signal` | none | `AbortSignal` that stops new dispatches and is threaded into `fetchOptions.signal` (unless the caller already set one) so in-flight Horizon requests abort too. |

**How it works:** a fixed pool of `min(maxConcurrency, addresses.length)`
workers pulls addresses off a shared cursor in input order. Results are
written into a pre-sized array by index, so output order always matches
input order regardless of which worker finishes first or how many workers
are running.

**Queue saturation:** every address beyond the first `maxConcurrency`
addresses had to wait for a worker slot to free up before it could be
dispatched. Each such wait increments the `batch_queue_saturated` counter
(`globalMetrics`), so dashboards can see when a batch job is concurrency-
bound rather than Horizon-bound. `batch_max_concurrency` records the
effective (clamped) cap used for the run.

**Abort/cancel:** if `signal` is already aborted when `runBatchValidation`
is called, no Horizon request is issued at all and every row resolves as
`CANCELLED` (`BATCH_REASON_CODES.cancelled`). If it fires mid-run, no
*new* address is dispatched, and any address that was already queued but
never reached is also returned as `CANCELLED` — the function still
resolves with exactly one row per input address, so nothing is left
orphaned or unresolved. Rate-budget exhaustion (`RateBudgetExhaustedError`)
uses the same "stop dispatching, fill the rest" mechanism and keeps its
existing `RATE_BUDGET_EXHAUSTED` reason code, unchanged from before this
option existed.

**Adaptive limit (Issue #946):** `AdaptiveConcurrency` (`src/checks-run.ts`)
keeps the effective limit within `[1, min(maxConcurrency, addresses)]`. It
halves when at least 20% of requests in the current window are throttled (429,
or a retryable error with `Retry-After`) and regains one slot per 10
consecutive successes. Requests started before a decrease are ignored.
Metrics: `batch_concurrency_limit`, `batch_horizon_throttled`,
`batch_concurrency_decreased`, `batch_concurrency_increased`. With the default
`maxConcurrency: 1` the limit stays at 1.

Enforced by `__tests__/adaptive-concurrency.test.ts`, `__tests__/batch-concurrency.test.ts`, `__tests__/batch.test.ts`,
and `__tests__/batch-metrics-counters.test.ts`.

---

## GitHub integration

### Triggers (consumer workflow)

This action does not define its own trigger — the **consumer** workflow listens to:

- `issues` → `types: [assigned]` — primary automation path
- `workflow_dispatch` — manual runs with optional address input

### Permissions

Minimum for commenting:

```yaml
permissions:
  issues: write
  contents: read
```

### Comment context

`comment.ts` uses `github.context.payload.issue.number`. If the action runs outside an issue context (e.g. bare `workflow_dispatch` without issue payload), posting is skipped with a warning — checks and outputs still run.

---

## Build and runtime

| Aspect | Choice |
|--------|--------|
| Runtime | `node20` (see `action.yml`) |
| Language | TypeScript → CommonJS (`ES2020`) |
| Entry | `dist/index.js` (compiled from `src/index.ts`) |
| HTTP | `node-fetch` v2 (CommonJS-compatible) |

The action ships compiled JavaScript in `dist/`. Consumers reference a release tag; they do not run `npm install` in the action repo.

## Release pipeline

The repository includes `.github/workflows/release.yml` to verify the shipped bundle before a tag release is cut.

The release job intentionally re-runs the same checks that protect the action at runtime:

1. Install dependencies with `npm ci`
2. Run `npm run lint`
3. Run `npm test`
4. Run `npm run build`
5. Confirm `dist/index.js` exists

This keeps the packaged action and the source-of-truth TypeScript code in sync before publishing a release tag.

---

## Extension points

Future enhancements that fit the current architecture:

1. **Soroban / smart contract checks** — new module parallel to `horizon.ts`. `validation.ts` already validates the StrKey shape of a contract (`C...`) `asset_issuer`; querying contract state over Soroban RPC is still open.
2. **Multi-asset trustlines** — `checks.ts` now exports `checkMultiAssetTrustlines` for validating an arbitrary list of assets in one call (Wave #32).
3. **PR comments** — extend `comment.ts` to detect `context.payload.pull_request`

See [CONTRIBUTING.md](../CONTRIBUTING.md) for proposing changes.

---

## Reusable workflow helpers (Wave #32)

`checks.ts` ships a set of workflow-composable helper functions extracted from the main validation pipeline. These are pure functions (no I/O) and can be imported directly by other tools in the Stellar ecosystem.

| Function | Signature | Purpose |
|---|---|---|
| `checkTrustlineExists` | `(account, code, issuer) → boolean` | Point check: does this account hold this specific trustline? |
| `checkReserveMet` | `(account, minReserve) → boolean` | Point check: is native XLM balance ≥ threshold? |
| `validateStrKeyFormat` | `(address) → boolean` | Validates G-address or C-address StrKey shape without throwing |
| `checkMultiAssetTrustlines` | `(account, assets[]) → Result[]` | Batch-checks required and optional trustlines |
| `calculateRecommendedReserve` | `(trustlineCount) → number` | Stellar reserve formula: 1 XLM base + 0.5 XLM × entries |
| `checkAccountSponsored` | `(account) → boolean` | True if `num_sponsored > 0` (reduces effective reserve requirement) |
| `generateValidationReport` | `(account, config, extras?) → ValidationReport` | Full structured report for dashboards or release automation |

### ValidationReport shape

```typescript
interface ValidationReport {
  address: string;
  strKeyValid: boolean;
  accountFunded: boolean;
  xlmBalance: string;
  reserveStatus: { current: number; required: number; met: boolean; deficit: string };
  trustlines: Array<{ asset: string; issuer: string; exists: boolean }>;
  sponsored: boolean;
  timestamp: string; // ISO 8601
}
```

---

## Parser fuzz & property tests (Wave #39)

The test suite now includes three test files that benchmark parser resilience:

| Test file | Scope |
|---|---|
| `__tests__/parser-fuzz.test.ts` | Property/fuzz tests for every parser function. Exercises boundary cases, injection payloads, and random inputs. Includes `Performance benchmarks` suite (10k iterations each). |
| `__tests__/e2e-parser-harness.test.ts` | Full pipeline tests wired through jest.fn() HTTP mocks. Covers success, 404, 503, 429 retry, malformed response shapes, 100-contributor scale, and comment snapshot assertions. |
| `__tests__/reusable-workflows.test.ts` | Unit and integration tests for all Wave #32 workflow helpers. Includes DAO onboarding, treasury sponsorship, and multi-asset gateway scenarios. |

---

## Security considerations

- **No secrets in logs** — addresses are public; tokens are never logged.
- **`github_token` scope** — use least privilege (`issues: write` only where needed).
- **Horizon URL** — consumers on testnet should pass testnet Horizon explicitly; do not rely on address format alone.
- **Input validation** — G-address regex prevents malformed Horizon paths and log injection in comments.
- **Markdown escaping** — `checks.ts` escapes dynamic content (Horizon error text, asset code/issuer, account addresses) via `markdown.ts` before it's embedded in a check detail, so untrusted text (e.g. a `detail`/`title` field from a misconfigured or malicious `horizon_url`) can't inject Markdown formatting, links, or break out of the code spans rendered in the issue comment.
- **Link safety (Issue #853)** — every URL `src/links.ts` renders as a clickable link (the FAQ `docs_base_url` override, the SEP-0010 dashboard proof link via `isValidDashboardUrl`, and `buildSep0007TxLink`'s wallet `callback`) is validated by the shared `isSafeExternalLink` guard before use. It rejects: any scheme other than `https:` (`javascript:`, `data:`, `vbscript:`, plain `http:`); embedded credentials (`user:pass@host`); private, loopback, link-local, or cloud-metadata hosts (same blocklist as the Horizon SSRF policy); and any URL containing a raw `(`, `)`, backtick, angle bracket, quote, or whitespace character — those are exactly the characters that would let a URL break out of the `[text](url)` Markdown syntax every one of these links is embedded in. A value that fails the check is dropped or falls back to a safe default rather than rendered broken or malicious; comment posting is never blocked by it. `buildAssetChecklist`'s `deepLink` field (`src/markdown.ts`) uses the same guard for the same reason. See `__tests__/links-hardening.test.ts` and the `buildAssetChecklist` section of `__tests__/markdown.test.ts`.

---

[← Back to README](../README.md)

## Wave runtime safeguards (#861–#864)

The runtime keeps validation separate from mutation. `posting_mode: dry-run` runs the same check and output pipeline as enforce mode, while the entrypoint gates every GitHub mutation—comments, check runs, labels, assignee changes, and Projects v2 updates—behind `posting_mode: post`.

Job Summary rendering is budget-aware. The compact overview is higher priority than the verbose metrics JSON artifact; the artifact is removed first, followed by safe line-boundary truncation with a visible marker if the compact report still exceeds the 1 MiB UTF-8 budget.

Horizon retry scheduling accepts both Retry-After encodings, applies a bounded 10% jitter, and enforces both the per-sleep ceiling and cumulative wait budget. Retry-After waits are exported as privacy-safe numeric metrics without addresses, URLs, or response bodies.


## Per-address check latency histogram

Issue #956. `globalCheckLatencyHistogram` (`src/metrics.ts`) records the wall-clock duration of each per-address check in `src/batch.ts` into the fixed `LATENCY_BUCKETS_MS` buckets (`<=50ms` … `+Inf`). Labels are limited to the bounded outcome set `pass | fail | invalid | error`; addresses are never labels, and only aggregates (count, total, min, max, avg, bucket counts) are stored, so memory and cardinality stay constant. Negative, NaN and non-finite durations are rejected and counted in `rejected`.

## Cache single-flight

Issue #958. `SimpleCache.getOrFetch(key, fetcher, { waiterTimeoutMs })` de-duplicates concurrent fetches for one key. Waiters time out after `waiterTimeoutMs` (default 30000) with `SingleFlightTimeoutError` (`code: SINGLE_FLIGHT_WAIT_TIMEOUT`) instead of hanging on a stuck leader. Counters: `cache_single_flight_leaders`, `cache_single_flight_waiters`, `cache_single_flight_waiter_timeouts` (also via `getSingleFlightStats()`).
