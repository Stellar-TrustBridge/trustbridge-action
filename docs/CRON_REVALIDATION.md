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

## Permissions

```yaml
permissions:
  issues: write   # required — post / update TrustBridge comments
  contents: read  # standard — checkout-less action runs
```

> **Note:** These are job-level permissions. If your repository has organisation-level rules that further restrict the token, you may need a scoped PAT stored as `TRUSTBRIDGE_TOKEN` and referenced via `secrets.TRUSTBRIDGE_TOKEN` instead of `secrets.GITHUB_TOKEN`.

### Minimum token scopes (PAT alternative)

| Scope | Reason |
| --- | --- |
| `repo` → `issues` | Read issue bodies; write comments |
| `repo` → `actions` | Dispatch revalidation workflow runs |

---

## Issue querying

The example workflow uses the **GitHub CLI** (`gh issue list`) which is pre-installed on `ubuntu-latest` runners. It filters by label, state, and the presence of at least one assignee:

```bash
gh issue list \
  --repo "owner/repo" \
  --label "bounty" \
  --state open \
  --limit 50 \
  --json number,title,assignees,body
```

### Pagination and batch size

`gh issue list` paginates automatically up to `--limit`. The default batch size in the workflow is **50 issues per run**. For larger backlogs:

- Increase `REVALIDATION_BATCH_SIZE` — each additional issue adds ~3 API calls.
- Add a `sleep 1` between dispatches (already included in the example) to distribute load.
- For > 200 issues, split the run into multiple jobs with offset queries or use a PAT with higher rate limits.

### Rate limits

| Token type | Limit |
| --- | --- |
| `GITHUB_TOKEN` | 5 000 req / hour |
| Fine-grained PAT | 5 000 req / hour (same quota pool) |
| GitHub App installation token | 15 000 req / hour (recommended for large orgs) |

The workflow emits a `::warning::` annotation if no addresses are parsed, which is often the first symptom of rate-limiting hitting the issue-list call.

---

## Issue template format

The address-extraction step uses the following pattern by default:

```
Stellar address: G<56 chars>
```

Example issue body field:

```markdown
### Contributor wallet
Stellar address: GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW
```

To change the extraction pattern, edit the `jq` expression in step 2 of the workflow:

```yaml
($issue.body // "" | capture("(?i)your custom pattern:\\s*(?<addr>G[A-Z2-7]{55})") // null)
```

Validation of the extracted address (length, character set, checksum) is performed by `trustbridge-action` itself, not by the extraction step.

---

## Recommended inputs for cron runs

| Input | Recommended cron value | Reason |
| --- | --- | --- |
| `fail_on_missing` | `false` | Keeps the cron job green; ❌ appears in the issue comment, not as a CI badge failure |
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

If you cannot or do not want to dispatch a second workflow, you can call `trustbridge-action` directly inside the cron job. The tradeoff is that cron jobs do not have an issue context, so the action **cannot post comments**. Use this variant only for auditing (balance/trustline checks) combined with the maintainer alert step.

```yaml
- name: Re-validate wallet (inline)
  uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ env.CURRENT_ADDRESS }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    fail_on_missing: false      # required for cron
    sticky_comment: true        # no-op without issue context, but harmless
    asset_code: ${{ env.ASSET_CODE }}
    asset_issuer: ${{ env.ASSET_ISSUER }}
    min_xlm_reserve: ${{ env.MIN_XLM_RESERVE }}
```

Then inspect the step outputs (`trustline_exists`, `account_funded`, `xlm_balance`) to build your alert payload.

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

---

## Weekly digest mode (#324)

Per-run comments on every CRON re-validation create noise. The digest mode aggregates all re-validation results into a single summary comment posted to a designated tracking issue once per week (or on any schedule you choose).

### What the digest does

- Runs TrustBridge for every open bounty issue.
- Collects each result in memory (no per-issue comments posted).
- Posts **one** summary comment to a tracking issue listing:
  - Total issues validated, ready count, blocked count, and ready rate.
  - A per-contributor breakdown (issue number, address, failed checks).
  - Redacted addresses when `privacy_mode: true` (SHA-256 hashes).
  - Capped at 50 entries per section to respect GitHub comment size limits.

### Example workflow

See [`docs/examples/weekly-digest.yml`](examples/weekly-digest.yml) for a copy-paste ready workflow.

Key inputs for digest mode:

| Input | Recommended value | Reason |
|-------|-------------------|--------|
| `fail_on_missing` | `false` | Keep the digest job green |
| `sticky_comment` | `false` | Per-issue, no comment to post |
| `comment_mode` | `new` | Per-issue, no comment to post |

### Size limits and PII

- The digest is capped at `DIGEST_MAX_LISTED_ISSUES = 50` entries per section.
  When there are more contributors, the comment includes a `… and N more` note.
- Set `privacy_mode: true` on the TrustBridge runs to hash all addresses before
  they enter the digest. Hashed addresses cannot be reversed but remain
  correlatable across digest runs (same address → same hash).

### Validate

```bash
npm test -- --testPathPattern 'summary'
```
