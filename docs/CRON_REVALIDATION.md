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

## Comment mode & safety (`comment_mode`)

TrustBridge provides a dedicated `comment_mode` setting to control comment side-effects during automated runs:

| Mode | Behavior | Use case |
| --- | --- | --- |
| `dry-run` | Validates accounts and sets all step outputs (`ready`, `reason_code`, `checks_json`) without calling the GitHub comment API | Audit-only cron sweeps, balance checks, pre-payout verification |
| `post` (default) | Creates or updates the sticky comment on the target issue | Live contributor notification workflows |
| `off` | Skips comment formatting entirely | CI performance / headless checks |

---

## Recommended inputs for cron runs

| Input | Recommended cron value | Reason |
| --- | --- | --- |
| `fail_on_missing` | `false` | Keeps the cron job green; ❌ appears in the issue comment, not as a CI badge failure |
| `comment_mode` | `dry-run` (or `post`) | `dry-run` is safest for audit sweeps; `post` updates sticky comment on issue |
| `sticky_comment` | `true` (default) | Updates the existing TrustBridge comment instead of posting a new one per run |
| `debug_mode` | `false` | Reduces log noise; enable only for targeted investigation |
| `horizon_cache_ttl_ms` | `0` or `60000` | Set to `0` to always fetch live data; set to `60000` to reduce Horizon calls when the same address appears on multiple issues |

### Why `fail_on_missing: false` for cron?

A cron job failing because one contributor's wallet drifted would break your CI badge and potentially suppress GitHub notification emails for real CI failures. Using `fail_on_missing: false` keeps the job green while:

1. Posting ❌ comments on affected issues so contributors see the problem.
2. Emitting GitHub Actions `::warning::` annotations visible in the run log.
3. Triggering the dedicated maintainer alert step when dispatch failures occur.

---

## Inline variant (no secondary workflow file)

If you cannot or do not want to dispatch a second workflow, you can call `trustbridge-action` directly inside the cron job. When running in a cron job without issue context, set `comment_mode: dry-run` so checks run cleanly and outputs are populated for downstream maintainer alerts:

```yaml
- name: Re-validate wallet (inline)
  uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ env.CURRENT_ADDRESS }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    fail_on_missing: false      # required for cron
    comment_mode: dry-run       # safe for headless cron runs
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

Pass `dry_run: true` via `workflow_dispatch` to log which issues would be revalidated without dispatching any sub-runs or posting any comments:

```yaml
on:
  workflow_dispatch:
    inputs:
      dry_run:
        default: "true"
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

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `parseable=0`, all issues skipped | Issue template format mismatch | Update the jq regex or adjust the issue template |
| Dispatch failures with 404 | `REVALIDATION_WORKFLOW_FILE` is wrong | Verify the workflow filename in `.github/workflows/` |
| Dispatch failures with 422 | `workflow_dispatch` not enabled on target workflow | Add `workflow_dispatch:` trigger to the target workflow |
| `::warning:: rate limit` on `gh issue list` | Too many issues or too-frequent schedule | Reduce `REVALIDATION_BATCH_SIZE` or switch to a PAT / GitHub App token |
| Comments not updated | `sticky_comment: false` in target workflow | Set `sticky_comment: true` in the per-issue revalidation workflow |

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) and [ERROR_HANDLING.md](ERROR_HANDLING.md) for deeper diagnostic guidance.

---

[← Back to USAGE](USAGE.md) · [← Back to README](../README.md)
