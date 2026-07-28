# Usage guide

How to integrate **trustbridge-action** into your repository workflows.

Related docs: [README](../README.md) · [Architecture](ARCHITECTURE.md) · [Error handling](ERROR_HANDLING.md)

---

## Prerequisites

1. A GitHub repository with Actions enabled
2. A Stellar **G-address** to validate (contributor wallet)
3. Workflow permissions allowing issue comments

---

## Basic workflow — issue assignment

```yaml
name: Verify Stellar wallet on assignment

on:
  issues:
    types: [assigned]

jobs:
  trustbridge:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      contents: read
    steps:
      - uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: GCONTRIBUTORADDRESSHERE
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

Replace `GCONTRIBUTORADDRESSHERE` with your project's method of obtaining the address (see [Extracting addresses](#extracting-stellar-addresses-from-issues)).

---

## Manual run — workflow_dispatch

```yaml
on:
  workflow_dispatch:
    inputs:
      stellar_address:
        description: 'Stellar G-address'
        required: true

jobs:
  trustbridge:
    runs-on: ubuntu-latest
    permissions:
      issues: write
    steps:
      - uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: ${{ github.event.inputs.stellar_address }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          fail_on_missing: false   # warn only for manual checks
```

> **Note:** Comments are only posted when the workflow runs in an **issue** context. For standalone `workflow_dispatch` without an open issue, checks still run and outputs are set; comment posting is skipped with a warning.

---

## Combined trigger (assigned + manual)

Matches the action design target:

```yaml
on:
  issues:
    types: [assigned]
  workflow_dispatch:
    inputs:
      stellar_address:
        description: 'Stellar G-address (manual runs)'
        required: true
      issue_number:
        description: 'Optional issue number for context'
        required: false

jobs:
  trustbridge:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      contents: read
    steps:
      - name: Resolve address
        id: addr
        run: |
          if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
            echo "value=${{ github.event.inputs.stellar_address }}" >> "$GITHUB_OUTPUT"
          else
            echo "value=GYOURDEFAULTORPARSEDADDRESS" >> "$GITHUB_OUTPUT"
          fi

      - uses: Stellar-TrustBridge/trustbridge-action@v1
        id: bridge
        with:
          stellar_address_input: ${{ steps.addr.outputs.value }}
          github_token: ${{ secrets.GITHUB_TOKEN }}

      - name: Log results
        run: |
          echo "trustline_exists=${{ steps.bridge.outputs.trustline_exists }}"
          echo "xlm_balance=${{ steps.bridge.outputs.xlm_balance }}"
          echo "account_funded=${{ steps.bridge.outputs.account_funded }}"
```

---

## Custom asset (non-USDC)

```yaml
with:
  stellar_address_input: ${{ steps.addr.outputs.value }}
  asset_code: EURC
  asset_issuer: GISSUERADDRESSHERE
  min_xlm_reserve: '2.0'
  github_token: ${{ secrets.GITHUB_TOKEN }}
```

---

## Testnet

Point Horizon at Stellar testnet:

```yaml
with:
  horizon_url: https://horizon-testnet.stellar.org
  asset_code: USDC
  asset_issuer: GTESTNETISSUER...
  stellar_address_input: GTESTNETADDRESS...
  github_token: ${{ secrets.GITHUB_TOKEN }}
  fail_on_missing: false
```

Use [Stellar Laboratory (testnet)](https://laboratory.stellar.org/#account-viewer?network=test) for test accounts.

---

## Warn instead of fail

For informational checks (e.g. onboarding reminders):

```yaml
with:
  fail_on_missing: false
  github_token: ${{ secrets.GITHUB_TOKEN }}
  stellar_address_input: ${{ steps.addr.outputs.value }}
```

The step succeeds with `core.warning()`; the issue comment still shows ❌ for failed checks.

## Debug mode and timeout

```yaml
with:
  github_token: ${{ secrets.GITHUB_TOKEN }}
  stellar_address_input: ${{ steps.addr.outputs.value }}
  debug_mode: true
  horizon_timeout_ms: 20000
```

- `debug_mode: true` enables extra action logs for troubleshooting.
- `horizon_timeout_ms` controls Horizon request timeout in milliseconds.

## Sticky comments across re-runs

```yaml
with:
  github_token: ${{ secrets.GITHUB_TOKEN }}
  stellar_address_input: ${{ steps.address.outputs.address }}
  sticky_comment: true   # default — update the previous comment instead of posting a new one
```

Set `sticky_comment: false` if you want a new comment posted on every run instead (e.g. for a full audit trail). See [Comment guide](COMMENT_GUIDE.md) for details on how the prior comment is located.

## Waiting for the account to be funded

```yaml
with:
  github_token: ${{ secrets.GITHUB_TOKEN }}
  stellar_address_input: ${{ steps.address.outputs.address }}
  wait_until_funded: true
  wait_until_funded_timeout_ms: 120000
  wait_until_funded_interval_ms: 5000
```

Use this when contributors are expected to fund their wallet right after assignment. The action polls `GET /accounts/{id}` every `wait_until_funded_interval_ms` until it stops 404ing or `wait_until_funded_timeout_ms` elapses, then proceeds exactly as it would for a single check (comment, outputs, `fail_on_missing`). Non-404 Horizon errors (rate limits, outages, timeouts) are not retried by the polling loop — the existing per-request retry/backoff in `horizon.ts` handles those, and if they're still failing after that, the run fails fast instead of continuing to poll.

## New output: `comment_url`

When the action runs in an issue context, it sets `comment_url` to the created GitHub comment URL.

```yaml
- name: TrustBridge check
  id: trustbridge
  uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ steps.address.outputs.address }}
    github_token: ${{ secrets.GITHUB_TOKEN }}

