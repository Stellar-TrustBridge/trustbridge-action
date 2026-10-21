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

Horizon response bodies are never logged for retryable (`429` / `5xx`)
responses, and no other fields are added to these lines. Offline runs never
call Horizon, so they produce no retry lines.

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
