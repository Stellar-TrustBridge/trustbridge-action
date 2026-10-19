# TrustBridge Action — FAQ

This document answers the most common questions contributors and maintainers encounter when using TrustBridge. Each section has a stable anchor that TrustBridge links to directly from failing check bullets in issue comments.

---

## Account not funded {#account-not-funded}

**Symptom:** The `account_funded` check shows ❌ and the comment says the account was not found on Horizon.

**What this means:** Your Stellar public key exists but the account has not been activated on the network yet. A Stellar account must receive at least **1 XLM** before it appears on the ledger.

**Steps to fix:**

1. Copy your Stellar public key (G-address) from your wallet.
2. Send **at least 1 XLM** to that address from an exchange (Coinbase, Kraken, Binance) or another funded Stellar account.
3. Wait ~5 seconds for the ledger to close.
4. Re-run the TrustBridge check — either by reassigning the issue or triggering a `workflow_dispatch`.

**Helpful links:**
- [Stellar Laboratory — Account Viewer](https://laboratory.stellar.org/#account-viewer?network=public)
- [LOBSTR wallet](https://lobstr.co/) — buy or receive XLM on mobile
- [Stellar docs: Account minimum balance](https://developers.stellar.org/learn/fundamentals/lumens#minimum-balance)

---

## Trustline missing {#trustline-missing}

**Symptom:** The `trustline_exists` check shows ❌.

**What this means:** Your account is funded but has not yet established a trustline for the required asset (e.g. USDC). A trustline is a permission record that lets your account hold and receive a specific asset.

**Steps to fix:**

1. Open [Stellar Laboratory — Transaction Builder](https://laboratory.stellar.org/#txbuilder?network=public).
2. Set the source account to your G-address.
3. Add a **Change Trust** operation with the asset code (`USDC`) and issuer address shown in the comment.
4. Sign and submit the transaction.

Alternatively, use a SEP-0007-compatible wallet (LOBSTR, Solar, Albedo) — TrustBridge embeds a one-click `web+stellar:` deep link in the comment when `sep0007_deep_links: true` is configured.

**Helpful links:**
- [LOBSTR — Add trustline guide](https://lobstr.co/blog/how-to-add-trustline-on-stellar)
- [Stellar docs: Trustlines](https://developers.stellar.org/learn/fundamentals/stellar-data-structures/accounts#trustlines)

---

## XLM reserve too low {#xlm-reserve-too-low}

**Symptom:** The `check_xlm_reserve` check shows ❌.

**What this means:** Your account is funded and has a trustline, but your XLM balance is below the required reserve. The Stellar protocol requires each account to maintain a minimum balance based on its subentries (trustlines, offers, etc.).

**How the reserve is calculated:**

```
protocol minimum = (2 + subentries + sponsoring − sponsored) × 0.5 XLM
```

TrustBridge then applies your configured `min_xlm_reserve` as a floor — your balance must meet whichever is higher.

**Steps to fix:**

Send additional XLM to your address to bring the balance above the required threshold shown in the comment.

**Helpful links:**
- [Stellar docs: Minimum balance](https://developers.stellar.org/learn/fundamentals/lumens#minimum-balance)
- [Stellar docs: Sponsorship (CAP-0033)](https://developers.stellar.org/docs/learn/encyclopedia/transactions-specialized/sponsored-reserves)

---

## Testing on testnet {#testing-on-testnet}

**Symptom:** You want to test TrustBridge without using real XLM.

**Steps to configure testnet:**

```yaml
- uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ steps.address.outputs.address }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    horizon_url: https://horizon-testnet.stellar.org
    asset_code: USDC
    asset_issuer: GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
    min_xlm_reserve: '1.5'
```

Get free testnet XLM from the [Stellar Friendbot](https://friendbot.stellar.org/?addr=YOUR_ADDRESS).

**Important:** Testnet accounts and mainnet accounts are independent — a G-address funded on testnet is **not** funded on mainnet.

**Helpful links:**
- [Stellar Friendbot](https://friendbot.stellar.org/)
- [Horizon testnet endpoint](https://horizon-testnet.stellar.org)
- [Stellar Laboratory (testnet)](https://laboratory.stellar.org/#account-viewer?network=testnet)

---

## Horizon error / service unavailable {#horizon-error}

**Symptom:** All checks show ❌ with a Horizon connectivity error, or the `wallet: horizon-error` label appears.

**What this means:** TrustBridge could not reach the Horizon API. This is usually a transient network issue, Horizon maintenance, or a misconfigured `horizon_url`.

**Steps to fix:**

1. Check [Stellar Status](https://status.stellar.org/) for known Horizon incidents.
2. Verify your `horizon_url` input is correct (`https://horizon.stellar.org` for mainnet).
3. If using a private Horizon mirror, confirm it is reachable from GitHub Actions runners.
4. Re-trigger the workflow after the outage resolves.

For high-availability workflows, configure a fallback URL:

```yaml
with:
  horizon_url: https://horizon.stellar.org
  horizon_url_fallback: https://horizon-testnet.stellar.org  # replace with your own mirror
```

### 429 responses and retry wait budgets

TrustBridge honors Horizon's `Retry-After` response and caps both an individual
wait and the total retry wait. When that total budget is exhausted, the action
stops retrying and reports a **Horizon retry wait budget exhausted** failure.
This is different from an unfunded account: no reliable account state was
received. Retry later, or adjust the retry delay and total-wait inputs for a
known-slow Horizon mirror.

**Helpful links:**
- [Stellar Status page](https://status.stellar.org/)
- [TrustBridge RPC fallback docs](https://github.com/Stellar-TrustBridge/trustbridge-action/blob/main/docs/USAGE.md#horizon-rpc-fallback-url)

---

## Debug mode and expert diagnostics {#debug-mode}

**Symptom:** You need detailed Horizon status codes, latency, and normalized inputs to diagnose a failure.

**How to enable:**

```yaml
- uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ steps.address.outputs.address }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    debug_mode: true
```

When `debug_mode: true`:
- Extra `core.debug` lines are emitted to the Actions log covering every stage of the Horizon client.
- An **Expert diagnostics** collapsible section is appended to the issue comment showing the Horizon HTTP status, round-trip latency, retry count, and normalized inputs. No secrets are included — addresses are redacted to first-4/last-4.

**Helpful links:**
- [TrustBridge debug logging docs](https://github.com/Stellar-TrustBridge/trustbridge-action/blob/main/README.md#debug-logging-and-redaction)

---

## Claimable balance shown instead of funded account {#claimable-balance}

**Symptom:** A contributor's address holds a claimable balance but the `account_funded` check shows ❌, or the comment mentions claimable balances.

**What this means:** A *claimable balance* is an escrowed amount of XLM or an asset that has been set aside for a specific recipient but has not yet been claimed. It is **not** the same as funding an account. Stellar accounts must be activated with at least 1 XLM sent directly to the account before they appear on the ledger and before trustlines can be created.

Until the contributor claims the balance (which itself requires a small funded account to pay the fee), their G-address remains unfunded.

**Steps to fix:**

1. Obtain a small amount of XLM from an exchange or another funded account to activate the G-address directly.
2. Once the account is active, claim the claimable balance using a SEP-0007-compatible wallet or Stellar Laboratory.
3. Re-run the TrustBridge check — either by reassigning the issue or triggering a `workflow_dispatch`.

**Workflow configuration note:** By default (`claimable_balance_policy: ignore`) claimable balances do not affect the funded check. Set `claimable_balance_policy: count` to surface an informational hint when unfunded accounts have pending claimable balances:

```yaml
with:
  stellar_address_input: ${{ steps.address.outputs.address }}
  github_token: ${{ secrets.GITHUB_TOKEN }}
  claimable_balance_policy: count
```

**Helpful links:**
- [Stellar docs: Claimable Balances](https://developers.stellar.org/docs/learn/encyclopedia/transactions-specialized/claimable-balances)
- [Stellar Laboratory — Claim Claimable Balance](https://laboratory.stellar.org/#txbuilder?network=public)

---

## Unauthorized trustline {#unauthorized-trustline}

**Symptom:** The trustline check shows ❌ with a message about an unauthorized or pending trustline, even though the contributor has added the asset to their wallet.

**What this means:** A trustline can exist in one of two authorization states:
- **Authorized** — the issuer has granted permission; the account can send and receive the asset.
- **Unauthorized / Pending** — the trustline record exists on the ledger but the issuer has not yet granted authorization. This happens when the issuer account has the `AUTH_REQUIRED` flag set.

TrustBridge distinguishes between a missing trustline and an unauthorized one. An unauthorized trustline means the contributor took the right steps (added the trustline) but the issuer still needs to authorize it.

**Steps to fix:**

1. Confirm with the project maintainer or asset issuer that your account has been authorized. Some assets require KYC or manual issuer review.
2. If you control the issuer account (test/private assets), use the `Allow Trust` or `Set Trustline Flags` operation in Stellar Laboratory to authorize the trustline.
3. Once authorized, re-run the TrustBridge check.

**Workflow configuration note:** Use `unauthorized_trustline_policy` to control how TrustBridge responds:

| Value | Behavior |
|-------|----------|
| `warn` (default) | Check passes, a warning annotation is emitted |
| `fail` | Check fails; `trustline_exists` output is `false` |
| `ignore` | Authorized and unauthorized trustlines are treated identically |

```yaml
with:
  stellar_address_input: ${{ steps.address.outputs.address }}
  github_token: ${{ secrets.GITHUB_TOKEN }}
  unauthorized_trustline_policy: fail   # or warn / ignore
```

**Helpful links:**
- [Stellar docs: Trustline Authorization](https://developers.stellar.org/docs/learn/encyclopedia/transactions-specialized/trustline-authorization)
- [Stellar Laboratory — Set Trustline Flags](https://laboratory.stellar.org/#txbuilder?network=public)

---

## Signed webhook not received {#webhook-not-received}

**Symptom:** Your dashboard is not receiving TrustBridge webhook notifications.

**Steps to diagnose:**

1. Confirm `webhook_url` is set in your workflow and points to an HTTPS endpoint.
2. Verify the endpoint is publicly reachable from GitHub Actions runner IPs.
3. Check the Actions log for `[TrustBridge] Webhook delivered` or `Webhook delivery failed` messages.
4. If the signature doesn't match, verify `webhook_secret` is the same value your receiver uses to verify signatures.

**Signature verification example (Node.js):**

```js
const crypto = require('crypto');

function verifySignature(payload, secret, signatureHeader) {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret)
    .update(payload, 'utf8').digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}
```

**Helpful links:**
- [TrustBridge webhook docs](https://github.com/Stellar-TrustBridge/trustbridge-action/blob/main/docs/USAGE.md#signed-dashboard-webhooks)
- [Issue #101 — Signed webhooks design](https://github.com/Stellar-TrustBridge/trustbridge-action/issues/101)

---

## OIDC webhook authentication failures {#oidc-webhook-troubleshooting}

These apply when `webhook_auth_mode: oidc` is set. OIDC failures are non-fatal: validation and comment posting continue, but the dashboard rejects or never sees the webhook.

### Token minting fails (missing `id-token: write`)

**Symptom:** The Actions log shows `OIDC token minting failed for audience "trustbridge-dashboard": ... Ensure the workflow has 'permissions: id-token: write'`, and the receiver returns `401` because no `Authorization` header was sent.

**Fix:** Grant the permission on the job (or workflow) that runs TrustBridge. Setting any `permissions:` block drops unlisted scopes, so list `id-token: write` explicitly alongside the others:

```yaml
permissions:
  issues: write
  contents: read
  id-token: write
```

GitHub does not issue OIDC tokens to `pull_request` runs from forks, so expect this warning there. Use HMAC mode for fork-triggered workflows or run TrustBridge from a trusted event (for example `issue_comment` or `issues`).

### Audience mismatch

**Symptom:** The log shows `Webhook delivered ... (OIDC) — HTTP 401` (or `403`), and the receiver reports an invalid `aud` claim.

**Fix:** `webhook_oidc_audience` (default `trustbridge-dashboard`) must exactly equal the audience your receiver accepts — same case, no trailing slash, and no URL unless the receiver expects one. Decode the token's claims on the receiver side and compare `aud` with the configured value.

### Webhook auth mode mismatch

**Symptom:** HTTP `401`/`403` even though the token mints successfully, or signature verification failures on the receiver.

**Fix:** In OIDC mode the action sends only `Authorization: Bearer <token>` and does **not** send `X-TrustBridge-Signature`, even when `webhook_secret` is set. Receivers must verify the JWT (issuer, audience, `repository` claim, signature against the issuer's JWKS) instead of the HMAC signature. Conversely, a receiver that expects a bearer token will reject HMAC-mode requests. Configure both sides for the same mode.

### Issuer rejected on GitHub Enterprise Server

**Symptom:** OIDC works on github.com but the receiver rejects tokens from GHES, or minting fails on GHES.

**Fix:** GHES tokens are issued by `https://<your-ghes-host>/_services/token`, not `https://token.actions.githubusercontent.com`, so the receiver must trust that issuer and fetch its JWKS. The OIDC provider requires GHES 3.8 or later. See [GHES_COMPATIBILITY.md](GHES_COMPATIBILITY.md) for the feature matrix and permission requirements.

> Never paste real tokens or secrets into issues or logs when asking for help. Tokens minted by the action are masked with `core.setSecret()`; redact any value you copy from receiver-side logs.

**Helpful links:**
- [TrustBridge OIDC docs](https://github.com/Stellar-TrustBridge/trustbridge-action/blob/main/docs/USAGE.md#oidc-federation-for-dashboard-webhooks-issue-224)
- [GitHub: About security hardening with OpenID Connect](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect)
