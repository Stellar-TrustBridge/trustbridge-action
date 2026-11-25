# Troubleshooting

## No issue comment appears

Confirm the action ran on an `issues` event and the workflow permissions include `issues: write`. Workflow dispatch runs can still validate, but there may be no issue context to comment on.

## Account is reported unfunded

Horizon returns `404` for accounts that have not been activated. Send the account at least the Stellar minimum balance before adding trustlines.

## Trustline is missing

Check both the asset code and issuer. A USDC trustline for a different issuer is not considered ready.

## Trustline is unauthorized

The contributor has added the trustline but the issuer has not yet authorized it. This happens when the issuing account has the `AUTH_REQUIRED` flag set. Ask the issuer to run `Allow Trust` or `Set Trustline Flags` for the contributor's account. Use `unauthorized_trustline_policy: fail | warn | ignore` to control how TrustBridge responds until authorization is granted. See [FAQ — Unauthorized trustline](FAQ.md#unauthorized-trustline) for full remediation steps.

## Claimable balance present but account unfunded

A claimable balance is not the same as an active account. The contributor must fund their G-address with at least 1 XLM before they can claim it. See [FAQ — Claimable balance](FAQ.md#claimable-balance) for full remediation steps. Set `claimable_balance_policy: count` to surface an informational hint in the check result when unfunded accounts have pending claimable balances.

## XLM reserve too low

The account exists but its native XLM balance is below `min_xlm_reserve`. Send additional XLM so the balance meets the configured minimum (default `1.5` XLM). Remember that each trustline also consumes base reserve.

## Horizon availability failed

Retry later or switch `horizon_url` to a trusted endpoint for the target network.

## Cron sweep fails across many issues during a Horizon incident

If a scheduled re-validation sweep reports `HORIZON_TIMEOUT`, `HORIZON_ERROR`,
`CIRCUIT_OPEN`, `RATE_BUDGET_EXHAUSTED` or `HORIZON_WAIT_BUDGET_EXHAUSTED` for
a large share of issues, Horizon is degraded — the wallets are not the
problem. Do not shorten the schedule or raise `max_retries`; that amplifies the
outage. Instead pause the sweep once ≥ 20 % of results are degraded, back off
the next sweep (15 min doubling up to 6 h, ± 20 % jitter), and lower
`max_retries` / `retry_max_total_wait_ms` for the incident. The full policy,
the resilience settings to tune, and a copy-paste workflow snippet are in
[CRON_REVALIDATION.md → Backoff when Horizon is degraded](CRON_REVALIDATION.md#backoff-when-horizon-is-degraded).

## Horizon retry wait budget exhausted

For `429`, `502`, `503`, and `504` responses, TrustBridge honors `Retry-After`
when present and stops once the configured total retry wait is exhausted. This
does not mean the account is unfunded: Horizon did not return a usable account
response. Retry later, use a healthy same-network fallback, or increase the
retry total-wait setting for a slow private mirror.

## Horizon request budget exhausted (RATE_BUDGET_EXHAUSTED)

The run consumed its `horizon_max_requests` budget. Back off, reduce batch
size, enable caching, then raise the budget if needed — follow the
[FAQ recovery playbook](FAQ.md#rate-budget-exhausted).

## Reading Horizon retry log lines

Every Horizon retry emits one structured log line with a fixed set of fields,
so rate-limit problems can be searched in the Actions log:

- Scheduled retries log at **debug** level (visible with `debug_mode: true` or
  `ACTIONS_STEP_DEBUG`) as `Horizon retry scheduled` (HTTP status) or
  `Horizon transport retry scheduled` (timeout / network error).
- Final exhaustion logs at **warning** level, always visible, as
  `Horizon retries exhausted (<reasonCode>): ...`.

| Field | Meaning |
| --- | --- |
| `event` | Always `horizon_retry`. |
| `phase` | `scheduled` (another attempt follows) or `exhausted` (request failed). |
| `endpointKind` | `primary` (`horizon_url`) or `fallback` (secondary / fallback URL). |
| `horizonUrl` | Base URL that was called; query string, fragment and credentials are removed and any account path segment is redacted. |
| `stellarAddress` | Account being fetched, redacted to first-4/last-4 (G, C and M addresses). |
| `attempt` | Zero-based index of the attempt that failed. |
| `maxAttempts` | Total attempts allowed (`max_retries + 1`). |
| `nextAttempt` | Index of the next attempt, or `null` when exhausted. |
| `status` | HTTP status of the failed attempt; `0` for transport errors. |
| `kind` | `http`, `timeout`, or `network`. |
| `delayMs` | Wait before the next attempt (`0` when exhausted). |
| `capped` | `true` when the wait was clamped to `retry_max_delay_ms` (for example a large `Retry-After`). |
| `retryAfterFromHeader` | `true` when the wait came from a `Retry-After` header. |
| `reasonCode` | `HORIZON_RETRY_SCHEDULED`, `HORIZON_RETRIES_EXHAUSTED`, or `HORIZON_WAIT_BUDGET_EXHAUSTED`. |

### Sampled exhaustion warnings (Issue #924)

Exhaustion warnings (`HORIZON_RETRIES_EXHAUSTED` and `HORIZON_WAIT_BUDGET_EXHAUSTED`) are sampled so a rate-limit storm does not flood the log and bury the root error:

- For each failure pattern, the first **3** warnings in a **60-second** window are logged in full. A pattern is the reason code, endpoint kind (`primary` or `fallback`), error kind, HTTP status, and redacted Horizon base URL. Account addresses are not part of the pattern, so one outage across many accounts is one stream.
- Later warnings in the same window are counted, not printed.
- When a window closes, or when the run ends, one summary line is written: `Horizon retry warnings sampled (<reasonCode>): N suppressed of M`. Its structured context has `event=horizon_retry_sampled`, `suppressedCount`, `totalCount`, `firstAt` and `lastAt` (UTC ISO timestamps for the first and last events in the window).
- Scheduled retries are debug lines and are never sampled.

To see every warning, count the summary lines against the full log. Each `suppressedCount` plus the printed warnings for that pattern equals `totalCount`. The sampling only affects log output. The `horizon_retry_*` metrics and the Job Summary counters still count every retry.

Horizon response bodies are never logged for retryable (`429` / `5xx`)
responses, and no other fields are added to these lines. Offline runs never
call Horizon, so they produce no retry lines.

## Structured log field allowlist and redaction (Issue #858)

`src/logger.ts`'s `redactContext` always redacts values — address-bearing
keys are masked, token/secret-shaped keys become `[REDACTED]`, and every
other string is scanned for an embedded address — regardless of mode. By
default no key is dropped, including nested objects and arrays (a secret or
address three levels deep inside a logged payload is still caught).

**Strict mode** additionally drops any top-level key that is not on
`LOG_CONTEXT_KEY_ALLOWLIST`:

```ts
import { redactContext, LOG_CONTEXT_KEY_ALLOWLIST } from './logger';

redactContext({ component: 'checks', rawPayload: accountResponse }, { strict: true });
// => { component: 'checks' } — rawPayload is dropped entirely, not just redacted,
//    because it is not on the allowlist.
```

The base allowlist covers `component`, `stellarAddress`, `horizonUrl`,
`reason_code`, `check`, `correlation_id` (Issue #904), the generic operational metadata keys `operation`,
`status`, `count`, `durationMs`, and every key with a defined address
redaction policy (`assetIssuer`, `accountId`, `contractAddress`, etc.). Pass
`extraAllowedKeys` to accept additional fields at a specific call site:

```ts
redactContext({ component: 'plugin-loader', pluginId }, { strict: true, extraAllowedKeys: ['pluginId'] });
```

Strict mode is opt-in per call — it does not change the default behavior of
any existing `logger.info`/`.warn`/`.error`/`.debug` call, so adopting it is
always a deliberate, per-call-site decision once that call's context keys
have been audited.

**Resilience on malformed context values:** a context value with a circular
reference, or nesting deeper than 10 levels, never crashes or hangs the
logger — `redactValue` detects the cycle (`[CIRCULAR]`) or caps the depth
(`[REDACTED_DEPTH_EXCEEDED]`) and returns a stable placeholder instead. See
`__tests__/logger.test.ts`'s "Issue #858" suites for the full regression
coverage (nested objects/arrays at multiple depths, strict-mode drop
behavior, and both malformed-input edge cases).

## Quoting the correlation id to support (Issue #904)

Every run generates one **correlation id** (`tb-` + 16 random hex chars, e.g.
`tb-3f9c1a7e5b2d4c60`) in `initCorrelationId` (`src/diagnostics.ts`). It is
random — never derived from tokens, addresses or run metadata — so it is
safe to paste publicly. It appears in:

| Surface | Where |
|---|---|
| Actions log | One `TrustBridge correlation id: tb-… (source=generated\|env)` line at the start of the run, plus a `correlation_id` field on **every** structured log line (`logInfo`/`logWarning`/`logError` JSON context and `logger.info`/`.warn`/`.error`/`.debug` `(…)` suffix). |
| Metrics JSON | Top-level `correlationId` field of `MetricsCollector.getSummary()` / `toJSON()`. It is never a metric tag, so it cannot create an unbounded label series. |
| Issue comment | Only when `debug_mode: true`: a hidden `<!-- trustbridge-action:correlation-id:tb-… -->` marker and a visible `Correlation ID: tb-…` line under the footer, plus a row at the top of the expert diagnostics block. Without `debug_mode` the comment is unchanged. |

**How support should use it:** ask the reporter to copy the id from the
comment footer (or the first lines of the job log) and search the Actions log
for it — `correlation_id":"tb-…"` / `correlation_id=tb-…` matches every line
from that run. Quote only the id; never ask for tokens or full addresses.

**Propagating an existing id:** set `TRUSTBRIDGE_CORRELATION_ID` in the step
`env:` (e.g. from a reusable workflow that fans out to several jobs) to reuse
one id across runs:

```yaml
- uses: Stellar-TrustBridge/trustbridge-action@v1
  env:
    TRUSTBRIDGE_CORRELATION_ID: wave-${{ github.run_id }}-${{ github.run_attempt }}
```

A propagated id must be 8–64 characters of `[A-Za-z0-9._-]` and must survive
the log redaction policy unchanged (anything that looks like a token,
secret assignment or Stellar address is rejected). An invalid value is
**never echoed**: the run logs a warning with reason code
`CORRELATION_ID_INVALID` and the reason (e.g. `correlation id must be 8-64
characters (got 3)`), then generates a fresh id. The `correlation_id` key is
on `LOG_CONTEXT_KEY_ALLOWLIST`, so strict-mode redaction keeps it.

Test coverage: `__tests__/correlation-id.test.ts`.

## Friendbot funding failed

With `use_friendbot: true`, a failed Friendbot call does not fail the job by
itself. `friendbot_called` is `true`, `friendbot_success` is `false`, and the
account is reported as unfunded. Common messages:

- `Friendbot returned HTTP 400: ...`: usually "account already exists". The
  account is already funded on that network, so check that `horizon_url` and
  `friendbot_url` point at the same network.
- `Friendbot returned HTTP 429` / `HTTP 5xx`: Friendbot is rate limiting or
  unavailable. Re-run later. TrustBridge calls Friendbot at most once per run
  and does not retry the request.
- `Friendbot request timed out after <n>ms`: raise `friendbot_timeout_ms`
  (max `60000`).
- `Friendbot URL "..." is not on the allowlist`: only official SDF Friendbot
  hosts are accepted. On futurenet use `https://friendbot-futurenet.stellar.org`.
- Warning `use_friendbot is enabled but horizon_url is not a test network`:
  Friendbot is never called on pubnet.

If funding succeeded but the run still fails, see the
[false-negative FAQ](FAQ.md#friendbot-testnet-false-negatives).

See [USAGE.md — Friendbot testnet funding](USAGE.md#friendbot-testnet-funding)
for the input reference.

## Comment posting fails with 404 on GitHub Enterprise Server (GHES)

TrustBridge builds its Octokit client from `context.apiUrl` (backed by the runner's `GITHUB_API_URL`), so it should target your GHES instance automatically. A 404 or "resource not accessible" error usually means either the runner isn't actually GHES-registered (so `GITHUB_API_URL` never got set) or the token lacks `issues: write`. See [docs/USAGE.md — GitHub Enterprise Server (GHES) support](USAGE.md#github-enterprise-server-ghes-support) for the full verification checklist.

## Plugin fails to load or run

**Symptom:** A configured plugin fails to execute, or you see `PluginLoadError` in the workflow logs.

**Checks:**
1. Confirm `trustbridge_plugins_path` is a relative path inside the workspace (e.g., `plugins/kyc.ts`).
2. Verify the file exists and exports a valid `CheckPlugin` object.
3. Check if the plugin throws an unexpected synchronous error during `run()`.

**Helpful links:**
- [Plugin Architecture](PLUGIN_ARCHITECTURE.md)
- [KYC Plugin Example](examples/kyc-plugin.md)

## Signed webhook not received

**Symptom:** Your dashboard doesn't receive TrustBridge notifications or rejects them with a signature error.

**Checks:**
1. Confirm `webhook_url` is a publicly reachable HTTPS endpoint.
2. Check the Actions log for delivery failure messages (e.g., `Webhook delivery failed`).
3. Verify that `webhook_secret` matches exactly on both the action input and the receiving server.

**Helpful links:**
- [FAQ: Signed webhook not received](FAQ.md#webhook-not-received)
- [USAGE: Dashboard webhook receiver contract](USAGE.md#dashboard-webhook-receiver-contract-issue-326)

## GitHub Projects V2 does not update

**Symptom:** The action runs successfully, but the linked issue does not move to the expected column in your GitHub Project.

**Checks:**
1. Verify you are using a Personal Access Token (Classic PAT with `repo` and `project` scopes, or a fine-grained PAT) for `trustbridge_projects_token`. The default `GITHUB_TOKEN` cannot update org-level Projects.
2. Check that the provided token hasn't expired.
3. Check the workflow logs for permission errors from the GitHub GraphQL API.

**Helpful links:**
- [USAGE: GitHub Projects v2 status updates](USAGE.md#github-projects-v2-status-updates-issue-222)

## Preflight permission probe fails (403 / 401)

Before making any Horizon calls, TrustBridge issues a read-only `GET /repos/{owner}/{repo}/issues/{number}/comments?per_page=1` probe to verify the token has at minimum `issues: read`. A 403 here means the workflow job is missing the required permission block:

```yaml
permissions:
  issues: write
  contents: read
```

A 401 means the token itself is invalid or expired — check that `github_token: ${{ secrets.GITHUB_TOKEN }}` is set correctly.

The preflight probe is **skipped entirely** when `comment_mode` is `dry-run` or `off`, because those modes never post a comment and therefore do not need `issues: write`. Use `comment_mode: dry-run` to validate Horizon checks without requiring write permission.

## Using preflight_only to diagnose permission issues

Set `preflight_only: true` to run only the permission probe and exit immediately — no Horizon calls are made. This is useful for verifying token permissions in a new repository without spending API quota:

```yaml
- uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ steps.address.outputs.address }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    preflight_only: true
```

The step succeeds when the probe passes (200) and fails with a clear error when the token lacks permission (403/401) or the issue is not found (404).

## Dry-run preflight output for missing permissions

`formatMissingPermissionsDryRun()` in `src/preflight.ts` renders the exact text logged by a dry-run preflight when the job lacks `issues: write` and/or `id-token: write` (the latter only matters for `webhook_auth_mode: oidc`). The output is snapshot-tested in `__tests__/preflight-dry-run.test.ts`, so it is stable across releases:

```text
[trustbridge] preflight (dry-run): missing workflow permissions
- `id-token: write` — required when `webhook_auth_mode: oidc` signs webhook deliveries
- `issues: write` — required to post or update the TrustBridge issue comment

Add to the workflow job:

permissions:
  contents: read
  id-token: write
  issues: write
```

## Job Summary was truncated

GitHub Job Summaries have a 1 MiB UTF-8 budget. TrustBridge treats the verbose metrics JSON as lower priority and removes it before truncating the compact overview. A visible `trustbridge-action:summary-truncated` marker identifies this soft-fail path; inspect the workflow logs or uploaded artifacts for the complete detail. The validation result and action outputs are not changed.

## Dry-run unexpectedly changed GitHub state

`posting_mode: dry-run` is side-effect free for TrustBridge-owned GitHub mutations. Confirm the workflow is not invoking a separate step or action that edits comments, labels, assignees, projects, or check runs. TrustBridge still performs Horizon reads and computes the same result as `post` mode.

## Retry-After wait metrics

A `horizon_retry_after_wait` metric records each actual jittered wait in milliseconds. The `horizon_retry_after_waits` and `horizon_retry_after_wait_ms` counters show how often and how long the action waited on server guidance. The wait is always bounded by `retry_max_delay_ms` and the cumulative `retry_max_total_wait_ms` budget.

## Diagnostics bundle

When a run fails in a way you cannot explain, or maintainers ask for details, enable the optional diagnostics bundle and attach it to the workflow run as an artifact. It is **off by default**; turn it on only while debugging or when asked for support.

```yaml
- id: trustbridge
  uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    diagnostics_zip_path: trustbridge-diagnostics.zip
    diagnostics_zip_max_bytes: "1048576" # optional, default 1 MiB
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: trustbridge-diagnostics
    path: ${{ steps.trustbridge.outputs.diagnostics_zip_path }}
    if-no-files-found: ignore
```

The zip contains:

| File | Contents |
|------|----------|
| `manifest.json` | Schema version, optional timestamp, size cap, redaction policy, every file with its size and SHA-256, and anything omitted to fit the cap |
| `inputs.json` | The resolved action inputs after redaction |
| `diagnostics.md` | The same expert diagnostics block used in `debug_mode` comments |
| `run-info.json` | Horizon status, latency, retries and (redacted) error, when available |

Nothing sensitive is included: `github_token`, webhook secrets, anything whose name contains `token`, `secret` or `password`, Stellar secret seeds, GitHub and bearer tokens, JWTs and PEM private keys are replaced, and every Stellar address is masked to first-4/last-4. Lines longer than 1 KiB are cut before redaction, and each file is capped at 256 KiB. The same input always produces the same bytes, so re-running writes nothing new, and the archive is written to a temporary file and renamed, so an interrupted run never leaves a truncated zip.

The `diagnostics_zip_path` must end in `.zip` and resolve inside `GITHUB_WORKSPACE`. If the bundle exceeds `diagnostics_zip_max_bytes`, optional files are dropped (extra files first, then `diagnostics.md`, then `run-info.json`) and listed under `omitted` in the manifest.

A bundle problem never changes the validation verdict: it logs a warning and sets the `diagnostics_zip_status` output.

| `diagnostics_zip_status` | Meaning and fix |
|--------------------------|-----------------|
| `written` | The bundle was created at `diagnostics_zip_path`. |
| `unchanged` | An identical bundle already existed; nothing was rewritten. |
| `disabled` | `diagnostics_zip_path` is empty. |
| `invalid_path` | The path is empty, does not end in `.zip`, escapes the workspace (including through a symlink), or is a directory. Use a workspace-relative `.zip` path. |
| `invalid_max_bytes` | `diagnostics_zip_max_bytes` is not a whole number between 4096 and 52428800. |
| `too_large` | Even the mandatory `manifest.json` and `inputs.json` do not fit. Raise `diagnostics_zip_max_bytes`. |
| `write_failed` | The file could not be written (permissions, a file where a directory is needed, full disk). The warning names the cause; make the workspace path writable. |

## SARIF upload failures

Playbook for `github/codeql-action/upload-sarif` failures after TrustBridge
writes `sarif_output_path` (generated by `src/sarif.ts`, SARIF 2.1.0). Working
workflow: [`docs/examples/sarif-code-scanning.yml`](examples/sarif-code-scanning.yml).

| Symptom (upload-sarif log) | Cause | Fix |
|---|---|---|
| `Resource not accessible by integration` / HTTP 403 | Job lacks `security-events: write` | Add `permissions: { security-events: write, contents: read }` to the job. Fork PRs never get this permission — gate the upload with `if: github.event.pull_request.head.repo.full_name == github.repository`. |
| `Advanced Security must be enabled for this repository` | Code scanning disabled on a private repo | Enable GitHub Advanced Security / code scanning in repo settings. |
| HTTP 404 on GHES | Code scanning not available on that GHES version | See [GHES compatibility](GHES_COMPATIBILITY.md); skip the upload step on unsupported servers. |
| `Path does not exist` / `No SARIF files found` | Upload ran when TrustBridge did not write the file (input empty, earlier step failed) | Set `sarif_output_path`, run the upload with `if: always()` and `hashFiles('trustbridge-results.sarif') != ''`. |
| `SARIF file is too large` / payload over 10 MB gzipped, or over 5000 results per run | Very large batch rosters | Split batches (`stellar_addresses`) across matrix jobs, one SARIF `category` each. |
| `Unable to upload: ... is not valid SARIF` / schema error | File edited or truncated after generation, or non-JSON written to the path | Do not post-process the file; validate with `jq empty trustbridge-results.sarif`. `$schema` must be the SARIF 2.1.0 schema URL and `version` `2.1.0` (`SARIF_SCHEMA` / `SARIF_VERSION` in `src/sarif.ts`). |
| Alerts duplicate on every run | Changing `category` between runs, or uploading multiple runs with the same category | Keep one stable `category` per workflow/matrix leg. Fingerprints use `partialFingerprints["trustbridge/v1"]`, so identical findings dedupe automatically. |
| Upload "succeeds" but no alerts appear | All checks passed (no results), or filtered by branch | Expected: a clean run uploads an empty `results` array. Alerts only show for the default branch and PR refs. |

Rule IDs (`TB000`–`TB010`) and their help URIs are defined in `src/sarif.ts`
and documented in [USAGE.md](USAGE.md#sarif-output-for-github-advanced-security).
Never paste SARIF into public issues without checking it: addresses are
redacted per the logging policy, but treat the file as CI output.
