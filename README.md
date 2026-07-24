# TrustBridge Action

[![CI](https://github.com/Stellar-TrustBridge/trustbridge-action/actions/workflows/ci.yml/badge.svg)](https://github.com/Stellar-TrustBridge/trustbridge-action/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**TrustBridge Action** is a GitHub Action that validates Stellar accounts before sensitive workflow steps — such as assigning bounty issues, granting repository access, or releasing payments. It queries the [Stellar Horizon API](https://developers.stellar.org/docs/data/apis/horizon), verifies that an account is funded, holds a trustline for a configured asset (USDC by default), and meets a minimum XLM reserve. Results are posted as a formatted comment on the GitHub issue with clear remediation steps.

---

## Why TrustBridge?

Open-source programs and DAOs often gate contributions on Stellar wallet readiness. Manual verification does not scale. TrustBridge automates the check at the moment an issue is assigned (or on demand), giving contributors immediate feedback and maintainers confidence that payout prerequisites are met.

| Problem | TrustBridge solution |
|--------|----------------------|
| Contributor assigned before wallet is ready | Runs automatically on `issues` → `assigned` |
| Unclear setup instructions | Posts a Markdown comment with ✅/❌ per check and links to Stellar Lab / LOBSTR |
| Silent CI failures | Configurable `fail_on_missing` to fail or warn |
| Custom assets / testnet | All Horizon and asset inputs are configurable |
| Re-runs spam the issue with duplicate comments | `sticky_comment` (default `true`) updates the previous TrustBridge comment in place |

---

## Quick start

Add a workflow file (e.g. `.github/workflows/trustbridge.yml`) in the **consumer repository**:

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
      - name: Resolve Stellar address
        id: address
        run: |
          if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
            echo "address=${{ github.event.inputs.stellar_address }}" >> "$GITHUB_OUTPUT"
          else
            # Example: read from issue body — customize for your project
            echo "address=GYOURCONTRIBUTORADDRESSHERE" >> "$GITHUB_OUTPUT"
          fi

      - name: TrustBridge check
        uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: ${{ steps.address.outputs.address }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          fail_on_missing: true
```

See [docs/USAGE.md](docs/USAGE.md) for advanced patterns (custom assets, testnet, extracting addresses from issue templates).

---

## Inputs

| Input | Required | Default | Description |
| -------- | ---------- | --------- | ------------- |
| `stellar_address_input` | **Yes** | — | Stellar public key (G-address, 56 characters) to validate |
| `github_token` | **Yes** | — | Token with `issues: write` to post comments (`GITHUB_TOKEN` is typical) |
| `horizon_url` | No | `https://horizon.stellar.org` | Horizon API base URL (use testnet URL for testing) |
| `asset_code` | No | `USDC` | Asset code for trustline verification |
| `asset_issuer` | No | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` | Issuer address for the asset |
| `min_xlm_reserve` | No | `1.5` | Minimum native XLM balance required |
| `debug_mode` | No | `false` | Enable extra action logs for troubleshooting |
| `horizon_timeout_ms` | No | `15000` | Horizon request timeout in milliseconds |
| `sticky_comment` | No | `true` | Update TrustBridge's previous issue comment instead of posting a new one each run |
| `wait_until_funded` | No | `false` | Poll Horizon until the account is funded instead of failing on the first 404 |
| `wait_until_funded_timeout_ms` | No | `120000` | Max time to poll for funding, in milliseconds (0-600000) |
| `wait_until_funded_interval_ms` | No | `5000` | Delay between funding polls, in milliseconds (1000-60000) |
| `fail_on_missing` | No | `true` | `true` → `core.setFailed()`; `false` → warning only |

Full input semantics and output reference: [docs/USAGE.md](docs/USAGE.md).

---

## Outputs

| Output | Type | Description |
| -------- | ------ | ------------- |
| `trustline_exists` | boolean (string) | `true` if the configured asset trustline exists |
| `xlm_balance` | string | Native XLM balance from Horizon (or `0` / `unknown`) |
| `account_funded` | boolean (string) | `true` if Horizon returned an active account |
| `comment_url` | string | URL to the created issue comment when run in issue context |

Use outputs in downstream steps:

```yaml
- name: TrustBridge check
  id: trustbridge
  uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ steps.address.outputs.address }}
    github_token: ${{ secrets.GITHUB_TOKEN }}

- name: Continue only if funded
  if: steps.trustbridge.outputs.account_funded == 'true'
  run: echo "Account is active"
```

---

## Soroban contract asset issuers

`asset_issuer` normally holds a classic Stellar issuer address (`G...`). If you pass a Soroban contract address (`C...`) instead — e.g. for a SEP-41 fungible token contract — TrustBridge validates it against the Stellar StrKey contract-address policy (56 characters, `C` prefix, base32 alphabet) before proceeding. An invalid contract address fails the run immediately with a clear error instead of reaching Horizon or being written into the metrics/JSON output. Valid contract addresses are recorded as a metric point (`asset_issuer_contract_validated`) tagged with the contract address, visible in the metrics summary logged under `debug_mode: true`.

---

## Waiting for a contributor to fund their account

By default, TrustBridge checks the account once: if Horizon returns 404 (not funded), the run immediately posts an unfunded result. For workflows where a contributor is expected to fund their wallet moments after assignment (e.g. a bot nudges them to send XLM as part of onboarding), set `wait_until_funded: true` to poll instead of failing on the first miss:

```yaml
with:
  stellar_address_input: ${{ steps.address.outputs.address }}
  github_token: ${{ secrets.GITHUB_TOKEN }}
  wait_until_funded: true
  wait_until_funded_timeout_ms: 120000   # give up after 2 minutes
  wait_until_funded_interval_ms: 5000    # poll every 5 seconds
```

Only a Horizon 404 ("account not found") triggers a poll. Rate limits, timeouts, and other Horizon errors are not treated as "not yet funded" — they surface immediately as a failure result so a Horizon outage can't turn into a silent multi-minute hang.

---

## Example issue comment

When checks fail, TrustBridge posts a comment like:

```markdown
## TrustBridge — Stellar Account Check

Checked account: `GABC...XYZ`
Horizon: `https://horizon.stellar.org`
Asset: **USDC** · Issuer: `GA5ZSEJ...KZVN`

### Results

- ❌ **Account funded** — Account `GABC...` was **not found** on Horizon...
- ❌ **USDC trustline** — Cannot verify trustline until the account exists.
- ❌ **XLM reserve** — Cannot verify XLM balance...

### Balances

- **XLM balance:** `0 XLM`
- **Minimum required:** `1.5 XLM`

### Setup cost estimate

- Stellar minimum account balance: **1 XLM**
- Base reserve per trustline: **0.5 XLM**
- Typical minimum to fund account + one trustline: **~1.5 XLM**

### Add a trustline

- [View account on Stellar Laboratory](https://laboratory.stellar.org/...)
- [Open Transaction Builder (Change Trust)](https://laboratory.stellar.org/#txbuilder?network=public)
- [LOBSTR wallet](https://lobstr.co/)

### Remediation

Activate `GABC...` by sending at least **1 XLM**...
```

---

## How it works

```mermaid
flowchart TD
  A[GitHub issues.assigned or workflow_dispatch] --> B[Read action inputs]
  B --> C{Valid G-address?}
  C -->|No| D[Fail fast]
  C -->|Yes| E[GET Horizon /accounts/{address}]
  E --> F{Response}
  F -->|404, wait_until_funded=false| G[Unfunded account result]
  F -->|404, wait_until_funded=true| W{Timeout budget left?}
  W -->|Yes| WS[Sleep poll interval] --> E
  W -->|No| G
  F -->|429/503/timeout| H[Retry with backoff]
  H --> E
  F -->|200| I[Run trustline + XLM checks]
  G --> J[Format Markdown comment]
  I --> J
  J --> K[Post issue comment]
  K --> L{All checks pass?}
  L -->|Yes| M[Success + set outputs]
  L -->|No| N{fail_on_missing?}
  N -->|true| O[setFailed]
  N -->|false| P[warning]
```

Deep dive: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Repository layout

```
trustbridge-action/
├── action.yml              # Action metadata and inputs/outputs
├── src/
│   ├── index.ts            # Entrypoint — orchestrates the run
│   ├── horizon.ts          # Horizon HTTP client
│   ├── checks.ts           # Validation logic
│   └── comment.ts          # Issue comment formatting
├── __tests__/              # Jest unit tests
├── docs/                   # Extended documentation
├── .github/workflows/ci.yml
├── README.md
└── CONTRIBUTING.md
```

Details: [docs/STRUCTURE.md](docs/STRUCTURE.md).

---

## Development

```bash
git clone https://github.com/Stellar-TrustBridge/trustbridge-action.git
cd trustbridge-action
npm ci
npm test          # unit tests
npm run lint      # ESLint
npm run build     # compile TypeScript → dist/
```

Contributing guidelines: [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Error handling

TrustBridge handles common failure modes from Horizon and invalid input:

| Scenario | Behavior |
|----------|----------|
| Invalid G-address | Fails before Horizon call |
| Account not found (404) | `account_funded=false`, remediation comment |
| Horizon 429 / 503 / timeout | Exponential backoff retries, then failure result |
| Account with zero trustlines | Trustline check fails with specific message |
| Comment post failure | Warning logged; check result still applied |

Full matrix: [docs/ERROR_HANDLING.md](docs/ERROR_HANDLING.md).

---

## Documentation index

| Document | Purpose |
|----------|---------|
| [README.md](README.md) | Overview, quick start, inputs/outputs (this file) |
| [docs/USAGE.md](docs/USAGE.md) | Workflow recipes and configuration examples |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, data flow, module responsibilities |
| [docs/STRUCTURE.md](docs/STRUCTURE.md) | File and directory reference |
| [docs/ERROR_HANDLING.md](docs/ERROR_HANDLING.md) | Error cases and retry behavior |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute, PR checklist, release process |

---

## License

MIT — see [LICENSE](LICENSE).

---

## Acknowledgments

Built for the Stellar open-source ecosystem. Horizon data provided by the [Stellar Development Foundation](https://stellar.org). Wallet setup links reference [Stellar Laboratory](https://laboratory.stellar.org) and [LOBSTR](https://lobstr.co/).
