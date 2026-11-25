# Cron wallet re-validation

Scheduled re-validation of contributor Stellar wallets across all open, assigned bounty issues.

Related docs: [USAGE](USAGE.md) · [Error handling](ERROR_HANDLING.md) · [Maintainer checklist](MAINTAINER_CHECKLIST.md)

---

## Why scheduled re-validation?

A one-time assignment check is insufficient for long-running Waves:

| Drift scenario | Assignment-time check | Cron check |
| --- | --- | --- |
| Trustline removed after assignment | ❌ Not caught | ✅ Caught next cron run |
| XLM balance spent below reserve | ❌ Not caught | ✅ Caught next cron run |
| Wallet address rotated (new G-address) | ❌ Not caught | ✅ Caught next cron run |
| Account closed / merged | ❌ Not caught | ✅ Caught next cron run |

Running a nightly (or pre-payout) sweep ensures no stale wallets reach the payout step.

---

## Quick start

1. **Copy** [`docs/examples/cron-revalidation.yml`](examples/cron-revalidation.yml) into your repository as `.github/workflows/trustbridge-cron.yml`.
2. **Set the `BOUNTY_LABEL` env var** to the label your project uses to identify bounty issues (default: `"bounty"`).
3. **Verify your issue template** includes a `Stellar address: G…` line so the extraction step can parse addresses (see [§ Issue template format](#issue-template-format)).
4. **Create or identify** the per-issue revalidation workflow that accepts `stellar_address` and `issue_number` as `workflow_dispatch` inputs. Point `REVALIDATION_WORKFLOW_FILE` at its filename.
5. **Push and enable** the workflow. It will run daily at 03:00 UTC.

---

## Permissions & Secrets

```yaml
permissions:
  issues: write   # required — post / update TrustBridge comments
  contents: read  # standard — checkout-less action runs
```

### Secrets configuration

| Secret | Purpose | When to use |
| --- | --- | --- |
| `secrets.GITHUB_TOKEN` | Default workflow token with `issues: write` and `contents: read` | Standard repository setup on default branch |
| `secrets.TRUSTBRIDGE_TOKEN` | Scoped Personal Access Token (PAT) with `repo` scope | When org-level token restrictions block comment creation |
| `secrets.GITHUB_APP_TOKEN` | Pre-minted GitHub App installation token | For high-volume org triage with 15,000 req/hr rate limits |

### Fork safety

Scheduled cron workflows run on all forks by default. To prevent failed runs or unwanted API requests on contributor forks, protect your cron job with:

```yaml
if: !github.event.repository.fork
```

---

## Comment posting and threading policy

Use `posting_mode` to control whether an issue comment is posted. `comment_mode` is only for the threading strategy (`sticky`, `new`, or `reply`).

| Mode | Behavior | Use case |
| --- | --- | --- |
| `posting_mode: dry-run` | Validates accounts and sets all step outputs (`ready`, `reason_code`, `checks_json`) without calling the GitHub comment API | Audit-only cron sweeps, balance checks, pre-payout verification |
| `posting_mode: post` (default) | Posts using the selected `comment_mode` threading strategy | Live contributor notification workflows |
| `posting_mode: off` | Skips comment posting while validation and outputs continue | CI performance / headless checks |

---

## Recommended inputs for cron runs

| Input | Recommended cron value | Reason |
| --- | --- | --- |
| `fail_on_missing` | `false` | Keeps the cron job green; ❌ appears in the issue comment, not as a CI badge failure |
| `posting_mode` | `dry-run` (or `post`) | `dry-run` is safest for audit sweeps; `post` uses the selected threading strategy |
| `comment_mode` | `sticky` (default) | Updates the existing TrustBridge comment instead of posting a new one per run |
| `debug_mode` | `false` | Reduces log noise; enable only for targeted investigation |
| `horizon_cache_ttl_ms` | `0` or `60000` | Set to `0` to always fetch live data; set to `60000` to reduce Horizon calls when the same address appears on multiple issues |

### Why `fail_on_missing: false` for cron?

A cron job failing because one contributor's wallet drifted would break your CI badge and potentially suppress GitHub notification emails for real CI failures. Using `fail_on_missing: false` keeps the job green while:

1. Posting ❌ comments on affected issues so contributors see the problem.
2. Emitting GitHub Actions `::warning::` annotations visible in the run log.
3. Triggering the dedicated maintainer alert step when dispatch failures occur.

---

## Backoff when Horizon is degraded

A nightly sweep that keeps firing at full rate while Horizon is returning `429` / `5xx` / timeouts makes the incident worse for every Wave org sharing that Horizon. TrustBridge already backs off **inside** a run; the cron workflow should back off **between** runs and between dispatches.

### 1. In-run resilience settings (per TrustBridge step)

These are enforced by `src/horizon.ts` / `src/resilience.ts`. During an incident, prefer *fewer, bounded* retries over more of them.

| Input | Default | Recommended during a Horizon incident | Effect |
| --- | --- | --- | --- |
| `max_retries` | `3` (0–10) | `1`–`2` | Attempts per endpoint on `429` / `502` / `503` / `504` / timeout |
| `retry_base_delay_ms` | `1000` | `2000` | Exponential backoff base (`base * 2^attempt`, ± 10 % jitter) |
| `retry_max_delay_ms` | `30000` | keep | Cap on any single wait, including `Retry-After` |
| `retry_max_total_wait_ms` | `120000` | `60000` | Cumulative wait budget per endpoint; exhaustion yields `HORIZON_WAIT_BUDGET_EXHAUSTED` |
| `horizon_timeout_ms` | `15000` | keep | Per-request timeout (`HORIZON_TIMEOUT`) |
| `horizon_max_requests` | `0` (unlimited) | e.g. `50` | Hard request budget per run (`RATE_BUDGET_EXHAUSTED`) |
| `use_cache` + `horizon_cache_ttl_ms` | off / `60000` | on / `60000` | Reuses results when an address appears on several issues |
| `horizon_url_fallback` / `rpc_fallback_url` | empty | a same-network mirror | Failover after retry exhaustion |

The circuit breaker (5 consecutive failures → open for 30 s, one half-open probe at a time) fast-fails with `CIRCUIT_OPEN` instead of sending more requests. See [Error handling → Retry-After cap inputs](ERROR_HANDLING.md#retry-after-cap-inputs-issue-705) and [Error handling → 503 / 502 / 504](ERROR_HANDLING.md#503--502--504--service-degradation) for full semantics.

### 2. Which signals mean "Horizon is degraded"

Drive pauses from the step's `reason_code` output, never from wallet failures. These codes are exported as `HORIZON_DEGRADED_REASON_CODES` in `src/resilience.ts`:

| `reason_code` | Meaning |
| --- | --- |
| `HORIZON_TIMEOUT` | Requests timed out after retries |
| `HORIZON_ERROR` | Non-retryable or exhausted Horizon HTTP / transport error |
| `CIRCUIT_OPEN` | Circuit breaker short-circuited the request |
| `RATE_BUDGET_EXHAUSTED` | `horizon_max_requests` budget used up |
| `HORIZON_WAIT_BUDGET_EXHAUSTED` | `Retry-After` / backoff waits exceeded `retry_max_total_wait_ms` |

Wallet outcomes (`TRUSTLINE_MISSING`, `RESERVE_TOO_LOW`, `ACCOUNT_NOT_FUNDED`, …) mean Horizon answered correctly and must **not** trigger a pause.

Supporting Action metrics in the Job Summary JSON artifact: the `horizon_retry_after_waits` / `horizon_retry_after_wait_ms` counters (Horizon asked us to slow down), the `horizonFetchLatencyHistogram` (latency shifting into the `2500` / `5000` / `+Inf` buckets), circuit-breaker state-change annotations, and — when tracing is enabled — `horizon.http_error` spans (see [ARCHITECTURE.md → Horizon error spans](ARCHITECTURE.md#horizon-error-spans)).

### 3. Pause and back off between sweeps

Recommended policy (`DEFAULT_CRON_BACKOFF_POLICY` in `src/resilience.ts`):

- **Pause the sweep** (stop dispatching further issues) once at least **5** results are in and **≥ 20 %** of them carry a degraded `reason_code` (`shouldPauseCronSweep`).
- **Back off the next sweep** after *n* consecutive degraded sweeps by `min(15 min × 2^(n-1), 6 h)` with **± 20 % jitter** (`computeCronBackoffDelayMs`): 15 min → 30 min → 1 h → 2 h → 4 h → 6 h. A clean sweep resets *n* to 0.
- **Jitter the schedule itself.** Avoid `0 * * * *` / `0 3 * * *`; pick an off-minute (`17 3 * * *`) and add a random `sleep` of up to a few minutes before the first Horizon call so Wave orgs do not hit Horizon in lockstep.
- **Never overlap runs.** Add a `concurrency` group so a slow, backing-off sweep is not joined by the next scheduled one.
- **Space dispatches.** Keep `REVALIDATION_BATCH_SIZE` small and sleep between `workflow_dispatch` calls during an incident.

```yaml
concurrency:
  group: trustbridge-cron
  cancel-in-progress: false

jobs:
  sweep:
    steps:
      - name: Jitter start
        run: sleep $(( RANDOM % 180 ))

      # … per-address TrustBridge step with id: tb …

      - name: Pause sweep if Horizon is degraded
        if: always()
        run: |
          case "${{ steps.tb.outputs.reason_code }}" in
            HORIZON_TIMEOUT|HORIZON_ERROR|CIRCUIT_OPEN|RATE_BUDGET_EXHAUSTED|HORIZON_WAIT_BUDGET_EXHAUSTED)
              echo "::warning::Horizon degraded (${{ steps.tb.outputs.reason_code }}); pausing sweep."
              echo "HORIZON_DEGRADED=true" >> "$GITHUB_ENV" ;;
          esac
```

Persist the consecutive-degraded counter wherever your sweep already keeps state (a repository variable, a cache entry, or a tracking issue label) and skip the run early while `now < last_run + computeCronBackoffDelayMs(n)`.

Pausing never changes readiness semantics: a skipped or paused sweep posts no comments and leaves the previous sticky comment untouched, so no partial state is written. Use `posting_mode: dry-run` to rehearse the policy without touching issues.

---

## Inline variant (no secondary workflow file)

If you cannot or do not want to dispatch a second workflow, you can call `trustbridge-action` directly inside the cron job. When running in a cron job without issue context, set `posting_mode: dry-run` so checks run cleanly and outputs are populated for downstream maintainer alerts:

```yaml
- name: Re-validate wallet (inline)
  uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ env.CURRENT_ADDRESS }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    fail_on_missing: false      # required for cron
    posting_mode: dry-run       # safe for headless cron runs
    asset_code: ${{ env.ASSET_CODE }}
    asset_issuer: ${{ env.ASSET_ISSUER }}
    min_xlm_reserve: ${{ env.MIN_XLM_RESERVE }}
```

Then inspect the step outputs (`ready`, `reason_code`, `trustline_exists`, `account_funded`, `xlm_balance`) to build your alert payload.

---

## Maintainer alert strategy

The example workflow logs a warning and optionally posts to a tracking issue. Choose the strategy that fits your team:

| Strategy | How |
| --- | --- |
| GitHub issue comment on a pinned tracking issue | Uncomment the `gh issue comment` lines in step 4 and set `ALERT_ISSUE_NUMBER` |
| Slack / Teams webhook | Replace step 4 with `curl -X POST` to your webhook URL |
| Email | Use `actions/send-email` or a similar action |
| GitHub Discussions post | Use `gh api graphql` with a `createDiscussion` mutation |

Regardless of strategy, always include the **run URL** in the alert so maintainers can drill into the run log directly.

---

## Dry run

Pass `posting_mode: dry-run` on the inner TrustBridge step to log which issues would be revalidated without dispatching any sub-runs or posting any comments. Expose it as a `workflow_dispatch` input on the cron workflow so maintainers can trigger a no-op sweep from the GitHub Actions UI:

```yaml
on:
  workflow_dispatch:
    inputs:
      posting_mode:
        description: 'Set to dry-run to skip comment posting (default: dry-run for safety)'
        default: "dry-run"
```

Then wire it through to the TrustBridge step:

```yaml
- name: Re-validate wallet (inline)
  uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    posting_mode: ${{ inputs.posting_mode || 'dry-run' }}
```

Use this to verify the label filter and address-extraction logic before enabling the schedule.

---

## Adjusting the schedule

```yaml
on:
  schedule:
    - cron: "0 3 * * *"    # nightly at 03:00 UTC (default)
    # - cron: "0 3 * * 1"  # weekly on Monday
    # - cron: "0 3 1 * *"  # monthly on the 1st
```

For Wave-based projects, trigger the sweep 24 hours before the Wave payout deadline so maintainers have time to follow up with contributors whose wallets have drifted.

---

## Issue template format

The extraction step parses a `Stellar address: G…` line from each open, assigned bounty issue. Keep the line stable and on its own line so the jq regex matches reliably:

```markdown
Stellar address: GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV
```

Issues without a parseable address are skipped and counted in the `parseable` summary output. If `parseable=0` on a run where you expect matches, see [Troubleshooting](#troubleshooting).

---

## Sample workflow

The full copy-paste workflow lives at [`docs/examples/cron-revalidation.yml`](examples/cron-revalidation.yml). It:

1. Lists open, assigned issues carrying `BOUNTY_LABEL` (batched via `REVALIDATION_BATCH_SIZE`).
2. Extracts each `Stellar address: G…` line and skips issues without one.
3. Dispatches the per-issue revalidation workflow (`REVALIDATION_WORKFLOW_FILE`) with `stellar_address` and `issue_number`.
4. Emits `::warning::` annotations and an optional maintainer alert when dispatch fails.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `parseable=0`, all issues skipped | Issue template format mismatch | Update the jq regex or adjust the issue template |
| Dispatch failures with 404 | `REVALIDATION_WORKFLOW_FILE` is wrong | Verify the workflow filename in `.github/workflows/` |
| Dispatch failures with 422 | `workflow_dispatch` not enabled on target workflow | Add `workflow_dispatch:` trigger to the target workflow |
| `::warning:: rate limit` on `gh issue list` | Too many issues or too-frequent schedule | Reduce `REVALIDATION_BATCH_SIZE` or switch to a PAT / GitHub App token |
| Comments not updated | `sticky_comment: false` in target workflow | Set `sticky_comment: true` in the per-issue revalidation workflow |
| Many issues report `HORIZON_TIMEOUT` / `CIRCUIT_OPEN` / `HORIZON_WAIT_BUDGET_EXHAUSTED` at once | Horizon is degraded, not the wallets | Pause and back off — see [§ Backoff when Horizon is degraded](#backoff-when-horizon-is-degraded) |

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

## Clock-skew tolerance (#871)

Freshness checks tolerate a ledger close timestamp up to 30 seconds in the future, which covers normal runner/NTP skew. A future timestamp beyond that tolerance is reported as `status: unknown` and remains fail-open; it is never treated as proof that Horizon is fresh. Library callers can override this with `clockSkewToleranceSeconds`. Keep runner clocks synchronized and investigate repeated `freshness_clock_skew_unknown` metrics.
