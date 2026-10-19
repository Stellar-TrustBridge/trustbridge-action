# Architecture

This document describes the internal structure of the TrustBridge Action and how its components interact. For operational guidance and FAQs, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

## Logging and Stellar address masking

The action emits diagnostics through `src/logger.ts`. Before any line reaches the Actions log, the logger runs a redaction pass so that Stellar addresses are not leaked into CI logs, which may be retained and shared by reviewers.

### Redacted patterns

Redaction is driven by two regular expressions in `src/logger.ts`:

- `STELLAR_ADDRESS_REGEX` — matches standard Stellar account (`G...`) and contract (`C...`) addresses (56-character StrKey encodings).
- `MUXED_ADDRESS_REGEX` — matches muxed account (`M...`) addresses, which embed a 64-bit memo ID alongside the underlying `G` address.

When a match is found, the address is replaced with a masked placeholder (e.g. `GABC...WXYZ` style truncation) so operators can still correlate log lines without exposing the full value. The redaction helpers are applied to every `core.info`, `core.debug`, `core.warning`, and `core.error` call routed through the logger.

### Context key allowlist

The logger accepts a structured context object. Only keys on an explicit allowlist (e.g. `operation`, `status`, `count`, `durationMs`) are serialized verbatim. Unknown keys are dropped rather than stringified, preventing accidental leakage of raw payload fields that may contain addresses.

### Exceptions

- **Comment bodies** posted to GitHub are *not* passed through the logger redactor. Comments are user-facing output and may legitimately contain full addresses (for example, a confirmation of the account that was funded). Review comment templates before enabling them in public repos.
- **Webhook payloads** received from GitHub are logged only after passing through the same redaction helpers; raw payloads are never emitted directly.
- **Federation responses** may contain addresses in free-form fields. These are redacted when logged, but partial addresses embedded in error messages are only masked if they match the regexes above — malformed or truncated addresses may slip through, so avoid logging raw error strings from federation calls.

### Example

Before redaction:

```
Funding account GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV
```

After redaction:

```
Funding account GABC...STUV
```

### Behavioral contract

`__tests__/logger.test.ts` is the authoritative specification for redaction behavior. It covers `G`, `C`, and `M` address masking, context allowlist enforcement, and the comment-body exception. Any change to `src/logger.ts` must keep these tests green; treat them as the source of truth when in doubt.

### privacy_mode

`privacy_mode` is a separate control from log redaction and affects *outputs* (comments and webhook responses) rather than the Actions log itself:

- When `privacy_mode` is enabled, generated comment bodies omit full addresses and use masked forms, and webhook responses redact address fields.
- When disabled, comments and webhook responses may include full addresses, while the Actions log remains redacted regardless.

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
| Latency histogram | Every fetch attempt (success, 404, exhausted-retries) records its wall-clock latency into `globalHorizonHistogram` (`HorizonLatencyHistogram` in `metrics.ts`), bucketed by `[50, 100, 250, 500, 1000, 2500, 5000, +Inf]` ms and labelled `primary` or `fallback`. The snapshot is included in the Job Summary JSON artifact under `horizonFetchLatencyHistogram`. No raw addresses or URLs are stored — only the endpoint kind tag and the numeric value. |

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
