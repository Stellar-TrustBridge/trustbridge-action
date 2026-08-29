# Usage guide

How to integrate **trustbridge-action** into your repository workflows.

Related docs: [README](../README.md) · [Architecture](ARCHITECTURE.md) · [Error handling](ERROR_HANDLING.md) · [Cron re-validation](CRON_REVALIDATION.md)

---

## Prerequisites

1. A GitHub repository with Actions enabled
2. A Stellar **G-address** to validate (contributor wallet)
3. Workflow permissions allowing issue/PR comments (`issues: write`) or discussion comments (`discussions: write` — see [GitHub Discussions — bounty threads](#github-discussions--bounty-threads-issue-221))

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

## Milestone gating

If you only want TrustBridge to run on issues assigned to a specific milestone (e.g. only run Horizon checks when assigned to `Wave 12`), use the `milestone_allowlist` input:

```yaml
      - uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: GCONTRIBUTORADDRESSHERE
          github_token: ${{ secrets.GITHUB_TOKEN }}
          milestone_allowlist: 'Wave 12,Wave 13'
```

- When the issue's milestone matches an entry in the list (case-insensitive), the action proceeds normally.
- When there is no match (or no milestone), the action safely skips execution and emits a summary note without posting a failure comment.
- If you prefer the step to explicitly fail instead of skipping gracefully, set `milestone_fail_on_skip: true`.

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

> **Note:** Comments are only posted when the workflow runs in an **issue**, **pull_request**, or **pull_request_target** context (or when `issue_number` is supplied for `workflow_dispatch`). For standalone `workflow_dispatch` without one of those, checks still run and outputs are set; comment posting is skipped with a warning.

---

## Pull request wallet checks (Issue #220)

TrustBridge can post (and sticky-upsert) its validation comment directly on a **pull request's conversation tab**, not just on issues. PRs are issues under the hood as far as GitHub's REST comment API is concerned, so the same `postIssueComment` path — sticky lookup, snooze, size limits — works unchanged; TrustBridge just needs the PR's number instead of an issue's.

```yaml
name: Verify Stellar wallet on PR

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  trustbridge:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      pull-requests: write
      contents: read
    steps:
      - uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: GCONTRIBUTORADDRESSHERE
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

### How it works

- On a `pull_request` (or `pull_request_target`) event, TrustBridge resolves the target from `github.event.pull_request.number` — `github.event.issue` is only populated for `issues`/`issue_comment` events, so relying on it alone silently skipped every PR before this fix.
- Only the numeric PR number is read from the event payload; the PR title/body are never inspected by TrustBridge and can't leak into comment content or Horizon requests.
- Sticky comments, snoozing, and truncation all behave identically to the issue path — nothing about the comment lifecycle changes for PRs.
- The `issues` event path is unchanged: when both `payload.issue` and `payload.pull_request` are present (an `issue_comment` event fired on a PR), TrustBridge keeps preferring `payload.issue.number`, matching its existing behaviour.

### Permissions

| Trigger | Required permission |
|---------|--------------------|
| `issues` events | `issues: write` |
| `pull_request` / `pull_request_target` events | `issues: write` (GitHub's REST API treats PR conversation comments as issue comments) |

> **Fork PRs:** on a plain `pull_request` trigger, GitHub gives the automatic `GITHUB_TOKEN` **read-only** access when the PR comes from a fork, regardless of the `permissions:` block above — so comment posting will fail with a 403 even though the preflight's read-only check can pass. If you need TrustBridge to comment on fork PRs, use `pull_request_target` instead, and review [GitHub's security guidance](https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/) first, since `pull_request_target` runs with the base branch's workflow file and a token that has write access even for untrusted fork code.

---

## GitHub Discussions — bounty threads (Issue #221)

Some projects run their bounty program from **GitHub Discussions** instead of issues. TrustBridge can post (and sticky-upsert) its validation comment there too.

```yaml
name: Verify Stellar wallet on discussion activity

on:
  discussion:
    types: [created, category_changed]

jobs:
  trustbridge:
    runs-on: ubuntu-latest
    permissions:
      discussions: write   # required — GraphQL path, not issues: write
      contents: read
    steps:
      - uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: GCONTRIBUTORADDRESSHERE
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

### How it works

- Discussion events carry a **GraphQL node id** (e.g. `DIC_…`), **not an issue number**. The REST issues API 404s on a discussion id — or, worse, comments on the wrong issue when the id happens to be numeric.
- When `github.event_name` is a discussion event, TrustBridge posts the comment through the GitHub **GraphQL API** (`addDiscussionComment` / `updateDiscussionComment` mutations) instead of the REST issues API.
- **Sticky comments work the same way as issues**: with `sticky_comment: true` (default), the previous TrustBridge comment on the discussion is found (paginated via GraphQL) and updated in place.
- The issue and PR comment paths (see [Pull request wallet checks](#pull-request-wallet-checks-issue-220)) are **unchanged**; the discussion path is only taken for discussion events.

### Permissions

| Target | Required permission |
|--------|--------------------|
| Issue / PR comments (REST) | `issues: write` (add `pull-requests: write` too for PR triggers, per [Pull request wallet checks](#pull-request-wallet-checks-issue-220)) |
| Discussion comments (GraphQL) | `discussions: write` |

> **Note:** the repository must have the **Discussions** feature enabled. Discussion polls, and converting a discussion → issue mid-flight, are intentionally out of scope.

---

## GitHub App authentication for org-wide triage (Issue #225)

When running TrustBridge across an entire organization or in centralized triage repositories, `GITHUB_TOKEN` is constrained to the repository executing the workflow. You can authenticate using a **GitHub App installation token** via the `github_app_token` input.

```yaml
name: Verify Stellar wallet via GitHub App

on:
  issues:
    types: [assigned]

jobs:
  trustbridge:
    runs-on: ubuntu-latest
    steps:
      - name: Generate GitHub App token
        id: app-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ vars.TRUSTBRIDGE_APP_ID }}
          private-key: ${{ secrets.TRUSTBRIDGE_APP_PRIVATE_KEY }}

      - uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: GCONTRIBUTORADDRESSHERE
          github_app_token: ${{ steps.app-token.outputs.token }}
```

### Security & Tradeoff: Pre-minted token vs. embedding PEM private keys
- **Pre-minted token preferred**: TrustBridge intentionally accepts a pre-minted installation token (`github_app_token`) rather than requiring raw PEM private keys and `app_id` to be embedded inside this action.
- **Principle of Least Privilege**: Generating short-lived installation tokens (typically expiring in 1 hour) via dedicated actions like `actions/create-github-app-token` isolates cryptographic signing credentials and avoids persisting long-lived private keys inside downstream action runtimes.
- **Credential redaction**: Any token or key value passed to TrustBridge is registered with GitHub Actions secret masking (`core.setSecret`) and stripped by the logger (`[REDACTED]`) to prevent accidental disclosure.
- **Enterprise compatibility**: Works automatically on GitHub Enterprise Server (`baseUrl` is derived from GitHub runner context `apiUrl`).
- **Same comment APIs**: Whether using `github_token` or `github_app_token`, all sticky comment lookups, GraphQL discussions, and upsert features operate identically.

---

## Combined trigger (assigned + manual)

Matches the action design target. Use `issue_number` on `workflow_dispatch` runs to target a specific issue for the result comment (Wave #29):

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
        description: 'Issue number to post result on (manual runs only)'
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
          issue_number: ${{ github.event.inputs.issue_number }}
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
  min_asset_balance: '100'
  min_xlm_reserve: '2.0'
  github_token: ${{ secrets.GITHUB_TOKEN }}
```

---

## Testnet campaign presets

Run dry Waves or onboard contributors on Stellar testnet using first-class campaign presets (`network: testnet` or `preset: testnet`):

```yaml
with:
  network: testnet
  stellar_address_input: GTESTNETADDRESS...
  github_token: ${{ secrets.GITHUB_TOKEN }}
```

Using `network: testnet` automatically populates:
- **Horizon URL:** `https://horizon-testnet.stellar.org`
- **Asset Code:** `USDC`
- **Asset Issuer:** `GBBD47IF6LWK2P7MDEVSCWR7DPUWV3NY3DTQEVFL4TWVC5GIOTASHEX2` (Circle Testnet USDC issuer)
- **Minimum XLM Reserve:** `1.5`

> **Network safety validation:**
> TrustBridge validates network compatibility before fetching account data. Combining a testnet Horizon endpoint with a mainnet asset issuer (e.g. mainnet USDC `GA5ZSEJY...`) fails fast with an explicit error to prevent accidental configuration errors.

---

## Canary & secondary endpoint failover

To protect Wave validation jobs against transient Horizon regional or provider outages, configure a secondary failover Horizon URL:

```yaml
with:
  horizon_url: https://horizon.stellar.org
  secondary_horizon_url: https://horizon-canary.stellar.org
  stellar_address_input: ${{ steps.addr.outputs.value }}
  github_token: ${{ secrets.GITHUB_TOKEN }}
```

- **Failover behavior:** When the primary Horizon URL fails after exponential retries due to a retryable error (HTTP 5xx, 429 rate limits, or network timeout), TrustBridge transparently attempts the secondary Horizon URL before declaring failure.
- **Definitive 404s skipped:** If Horizon returns a 404 (account missing / not funded), failover is skipped immediately because 404 is a non-retryable account state, not a transport outage.
- **Cross-network guard:** Failover between different networks (e.g. mainnet to testnet) is disabled by default (`allow_cross_network_fallback: false` / `allow_cross_network_failover: false`) to avoid silent network context shifts. Set `allow_cross_network_fallback: true` to opt into cross-network fallback anyway.
- **Observability:** Issue comments and debug logs reflect whether the primary or secondary Horizon base URL served the response.

### Cross-network mismatch detection (Issue #266)

When Horizon returns 404 for the configured `horizon_url`, TrustBridge deterministically probes the **canonical opposite network** (`https://horizon.stellar.org` ↔ `https://horizon-testnet.stellar.org`) with a 5s timeout to see if the same `G…` address is funded elsewhere:

- `404` on public + `200` on testnet (or reverse) → comment shows a clear mismatch: “was not found on **public** but **is active on testnet** (https://horizon-testnet.stellar.org) — ensure `horizon_url` points at the correct network.” Remediation suggests either funding on the configured network or updating `horizon_url` to the opposite canonical URL.
- `404` on both networks → genuinely unfunded, no mismatch hint.
- Opposite returns `503/429/500` or network error/timeout → no hint (avoids false positives when the other Horizon is temporarily unavailable).
- The opposite URL is SSRF-validated; an invalid URL never gets probed.

This probe is **bounded and allowlisted** — only the two canonical Horizons are ever checked. Arbitrary `horizon_url_fallback` / `secondary_horizon_url` values are **never** probed here; falling back to a user-supplied URL on a different network is gated by `allow_cross_network_fallback` in `src/horizon.ts` (never cross-network unless you opt in). That keeps behavior deterministic and prevents an extra network probe from being treated as a fallback.

```yaml
with:
  horizon_url: https://horizon.stellar.org   # configured as public
  # fallback on a different network is disabled by default:
  secondary_horizon_url: https://horizon-testnet.stellar.org
  allow_cross_network_fallback: false  # default — mismatch hint still shown, but fallback not used
```

Both directions are tested (public→testnet and testnet→public).

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

---

## fail_on_missing patterns: Contributor vs. Maintainer gates (Issue #142)

TrustBridge provides two modes to match the workflow's trust model:

| Mode | `fail_on_missing` | When to use | Behavior on failure |
|------|-------------------|-------------|-------------------|
| **Hard-fail (maintainer gate)** | `true` (default) | Maintainer audit job or bounty payout (high trust, all checks must pass) | Workflow fails; requires manual intervention to proceed |
| **Warn-only (contributor-friendly)** | `false` | Contributor assignment workflow (low friction, guidance over blocking) | Workflow continues; contributor gets warning comment with remediation steps |

### Contributor-friendly assignment workflow

When assigning issues to contributors, use `fail_on_missing: false` to avoid blocking the assignment if the wallet isn't yet ready:

```yaml
name: Assign and check wallet (non-blocking)

on:
  issues:
    types: [assigned]

jobs:
  check-wallet:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      contents: read
    steps:
      - name: Extract address
        id: addr
        run: echo "value=GYOURCONTRIBUTORADDRESSHERE" >> "$GITHUB_OUTPUT"

      - name: TrustBridge check
        uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: ${{ steps.addr.outputs.value }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          fail_on_missing: false   # don't fail; contributor can set up wallet afterward
```

**Result:**
- ✓ Issue assignment succeeds regardless of wallet status.
- ✓ Comment posted with clear remediation steps (fund account, add trustline, etc.).
- ✓ Contributor has a roadmap but isn't blocked.

### Maintainer-only payout audit workflow

For sensitive operations (bounty payouts, grants), use `fail_on_missing: true` to gate on strict wallet readiness:

```yaml
name: Bounty payout audit (maintainer gate)

on:
  workflow_dispatch:
    inputs:
      stellar_address:
        description: Contributor's Stellar address
        required: true

jobs:
  verify-and-payout:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      contents: read
    steps:
      - name: TrustBridge check
        uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: ${{ github.event.inputs.stellar_address }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          fail_on_missing: true    # hard-fail if wallet not ready
          min_xlm_reserve: '10'    # bounty threshold
          sticky_comment: true

      - name: Initiate payout
        run: |
          # Only runs if TrustBridge checks passed
          echo "Initiating payout to ${{ github.event.inputs.stellar_address }}"
          # your payout script here
```

**Result:**
- ✓ Workflow hard-fails if wallet is unfunded, missing trustline, or low on reserve.
- ✓ Prevents accidental mis-sends or stuck funds.
- ✓ Maintainer gets clear error message and comment explaining why.

### Bounty workflow with label gate + hard-fail

Combine the [label gate pattern](LABEL_GATE_DESIGN.md) with `fail_on_missing: true` to validate only when a `bounty` label is explicitly set:

```yaml
name: Verify Stellar wallet (label gate + hard-fail)

on:
  issues:
    types: [assigned]

jobs:
  trustbridge-gated:
    runs-on: ubuntu-latest
    permissions:
      issues: read
      issues: write
      contents: read
    steps:
      - name: TrustBridge with label gate
        id: gate
        uses: Stellar-TrustBridge/trustbridge-action/.github/actions/trustbridge-label-gate@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          stellar_address_input: GYOURCONTRIBUTORADDRESSHERE
          gate_labels: 'bounty'            # only validate if "bounty" label is present
          post_skip_comment: 'true'        # let contributor know why validation skipped
          fail_on_missing: 'true'          # hard-fail when gate is open

      - name: Process bounty
        if: steps.gate.outputs.gate_skipped != 'true' && steps.gate.outputs.account_funded == 'true'
        run: echo "✓ Ready for payout"

      - name: Alert on gate skip
        if: steps.gate.outputs.gate_skipped == 'true'
        run: echo "ℹ️  Add the 'bounty' label to trigger wallet validation"
```

**Result:**
- ✓ Assignment without `bounty` label: validation skipped, skip notice posted.
- ✓ Assignment with `bounty` label: validation runs, workflow hard-fails if wallet not ready.
- ✓ Different workflows can have different gates and thresholds (see [`trustbridge-label-gate-branching.yml`](examples/trustbridge-label-gate-branching.yml) for per-label rules).

### Key behavioral guarantees (test-documented)

| Scenario | `fail_on_missing=true` | `fail_on_missing=false` |
|----------|----------------------|------------------------|
| **All checks pass** | ✓ Step succeeds | ✓ Step succeeds |
| **Checks fail** | ✗ `core.setFailed()` — step fails, workflow fails | ⚠️ `core.warning()` — step succeeds, workflow continues |
| **Default** | Yes (safe by default) | — |

These guarantees are verified by comprehensive test matrix in [`__tests__/fail_on_missing.benchmark.test.ts`](../__tests__/fail_on_missing.benchmark.test.ts).

---

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

## Onboarding checklist (default on)

```yaml
with:
  github_token: ${{ secrets.GITHUB_TOKEN }}
  stellar_address_input: ${{ steps.address.outputs.address }}
  onboarding_checklist: true   # default — include live fund → trustline → balance checklist
```

The checklist section uses GitHub Markdown task-list checkboxes that reflect live Horizon validation (`accountFunded`, `trustlineExists`, `xlmReserveMet`) and links to [TROUBLESHOOTING.md](TROUBLESHOOTING.md) FAQ anchors. Set `onboarding_checklist: false` to omit it.

## Auto-unassign on not-ready (Issue #228)

Maintainers can opt into automatically unassigning the issue assignee if their Stellar wallet readiness checks fail:

```yaml
with:
  github_token: ${{ secrets.GITHUB_TOKEN }}
  stellar_address_input: ${{ steps.address.outputs.address }}
  unassign_on_not_ready: true   # default false (opt-in policy)
```

### Policy behavior
- **Opt-in only**: Default is `false`. When disabled, assignees are never modified.
- **Trigger**: Runs only when `ready: false` (one or more readiness checks fail).
- **Outage protection**: Does not unassign contributors on transient Horizon network/outage errors (`HORIZON_ERROR`, `HORIZON_TIMEOUT`, `TLS_ERROR`).
- **Bot filtering**: Bot assignees (`type: Bot` or ending in `[bot]`) are ignored.
- **Permissions**: Requires `issues: write` permission on `github_token`. If permission is missing or an API error occurs, a non-fatal warning is logged and the workflow proceeds without crashing.
- **Workflow dispatch safety**: Safely skips when there is no issue context (e.g. manual dispatch without an issue).

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

## Action outputs

### `comment_url`

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

### Readiness badge outputs

The action exposes badge snippets suitable for embedding in READMEs or dashboards:

- **`readiness_badge_markdown`** — Markdown-formatted badge with link to TrustBridge repository
- **`readiness_badge_url`** — Plain Shields.io badge URL reflecting wallet-check status (pass/fail)

#### Embedding in README

Add the badge to your repository README using the Markdown output:

```yaml
- name: TrustBridge check
  id: trustbridge
  uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ steps.address.outputs.address }}
    github_token: ${{ secrets.GITHUB_TOKEN }}

- name: Update README with badge
  run: |
    # Example: update README with the latest badge status
    echo "Badge: ${{ steps.trustbridge.outputs.readiness_badge_markdown }}" >> README.md
```

#### Example badge output

**Pass state:** [![TrustBridge](https://img.shields.io/badge/trustbridge-Ready-brightgreen)](https://github.com/Stellar-TrustBridge/trustbridge-action)

**Fail state:** [![TrustBridge](https://img.shields.io/badge/trustbridge-Not%20Ready-red)](https://github.com/Stellar-TrustBridge/trustbridge-action)

The badge reflects the validation result without exposing PII (addresses, balances, or asset details).

### Sponsorship outputs

The action exposes sponsorship relationship counts from the Stellar Horizon API when available:

- **`num_sponsoring`** — Number of accounts this account is sponsoring (numeric string)
- **`num_sponsored`** — Number of accounts sponsoring this account (numeric string)

#### Using sponsorship outputs in workflows

Sponsorship outputs are useful for understanding reserve requirements and sponsorship relationships:

```yaml
- name: TrustBridge check
  id: trustbridge
  uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ steps.address.outputs.address }}
    github_token: ${{ secrets.GITHUB_TOKEN }}

- name: Check sponsorship status
  run: |
    echo "Sponsoring: ${{ steps.trustbridge.outputs.num_sponsoring }} accounts"
    echo "Sponsored by: ${{ steps.trustbridge.outputs.num_sponsored }} accounts"
```

When an account is **sponsored** (`num_sponsored > 0`), reserve requirements are covered by the sponsoring account. The TrustBridge comment will automatically note this and provide links to Stellar sponsorship documentation for clarity.

### Claimable balances and funded definition (Issue #260)

By default, **funded** means Horizon `GET /accounts/{id}` returned `200`. Claimable balances are **ignored**:

- An address that has `0` native XLM but has claimable balances on Horizon still shows *“not found / unfunded”* and gets the unfunded remediation (fund + trustline). No extra Horizon request is made, so there is no extra request budget impact. Empty claimables (`0`) are treated as “no hint” in either mode.

To surface claimable balances without changing the `ready` gate, set `claimable_balance_policy: count`:

```yaml
with:
  stellar_address_input: ${{ steps.addr.outputs.value }}
  github_token: ${{ secrets.GITHUB_TOKEN }}
  claimable_balance_policy: count   # default is "ignore"
```

Then, when the account is `404` but Horizon reports claimable balances for the claimant, the comment adds: *“It has N claimable balance(s) — these must be claimed after funding”* and the remediation includes the `claimable_balances?claimant=` Horizon link. The check is informational — `account_funded` stays `false` and `ready` is not set true unless you explicitly gate on it. The extra `GET /claimable_balances?claimant=…&limit=5` request is bounded to 5s and is only made when `count` is set.

Policy is tested for both `ignore` (default, no hint) and `count` (hint when >0, no hint when 0).

### SEP-0010 challenge proof (Issue #252)

Proving wallet control beats “please add a trustline” copy-paste. Comments already have SEP-0007 links for funding. You can optionally include a SEP-0010 challenge proof:

```yaml
with:
  stellar_address_input: ${{ steps.addr.outputs.value }}
  github_token: ${{ secrets.GITHUB_TOKEN }}
  # Prefer a dashboard Freighter proof link (no nonce in the issue):
  sep0010_dashboard_url: https://your-dashboard.example/verify?address=G...
  # Or, if you must, a raw challenge XDR (truncated in the comment, do not reuse nonce):
  # sep0010_challenge_xdr: AAAA...
```

- When `sep0010_dashboard_url` (https, not private/loopback) is set, the comment shows *“Proof of wallet control (SEP-0010) — [Open dashboard proof](url)”* with network context. This is the preferred mode.
- When only `sep0010_challenge_xdr` is set, the comment shows a truncated `24…8` XDR snippet with signing instructions and a link to SEP-0010. Raw nonces are truncated in the comment and never logged; do not reuse a challenge.
- If both are set, the dashboard link wins (no raw XDR rendered).
- The snippet is informational and **does not block `ready`** unless your workflow explicitly gates on it. It is size-capped; if the total comment exceeds GitHub’s 65k limit, the remediation truncation keeps the snippet.

See `docs/COMMENT_GUIDE.md` for snapshot examples and comment-size guidance.

### Split native XLM vs trustline balance (Issue #246)

Maintainers can now tell “has USDC but no XLM” from the inverse. The comment’s `### Balances` section and outputs now distinguish native vs asset:

**Comment:**
```md
### Balances
- **Native XLM balance:** `10.0000000 XLM`
- **Minimum required (XLM reserve):** `1.5 XLM` (protocol minimum `1.5 XLM` from 1 subentries/sponsorship, configured floor `1.5 XLM`)
- **USDC trustline balance:** `100.0000000 USDC` (limit `1000.0000000 USDC`) — or `0 USDC — no trustline`
```

- `Native XLM balance` is the raw Horizon native balance string (7 decimals, `0` / `_unknown_` on error paths).
- `USDC trustline balance` is the asset balance for the configured `asset_code`/`asset_issuer` (7 decimals). When the trustline is missing, it shows `0 … — no trustline`; when Horizon is unreachable, `_unknown_`; when `0` balance trustline exists, `0.0000000`.
- Limits are shown when available (Issue #140).

**Outputs (non-breaking additions):**
| Output | Description |
|--------|-------------|
| `asset_balance` | Configured asset balance (7-decimal Horizon string, `0` if no trustline, `unknown` on error) |
| `native_balance` | Alias of `xlm_balance` (native XLM, 7 decimals) |

`xlm_balance`, `trustline_exists`, `account_funded`, `checks_json`, `comment_url` etc. are unchanged. Balance parsing follows `docs/DECIMAL_PRECISION.md` — 7-decimal stroops, `BigInt` for maximum precision.

---

## Validating your workflow config against the schema

TrustBridge publishes a [JSON Schema](../schemas/action-inputs.schema.json)
for all `action.yml` inputs at `schemas/action-inputs.schema.json`. Integrators
can validate their `with:` block in CI to catch typos, removed inputs, or
type mismatches **before** they cause silent runtime failures on assignment day.

### What the schema enforces

- Every property matches a declared `action.yml` input.
- All values are typed as `"string"` (GitHub Actions passes all inputs as strings).
- `additionalProperties: false` — unknown keys are rejected immediately.
- `required: ["github_token"]` — the one mandatory input is enforced.

### Validate with ajv-cli (Node)

```bash
# Install once
npm install --save-dev ajv-cli

# Create a sample config file — mirrors your workflow's `with:` block
cat > my-trustbridge-config.json << 'EOF'
{
  "github_token": "${{ secrets.GITHUB_TOKEN }}",
  "stellar_address_input": "GABC...",
  "fail_on_missing": "true",
  "horizon_url": "https://horizon.stellar.org"
}
EOF

# Validate against the schema
npx ajv-cli validate \
  -s schemas/action-inputs.schema.json \
  -d my-trustbridge-config.json
```

### Validate with check-jsonschema (Python)

```bash
pip install check-jsonschema

check-jsonschema \
  --schemafile schemas/action-inputs.schema.json \
  my-trustbridge-config.json
```

### Add it to your CI workflow

```yaml
- name: Validate TrustBridge config against schema
  run: |
    npm install --save-dev ajv-cli
    npx ajv-cli validate \
      -s schemas/action-inputs.schema.json \
      -d ci/trustbridge-config.json
```

This step fails immediately if you add an unrecognised input or remove a
required field, giving a clear error message before the action ever runs.

### Schema location

The schema is published alongside the action source and is always in sync
with `action.yml`. The sync is enforced by:

1. A Jest test suite (`__tests__/action-schema-sync.test.ts`) that parses
   `action.yml` at runtime and asserts every input appears in the schema and
   vice-versa. CI fails on any drift.
2. A dedicated CI step (`Verify action.yml ↔ schema sync`) that runs
   `npm test -- --testPathPattern action-schema-sync` on every push and PR.

See [CONTRIBUTING.md](../CONTRIBUTING.md#keeping-the-schema-in-sync-with-actionyml)
for the update checklist maintainers follow when adding or changing inputs.

---

## Ledger freshness guard

The freshness guard detects when a Horizon node is serving stale data by
comparing the latest ingested ledger close time to the current wall clock.

**Disabled by default** — set `check_ledger_freshness: true` to enable.

```yaml
with:
  stellar_address_input: ${{ steps.addr.outputs.value }}
  github_token: ${{ secrets.GITHUB_TOKEN }}
  check_ledger_freshness: true
  max_ledger_lag_seconds: 60        # warn if Horizon is >60 s behind
  ledger_freshness_fail_on_stale: false   # false = warn only (default)
```

When `ledger_freshness_fail_on_stale: true` is set, a stale node causes the
action to hard-fail before running any account checks.

The guard fetches `GET <horizon_url>/` and reads
`history_latest_ledger_closed_at`. If the value is missing or unparseable,
the guard emits a warning and proceeds (fail-open) — a Horizon outage won't
cause a silent false-pass.

Freshness lag and latest ledger sequence are recorded as metrics
(`freshness_lag_seconds`, `freshness_latest_ledger`) and visible in the
`debug_mode: true` metrics JSON artifact.

---

## Handling oversized reports

Long remediation sections (multi-check failures, expert diagnostics, batch results) can push the comment body past GitHub's 65,536-byte limit. When that happens, TrustBridge automatically:

1. Writes the **full** validation report to a workspace file (`trustbridge-report.md` by default).
2. Posts a **truncated** comment with a notice explaining where to find the full report.
3. Sets the `full_report_path` output to the absolute path of the written file.

The file is only written when the body exceeds the limit — normal short comments are unchanged.

### Uploading the report as a workflow artifact

Add an `actions/upload-artifact` step **after** the TrustBridge step to make the full report available for download from the Actions run summary:

```yaml
jobs:
  trustbridge:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      contents: read
    steps:
      - name: TrustBridge check
        id: trustbridge
        uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: ${{ steps.addr.outputs.value }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          # Optional: customise where the full report is written
          report_output_path: trustbridge-report.md

      - name: Upload full validation report
        if: steps.trustbridge.outputs.full_report_path != ''
        uses: actions/upload-artifact@v4
        with:
          name: trustbridge-full-report
          path: ${{ steps.trustbridge.outputs.full_report_path }}
          retention-days: 7
```

The `if:` condition means the upload step is skipped entirely on normal runs where the comment fit within the limit.

### Configuring the report path

Use the `report_output_path` input to change where the file is written:

```yaml
with:
  report_output_path: reports/trustbridge-${{ github.run_id }}.md
```

Intermediate directories are created automatically. The path can be workspace-relative or absolute.

### Outputs added by this feature

| Output | Description |
| ------ | ----------- |
| `full_report_path` | Absolute path of the written report file, or empty string when no file was written |

---

## Extracting Stellar addresses from issues

Common patterns:

### Automatic extraction via `extract_address_from_issue`

Parse a labeled line from a free-form Markdown issue body (classic `.md`/`.yml` issue templates, or any issue where contributors paste an address in a known format):

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

### Assignee → address roster map (`assignee_address_map`)

When wallets are stored out-of-band (org variable, private roster file, Actions secret), pass a JSON map of **GitHub username → Stellar G-address**. TrustBridge reads the assignee login from the GitHub event context (`payload.assignee` on `issues.assigned`, otherwise the first issue assignee) and resolves the address **before** calling Horizon — no issue-body parsing required.

**Inline JSON** (small public rosters or values injected from a secret):

```yaml
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
          github_token: ${{ secrets.GITHUB_TOKEN }}
          # Prefer injecting from a secret/org variable rather than hard-coding:
          assignee_address_map: ${{ vars.STELLAR_ASSIGNEE_ROSTER }}
          # Example shape: {"alice":"GABC...","bob":"GDEF..."}
```

**JSON file path** (checked out in the job workspace):

```json
{
  "alice": "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  "bob": "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H"
}
```

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: Stellar-TrustBridge/trustbridge-action@v1
    with:
      github_token: ${{ secrets.GITHUB_TOKEN }}
      assignee_address_map: rosters/wallets.json
```

Usernames are matched **case-insensitively**. When the map is set, `stellar_address_input` is not required. Missing assignees fail with an actionable error; invalid G-addresses still go through the existing address validation before Horizon.

> **Security:** Do **not** commit private or sensitive rosters to a public repository. Prefer GitHub Actions secrets / org variables, a private repo path, or a checkout of a restricted artifact. Public exposure of username↔wallet links can deanonymize contributors.

---

## Per-check named outputs (fine-grained gating)

In addition to the legacy `account_funded` and `trustline_exists` outputs,
TrustBridge exposes three named per-check outputs that map one-to-one onto
the internal validation checks:

| Output | Type | Description |
|--------|------|-------------|
| `check_account_funded` | `'true'`/`'false'` | Account exists and is funded on Stellar |
| `check_trustline` | `'true'`/`'false'` | Trustline for `asset_code`/`asset_issuer` is present |
| `check_xlm_reserve` | `'true'`/`'false'` | Native XLM ≥ `min_xlm_reserve` |

These are backward-compatible additions — all existing `account_funded`,
`trustline_exists`, and `xlm_balance` outputs continue to work unchanged.

### Branching workflow: allow funded-but-trustline-pending path

A common pattern is to let contributors proceed when the account is funded
even if the trustline is not yet set up (e.g. to unblock an issue assignment
while the contributor completes wallet configuration):

```yaml
- name: TrustBridge check
  id: tb
  uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ steps.addr.outputs.value }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    fail_on_missing: false   # don't hard-fail; we branch on outputs below

- name: Full payout path — all checks passed
  if: >
    steps.tb.outputs.check_account_funded == 'true' &&
    steps.tb.outputs.check_trustline == 'true' &&
    steps.tb.outputs.check_xlm_reserve == 'true'
  run: echo "Ready for immediate payout"

- name: Funded but trustline or reserve pending — assign but hold payment
  if: >
    steps.tb.outputs.check_account_funded == 'true' &&
    (steps.tb.outputs.check_trustline != 'true' ||
     steps.tb.outputs.check_xlm_reserve != 'true')
  run: echo "Account active — awaiting trustline/reserve setup before payout"

- name: Account not funded — block assignment
  if: steps.tb.outputs.check_account_funded != 'true'
  run: |
    echo "Contributor wallet not yet funded — blocking assignment"
    exit 1
```

### Reserve-only gating

Gate a step purely on whether the XLM reserve is met, independent of the
trustline check:

```yaml
- name: Assert reserve met
  if: steps.tb.outputs.check_xlm_reserve != 'true'
  run: |
    echo "XLM reserve not met (balance: ${{ steps.tb.outputs.xlm_balance }})"
    exit 1
```

---

## Outputs in downstream jobs

TrustBridge exposes both legacy outputs and comprehensive audit & timing metadata for downstream automation, payout gating, and compliance monitoring.

### Available Action Outputs

| Output | Type | Description |
|---|---|---|
| `ready` | `boolean` (`"true"`/`"false"`) | **Overall readiness gate**: `true` when all validation checks pass, `false` otherwise. Ideal for `if:` condition in downstream payout jobs. |
| `validated_at` | `string` | ISO 8601 UTC timestamp of when validation occurred. |
| `horizon_url` | `string` | Horizon endpoint base URL used for account queries. |
| `asset_code` | `string` | Asset code checked (e.g. `USDC`). |
| `asset_issuer` | `string` | Asset issuer Stellar G-address checked. |
| `reason_code` | `string` | Machine-readable failure classification code (see Catalog below). |
| `checks_json` | `string` (JSON) | Array of check objects: `[{"label": "...", "passed": true, "detail": "..."}]`. |
| `timings_json` | `string` (JSON) | Execution timing breakdown object in milliseconds. |
| `timing_input_parse_ms` | `string` | Input parsing phase latency in milliseconds. |
| `timing_horizon_fetch_ms` | `string` | Horizon API query latency in milliseconds. |
| `timing_checks_ms` | `string` | Account checks evaluation latency in milliseconds. |
| `timing_comment_post_ms` | `string` | Issue comment posting latency in milliseconds. |
| `timing_total_ms` | `string` | Total action execution duration in milliseconds. |
| `trustline_exists` | `string` (legacy) | Whether the account holds a trustline for the asset (`"true"`/`"false"`). |
| `xlm_balance` | `string` (legacy) | Native XLM balance as reported by Horizon. |
| `account_funded` | `string` (legacy) | Whether the account exists on the ledger (`"true"`/`"false"`). |
| `comment_url` | `string` (legacy) | Created/updated issue comment URL. |
| `full_report_path` | `string` (legacy) | Workspace path to full report when comment body exceeded size limits. |

### Failure Reason Code Catalog (`reason_code`)

| Reason Code | Description |
|---|---|
| `SUCCESS` | All checks passed successfully. |
| `ACCOUNT_NOT_FUNDED` | Account was not found on Horizon (404 / unfunded). |
| `TRUSTLINE_MISSING` | Account exists but is missing a trustline for the specified asset. |
| `TRUSTLINE_UNAUTHORIZED` | Trustline exists but is not authorized by the issuer. |
| `TRUSTLINE_LIMIT_TOO_LOW` | Trustline limit is below `min_trustline_limit`. |
| `RESERVE_TOO_LOW` | XLM balance does not meet the reserve requirement floor or protocol minimum. |
| `HORIZON_TIMEOUT` | Horizon API request timed out before returning a response. |
| `HORIZON_ERROR` | Horizon API returned an HTTP error (5xx or non-404 4xx). |
| `TLS_ERROR` | Transport-layer TLS/certificate verification failed connecting to Horizon. |
| `INVALID_ADDRESS` | Provided Stellar address failed StrKey format/checksum validation. |

### Example — Downstream Payout Gating

```yaml
jobs:
  verify:
    runs-on: ubuntu-latest
    outputs:
      ready: ${{ steps.bridge.outputs.ready }}
      reason: ${{ steps.bridge.outputs.reason_code }}
      checks: ${{ steps.bridge.outputs.checks_json }}
    steps:
      - id: bridge
        uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: G...
          github_token: ${{ secrets.GITHUB_TOKEN }}

  payout:
    needs: verify
    if: needs.verify.outputs.ready == 'true'
    runs-on: ubuntu-latest
    steps:
      - name: Execute automated payout
        run: echo "Account verified ready! Proceeding with payout..."
```

### Timing Breakdown & Triage (`timings_json`)

Downstream workflows and maintainers can inspect phase timings to triage slow runs and detect availability anomalies:
- **`timing_horizon_fetch_ms`**: Indicates latency introduced by the Horizon API endpoint. High values suggest Horizon congestion or rate limiting.
- **`timing_comment_post_ms`**: Indicates GitHub API latency.
- **`timing_checks_ms`**: Evaluation time in Node runner (typically < 10ms).

> **Balance parsing for release scripts:** The `xlm_balance` output is a raw
> Horizon decimal string (e.g. `"14.9999700"`). Use `parseFloat()` for
> threshold comparisons, integer stroop arithmetic for payment math, or
> `BigInt` for auditable precision. See
> [DECIMAL_PRECISION.md](DECIMAL_PRECISION.md) for safe-parsing examples and
> rules to avoid floating-point bugs in downstream payout scripts.

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

## Address resolution precedence (Issue #219)

TrustBridge resolves the Stellar G-address to validate using the following precedence order. The **first** source that yields a non-empty address wins; all later sources are skipped.

| Priority | Source | When used | Conflict handling |
| -------- | ------ | --------- | ----------------- |
| 1 (highest) | **Soroban contract registry** | `soroban_rpc_url` + `contract_id` are set and `get_address(username)` returns a non-empty result | Wins over assignee map and direct input; contract lookup failure falls through to priority 2 |
| 2 | **Assignee address map** | `assignee_address_map` is set and the current assignee login matches an entry | Wins over direct input; missing assignee is a hard error |
| 3 (lowest) | **Direct input** | `stellar_address_input` is set | Used when neither contract nor map produces an address |

### When multiple sources are configured

If you set both `assignee_address_map` and `stellar_address_input`, the map wins (priority 2 > 3). If you set `soroban_rpc_url` + `contract_id` **and** `assignee_address_map`, the contract wins when the lookup succeeds; on failure, the map is used as fallback.

### Conflict logging

When a source other than direct input resolves the address, TrustBridge logs which source won at `info` level so maintainers can audit the resolution path in workflow logs.

### Example — all three sources configured

```yaml
- uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    # Priority 1: contract registry (used when available)
    soroban_rpc_url: https://soroban-testnet.stellar.org
    contract_id: CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM
    # Priority 2: assignee map (fallback if contract lookup fails)
    assignee_address_map: '{"octocat": "GABC...1234"}'
    # Priority 3: direct input (last resort)
    stellar_address_input: GABC...1234
    github_token: ${{ secrets.GITHUB_TOKEN }}
```

---

## Structured Artifacts (Security & Auditing)

TrustBridge can emit a structured JSON artifact summarizing the check results for machine-readability, security reviews, and auditing. This avoids needing to parse markdown comments or action outputs.
By default, this feature is disabled.

To enable it, set `write_validation_json: 'true'`. You can then upload it using `actions/upload-artifact`:

```yaml
jobs:
  trustbridge:
    runs-on: ubuntu-latest
    steps:
      - uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: ${{ github.event.inputs.stellar_address }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          write_validation_json: 'true'
          validation_json_path: 'validation.json' # Default

      - name: Upload Validation Artifact
        uses: actions/upload-artifact@v4
        if: always() # Ensure artifact is uploaded even if validation fails
        with:
          name: trustbridge-validation-artifact
          path: validation.json
```

**JSON Schema:**
The `validation.json` file contains:
- `timestamp`: ISO-8601 string of the validation time
- `address`: The evaluated Stellar account address
- `asset`: Object containing `code` and `issuer`
- `horizonUrl`: The Horizon API URL used for checks
- `readiness`: Object containing `ready` (boolean), `totalChecks`, `passedChecks`, `failedChecks`, and `failedLabels`
- `checks`: Array of per-check results
- `balances`: Object containing `xlm` balance string

> **Security Note:** The generated artifact is strictly filtered and will **never** contain the `github_token` or any authentication headers.

---

## Security: validation.json and delta vs previous run

TrustBridge can emit a structured `validation.json` artifact and compare it to the **previous workflow run** so auditors see what newly passed or failed between cron revalidations (Issue #148).

### Recommended strategy: retain artifacts between runs

Download the previous run’s artifact into the job, then pass its path as `previous_validation_path`. Always upload the current `validation.json` (even on failure) so the next run can compare.

```yaml
name: TrustBridge cron revalidation

on:
  schedule:
    - cron: '0 6 * * *'
  workflow_dispatch:

jobs:
  trustbridge:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      contents: read
      actions: read   # needed only for download-artifact across runs
    steps:
      - name: Download previous validation artifact (optional)
        continue-on-error: true
        uses: actions/download-artifact@v4
        with:
          name: trustbridge-validation
          path: previous-validation
          # For cross-run retention, prefer a dedicated store or
          # gh api + artifact ID lookup; see tradeoffs below.

      - name: TrustBridge check
        uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: ${{ vars.STELLAR_ADDRESS }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          write_validation_json: true
          validation_json_path: validation.json
          previous_validation_path: previous-validation/validation.json
          privacy_mode: true   # hash addresses in the JSON artifact

      - name: Upload validation artifact
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: trustbridge-validation
          path: validation.json
          retention-days: 30
```

**First run:** if `previous_validation_path` is empty or the file is missing, TrustBridge **omits** the delta section and does not fail.

**Delta surfaces:**
- Issue comment section `### Delta vs previous run` (newly passed / newly failed / unchanged)
- Optional `delta` object inside `validation.json` when writing is enabled

### Strategy tradeoffs

| Approach | Pros | Cons |
| -------- | ---- | ---- |
| **Local artifact path** (`previous_validation_path`) — **recommended** | Explicit matching; no Actions API logic inside the action; soft-fails on first run | Consumer must download/retain artifacts (or copy from a known store) |
| **GitHub Actions API auto-discover** (not implemented) | Zero wiring for consumers | Needs `actions: read`; brittle around artifact names, matrix jobs, retention; rate limits |

`actions/download-artifact@v4` only downloads artifacts from the *current* workflow run by default. For cron-to-cron comparison, retain the file outside GitHub (S3, gist, commit to an internal branch) **or** use `gh api` / a custom step to fetch the previous successful run’s artifact ID, then pass the downloaded path to `previous_validation_path`.

### Privacy mode

When `privacy_mode: true`, addresses and asset issuers in `validation.json` (and its `delta`) are replaced with `sha256:<16 hex>` digests so retained artifacts and public logs do not expose raw G-/C-addresses. Issue comments still use full addresses for remediation. The artifact **never** includes `github_token` or auth headers.

### JSON schema (high level)

- `schemaVersion`, `timestamp`, `address`, `asset`, `horizonUrl`
- `readiness` — gate summary (`ready`, counts, failed labels)
- `checks[]` — `{ label, passed, detail }`
- `balances.xlm`
- `delta` — optional `{ newlyPassed, newlyFailed, unchanged, improved, regressed, previousTimestamp }`
- `privacyMode` — present when hashing was applied

---

## SARIF output for GitHub Advanced Security

TrustBridge can emit validation results as SARIF 2.1.0 for integration with GitHub Advanced Security (GHAS) code scanning. This allows wallet-check failures to appear alongside other security findings in the repository's Security tab.

### Enable SARIF output

Set the optional `sarif_output_path` input to a file path where the SARIF JSON will be written:

```yaml
steps:
  - uses: Stellar-TrustBridge/trustbridge-action@v1
    with:
      stellar_address_input: ${{ steps.address.outputs.address }}
      github_token: ${{ secrets.GITHUB_TOKEN }}
      sarif_output_path: trustbridge-results.sarif

  - name: Upload SARIF results to GHAS
    if: always()  # run even if TrustBridge checks fail
    uses: github/codeql-action/upload-sarif@v2
    with:
      sarif_file: trustbridge-results.sarif
```

The SARIF file includes:
- **Rule definitions** — TB001 (account funded), TB002 (trustline), TB003 (XLM reserve), TB004 (Horizon availability)
- **Severity levels** — Passed checks appear as `note`, failed checks as `error`
- **Validation gate summary** — Total/passed/failed check counts in run properties
- **Locations** — Links to the Horizon endpoint and checked account address

### SARIF rule reference

| Rule ID | Check | Help link |
| ------- | ----- | --------- |
| TB001 | Account funded | [Stellar Accounts](https://developers.stellar.org/docs/fundamentals-and-concepts/stellar-data-structures/accounts) |
| TB002 | Asset trustline | [Trustlines](https://developers.stellar.org/docs/fundamentals-and-concepts/stellar-data-structures/account-data#trustlines) |
| TB003 | XLM reserve | [Reserves & Fees](https://developers.stellar.org/docs/learn/fundamentals/fees-and-metering#reserve) |
| TB004 | Horizon availability | [Horizon API](https://developers.stellar.org/docs/data/apis/horizon) |

---

## Internationalization (i18n)

Issue comments can be rendered in multiple languages. Set the optional `locale` input to change the comment language:

```yaml
steps:
  - uses: Stellar-TrustBridge/trustbridge-action@v1
    with:
      stellar_address_input: ${{ steps.address.outputs.address }}
      github_token: ${{ secrets.GITHUB_TOKEN }}
      locale: 'es'  # Spanish
```

### Supported locales

| Locale | Language | Example comment |
| ------ | -------- | --------------- |
| `en` | English (default) | Check labels, remediation, setup cost all in English |
| `es` | Spanish | "Verificación de Cuenta Stellar", "Cuenta financiada", etc. |
| `pt` | Portuguese | "Verificação de Conta Stellar", "Conta financiada", etc. |
| `ja` | Japanese | "Stellarアカウントチェック", "結果", "残高", etc. |
| `fr` | French | "Vérification du Compte Stellar", "Résultats", etc. |
| `de` | German | "Stellar-Kontoprüfung", "Ergebnisse", "Guthaben", etc. |

If an unsupported or invalid locale is provided, the action falls back to English (`en`).

> **CJK note (Japanese):** Japanese characters are full-width in terminal character counters, but GitHub renders Markdown in HTML with proportional fonts — no manual padding is required. All Japanese strings are kept concise to avoid layout issues in narrow viewports.

### Example: LATAM campaign

```yaml
name: Verificar Billetera Stellar

on:
  issues:
    types: [assigned]

jobs:
  verify:
    runs-on: ubuntu-latest
    permissions:
      issues: write
    steps:
      - uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: ${{ github.event.issue.body }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          locale: 'es'  # Comment in Spanish
          fail_on_missing: false  # Warn only; don't fail workflow
```

### Example: Japanese Wave campaign

```yaml
name: Stellar ウォレット確認

on:
  issues:
    types: [assigned]

jobs:
  verify:
    runs-on: ubuntu-latest
    permissions:
      issues: write
    steps:
      - uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: ${{ github.event.issue.body }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          locale: 'ja'  # コメントを日本語で
          fail_on_missing: false
```

### Example: French Wave campaign

```yaml
name: Vérification du portefeuille Stellar

on:
  issues:
    types: [assigned]

jobs:
  verify:
    runs-on: ubuntu-latest
    permissions:
      issues: write
    steps:
      - uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: ${{ github.event.issue.body }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          locale: 'fr'  # Commentaire en français
          fail_on_missing: false
```

### Example: German Wave campaign

```yaml
name: Stellar-Wallet-Prüfung

on:
  issues:
    types: [assigned]

jobs:
  verify:
    runs-on: ubuntu-latest
    permissions:
      issues: write
    steps:
      - uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: ${{ github.event.issue.body }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          locale: 'de'  # Kommentar auf Deutsch
          fail_on_missing: false
```

---

## Release SBOM (Software Bill of Materials)

TrustBridge publishes a Software Bill of Materials (SBOM) alongside each release for supply-chain security review.

### Accessing the SBOM

1. Go to the [TrustBridge releases page](https://github.com/Stellar-TrustBridge/trustbridge-action/releases)
2. Open a release (e.g., `v1.0.0`)
3. Download the attached `trustbridge-sbom.json` file

### SBOM format

The SBOM is generated in **CycloneDX JSON** format, which is widely supported by:
- [Dependency-Track](https://dependencytrack.org/) (software inventory platform)
- [NTIA SBOM Tool](https://github.com/ntia/sbom-pointers)
- GitHub's own [Dependency Scanning](https://docs.github.com/en/code-security/supply-chain-security)

### Verifying the SBOM

After downloading, you can verify its structure:

```bash
# Check that it's valid JSON
jq . trustbridge-sbom.json > /dev/null && echo "Valid SBOM"

# See all dependencies
jq '.components[] | {name, version}' trustbridge-sbom.json

# Check for a specific dependency
jq '.components[] | select(.name == "@actions/core")' trustbridge-sbom.json
```

### Using the SBOM in your supply chain

```bash
# Example: Submit to NTIA Tool for policy check
sbom-tool validate --input-format CycloneDX --input-file trustbridge-sbom.json

# Example: Import into Dependency-Track for monitoring
curl -X POST "https://your-dependency-track/api/v1/bom" \
  -H "X-API-Key: <your-key>" \
  -F "project=<project-uuid>" \
  -F "bom=@trustbridge-sbom.json"
```

---

## Scheduled wallet re-validation (cron)

A one-time assignment check is insufficient for long-running Waves. Wallets can drift after assignment — trustline removed, balance spent, or address rotated. Run a scheduled sweep before payout to catch stale trustlines early.

See **[CRON_REVALIDATION.md](CRON_REVALIDATION.md)** for a full guide and a ready-to-copy workflow at [`docs/examples/cron-revalidation.yml`](examples/cron-revalidation.yml).

Key recommendations for cron runs:

- Set `fail_on_missing: false` — keeps the cron job green; ❌ appears in the issue comment, not as a CI badge failure.
- Keep `sticky_comment: true` — updates the existing TrustBridge comment rather than flooding the issue thread.
- Wire up the maintainer alert step so drift is surfaced even when the job succeeds.

---

## Pinning versions

| Reference | When to use |
| --------- | ------------- |
| `@v1` | Recommended for production (semver major) |
| `@main` | Latest development — use for testing only |
| `@abc1234` | Pin to commit SHA for maximum reproducibility |

---

## GitHub Enterprise Server (GHES) support

**Support statement: best-effort.** TrustBridge is not tested against a live GHES instance in CI (no GHES infra is currently available to this project), but the code path that talks to the GitHub REST API — issue comment posting in `src/comment.ts` — is written to respect the enterprise API base rather than assume `github.com`, and is covered by mocked-API-base tests (`__tests__/comment.test.ts`). Horizon/Stellar checks themselves (`src/horizon.ts`) make no GitHub API calls at all, so they behave identically on GHES and github.com.

### What changes on GHES

On a GHES runner, the Actions runner sets `GITHUB_API_URL` (and `GITHUB_SERVER_URL`, `GITHUB_GRAPHQL_URL`) to your enterprise instance's endpoints instead of the public GitHub ones, e.g.:

```bash
GITHUB_API_URL=https://ghes.example.com/api/v3
GITHUB_SERVER_URL=https://ghes.example.com
```

`@actions/github`'s `context.apiUrl` reads `GITHUB_API_URL` automatically. TrustBridge passes it explicitly as `baseUrl` when constructing its Octokit client (`github.getOctokit(token, { baseUrl: context.apiUrl })` in `postIssueComment`), so REST calls (`listComments`, `createComment`, `updateComment`) target your enterprise API instead of `api.github.com`. No workflow input needs to change for this — it's automatic based on where the runner executes.

### Verification checklist (no live GHES instance required)

Run through this on your own GHES org before relying on TrustBridge there:

- [ ] Runner is a **self-hosted runner registered to the GHES instance** (GHES doesn't offer GitHub-hosted runners) — confirm `runs-on:` targets a valid self-hosted label.
- [ ] `GITHUB_TOKEN` (or the PAT passed as `github_token`) has `issues: write` scope/permission on the target repo.
- [ ] The workflow's `permissions:` block includes `issues: write`, `contents: read`.
- [ ] Your GHES version supports the REST endpoints TrustBridge uses (`GET /repos/{owner}/{repo}/issues/{n}/comments`, `POST`/`PATCH` on the same) — these are core Issues API endpoints present since early GHES releases; no minimum version issue is currently known.
- [ ] Network egress from the GHES runner to the public Horizon API (`https://horizon.stellar.org` or your configured `horizon_url`) is allowed — GHES runners are often on restricted networks, and Horizon itself is **not** an enterprise-mirrored service (out of scope for this issue; see Horizon RPC fallback docs above if you run a private Horizon mirror).

### Troubleshooting GHES 404 / permission errors

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `Could not look up existing TrustBridge comment, falling back to a new comment: ... 404` or similar on every run | `getOctokit` hit `api.github.com` instead of your GHES instance (e.g. an old TrustBridge version without the `baseUrl` fix, or `GITHUB_API_URL` unset because the runner isn't actually GHES-registered) | Upgrade to a TrustBridge version that includes the GHES `baseUrl` fix; confirm the job actually runs on a GHES-registered self-hosted runner (`echo $GITHUB_API_URL` in a debug step) |
| `403`/`Resource not accessible by integration` when posting the comment | Token lacks `issues: write`, or your GHES instance enforces stricter default token permissions than github.com | Add `permissions: { issues: write }` to the job/workflow; for a PAT, confirm it has `repo` (classic) or `issues:write` (fine-grained) scope on that specific repo |
| Comment posts to the wrong host / link in the comment 404s | `comment_url` output correctly reflects whatever host answered the API call — a wrong host here means `GITHUB_API_URL`/`GITHUB_SERVER_URL` are misconfigured on the runner itself, not a TrustBridge issue | Check the self-hosted runner's environment / `_work/_temp` runner config for correct GHES URLs |

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
| `TRUSTBRIDGE_UNASSIGN_ON_NOT_READY` | `unassign_on_not_ready` | `true`/`false` |

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

## Label gate pattern

Use a **label gate** to conditionally run TrustBridge validation based on issue labels. This pattern avoids unnecessary validation runs and controls noise — for example, gate bounty payouts behind a `bounty` label so not every issue assignment triggers wallet checks.

### When to use

- **Reduce noise**: Only validate when an issue has a specific label (e.g., `bounty`, `needs-wallet`).
- **Control cost**: Skip Horizon queries when validation is not required.
- **Gate workflows**: Different workflows with different validation rules based on labels.
- **Explicit opt-in**: Require maintainers to add a label before wallet checks run.

### Design & example workflows

The TrustBridge repository provides:

1. **Composite action** — `.github/actions/trustbridge-label-gate/action.yml` that wraps trustbridge-action with label checking.
2. **Example workflows** — Ready-to-copy patterns in `docs/examples/`:
   - [`trustbridge-label-gate.yml`](examples/trustbridge-label-gate.yml) — simple gate with minimal permissions.
   - [`trustbridge-label-gate-verbose.yml`](examples/trustbridge-label-gate-verbose.yml) — gate with skip comment.
   - [`trustbridge-label-gate-branching.yml`](examples/trustbridge-label-gate-branching.yml) — per-label rules.

3. **Full design doc** — [`docs/LABEL_GATE_DESIGN.md`](LABEL_GATE_DESIGN.md) with edge cases, error handling, and label conventions.

### Quick start

Copy this into `.github/workflows/trustbridge-gate.yml` in your consumer repository:

```yaml
name: Verify Stellar wallet (with label gate)

on:
  issues:
    types: [assigned]

jobs:
  trustbridge-gated:
    runs-on: ubuntu-latest
    permissions:
      issues: read
      contents: read
    steps:
      - name: TrustBridge with label gate
        id: gate
        uses: Stellar-TrustBridge/trustbridge-action/.github/actions/trustbridge-label-gate@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          stellar_address_input: GYOURCONTRIBUTORADDRESSHERE
          gate_labels: 'bounty,needs-wallet'  # open gate if any label is present
          post_skip_comment: 'false'           # don't post when gate is closed
          fail_on_missing: 'true'

      - name: Continue only if validated and funded
        if: steps.gate.outputs.gate_skipped != 'true' && steps.gate.outputs.account_funded == 'true'
        run: echo "Ready for payout"
```

### Key behaviors

| Scenario | Behavior |
|----------|----------|
| Gate label present | Run trustbridge-action with all inputs; post result comment. |
| No gate label | Skip validation; optionally post a skip notice (set `post_skip_comment: true`). |
| Multiple gate labels | Open the gate if **any** label is present. |
| 403 on label check | Fall-open: run trustbridge-action anyway (over-validate rather than silently skip). |
| Network error during label check | Fall-open: run trustbridge-action. |

### Outputs

| Output | Description |
|--------|-------------|
| `gate_skipped` | `'true'` if the gate was closed, `'false'` if the gate was open. |
| `gate_label_found` | Name of the first gate label that was found, or empty if none. |
| `account_funded`, `trustline_exists`, `xlm_balance` | Forwarded from trustbridge-action when the gate is open; empty when skipped. |

### Permissions

**Minimal** (gate only, no skip comment):
```yaml
permissions:
  issues: read
  contents: read  # optional; only if using trustbridge_config_path
```

**With skip comment posting:**
```yaml
permissions:
  issues: read    # read labels
  issues: write   # post skip comment
  contents: read  # optional
```

### Recommended label names

| Label | Use case | Color |
|-------|----------|-------|
| `bounty` | Bounty payout; wallet must be ready. | Gold (#FFD700) |
| `needs-wallet` | Wallet verification required. | Blue (#0075CA) |
| `grant` | Grant or donation payout. | Green (#28A745) |

You can define any labels your program requires; these are examples.

---

## Integrations and extension examples

### KYC gate (optional consumer logic)

Wave programs that require identity verification before payout can add an
optional KYC check via the [plugin architecture](PLUGIN_ARCHITECTURE.md).
A hardened reference example — with safe comment output, no PII in logs,
and full Markdown escaping — is available at:

- **Plugin source:** [`docs/examples/kyc-plugin.ts`](examples/kyc-plugin.ts)
- **Guide:** [`docs/examples/kyc-plugin.md`](examples/kyc-plugin.md)

The KYC plugin is **never enforced by default**. It only runs when you
explicitly register it alongside the core checks.

---

[← Back to README](../README.md) · [Cron re-validation →](CRON_REVALIDATION.md)

## New Features — Wave #26-28 Enhancements

### Badge outputs for README/dashboard embeds

TrustBridge now exposes `badge_markdown` and `badge_url` outputs containing pass/fail/pending status badges suitable for embedding in README.md or maintainer dashboards.

**Outputs available:**
- `badge_markdown`: Markdown-formatted badge link (e.g. `[![TrustBridge Ready](https://img.shields.io/badge/trustbridge-ready-brightgreen)](...)`)
- `badge_url`: Direct Shields.io badge URL for embedding in HTML or docs

**Use case:** Display wallet readiness status in your project README without exposing account details.

```yaml
- uses: Stellar-TrustBridge/trustbridge-action@v1
  id: bridge
  with:
    stellar_address_input: G...
    github_token: ${{ secrets.GITHUB_TOKEN }}

- name: Create badge
  run: |
    echo "${{ steps.bridge.outputs.badge_markdown }}" >> README.md
```

### Persistent cache backend (opt-in)

When running matrix validation jobs, each leg re-fetches the same account from Horizon and risks hitting rate limits (429s). TrustBridge now supports optional persistent caching via GitHub Actions cache backend to reuse account data across matrix legs and between workflow runs.

**Inputs:**
- `use_cache`: Enable in-memory TTL cache within a single action run (default: `false`)
- `use_actions_cache_backend`: Persist cache to GitHub Actions backend across runs (default: `false`)
- `horizon_cache_ttl_ms`: Cache TTL in milliseconds (default: `60000`, max: `3600000`)

**Constraints:**
- Cache misses on HTTP 404 (unfunded accounts may become funded) — always re-fetches
- Cache keys are namespaced by Horizon URL + address to prevent cross-network collisions
- No secrets or sensitive data in cache keys (addresses are hashed)
- Fail-open: cache backend errors never block validation

**Example — matrix payout with persistent cache:**

```yaml
strategy:
  matrix:
    address: [GAAA..., GBBB..., GCCC...]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: ${{ matrix.address }}
          use_cache: 'true'
          use_actions_cache_backend: 'true'
          horizon_cache_ttl_ms: '300000'    # 5 minutes
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

### Dead code cleanup

Removed duplicate/orphaned modules:
- `src/error-log.ts` — was a duplicate of `src/horizon.ts`
- `src/validator.ts` — was a duplicate of `src/metrics.ts`

**Migration:** No action needed. These modules were not exposed in the public API and existing workflows are unaffected.

### GitHub Checks API for required status gates

When enabled via `use_check_runs: true`, TrustBridge creates a GitHub Check Run with individual validation checks as annotations and a conclusion (success/failure) reflecting the overall result. This allows merge queues and required checks to gate on TrustBridge as a named check.

**Permissions required:**
```yaml
permissions:
  issues: write
  checks: write      # NEW: required for Check Run creation
```

**Behavior:**
- Each validation check (account funded, trustline exists, XLM reserve) appears as an annotation in the Check Run
- Check conclusion is `success` if all checks pass, `failure` otherwise
- Annotations are visible in the Actions UI under the "Annotations" panel
- Fail-open: if Checks API returns 403 (permission denied), a warning is logged and validation continues

**Example — gated merge queue:**

```yaml
name: Verify wallet + allow merge

on:
  issues:
    types: [assigned]

jobs:
  verify:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      checks: write   # NEW
    steps:
      - uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: G...
          use_check_runs: true
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

**In GitHub UI:**
1. Open a pull request targeting this repository
2. Navigate to the "Checks" tab
3. Find the "TrustBridge Validation" check
4. Click to see individual check annotations (account funded, trustline, reserve)
5. Add this check as a required status check in branch protection rules to gate merges

**Troubleshooting:**
| Error | Cause | Fix |
|-------|-------|-----|
| `Checks API permission denied (403)` | Token lacks `checks: write` | Add `permissions: { checks: write }` to the workflow job |
| No Check Run appears | `use_check_runs: false` or not set | Set `use_check_runs: 'true'` in the action input |
| Check Run appears but no annotations | Checks API annotation limit (50 per request) — TrustBridge truncates to first 50 | This is expected behavior; all checks still run locally |

**Known limitations:**
- Fork pull requests: `GITHUB_TOKEN` in fork runs is read-only by default; you need an org-level token or GitHub App to post checks from a fork (GitHub Actions limitation, not specific to TrustBridge).
- GitHub Enterprise Server: Supported via the existing `@actions/github` Octokit client (same as comment posting). Follow the comment-posting GHES guide above; no additional setup is required for Check Runs.

---

## Schema & Output Contract

TrustBridge maintains a JSON schema for all outputs to enable consumer tooling (code generation, validation, type-checking) and catch API mismatches early.

### Schema files

- `schemas/action-inputs.schema.json` — validates `action.yml` inputs and `.trustbridge.yml` config files
- **Outputs schema** — currently maintained as inline TypeScript interfaces in `src/outputs.ts` and `src/badge.ts`

### All declared outputs

**Legacy (backward compatible):**
- `trustline_exists` (boolean string)
- `xlm_balance` (decimal string)
- `account_funded` (boolean string)
- `comment_url` (URL string or empty)
- `full_report_path` (file path string or empty)

**Audit & integration:**
- `ready` (boolean string)
- `validated_at` (ISO-8601 timestamp string)
- `horizon_url` (URL string)
- `asset_code` (asset code string)
- `asset_issuer` (G-address string)
- `reason_code` (enum string: SUCCESS, ACCOUNT_NOT_FUNDED, TRUSTLINE_MISSING, RESERVE_TOO_LOW, etc.)
- `checks_json` (JSON array string of `{ label, passed, detail }` objects)

**Badge:**
- `badge_markdown` (Markdown string with embedded Shields.io URL)
- `badge_url` (Shields.io URL string)

**Timing:**
- `timings_json` (JSON object string: `{ input_parse_ms, horizon_fetch_ms, checks_ms, comment_post_ms, total_ms }`)
- `timing_*_ms` (individual phase timings as numeric strings)

**Sponsorship:**
- `num_sponsoring` (numeric string)
- `num_sponsored` (numeric string)

All outputs are **strings** (GitHub Actions limitation). Consume them as:
- Boolean: `${{ steps.bridge.outputs.ready == 'true' }}`
- Number: `parseFloat('${{ steps.bridge.outputs.timing_total_ms }}')`
- JSON: `JSON.parse('${{ steps.bridge.outputs.checks_json }}')`

---

## GitHub Projects v2 status updates (Issue #222)

Maintainer project boards frequently track bounty issues or contributor tasks. TrustBridge can automatically update an issue or pull request's status field on a GitHub Projects v2 board based on the validation result.

### Example configuration

```yaml
jobs:
  trustbridge:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      contents: read
      # If using default GITHUB_TOKEN for organization-level projects, ensure project permissions:
      # project: write (for GitHub App/PAT)
    steps:
      - uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: ${{ steps.extract.outputs.address }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          project_id: 'PVT_kwDOAB1234567890'
          project_status_field: 'Status'
          project_status_pass: 'Ready to Pay'
          project_status_fail: 'Needs Wallet'
          # If your GITHUB_TOKEN lacks organization project scopes, pass a PAT:
          project_token: ${{ secrets.PROJECTS_PAT || secrets.GITHUB_TOKEN }}
```

### Inputs

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `project_id` | string | `""` | Optional ProjectV2 Node ID (e.g. `PVT_...`). When empty, project updates are skipped. |
| `project_status_field` | string | `"Status"` | The name of the project field to update (supports Single-Select and Text fields). |
| `project_status_pass` | string | `""` | Value/option name to set when all validation checks pass. |
| `project_status_fail` | string | `""` | Value/option name to set when validation checks fail. |
| `project_token` | string | `""` | Optional token with `project` or `write:org` permissions if different from `github_token`. |

### Behavior & Error Handling

- **Opt-in only:** When `project_id` is omitted or empty, no GraphQL project operations run.
- **Automatic Item Enrollment:** If the issue is not yet an item on the project board, TrustBridge will automatically add it before updating the status field.
- **Fail-open:** Missing permissions or Project API errors emit clear warnings (e.g. reminding maintainers about the required `project` scope) and will **never** fail the workflow step or wallet validation checks.

---

## Dashboard webhook receiver contract (Issue #326)

TrustBridge POSTs a signed JSON notification to `webhook_url` after every validation run. This section is the **action-side contract freeze** — everything described here is guaranteed by the code in `src/webhook.ts` and is covered by the golden fixture at `__tests__/fixtures/webhook-payload.json`.

### Enabling webhooks

```yaml
jobs:
  trustbridge:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      contents: read
    steps:
      - uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: ${{ steps.extract.outputs.address }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          webhook_url: 'https://dashboard.example.com/api/webhooks/trustbridge-action'
          webhook_secret: ${{ secrets.WEBHOOK_SECRET }}
```

### HTTP request contract

| Property | Value |
|----------|-------|
| Method | `POST` |
| Content-Type | `application/json` |
| User-Agent | `trustbridge-action/1` |
| Timeout | `5000 ms` (configurable via `webhook_timeout_ms`) |
| Retry | None — webhook delivery is best-effort, one attempt per run |

### Signature header

When `webhook_secret` is set, the request includes:

```
X-TrustBridge-Signature: sha256=<64-hex-chars>
```

The signature is `HMAC-SHA256` over the **raw UTF-8 JSON body**, formatted as `sha256=<hex-digest>` — the same convention used by GitHub's own webhook signatures.

When `webhook_secret` is empty the `X-TrustBridge-Signature` header is **omitted entirely** (the request is sent unsigned). Always set a secret in production.

### Payload body (schema version `"1"`)

```json
{
  "schema_version": "1",
  "event": "validation_complete",
  "timestamp": "<ISO-8601 UTC>",
  "repository": "owner/repo",
  "issue_number": 42,
  "stellar_address": "GA5Z...KZVN",
  "result": {
    "valid": true,
    "account_funded": true,
    "trustline_exists": true,
    "xlm_balance": "10.5",
    "checks": [
      { "label": "Account funded", "passed": true },
      { "label": "USDC trustline", "passed": true }
    ]
  }
}
```

**Field reference:**

| Field | Type | Description |
|-------|------|-------------|
| `schema_version` | `"1"` (string literal) | Contract version. Will be bumped (e.g. `"2"`) on any breaking payload change. |
| `event` | `"validation_complete"` (string literal) | Event type. Reserved for future event types. |
| `timestamp` | ISO-8601 UTC string | When the validation ran (`new Date().toISOString()`). |
| `repository` | `"owner/repo"` string | Full repository name from the GitHub Actions context. |
| `issue_number` | integer or `null` | Issue number when run in an issue context; `null` for non-issue runs (e.g. `workflow_dispatch` without an issue). |
| `stellar_address` | redacted string | Contributor address masked to `first4…last4` (e.g. `GA5Z…KZVN`). The full address is **never** sent to the webhook receiver. |
| `result.valid` | boolean | `true` when all checks passed. |
| `result.account_funded` | boolean | `true` when Horizon found an active account. |
| `result.trustline_exists` | boolean | `true` when the configured asset trustline is present. |
| `result.xlm_balance` | string | Native XLM balance reported by Horizon (`"0"` when unfunded). |
| `result.checks` | array | One entry per check: `{ "label": string, "passed": boolean }`. The `detail` field present in internal `ValidationResult` is intentionally excluded. |

**Golden fixture:** `__tests__/fixtures/webhook-payload.json` contains a canonical example of a passing-run payload and is imported by `webhook.test.ts` to verify structural compliance.

### Verifying the signature (Node.js receiver snippet)

```javascript
// Express / Node.js example receiver for
// POST /api/webhooks/trustbridge-action

const crypto = require('crypto');
const express = require('express');
const app = express();

// Parse the raw body as a Buffer so we sign exactly what was sent.
app.use('/api/webhooks/trustbridge-action', express.raw({ type: 'application/json' }));

app.post('/api/webhooks/trustbridge-action', (req, res) => {
  const secret = process.env.WEBHOOK_SECRET; // same value as webhook_secret in the workflow
  const signature = req.headers['x-trustbridge-signature'];

  if (!signature) {
    res.status(401).json({ error: 'missing signature' });
    return;
  }

  // Compute the expected signature over the raw body bytes.
  const expected = 'sha256=' +
    crypto.createHmac('sha256', secret)
          .update(req.body)          // req.body is a Buffer when using express.raw()
          .digest('hex');

  // Constant-time comparison to prevent timing attacks.
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    res.status(403).json({ error: 'invalid signature' });
    return;
  }

  const payload = JSON.parse(req.body.toString('utf8'));

  // Guard against future schema versions your receiver doesn't understand yet.
  if (payload.schema_version !== '1') {
    res.status(422).json({ error: `unsupported schema_version: ${payload.schema_version}` });
    return;
  }

  // Process the payload.
  const { event, repository, issue_number, stellar_address, result } = payload;
  console.log(`[${event}] repo=${repository} issue=${issue_number} address=${stellar_address} valid=${result.valid}`);

  res.status(200).json({ received: true });
});

app.listen(3000);
```

> **Important:** Use `express.raw()` (or equivalent middleware that gives you the raw bytes before JSON parsing) when verifying the signature. Running `JSON.stringify(JSON.parse(body))` can silently reorder keys and produce a different byte sequence, causing every signature check to fail.

### HMAC test vector

The known vector used in `webhook.test.ts` for regression testing:

```
body:   "test"
secret: "secret"
result: sha256=0329a06b62cd16b33eb6792be8c60b158d89a2ee3a876fce9a881ebb488c0914
```

Verify with:

```bash
echo -n "test" | openssl dgst -sha256 -hmac "secret"
```

### Schema versioning policy

`schema_version` is a **string** (not a number) to allow future values like `"1.1"` without breaking strict parsers. The current version is `"1"`. Any addition of a new **required** field, removal of an existing field, or change to the meaning of an existing field constitutes a breaking change and will increment the version. New **optional** fields may be added within the same version. Your receiver should check `schema_version` on every request and return `422` for unknown versions rather than silently processing unexpected data.

---

## OIDC Federation for Dashboard Webhooks (Issue #224)

By default, dashboard webhook notifications use HMAC-SHA256 signatures with a long-lived shared secret (`webhook_secret`). To eliminate the risk of leaked secrets in fork workflows and repository settings, TrustBridge supports **OpenID Connect (OIDC) federation** with `trustbridge-dashboard`.

When `webhook_auth_mode: oidc` is configured, TrustBridge requests a short-lived OIDC ID token directly from GitHub's OIDC provider (with `id-token: write` permission) and sends it in the HTTP `Authorization: Bearer <token>` header.

### Example configuration

```yaml
jobs:
  trustbridge:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      contents: read
      id-token: write  # required for OIDC federation
    steps:
      - uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: ${{ steps.extract.outputs.address }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          webhook_url: 'https://dashboard.stellar-trustbridge.org/api/v1/webhook'
          webhook_auth_mode: 'oidc'
          webhook_oidc_audience: 'trustbridge-dashboard'  # default audience
```

### OIDC Claims & Dashboard Verification Contract

The minted GitHub OIDC token contains standard JWT claims that the receiver validates:
- `iss`: `https://token.actions.githubusercontent.com`
- `aud`: Configured audience (default `trustbridge-dashboard`)
- `repository`: Current GitHub repository (`owner/repo`)
- `repository_owner`: Repository owner login
- `workflow`: Workflow name
- `actor`: Initiating GitHub user or bot

**Security Guarantees:**
- **Zero long-lived secrets:** No shared webhook secret needs to be stored or rotated in GitHub Secrets.
- **Never logged:** The action registers the minted OIDC token with `core.setSecret()` to prevent accidental exposure in runner logs.
- **HMAC remains default:** Workflows without `webhook_auth_mode: oidc` continue using HMAC-SHA256 signing transparently.
- **Fail-open delivery:** OIDC token errors or network timeouts log non-fatal warnings and never block comment posting or validation results.

---

## Reusable Workflow & Required Status Checks (Issue #223)

To simplify adoption across multiple repositories and prevent permission misconfigurations, TrustBridge provides a blessed reusable workflow at `.github/workflows/trustbridge-reusable.yml`.

Organizations can invoke this reusable workflow with `workflow_call` and configure it as a **required status check** in GitHub Branch Protection rules.

### Reusable Workflow Caller Example

Create a workflow file in your repository (e.g. `.github/workflows/wallet-check.yml`):

```yaml
name: Contributor Wallet Validation Gate

on:
  pull_request:
    branches: [main]
  merge_group:
  issues:
    types: [assigned]
  workflow_dispatch:
    inputs:
      stellar_address:
        description: 'Stellar G-address'
        required: true

permissions:
  contents: read
  issues: write
  pull-requests: read
  id-token: write

jobs:
  verify-wallet:
    name: verify-wallet
    uses: Stellar-TrustBridge/trustbridge-action/.github/workflows/trustbridge-reusable.yml@v1
    secrets: inherit
    with:
      stellar_address_input: ${{ github.event.inputs.stellar_address || 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' }}
      fail_on_missing: true
```

### Configuring as a Required Status Check

1. In your GitHub repository, navigate to **Settings** → **Branches** (or **Rules** → **Rulesets**).
2. Under **Branch protection rules**, select or add a rule for your target branch (e.g. `main`).
3. Enable **Require status checks to pass before merging**.
4. In the search box, search for the status check name:
   `verify-wallet / TrustBridge Status Check` (or `<job-id> / TrustBridge Status Check`).
5. Select the check and save changes.

### Security and Best Practices

- **Minimal Permissions:** The reusable workflow requests only `contents: read`, `issues: write`, `pull-requests: read`, and `id-token: write`.
- **Pinned Version:** Always pin the reusable workflow to a major version tag (e.g. `@v1`) or a specific commit SHA.
- **Pass-through Secrets:** Using `secrets: inherit` automatically forwards `GITHUB_TOKEN` to post/update sticky issue comments without hardcoding personal access tokens.
- **Merge Queue Support:** Works seamlessly with `merge_group` trigger events.

---

## Horizon Retry & Exponential Backoff Configuration (Issue #203)

TrustBridge includes full plumbing for configurable retry attempts and exponential backoff parameters on Horizon API requests (including 429 rate limits, 502/503/504 gateway errors, and transient network timeouts).

### Inputs

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `max_retries` | number | `3` | Maximum number of retry attempts for retryable Horizon responses (0 to 20). |
| `retry_base_delay_ms` | number | `1000` | Initial base delay in milliseconds for exponential backoff (`base * 2^attempt`). |
| `retry_max_delay_ms` | number | `30000` | Maximum cap in milliseconds for any single backoff delay. |

### Example configuration

```yaml
jobs:
  trustbridge:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      contents: read
    steps:
      - uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: ${{ steps.extract.outputs.address }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          max_retries: 5
          retry_base_delay_ms: 500
          retry_max_delay_ms: 15000
```

### Behavior & Guarantees

- **Respects `Retry-After`:** When Horizon returns HTTP 429 with a `Retry-After` header, TrustBridge uses the header value (capped at `retry_max_delay_ms`).
- **Zero Retries Supported:** Setting `max_retries: 0` disables retries and fails immediately on the first error.
- **Failover Compatibility:** Works seamlessly with `horizon_url_fallback` and `rpc_fallback_url`.

---

## Validation & Testing

TrustBridge runs a comprehensive test suite covering all features:

```bash
# Run all tests (unit + integration)
npm test

# Run badge tests only
npm test -- --testPathPattern badge

# Run cache tests only
npm test -- --testPathPattern cache

# Run output contract tests
npm test -- --testPathPattern outputs

# Check + build (required before PR)
npm run lint && npm run build
```

Tests validate:
- Output contract (all declared outputs are set and have correct types)
- Badge generation (pass/fail/pending states correctly mapped to shield states)
- Cache behavior (TTL expiration, hit/miss, persistent backend)
- Check Run creation (permission errors handled gracefully, fail-open)
- Dead code is removed (no orphaned modules imported)

---

## Changelog

### Wave #28 — Badge Outputs Contract
- **Added:** `badge_markdown` and `badge_url` outputs declared in `action.yml`
- **Fixed:** Consumer workflows using badge outputs no longer break in composite actions
- **Docs:** Badge output examples in README and USAGE.md

### Wave #27 — Persistent Cache Backend
- **Added:** `use_cache` and `use_actions_cache_backend` inputs
- **Added:** `CacheBackendOptions` and `PersistentCacheBackend` interfaces for pluggable backends
- **Constraint:** 404 responses never cached (unfunded accounts may become funded)
- **Testing:** Cache behavior validated across matrix legs and runs

### Wave #26 — GitHub Checks API
- **Added:** `use_check_runs` input and `checks-run.ts` module
- **Added:** Per-check annotations visible in GitHub UI
- **Fail-open:** Permission errors logged as warnings, validation continues
- **Testing:** Checks API mocked for unit tests (no live GitHub integration required)

### Cleanup — Dead Code Removal
- **Removed:** `src/error-log.ts` (duplicate of `src/horizon.ts`)
- **Removed:** `src/validator.ts` (duplicate of `src/metrics.ts`)
- **Impact:** Zero; these modules were not part of the public API
- **Verify:** `npm run build && npm test` confirm no imports of deleted modules

