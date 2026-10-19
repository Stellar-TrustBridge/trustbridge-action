# SEP-0001 Home Domain Alignment Check

TrustBridge can optionally inspect an asset issuer's **on-chain `home_domain`
field** (as returned by Horizon) and record the result in metrics. This surfaces
issuer metadata alignment as a signal for regulated-asset programs without
blocking the default USDC payout flow.

---

## How it works

Stellar accounts can set a `home_domain` field directly on-chain. Horizon
exposes this value in the account resource. TrustBridge reads it from the
issuer account returned by Horizon and checks it against an optional expected
value you configure.

The check is **purely on-chain** — it does **not** fetch or verify the
`stellar.toml` file over HTTP. Full SEP-0001 HTTP fetch and TOML signature
verification is [out of scope](#out-of-scope).

If a future implementation adds the optional HTTP TOML fetch, it must use a
server-side fetch wrapper that enforces these rules:

- maximum redirect count (default 5 hops)
- HTTPS-only redirects with no protocol downgrade
- same-origin redirect enforcement for the home-domain fetch
- re-validation of every redirect target with the SSRF allowlist checker
- loop detection to prevent redirect cycling into metadata or private hosts

This keeps the fetch SSRF-safe even when the initial URL is public and a later
redirect points at an attacker-controlled host.

---

## Configuration

Add the inputs to your workflow step:

```yaml
- uses: your-org/trustbridge-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    stellar_address_input: ${{ steps.extract.outputs.address }}

    # Enable the check (off by default)
    home_domain_check_enabled: 'true'

    # Optional: require this exact domain (case-insensitive)
    # Leave empty to accept any non-empty home_domain value
    expected_home_domain: 'centre.io'

    # 'warn'   — informational only, never fails the action (default)
    # 'strict' — a missing or mismatched domain fails the check and,
    #            when fail_on_missing is true, fails the workflow step
    home_domain_check_mode: 'warn'
```

### Inputs

| Input | Default | Description |
|---|---|---|
| `home_domain_check_enabled` | `false` | Enable the SEP-0001 home domain check. |
| `expected_home_domain` | _(empty)_ | Domain the issuer must have on-chain. If empty, any non-empty value passes. |
| `home_domain_check_mode` | `warn` | `warn` = informational. `strict` = blocks `valid` on failure. |

---

## Outcomes and metrics

Each run emits one counter and one tagged metric point:

| Outcome | Counter | Meaning |
|---|---|---|
| `valid` | `home_domain_valid` | Domain present and matches expectation. |
| `missing` | `home_domain_missing` | Issuer has no `home_domain` set on-chain. |
| `mismatch` | `home_domain_mismatch` | Domain present but does not match `expected_home_domain`. |
| `skipped` | `home_domain_skipped` | Check not enabled (`home_domain_check_enabled: false`). |

All outcomes also record a `home_domain_check` metric point with `outcome` and
`mode` tags for dashboard slicing:

```json
{
  "name": "home_domain_check",
  "value": 1,
  "unit": "count",
  "tags": { "outcome": "valid", "mode": "warn" }
}
```

---

## Comment output

When the check is enabled a **SEP-0001 home domain** row is added to the
TrustBridge comment table:

| Check | Status |
|---|---|
| Account funded | ✅ |
| USDC trustline | ✅ |
| XLM reserve | ✅ |
| **SEP-0001 home domain** | ✅ `centre.io` ✓ |

In `warn` mode a failing row is marked informational and does not change the
overall result. In `strict` mode the row fails and, when `fail_on_missing: true`
is set, the workflow step exits with a non-zero status.

---

## Modes

### `warn` (default)

Safe for all workflows. The check is purely observational:

- Adds an informational row to the comment table.
- Emits `home_domain_missing` / `home_domain_mismatch` metrics.
- Does **not** set `valid = false`.
- Does **not** fail the action.

Use this mode to start collecting data before enforcing a policy.

### `strict`

For programs that require verifiable issuer metadata:

- A missing or mismatched `home_domain` sets the check row to **failed**.
- When `fail_on_missing: true` the action exits with a non-zero status and
  posts a remediation message in the issue comment.
- Existing workflows on the default USDC issuer (`GA5Z…`) are unaffected
  because `home_domain_check_enabled` is `false` by default.

---

## Plugin API

The `homeDomainPlugin` (`trustbridge/home-domain`) follows the standard
`CheckPlugin` interface and can be used in a custom plugin pipeline:

```ts
import { runPlugins } from './pluginRunner';
import { corePlugins } from './corePlugins';
import { PluginRegistry } from './plugin';

const registry = new PluginRegistry();
corePlugins.forEach(p => registry.register(p));

// homeDomainPlugin is a no-op when config.homeDomainCheckEnabled is false
const result = runPlugins(ctx, registry);
```

The `evaluateHomeDomain(issuerAccount, config)` helper is also exported from
`src/checks.ts` for direct use in custom plugins or tests.

---

## Limitations

- **On-chain data only.** TrustBridge reads the `home_domain` field already
  present in the Horizon account resource. It does **not** resolve the domain
  via DNS, fetch the `stellar.toml` file, or verify any signatures.
- **Issuer account availability.** The `home_domain` field is read from the
  account currently held in the TrustBridge execution context. In most
  deployments this is the *wallet* account, not the *issuer* account. A future
  enhancement will add an optional issuer-account prefetch.
- **Horizon data freshness.** Horizon may cache account data. Set
  `horizon_cache_ttl_ms: 0` if you need the latest on-chain state for
  compliance checks.
- **No TOML verification.** Full SEP-0001 compliance requires fetching
  `https://<home_domain>/.well-known/stellar.toml` and verifying that the
  issuer address matches the `SIGNING_KEY` or `ACCOUNTS` list. That HTTP
  fetch is intentionally out of scope to keep TrustBridge dependency-free
  and SSRF-safe in GitHub Actions environments.

---

## Out of scope

The following are **not** implemented and are not planned without an explicit
opt-in mechanism:

- HTTP fetch of `stellar.toml` from the `home_domain` URL.
- Signature or key verification against TOML contents.
- DNS resolution or certificate validation of the home domain.
- Blocking default mainnet USDC flows without `home_domain_check_enabled: true`.
