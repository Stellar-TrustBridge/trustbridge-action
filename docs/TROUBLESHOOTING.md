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
