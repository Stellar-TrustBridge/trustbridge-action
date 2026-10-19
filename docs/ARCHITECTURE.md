# Architecture

This document describes the internal design of **trustbridge-action**: how data flows from a GitHub event through Horizon to an issue comment and workflow outcome.

Related docs: [README](../README.md) · [Structure](STRUCTURE.md) · [Usage](USAGE.md) · [Error handling](ERROR_HANDLING.md)

---

## Goals and constraints

1. **Deterministic checks** — Given a Stellar address and asset configuration, produce a repeatable pass/fail result from Horizon state.
2. **Actionable feedback** — Every failure path should yield human-readable remediation in the issue comment.
3. **GitHub Actions idioms** — Use `@actions/core` for inputs/outputs/failure and `@actions/github` for REST API access.
4. **Resilience** — Transient Horizon errors (timeouts, 503, rate limits) are retried; permanent errors (404, invalid address) fail fast.
5. **Testability** — Pure validation logic lives in `checks.ts`, isolated from I/O for unit testing.

---

## High-level components

```mermaid
graph LR
  subgraph GitHub
    EV[issues.assigned / workflow_dispatch]
    ISS[Issue comment API]
  end

  subgraph Action["trustbridge-action (Node 20)"]
    IDX[index.ts]
    CHK[checks.ts]
    HOR[horizon.ts]
    CMT[comment.ts]
  end

  subgraph External
    HZ[Stellar Horizon]
  end

  EV --> IDX
  IDX --> CHK
  IDX --> HOR
  HOR --> HZ
  IDX --> CMT
  CMT --> ISS
  CHK --> CMT
```

| Module | Responsibility |
|--------|----------------|
| `index.ts` | Read inputs, orchestrate fetch → validate → comment → fail/warn, set outputs |
| `horizon.ts` | HTTP client, response typing, retries, `HorizonError` |
| `checks.ts` | Address validation, trustline/XLM rules, result aggregation, validation-gate summary |
| `comment.ts` | Markdown rendering, Octokit `issues.createComment`, sticky comment upsert |

---

## Execution sequence

```mermaid
sequenceDiagram
  participant GH as GitHub Runner
  participant IDX as index.ts
  participant HOR as horizon.ts
  participant CHK as checks.ts
  participant CMT as comment.ts
  participant HZ as Horizon API

  GH->>IDX: Run action (inputs)
  IDX->>CHK: validateStellarAddress()
  alt invalid address
    CHK-->>IDX: throw
    IDX-->>GH: setFailed
  end
  IDX->>HOR: fetchAccount(url, address)
  loop up to 3 retries
    HOR->>HZ: GET /accounts/{id}
    HZ-->>HOR: 200 | 404 | 429 | 503 | timeout
  end
  alt 404 and wait_until_funded
    loop until funded or timeout budget exhausted
      HOR->>HZ: GET /accounts/{id}
    end
    HOR-->>IDX: HorizonAccount | HorizonError(404) on timeout
  else 404
    HOR-->>IDX: HorizonError(404)
    IDX->>CHK: unfundedAccountResult()
  else 200
    HOR-->>IDX: HorizonAccount
    IDX->>CHK: runAccountChecks()
  else other error
    HOR-->>IDX: HorizonError / throw
    IDX->>CHK: horizonFailureResult()
  end
  IDX->>IDX: setOutput(trustline_exists, xlm_balance, account_funded)
  IDX->>CMT: formatCommentBody() + postIssueComment()
  CMT->>GH: REST POST /issues/{n}/comments
  alt checks failed && fail_on_missing
    IDX-->>GH: setFailed
  else checks failed && !fail_on_missing
    IDX-->>GH: warning
  else
    IDX-->>GH: success
  end
```

---

## Data model

### HorizonAccount

Parsed from `GET /accounts/{account_id}`. The action primarily uses:

