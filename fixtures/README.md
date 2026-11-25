# TrustBridge Fixture Files

Recorded Horizon account JSON snapshots for **offline development and testing**
without a live Horizon endpoint or Docker.

Use these with the `fixture_mode` and `fixture_path` action inputs — see
[docs/USAGE.md](../docs/USAGE.md#offline-fixture-mode-304) and
[CONTRIBUTING.md](../CONTRIBUTING.md#offline-development-with-fixture-mode) for
the full cookbook.

---

## Available fixtures

| File | Description |
|------|-------------|
| `account-funded.json` | Account with 10 XLM and a USDC trustline — all checks pass |
| `account-no-trustline.json` | Account with 10 XLM but **no** USDC trustline |
| `account-low-balance.json` | Account with 0.5 XLM (below the 1.5 XLM minimum) and a USDC trustline |

## Format

Each file is a standard Horizon `/accounts/{address}` response body:

```json
{
  "id": "G...",
  "account_id": "G...",
  "sequence": "123456789",
  "subentry_count": 1,
  "num_sponsoring": 0,
  "num_sponsored": 0,
  "balances": [
    { "balance": "10.0000000", "asset_type": "native", ... },
    { "balance": "50.0000000", "asset_type": "credit_alphanum4", "asset_code": "USDC", ... }
  ]
}
```

The `id` and `account_id` fields do not need to match the `stellar_address_input`
you supply to the action — in fixture mode the address is validated for format
only, and the fixture JSON is returned directly without a network call.

## Creating your own fixtures

You can capture a real Horizon response with `curl`:

```bash
curl -s "https://horizon.stellar.org/accounts/GABC...XYZ" > fixtures/my-account.json
# Scrub the real address to avoid committing contributor data:
sed -i 's/GABC...XYZ/GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF/g' fixtures/my-account.json
```

> **Privacy:** Never commit real contributor addresses or balance data.
> Replace `id` / `account_id` with the placeholder address shown in the
> existing fixtures before committing.

## Security note

Fixture mode bypasses the Horizon HTTP client entirely — no SSRF checks are
performed against the fixture path.  The path is resolved relative to the
GitHub Actions workspace root (`GITHUB_WORKSPACE`) and a path-traversal guard
prevents escaping outside the workspace.  Fixture mode is **never activated
unless `fixture_mode: true` is explicitly set** — the SSRF allowlist remains
fully enforced for all normal (non-fixture) runs.
