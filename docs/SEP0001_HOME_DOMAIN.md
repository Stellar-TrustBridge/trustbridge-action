# SEP-0001 Home Domain Alignment Check

TrustBridge can optionally inspect an asset issuer's **on-chain `home_domain`
field** (as returned by Horizon) and record the result in metrics. This surfaces
issuer metadata alignment as a signal for regulated-asset programs without
blocking the default USDC payout flow.

---

## How it works

Stellar accounts can set a `home_domain` field directly on-chain. Horizon
exposes this value in the account resource. When `home_domain_check_enabled`
is true, TrustBridge fetches the **asset issuer** account (`asset_issuer`)
from `horizon_url` and checks its `home_domain` against an optional expected
value you configure. In batch mode the issuer is fetched once and every
address row is evaluated against it.

If the issuer account can't be fetched, or the issuer is a Soroban contract
(C-address, which has no `home_domain`), the outcome is `missing`.

By default the check is **purely on-chain**: it does not fetch or verify the
`stellar.toml` file over HTTP. Operators can opt in to fetching
`https://{home_domain}/.well-known/stellar.toml` with
`stellar_toml_fetch_enabled: 'true'` (see
[Optional stellar.toml fetch](#optional-stellartoml-fetch)). TOML signature /
`SIGNING_KEY` verification is still [out of scope](#out-of-scope).

The optional fetch goes through the same SSRF gate as `horizon_url`
(`fetchSSRFSafe` in `src/ssrf.ts`):

- HTTPS only; private, loopback, link-local and metadata hosts are refused
  (including decimal/hex/IPv6-mapped encodings)
- the home domain is resolved before connecting and refused if any address is
  private (DNS rebinding guard)
- redirects are **not** followed: any 3xx fails the fetch, so a redirect to a
  disallowed host can never be reached
- the body is capped at 256 KB (checked via `Content-Length` and again after
  download)

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
| `stellar_toml_fetch_enabled` | `false` | Also fetch `https://{domain}/.well-known/stellar.toml`. Only takes effect when `home_domain_check_enabled` is `true`. |
| `stellar_toml_cache_ttl_ms` | `3600000` | How long a fetched TOML body is reused within the job. `0` disables caching. Clamped to 24 h (`86400000`). |
| `stellar_toml_hash_pin` | _(empty)_ | `sha256:<64 hex>` or `sha512:<128 hex>`. When set, a body whose digest differs is rejected and the check fails, in both modes. |

---

## Optional stellar.toml fetch

### Input matrix

| `home_domain_check_enabled` | `stellar_toml_fetch_enabled` | `stellar_toml_hash_pin` | Network call? | Result |
|---|---|---|---|---|
| `false` | any | any | No | No home-domain or TOML check. |
| `true` | `false` | any (ignored) | **No.** The SSRF-guarded HTTP client is never called. | On-chain `home_domain` check only. |
| `true` | `true` | empty | Yes (unless cached) | On-chain check **plus** an `SEP-0001 stellar.toml` row. A fetch error only blocks `valid` in `strict` mode. |
| `true` | `true` | set | Yes (unless cached) | On-chain check plus TOML row. A fetch error **or** a hash mismatch always blocks `valid` (fail closed), in both modes. |

The domain fetched is `expected_home_domain` when it is set, otherwise the
on-chain `home_domain`. When neither is known, the TOML step is skipped.

### Cache TTL semantics

- A cached body is served only while `now − fetchedAt < stellar_toml_cache_ttl_ms`.
  Within that window no second HTTP request is made.
- An entry dated in the future (the runner clock moved backwards) counts as
  expired, so clock skew cannot stretch the TTL.
- TTLs above 24 h are clamped. `0` disables the cache.
- The cache lives in job memory only. Nothing is written to disk or to the
  Actions cache, so a poisoned entry cannot outlive the job.

### Hash pin behaviour

- The pin is checked on **every** read, including cache hits. A cached body
  that no longer matches (for example right after you rotate the pin) is evicted
  and fetched again. A freshly fetched body that does not match is rejected and
  **never cached**.
- A malformed pin fails before any network call.
- The error shows only the expected and computed digests, for example
  `stellar.toml from centre.io rejected: TOML hash mismatch: got 9f…, expected 76…`.
  The TOML body (which may list issuer accounts and contacts) is never written
  to the comment or the logs.

### MITM and cache-poisoning mitigations

| Threat | Mitigation |
|---|---|
| Network MITM / downgrade | HTTPS only; redirects refused, so no `https → http` hop. |
| Redirect to an internal service | Any 3xx fails the fetch. The URL and every resolved address are checked against the SSRF blocklist. |
| DNS rebinding (`anchor.example` → `127.0.0.1`) | Resolved addresses are checked before connecting. |
| Compromised or defaced anchor web server | `stellar_toml_hash_pin` fails closed on any byte change. |
| Poisoned cache entry served later | Cache is per-job memory with a bounded TTL, and the pin is checked on every cache hit. |
| Oversized response / memory pressure | 256 KB cap on `Content-Length` and on the downloaded body. |

### Fetch limits (Issue #782)

Every stellar.toml fetch goes through `fetchSSRFSafe` (`src/ssrf.ts`) with
these fixed limits, enforced in `src/toml.ts`:

| Limit | Value | Failure detail |
|---|---|---|
| Max body size | 256 KB (`MAX_STELLAR_TOML_BYTES`); a caller-supplied `maxBodyBytes` can lower but never raise it | `Response body exceeds limit of 262144 bytes` |
| Content-Type allowlist | `application/toml`, `application/x-toml`, `text/toml`, `text/x-toml`, `text/plain` (parameters such as `charset` ignored; a missing header is accepted) | `stellar.toml from <domain> rejected: unexpected Content-Type "<type>"` |
| Redirects | None followed (`maxRedirects: 0`) | `HTTP 3xx` |
| Empty body | Rejected | `stellar.toml from <domain> rejected: empty body` |

Rejected responses fail the check and are never cached.

### Pin rotation workflow

1. Before the anchor publishes a new `stellar.toml`, compute its digest from a
   trusted machine:

   ```bash
   curl -sSf https://centre.io/.well-known/stellar.toml | sha256sum
   ```

2. Review the diff of the new file against the old one (issuer `ACCOUNTS`,
   `SIGNING_KEY`, `CURRENCIES`).
3. Open a PR that updates `stellar_toml_hash_pin` (ideally kept in a repository
   or organization variable such as `vars.USDC_TOML_PIN`) to `sha256:<new digest>`.
4. Merge right after the anchor's change goes live. Runs in between fail closed
   with a hash-mismatch error rather than trusting an unreviewed file.
5. If you cannot coordinate with the anchor, briefly switch
   `home_domain_check_mode` to `warn` *and* clear the pin while you review, then
   restore both.

```yaml
- uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    stellar_address_input: ${{ steps.extract.outputs.address }}
    home_domain_check_enabled: 'true'
    expected_home_domain: 'centre.io'
    home_domain_check_mode: 'strict'
    stellar_toml_fetch_enabled: 'true'
    stellar_toml_cache_ttl_ms: '600000'
    stellar_toml_hash_pin: ${{ vars.USDC_TOML_PIN }}
```

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

## Failure matrix

When a home-domain check does not pass, the `outcome` tag on the
`home_domain_check` metric point (and the `home_domain_*` counter) is the
canonical reason code. Use the matrix below to map each symptom to its reason
code and remediation. The reason codes are emitted by `evaluateHomeDomain` in
`src/checks.ts` and must stay in sync with this table.

| Symptom | Reason code (`outcome`) | Counter | Typical cause | Remediation |
|---|---|---|---|---|
| Check never runs; no `home_domain_check` metric | `skipped` | `home_domain_skipped` | `home_domain_check_enabled` is `false` (default). | Set `home_domain_check_enabled: 'true'` on the workflow step. |
| Issuer row shows no domain; `missing` outcome | `missing` | `home_domain_missing` | Issuer account has no `home_domain` set on-chain, or Horizon returned an empty value. | Set `home_domain` on the issuer account (`manage_data`/account merge tooling) and re-run; confirm Horizon is not serving stale data (`horizon_cache_ttl_ms: 0`). |
| Domain present but flagged; `mismatch` outcome | `mismatch` | `home_domain_mismatch` | On-chain `home_domain` differs from `expected_home_domain` (comparison is case-insensitive). | Correct `expected_home_domain` to the issuer's real domain, or update the issuer's on-chain `home_domain`. |
| Strict mode fails the step | `missing` or `mismatch` | `home_domain_missing` / `home_domain_mismatch` | `home_domain_check_mode: 'strict'` with `fail_on_missing: true` and a failing outcome. | Fix the underlying `missing`/`mismatch` cause above, or switch to `warn` mode while remediating. |
| Domain looks correct but still `mismatch` | `mismatch` | `home_domain_mismatch` | Trailing whitespace, scheme (`https://`), or path included in `expected_home_domain`. | Provide a bare hostname (e.g. `centre.io`), no scheme or path. |

> **Note:** `valid` is the only passing outcome and is not listed above. Any
> outcome other than `valid`/`skipped` is a failure that `strict` mode treats
> as blocking.

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

In `warn` mode a failing row stays passing but is prefixed with ⚠️ and marked
"Warning only", so the problem is visible without changing the overall result.
In `strict` mode the row fails, the comment's **Remediation** section explains
the mismatch (actual vs expected domain) or the missing domain, and, when
`fail_on_missing: true` is set, the workflow step exits with a non-zero status.

Domain strings are public issuer metadata, so they appear in comments and
SARIF messages. They are not written to debug logs by the home domain check.

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

- **On-chain data by default.** Without `stellar_toml_fetch_enabled`,
  TrustBridge only reads the `home_domain` field already present in the Horizon
  account resource. With it enabled, the TOML body is fetched and optionally
  hash-pinned, but its contents are not parsed or signature-verified.
- **Issuer account availability.** The `home_domain` field is read from the
  account currently held in the TrustBridge execution context. In most
  deployments this is the *wallet* account, not the *issuer* account. A future
  enhancement will add an optional issuer-account prefetch.
- **Horizon data freshness.** Horizon may cache account data. Set
  `horizon_cache_ttl_ms: 0` if you need the latest on-chain state for
  compliance checks.
- **No TOML content verification.** Full SEP-0001 compliance requires
  verifying that the issuer address matches the `SIGNING_KEY` or `ACCOUNTS`
  list in the TOML. TrustBridge does not parse the TOML for this. Use
  `stellar_toml_hash_pin` to pin a reviewed file instead.

---

## Out of scope

The following are **not** implemented and are not planned without an explicit
opt-in mechanism:

- HTTP fetch of `stellar.toml` *unless* `stellar_toml_fetch_enabled: 'true'` is set (opt-in, see above).
- Signature or key verification against TOML contents.
- Blocking default mainnet USDC flows without `home_domain_check_enabled: true`.