- `account_id` — canonical address
- `balances[]` — native XLM and credit assets
- `subentry_count`, `num_sponsoring`, `num_sponsored` — used to compute the sponsor-aware protocol minimum reserve (see [Check rules § 3](#3-xlm-reserve)). `num_sponsoring`/`num_sponsored` are optional — older Horizon snapshots omit them and they are treated as `0`.

### ValidationResult

Produced by `checks.ts`:

```typescript
interface ValidationResult {
  valid: boolean;
  accountFunded: boolean;
  trustlineExists: boolean;
  xlmBalance: string;
  xlmReserveMet: boolean;
  checks: CheckResultItem[];
  remediation?: string;
  reserveRequirement?: ReserveRequirement; // sponsor-aware reserve math (see § 3)
}
```

Each `CheckResultItem` maps to one ✅/❌ line in the issue comment.

---

## Check rules

### 1. Account funded

- **Pass:** Horizon returns HTTP 200 with account record.
- **Fail:** Horizon returns HTTP 404 (account not activated).

### 2. Asset trustline

- **Pass:** `balances` contains an entry where `asset_code` and `asset_issuer` match inputs (non-native).
- **Fail:** No matching entry. Message distinguishes **zero trustlines** vs **other trustlines present**.

### 3. XLM reserve

- **Pass:** Native balance ≥ `required`, where `required = max(protocolMinimum, min_xlm_reserve)`.
- **Fail:** Balance below `required`; remediation includes delta to send.

`protocolMinimum` is computed from the account itself — `(2 + subentry_count + num_sponsoring − num_sponsored) × 0.5 XLM` (CAP-0033) — so `min_xlm_reserve` acts as a floor override rather than the sole threshold. This makes the check accurate for accounts with sponsored trustlines (which don't count against the sponsoree's own reserve) as well as accounts with several unsponsored subentries. Default `1.5` for `min_xlm_reserve` reflects Stellar protocol economics: **1 XLM** minimum account balance + **0.5 XLM** base reserve per trustline subentry — the unsponsored one-subentry case.

---

## Horizon client design

`horizon.ts` implements:

| Feature | Implementation |
|---------|----------------|
| Timeout | `AbortController` per request (15s default) |
| Retries | Up to 3 on 429, 502, 503, 504, timeout |
| Backoff | Exponential (1s, 2s, 4s) or `Retry-After` header |
| 404 | Non-retryable `HorizonError` → unfunded path; never cached |
| URL normalization | Strips trailing slashes from `horizon_url` |
| Cache | Optional in-memory TTL cache (`use_cache` + `horizon_cache_ttl_ms`, default disabled), keyed on `(horizon_url, stellar_address)`. 404s are never cached as funded. |
| RPC fallback | On retry exhaustion, fails over to `horizon_url_fallback`/`rpc_fallback_url`. Refused by default when the fallback resolves to a different Stellar network than the primary — see `allow_cross_network_fallback`. |

Errors are classified as **retryable** vs **terminal** to avoid masking real problems with infinite loops.

---

## GitHub integration

### Triggers (consumer workflow)

This action does not define its own trigger — the **consumer** workflow listens to:

- `issues` → `types: [assigned]` — primary automation path
- `workflow_dispatch` — manual runs with optional address input

### Permissions

Minimum for commenting:

```yaml
permissions:
  issues: write
  contents: read
```

### Comment context

`comment.ts` uses `github.context.payload.issue.number`. If the action runs outside an issue context (e.g. bare `workflow_dispatch` without issue payload), posting is skipped with a warning — checks and outputs still run.

---

## Build and runtime

| Aspect | Choice |
|--------|--------|
| Runtime | `node20` (see `action.yml`) |
| Language | TypeScript → CommonJS (`ES2020`) |
| Entry | `dist/index.js` (compiled from `src/index.ts`) |
| HTTP | `node-fetch` v2 (CommonJS-compatible) |

The action ships compiled JavaScript in `dist/`. Consumers reference a release tag; they do not run `npm install` in the action repo.

## Release pipeline

The repository includes `.github/workflows/release.yml` to verify the shipped bundle before a tag release is cut.

The release job intentionally re-runs the same checks that protect the action at runtime:

1. Install dependencies with `npm ci`
2. Run `npm run lint`
3. Run `npm test`
4. Run `npm run build`
5. Confirm `dist/index.js` exists

This keeps the packaged action and the source-of-truth TypeScript code in sync before publishing a release tag.

---

## Extension points

Future enhancements that fit the current architecture:

1. **Soroban / smart contract checks** — new module parallel to `horizon.ts`. `validation.ts` already validates the StrKey shape of a contract (`C...`) `asset_issuer`; querying contract state over Soroban RPC is still open.
2. **Multi-asset trustlines** — `checks.ts` now exports `checkMultiAssetTrustlines` for validating an arbitrary list of assets in one call (Wave #32).
3. **PR comments** — extend `comment.ts` to detect `context.payload.pull_request`

See [CONTRIBUTING.md](../CONTRIBUTING.md) for proposing changes.

---

## Reusable workflow helpers (Wave #32)

`checks.ts` ships a set of workflow-composable helper functions extracted from the main validation pipeline. These are pure functions (no I/O) and can be imported directly by other tools in the Stellar ecosystem.

| Function | Signature | Purpose |
|---|---|---|
| `checkTrustlineExists` | `(account, code, issuer) → boolean` | Point check: does this account hold this specific trustline? |
| `checkReserveMet` | `(account, minReserve) → boolean` | Point check: is native XLM balance ≥ threshold? |
| `validateStrKeyFormat` | `(address) → boolean` | Validates G-address or C-address StrKey shape without throwing |
| `checkMultiAssetTrustlines` | `(account, assets[]) → Result[]` | Batch-checks required and optional trustlines |
| `calculateRecommendedReserve` | `(trustlineCount) → number` | Stellar reserve formula: 1 XLM base + 0.5 XLM × entries |
| `checkAccountSponsored` | `(account) → boolean` | True if `num_sponsored > 0` (reduces effective reserve requirement) |
| `generateValidationReport` | `(account, config, extras?) → ValidationReport` | Full structured report for dashboards or release automation |

### ValidationReport shape

```typescript
interface ValidationReport {
  address: string;
  strKeyValid: boolean;
  accountFunded: boolean;
  xlmBalance: string;
  reserveStatus: { current: number; required: number; met: boolean; deficit: string };
  trustlines: Array<{ asset: string; issuer: string; exists: boolean }>;
  sponsored: boolean;
  timestamp: string; // ISO 8601
}
```

---

## Parser fuzz & property tests (Wave #39)

The test suite now includes three test files that benchmark parser resilience:

| Test file | Scope |
|---|---|
| `__tests__/parser-fuzz.test.ts` | Property/fuzz tests for every parser function. Exercises boundary cases, injection payloads, and random inputs. Includes `Performance benchmarks` suite (10k iterations each). |
| `__tests__/e2e-parser-harness.test.ts` | Full pipeline tests wired through jest.fn() HTTP mocks. Covers success, 404, 503, 429 retry, malformed response shapes, 100-contributor scale, and comment snapshot assertions. |
| `__tests__/reusable-workflows.test.ts` | Unit and integration tests for all Wave #32 workflow helpers. Includes DAO onboarding, treasury sponsorship, and multi-asset gateway scenarios. |

---

## Security considerations

- **No secrets in logs** — addresses are public; tokens are never logged.
- **`github_token` scope** — use least privilege (`issues: write` only where needed).
- **Horizon URL** — consumers on testnet should pass testnet Horizon explicitly; do not rely on address format alone.
- **Input validation** — G-address regex prevents malformed Horizon paths and log injection in comments.
- **Markdown escaping** — `checks.ts` escapes dynamic content (Horizon error text, asset code/issuer, account addresses) via `markdown.ts` before it's embedded in a check detail, so untrusted text (e.g. a `detail`/`title` field from a misconfigured or malicious `horizon_url`) can't inject Markdown formatting, links, or break out of the code spans rendered in the issue comment.

---

[← Back to README](../README.md)