- name: Capture comment URL
  run: echo "Comment URL: ${{ steps.trustbridge.outputs.comment_url }}"
```

---

## Private Horizon mirrors

Enterprises running TrustBridge against their own Horizon mirror (instead of the public `https://horizon.stellar.org`) should be aware of the following:

- **HTTPS only.** `horizon_url`, `horizon_url_fallback`, and `rpc_fallback_url` must use `https://`. Plain `http://` endpoints are rejected before any connection is attempted — TrustBridge never weakens or skips TLS certificate verification, and there is no input to disable it.
- **SSRF-safe targets required.** The same URLs are rejected if they target a private IP range, loopback, link-local address, or a cloud metadata endpoint (`169.254.169.254`, `metadata.google.internal`), or use `file://`. This applies to the direct action inputs, not just values sourced from `.trustbridge.yml` (see [Consumer trustbridge.yml config file](../README.md#consumer-trustbridgeyml-config-file) for that layer's guarantees).
- **Certificate must be trusted by the runner.** Self-signed, expired, or otherwise untrusted certificates cause the run to fail with a distinct **"Horizon TLS / certificate verification"** check — this is reported separately from account/trustline failures so it is never mistaken for "the contributor's account isn't set up right."
- **Custom/private CA.** TrustBridge does not ship a custom CA bundle injection input in v1. If your mirror's certificate is signed by an internal CA, add a step before the TrustBridge step that sets `NODE_EXTRA_CA_CERTS` to point at a PEM file containing your CA chain:

  ```yaml
  - name: Trust internal CA
    run: echo "NODE_EXTRA_CA_CERTS=$GITHUB_WORKSPACE/internal-ca.pem" >> "$GITHUB_ENV"

  - uses: Stellar-TrustBridge/trustbridge-action@v1
    with:
      horizon_url: https://horizon.internal.example.com
      stellar_address_input: ${{ steps.address.outputs.address }}
      github_token: ${{ secrets.GITHUB_TOKEN }}
  ```

  Do **not** set `NODE_TLS_REJECT_UNAUTHORIZED=0` to work around a certificate problem — that disables TLS verification for the whole process. TrustBridge detects and warns loudly in the logs if it finds this set in the environment.
- **The comment hides your mirror's hostname by default.** Since a private Horizon mirror's hostname can itself be sensitive infrastructure information, the issue comment only shows the URL scheme (e.g. `https://•••`) unless `debug_mode: true` is set, in which case the full host is shown (the account address embedded in any Horizon URL is always masked regardless).

---

## Unauthorized trustline policy

Some issued assets set the issuer's `AUTHORIZATION_REQUIRED` flag, meaning a trustline can exist on an account without the issuer having authorized it yet — payments in that asset will fail until authorization happens, even though the trustline check alone would otherwise look green. Control how TrustBridge treats this with `unauthorized_trustline_policy`:

| Value | Behavior |
| ----- | -------- |
| `warn` (default) | Trustline check still passes; the comment adds a warning explaining the account needs issuer authorization. |
| `fail` | The trustline check does not pass. The `trustline_exists` output reflects this stricter meaning. |
| `ignore` | No additional check or warning — matches pre-#72 behavior. |

```yaml
with:
  stellar_address_input: ${{ steps.address.outputs.address }}
  github_token: ${{ secrets.GITHUB_TOKEN }}
  unauthorized_trustline_policy: fail
```

---

## Clawback-enabled asset warnings

If the configured asset's trustline has clawback enabled (the issuer can revoke balances from the account at any time), TrustBridge surfaces a warning in the comment by default. For security-sensitive workflows (e.g. gating bounty payouts), set `clawback_strict_mode: true` to fail the check instead of only warning:

```yaml
with:
  stellar_address_input: ${{ steps.address.outputs.address }}
  github_token: ${{ secrets.GITHUB_TOKEN }}
  clawback_strict_mode: true
```

Vanilla mainnet USDC (and any asset without clawback enabled) never triggers this warning — it is only raised when Horizon reports `is_clawback_enabled: true` on the matched trustline.

---

## Extracting Stellar addresses from issues

Common patterns:

### Issue template field

Parse a labeled line from the issue body:

```yaml
- name: Extract Stellar address
  id: stellar
  uses: actions/github-script@v7
  with:
    script: |
      const body = context.payload.issue?.body ?? '';
      const match = body.match(/Stellar address:\s*(G[A-Z2-7]{55})/i);
      if (!match) core.setFailed('No Stellar address found in issue body');
      core.setOutput('address', match[1]);
```

### Assignee-linked profile

Fetch a custom field or org profile via your own API step, then pass the result to `stellar_address_input`.

---

## Outputs in downstream jobs

```yaml
jobs:
  verify:
    runs-on: ubuntu-latest
    outputs:
      funded: ${{ steps.bridge.outputs.account_funded }}
    steps:
      - id: bridge
        uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: G...
          github_token: ${{ secrets.GITHUB_TOKEN }}

  payout:
    needs: verify
    if: needs.verify.outputs.funded == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: echo "Ready for payout pipeline"
```

---

## Pinning versions

| Reference | When to use |
| --------- | ------------- |
| `@v1` | Recommended for production (semver major) |
| `@main` | Latest development — use for testing only |
| `@abc1234` | Pin to commit SHA for maximum reproducibility |

---

## Permissions reference

```yaml
permissions:
  issues: write    # required for comments
  contents: read   # standard for checkout-less actions
```

If using `GITHUB_TOKEN`, no extra secret is required beyond workflow permissions.

---

## workflow_run chained triggers (#146)

Use `workflow_run` when you want TrustBridge to run as a trusted downstream job triggered by an upstream address-resolution workflow. This is common in organizations that separate the untrusted "read the issue" step from the trusted "validate and comment" step.

### Why use workflow_run instead of a direct issues: trigger?

| Scenario | Recommendation |
|----------|----------------|
| Simple: address in issue body, single repo | `issues: [assigned]` directly on the TrustBridge step |
| Complex: address from external API/bot, matrix payouts, fork trust isolation | `workflow_run` + artifact passing |

### Critical differences from a direct `issues:` trigger

1. **No issue context in `github.event`** — `workflow_run` events do not carry `github.event.issue`. You must pass the issue number from the upstream workflow via an artifact or repository variable.
2. **GITHUB_TOKEN has write access to the base repo** — correct for posting issue comments; safe even on fork-triggered `pull_request` or `issues` events.
3. **Re-runs are idempotent** — `sticky_comment: true` (default) ensures TrustBridge updates its existing comment rather than spamming the issue on each re-run.

### Required permissions

```yaml
permissions:
  issues: write      # post/update the TrustBridge comment
  contents: read     # standard
  actions: read      # download artifacts from the upstream run
```

### Passing the Stellar address between workflows

The upstream workflow uploads a JSON artifact; the downstream workflow reads it:

**Upstream (intake workflow):**
```yaml
- name: Upload TrustBridge inputs
  uses: actions/upload-artifact@v4
  with:
    name: trustbridge-inputs
    path: /tmp/trustbridge/inputs.json
    # inputs.json: {"stellar_address":"G...","issue_number":42}
```

**Downstream (TrustBridge workflow):**
```yaml
- uses: actions/download-artifact@v4
  with:
    name: trustbridge-inputs
    run-id: ${{ github.event.workflow_run.id }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
    path: /tmp/trustbridge
```

### Injecting issue context

Because `workflow_run` events have no `payload.issue`, you must patch the event file before TrustBridge runs:

```yaml
- uses: actions/github-script@v7
  with:
    script: |
      const fs = require('fs');
      const eventPath = process.env.GITHUB_EVENT_PATH;
      const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
      event.issue = { number: parseInt('${{ steps.inputs.outputs.issue }}', 10) };
      fs.writeFileSync(eventPath, JSON.stringify(event));
```

### GITHUB_TOKEN limitations across repos

`GITHUB_TOKEN` can only post comments on the **same repository** as the workflow file. For cross-repo comment posting (rare), use a PAT with `repo` scope or a GitHub App token.

### Troubleshooting "comment skipped" in workflow_run context

If TrustBridge warns "No issue context found — skipping comment", the most common causes are:

| Cause | Fix |
|-------|-----|
| `github.event.issue` not injected | Add the "Inject issue context" step above |
| `issue_number` is `NaN` or `0` | Verify your `jq` command extracts a valid integer |
| Token lacks `issues: write` | Add `permissions: issues: write` to the job |
| Upstream workflow was a `push` or PR event | Only `issues`-context runs have issue numbers; use `workflow_dispatch` for manual checks |

See the complete working example: [docs/examples/workflow_run_chained.yml](examples/workflow_run_chained.yml)

---

## Per-check env vars for payout jobs (#147)

For payout bots and matrix workflows, TrustBridge supports a `TRUSTBRIDGE_*` environment variable layer so you can configure asset and network settings without duplicating `with:` inputs across matrix legs.

### Precedence

```
with: input  >  TRUSTBRIDGE_* env var  >  action.yml default
```

An explicit `with:` value always wins. The env var is only consulted when the `with:` value is empty.

### Supported env vars

| Env var | Maps to input | Notes |
|---------|--------------|-------|
| `TRUSTBRIDGE_HORIZON_URL` | `horizon_url` | |
| `TRUSTBRIDGE_HORIZON_URL_FALLBACK` | `horizon_url_fallback` | |
| `TRUSTBRIDGE_RPC_FALLBACK_URL` | `rpc_fallback_url` | |
| `TRUSTBRIDGE_ASSET_CODE` | `asset_code` | |
| `TRUSTBRIDGE_ASSET_ISSUER` | `asset_issuer` | |
| `TRUSTBRIDGE_MIN_XLM_RESERVE` | `min_xlm_reserve` | |
| `TRUSTBRIDGE_FAIL_ON_MISSING` | `fail_on_missing` | `true`/`false` |
| `TRUSTBRIDGE_DEBUG_MODE` | `debug_mode` | |
| `TRUSTBRIDGE_HORIZON_TIMEOUT_MS` | `horizon_timeout_ms` | |
| `TRUSTBRIDGE_STICKY_COMMENT` | `sticky_comment` | |
| `TRUSTBRIDGE_WAIT_UNTIL_FUNDED` | `wait_until_funded` | |
| `TRUSTBRIDGE_WAIT_UNTIL_FUNDED_TIMEOUT_MS` | `wait_until_funded_timeout_ms` | |
| `TRUSTBRIDGE_WAIT_UNTIL_FUNDED_INTERVAL_MS` | `wait_until_funded_interval_ms` | |
| `TRUSTBRIDGE_HORIZON_CACHE_TTL_MS` | `horizon_cache_ttl_ms` | |
| `TRUSTBRIDGE_USE_CACHE` | `use_cache` | |
| `TRUSTBRIDGE_LOG_INPUTS` | `log_inputs` | |
| `TRUSTBRIDGE_PREFLIGHT_ONLY` | `preflight_only` | |

**Not supported** (intentionally excluded): `github_token`, `stellar_address_input`. These must always be supplied via explicit `with:` inputs. Never place token values in environment variables where they may be printed to job logs.

### Matrix payout example

```yaml
strategy:
  matrix:
    include:
      - asset_code: USDC
        asset_issuer: GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
        min_xlm_reserve: '1.5'
      - asset_code: EURC
        asset_issuer: GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP
        min_xlm_reserve: '2.0'

env:
  TRUSTBRIDGE_ASSET_CODE:    ${{ matrix.asset_code }}
  TRUSTBRIDGE_ASSET_ISSUER:  ${{ matrix.asset_issuer }}
  TRUSTBRIDGE_MIN_XLM_RESERVE: ${{ matrix.min_xlm_reserve }}
  TRUSTBRIDGE_FAIL_ON_MISSING: 'true'

steps:
  - uses: Stellar-TrustBridge/trustbridge-action@v1
    with:
      stellar_address_input: ${{ steps.addr.outputs.value }}
      github_token: ${{ secrets.GITHUB_TOKEN }}
      # asset_code, asset_issuer, min_xlm_reserve resolved from env vars above
```

See the full working example: [docs/examples/payout_matrix.yml](examples/payout_matrix.yml)

---

## issues:write preflight (#145)

TrustBridge automatically runs a **preflight check** before any Horizon calls to verify that the token can post issue comments. This prevents wasting Horizon API quota when permissions are misconfigured.

### What the preflight checks

1. **Issue context** — is there an issue number in the event payload? If not (e.g. `workflow_dispatch` without an issue), comment posting is silently skipped and Horizon runs normally.
2. **Token permission** — calls `GET /repos/{owner}/{repo}/issues/{number}/comments` (read-only). A 401 or 403 response fails the run immediately with a clear permission error before any Horizon work.

### Preflight-only mode

Set `preflight_only: true` to run only the permission check and exit without calling Horizon. Useful when setting up TrustBridge for the first time:

```yaml
- uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ steps.addr.outputs.value }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    preflight_only: true   # exits after permission check, no Horizon call
```

### Troubleshooting preflight failures

| Error | Cause | Fix |
|-------|-------|-----|
| `GitHub token lacks issues: write permission (403)` | Token scope too narrow | Add `permissions: issues: write` to the workflow job |
| `GitHub token is not authorized (401)` | Invalid or expired token | Verify the token / regenerate the PAT |
| `Issue #N was not found (404)` | Closed or deleted issue | Run the check on an open issue |

---

[← Back to README](../README.md)
