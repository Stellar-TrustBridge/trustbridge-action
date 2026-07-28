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

## GitHub App token guide

Some organizations restrict the default `GITHUB_TOKEN` to prevent cross-repo access or to enforce finer-grained permissions. In these cases, use a **GitHub App installation token** instead.

### Why use a GitHub App token?

| Concern | `GITHUB_TOKEN` | GitHub App token |
|---------|---------------|------------------|
| Cross-repo access | Limited to the current repo | Can be scoped to specific repos |
| Permission granularity | Fixed per-event permissions | Customizable per-app |
| Org policy compliance | May be blocked by org settings | Allowed when app is installed |
| Token rotation | Automatic (short-lived) | Manual rotation required |

### Setup steps

1. **Create a GitHub App** in your organization or personal account:
   - Go to **Settings → Developer settings → GitHub Apps → New GitHub App**
   - Set the **Homepage URL** to your repo URL
   - Set the **Webhook URL** to a placeholder (not required for this use case)

2. **Grant permissions** to the App:
   - Under **Repository permissions**, grant:
     - **Issues**: `Read and write`
     - **Metadata**: `Read-only`
   - Under **Organization permissions**, grant only what is needed

3. **Install the App** on the target repository:
   - On the App settings page, click **Install** and select the repository

4. **Generate an installation access token** in your workflow:

```yaml
- name: Generate GitHub App token
  id: app-token
  uses: actions/create-github-app-token@v1
  with:
    app-id: ${{ secrets.GITHUB_APP_ID }}
    private-key: ${{ secrets.GITHUB_APP_PRIVATE_KEY }}
```

5. **Pass the token** to the action:

```yaml
- uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ steps.address.outputs.address }}
    github_token: ${{ steps.app-token.outputs.token }}
    fail_on_missing: true
```

### Security warnings

- **Do not log the token.** The action redacts `github_token` values in diagnostic output, but avoid printing it in workflow logs.
- **Rotate keys regularly.** GitHub App private keys should be rotated on a schedule. Delete old keys after generating new ones.
- **Use least privilege.** Grant only the permissions the App needs. The action requires `issues: write` to post comments.
- **Store secrets in GitHub Secrets.** Never commit private keys or App IDs to the repository.

### Events without issue context

When the action runs in a `workflow_dispatch` or `push` context (not an issue event), there is no issue to comment on. The action still performs all checks and sets outputs, but comment posting is skipped with a warning. This applies regardless of token type.

---

## Org-level policy inheritance

Integrators managing many repositories can centralize TrustBridge policy (asset, reserve, fail behavior) using **GitHub organization variables and secrets**, so child repos don't need to re-specify everything.

### Naming conventions

| Action input | Org variable/secret name | Description |
|-------------|--------------------------|-------------|
| `horizon_url` | `TRUSTBRIDGE_HORIZON_URL` | Horizon API base URL |
| `asset_code` | `TRUSTBRIDGE_ASSET_CODE` | Asset code for trustline verification |
| `asset_issuer` | `TRUSTBRIDGE_ASSET_ISSUER` | Issuer Stellar address |
| `min_xlm_reserve` | `TRUSTBRIDGE_MIN_XLM_RESERVE` | Minimum native XLM balance required |
| `fail_on_missing` | `TRUSTBRIDGE_FAIL_ON_MISSING` | `true` to fail, `false` to warn |
| `horizon_timeout_ms` | `TRUSTBRIDGE_HORIZON_TIMEOUT_MS` | Horizon request timeout |
| `sticky_comment` | `TRUSTBRIDGE_STICKY_COMMENT` | Update previous comment instead of posting new one |
| `wait_until_funded` | `TRUSTBRIDGE_WAIT_UNTIL_FUNDED` | Poll until account is funded |

### Reusable workflow example

Create `.github/workflows/trustbridge.yml` in the organization template repo:

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
      - name: TrustBridge check
        uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: ${{ inputs.stellar_address }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          horizon_url: ${{ vars.TRUSTBRIDGE_HORIZON_URL }}
          asset_code: ${{ vars.TRUSTBRIDGE_ASSET_CODE }}
          asset_issuer: ${{ vars.TRUSTBRIDGE_ASSET_ISSUER }}
          min_xlm_reserve: ${{ vars.TRUSTBRIDGE_MIN_XLM_RESERVE }}
          fail_on_missing: ${{ vars.TRUSTBRIDGE_FAIL_ON_MISSING }}
          horizon_timeout_ms: ${{ vars.TRUSTBRIDGE_HORIZON_TIMEOUT_MS }}
          sticky_comment: ${{ vars.TRUSTBRIDGE_STICKY_COMMENT }}
          wait_until_funded: ${{ vars.TRUSTBRIDGE_WAIT_UNTIL_FUNDED }}
```

### Override precedence

Explicit action inputs always win over org variable defaults. The precedence order is:

1. **Action input** (explicit value in the workflow step)
2. **Org variable** (set via `vars` or `secrets`)
3. **Default value** (the built-in default in `action.yml`)

This means a repo can override the org default by setting an explicit input, while repos that omit the input inherit the org-level policy.

### Using org secrets for sensitive values

For values that should not be visible in the repository settings UI (e.g., custom Horizon URLs with embedded tokens), use **GitHub Secrets** instead of Variables:

```yaml
horizon_url: ${{ secrets.TRUSTBRIDGE_HORIZON_URL }}
```

Secrets are masked in workflow logs and are not visible to repository collaborators.

### Org policy enforcement

GitHub organization rulesets can enforce that certain workflows use the centralized TrustBridge configuration. Mention this as a possibility — rulesets can require the `trustbridge.yml` config file or specific workflow inputs to be present, but TrustBridge itself does not enforce rulesets programmatically.

---

## Extracting Stellar addresses from issues
