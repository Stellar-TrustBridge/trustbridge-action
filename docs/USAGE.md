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

## Soroban contract registry lookup

For programs that maintain an on-chain mapping of GitHub usernames to Stellar G-addresses via the `trustbridge-contract` registry, TrustBridge can resolve the address automatically before running Horizon checks.

### How it works

1. When `soroban_rpc_url`, `contract_id`, and `github_username` are all set, TrustBridge calls `get_address(github_username)` on the registry contract via `simulateTransaction`.
2. If the username is registered, the resolved G-address is used for all subsequent Horizon checks instead of `stellar_address_input`.
3. If the username is **not registered**, or the registry is **unavailable** (rate-limited, outage, timeout), TrustBridge logs a warning and falls back to `stellar_address_input` — existing workflows are never broken.

### Configuration

| Input | Required | Default | Description |
| ----- | -------- | ------- | ----------- |
| `soroban_rpc_url` | No | `''` | Soroban RPC endpoint (e.g. `https://soroban-testnet.stellar.org`). Leave empty to skip registry lookup. |
| `contract_id` | No | `''` | C-address of the `trustbridge-contract` registry. Required when `soroban_rpc_url` is set. |
| `github_username` | No | `''` | GitHub username to resolve. Falls back to `stellar_address_input` if not registered. |

### Example — resolve assignee address from registry

```yaml
- uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    github_username: ${{ github.event.assignee.login }}
    soroban_rpc_url: https://soroban-testnet.stellar.org
    contract_id: CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM
    stellar_address_input: ${{ steps.addr.outputs.value }}  # fallback
    github_token: ${{ secrets.GITHUB_TOKEN }}
```

### Rollout instructions

1. Deploy the `trustbridge-contract` registry to your target Stellar network.
2. Register contributor GitHub usernames via the contract's `set_address` function.
3. Add `soroban_rpc_url`, `contract_id`, and `github_username` to your workflow.
4. Keep `stellar_address_input` set as a fallback for contributors not yet registered.
5. Gradually migrate contributors to the registry; remove `stellar_address_input` once all are registered.

### Backward compatibility

All three inputs (`soroban_rpc_url`, `contract_id`, `github_username`) default to empty string. Existing workflows that do not set them are completely unaffected — the registry lookup is skipped entirely and the action behaves identically to previous versions.

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

[← Back to README](../README.md)
