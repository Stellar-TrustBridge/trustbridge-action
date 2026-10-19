# TrustBridge Comment Guide

This document describes how TrustBridge formats issue comments, how FAQ deep links are generated and kept in sync, and the rules contributors must follow when adding new check CTAs.

---

## Comment structure

Every TrustBridge issue comment follows a fixed section order:

1. **Hidden markers** — `<!-- trustbridge-action:sticky-comment:schema-v… -->` and a snooze marker. Used for upsert detection and snooze state.
2. **Header** — `## TrustBridge — Stellar Account Check`
3. **Account/Horizon/Asset summary** — checked account address, Horizon URL, and asset identity.
4. **Results** — one bullet per check (`✅`/`❌`), with a `[→ FAQ]` link on each failing check.
5. **Circuit-breaker banner** *(only when the Horizon circuit breaker was open)* — see [Circuit-breaker banner](#circuit-breaker-banner-issue-434).
6. **Onboarding checklist** — a GitHub Markdown task-list showing fund → trustline → verify balance (default `on`, disable via `onboarding_checklist: false`).
7. **Optional sections** (in order): ledger freshness alert, network-passphrase mismatch, delta section, validation gate, balances, setup cost estimate, Stellar Lab / LOBSTR links, SEP-0007 deep links, SEP-0010 proof, remediation, configuration summary, action outputs reference, hardened metrics, expert diagnostics (debug mode only).
8. **Footer** — `_Posted by [trustbridge-action](…)_`

---

## Comment threading & posting modes (`comment_mode` & `posting_mode`)

TrustBridge separates the comment posting policy from the comment threading strategy:

### Posting policy (`posting_mode`)

- **`post`** (default): Post or update comments on GitHub.
- **`dry-run`**: Build comment body and set all action outputs, but skip GitHub API calls to post comments.
- **`off`**: Skip comment posting; validation and action outputs still run.

`posting_mode` controls whether the comment is posted; `comment_mode` controls how a posted comment is threaded. For backwards compatibility only, legacy `post`, `dry-run`, or `off` values in `comment_mode` are treated as `posting_mode` when `posting_mode` is omitted. New workflows should use the inputs independently.

### Threading strategy (`comment_mode`)

- **`sticky`** (default): Find and update TrustBridge's previous comment in place on the issue or discussion (`sticky_comment: true`).
- **`new`**: Always post a fresh top-level comment on every run (`sticky_comment: false`), providing a complete audit log.
- **`reply`**: Thread comments chronologically under the first TrustBridge check comment.

#### Reply mode implementation & GitHub API behavior (Issue #419)

GitHub's REST API for Issues (`/repos/{owner}/{repo}/issues/{issue_number}/comments`) does not support a native `in_reply_to` parameter (which is exclusive to pull request review comments).

When `comment_mode: 'reply'` is configured, TrustBridge:
1. Locates the **first (oldest)** TrustBridge comment on the issue using `findFirstTrustBridgeComment` (via GraphQL pagination with REST fallback).
2. If an existing TrustBridge comment is found (e.g. comment `#12345`), TrustBridge prepends a Markdown reference header to the comment body:
```markdown
> _Reply to [TrustBridge check #12345](https://github.com/owner/repo/issues/1#issuecomment-12345)_
```
3. If no previous TrustBridge comment exists on the issue, TrustBridge posts the initial comment cleanly without a reply prefix.
4. On GitHub Discussions, TrustBridge uses GraphQL `addDiscussionComment` with `replyToId` to post threaded replies in the discussion thread.

### `comment_id` output (Issue #696)

Every successful post publishes the numeric REST comment id as the `comment_id` action output, next to `comment_url`. `upsertIssueComment` in `src/comment.ts` returns `{ url, id }` from the response of whichever call actually wrote the body, and `setValidationOutputs` publishes it.

How `posting_mode` and `comment_mode` decide between update and create:

| `posting_mode` | `comment_mode` (`sticky_comment`) | Prior TrustBridge comment | API call | `comment_id` |
| --- | --- | --- | --- | --- |
| `post` | `sticky` (`true`) | found | `issues.updateComment` | id of the existing comment |
| `post` | `sticky` (`true`) | found, but update fails | `issues.createComment` (fallback) | id of the **new** comment |
| `post` | `sticky` (`true`) | not found / lookup fails | `issues.createComment` | id of the new comment |
| `post` | `sticky` (`true`) | found, snooze window active | none | id of the existing comment |
| `post` | `new` (`false`) | any | `issues.createComment` | id of the new comment |
| `post` | `reply` | any | `issues.createComment` (with reply header) | id of the reply |
| `dry-run` | any | any | none | `""` |
| `off` | any | any | none | `""` |

Notes:

- With an explicit `issue_number` (e.g. `workflow_dispatch`), the lookup and the id refer to that issue. With no issue or PR context the post is skipped with a warning and `comment_id` is `""`; the job is not failed.
- A failed post is downgraded to a warning and leaves `comment_id` empty.
- The id is always a REST issue-comment id. Discussion comments (GraphQL node ids such as `DC_…`) are not published as `comment_id`.
- `comment_id` is not part of the dashboard webhook payload, so `privacy_mode` has nothing extra to redact.

See [USAGE.md — `comment_id`](USAGE.md#comment_id--chaining-a-follow-up-edit-issue-696) for a workflow that edits the comment in a later step.

---
## FAQ deep links

### How they work

Every failing check bullet in the **Results** section automatically appends a `[→ FAQ]` link that takes contributors straight to the relevant section of `docs/FAQ.md`. This is implemented in `src/comment.ts` via `buildFaqLinkForCheck` from `src/links.ts`.

The onboarding checklist items (Fund account / Add trustline / Verify XLM balance) also carry FAQ links, generated in `src/markdown.ts` via `buildOnboardingChecklist`. The label text is localized (Issue #436), but the anchors are locale-independent.

### Anchor registry

All FAQ anchor names are declared in `src/links.ts` in the `FAQ_ANCHORS` constant:

- The checked Stellar account.
- The Horizon endpoint used for verification.
- The target asset code and issuer.
- Per-check status for funding, trustline readiness, and XLM reserve.
- An optional **Onboarding checklist** (default on via `onboarding_checklist: true`) with Markdown task-list checkboxes that auto-check from live `ValidationResult` state, plus FAQ links for each step.
- A machine-readable validation-gate summary that callers can use to tell whether the run is release-ready or blocked.
- Links to Stellar Laboratory and LOBSTR for remediation.

## Validation gate

The **Validation gate** section is the machine-readable verdict that mirrors the `ready` and `reason_code` action outputs, so a dashboard triager can read the outcome straight from the comment instead of digging through the Actions log (Issue #450).

```markdown
### Validation gate

- Ready to proceed: all checks passed.
- Passed checks: 3/3
- Failed checks: 0
- Ready: `true`
- Reason code: `SUCCESS`
```

On a blocked run the first bullet becomes `Blocked by: <failed check labels>` and `Ready` / `Reason code` reflect the failure.

| Field | Source | Fallback |
| --- | --- | --- |
| `Ready` | `buildValidationGate(result).ready` | Always present |
| `Reason code` | `result.reasonCode` | `SUCCESS` when `result.valid`, otherwise `FAILED` |

The fallback is the same contract the `reason_code` action output uses, so the comment and the output never disagree. `Reason code` is rendered inside a code span, so snake_case values stay literal and copy-pasteable; only backticks are neutralized.

All labels in this section are localized (Issue #450): `en`, `es`, `pt`, `ja`, `fr`, `de`.

---

## Multi-check failure summaries (Issue #761)

When a single run fails more than one check, the **Results** section lists every failing bullet in the fixed check order (funding → trustline → XLM reserve → per-asset trustlines → clawback → authorization), each with its own `[→ FAQ]` link. The **Validation gate** then aggregates them into one `Blocked by:` line so a triager can read the whole failure set without scanning the log.

These examples show the combinations Wave contributors hit most often. They are illustrative — the exact wording comes from `src/markdown.ts` and the labels from `src/i18n.ts`.

### Example A — multi-asset + clawback + unauthorized

A run with `assets_json` listing two assets, where the primary asset is clawback-enabled and the account is not authorized for one of the listed assets:

```markdown
### Results

- ✅ Account funded
- ✅ Trustline ready for `USDC:GA5Z…KZVN`
- ❌ XLM reserve below minimum [→ FAQ](docs/FAQ.md#xlm-reserve)
- ❌ Trustline missing for `EURC:GCQT…KRR2` [→ FAQ](docs/FAQ.md#asset-trustlines)
- ❌ Asset `USDC:GA5Z…KZVN` has clawback enabled [→ FAQ](docs/FAQ.md#clawback)
- ❌ Account not authorized for `EURC:GCQT…KRR2` [→ FAQ](docs/FAQ.md#authorization)

### Validation gate

- Blocked by: XLM reserve, Asset trustlines, Clawback, Authorization
- Passed checks: 2/6
- Failed checks: 4
- Ready: `false`
- Reason code: `FAILED`
```

### Example B — multi-asset only (no clawback, no authorization)

```markdown
### Results

- ✅ Account funded
- ✅ Trustline ready for `USDC:GA5Z…KZVN`
- ✅ XLM reserve sufficient
- ❌ Trustline missing for `EURC:GCQT…KRR2` [→ FAQ](docs/FAQ.md#asset-trustlines)
- ❌ Trustline missing for `FOO:GA5Z…KZVN` [→ FAQ](docs/FAQ.md#asset-trustlines)

### Validation gate

- Blocked by: Asset trustlines
- Passed checks: 3/5
- Failed checks: 2
- Ready: `false`
- Reason code: `FAILED`
```

### Example C — clawback + unauthorized (single asset)

```markdown
### Results

- ✅ Account funded
- ✅ Trustline ready for `USDC:GA5Z…KZVN`
- ✅ XLM reserve sufficient
- ❌ Asset `USDC:GA5Z…KZVN` has clawback enabled [→ FAQ](docs/FAQ.md#clawback)
- ❌ Account not authorized for `USDC:GA5Z…KZVN` [→ FAQ](docs/FAQ.md#authorization)

### Validation gate

- Blocked by: Clawback, Authorization
- Passed checks: 3/5
- Failed checks: 2
- Ready: `false`
- Reason code: `FAILED`
```

### Example D — happy path (all checks pass)

```markdown
### Results

- ✅ Account funded
- ✅ Trustline ready for `USDC:GA5Z…KZVN`
- ✅ XLM reserve sufficient
- ✅ Trustline ready for `EURC:GCQT…KRR2`
- ✅ Asset `USDC:GA5Z…KZVN` has no clawback
- ✅ Account authorized for `EURC:GCQT…KRR2`

### Validation gate

- Ready to proceed: all checks passed.
- Passed checks: 6/6
- Failed checks: 0
- Ready: `true`
- Reason code: `SUCCESS`
```

### Rules for multi-check summaries

- **Order is stable.** Failing bullets follow the fixed check order above so diffs between runs stay readable and sticky-comment updates don't reshuffle lines.
- **One FAQ link per failing bullet.** Never collapse multiple failures into a single bullet — each failure keeps its own `[→ FAQ]` anchor so remediation is one click away.
- **`Blocked by:` lists every failed check label**, comma-separated, in the same order as the Results bullets. It is derived from the same `ValidationResult` the `reason_code` output uses, so the comment and the output never disagree.
- **`Passed checks` / `Failed checks`** count every check that ran, including per-asset trustline checks from `assets_json`.
- **Clawback and authorization failures are distinct checks.** A clawback-enabled asset and an unauthorized account are separate bullets with separate FAQ anchors; do not merge them.
- **Empty or malformed `assets_json`** is ignored (no per-asset bullets) and never produces a partial privileged state — the run either renders the full set or omits the section entirely, matching the single-asset golden snapshots.

Implementation: `buildResults` and `buildValidationGate` in `src/markdown.ts`, wired into `formatCommentBody` in `src/comment.ts`; labels localized in `src/i18n.ts`.

---

## Per-asset trustline table (`assets_json`) (Issue #552)

When the workflow sets `assets_json`, the run checks trustlines for every listed asset in addition to the primary `asset_code`/`asset_issuer` pair. The results are rendered as a dedicated table directly after the **Balances** section — matching the behaviour `action.yml` documents for the `assets_trustline_status` / `trustlines_summary` outputs.

```markdown
### Asset trustlines

| Asset | Trustline | Balance | Issuer |
| --- | --- | --- | --- |
| EURC | ✅ exists | `12.5000000` | `GCQT…KRR2` |
| FOO | ❌ missing | `0` — no trustline | `GA5Z…KZVN` |
```

Rendering rules:

- **Section is omitted entirely** when `assets_json` is unset, empty, or every entry was deduplicated against the primary asset — single-asset comments are byte-identical to previous releases (golden snapshots unchanged).
- Asset codes are escaped through `escapeMarkdownInline`, so a code containing `|`, `*`, `[`, or backticks cannot break out of the table or inject Markdown structure.
- Issuers are shortened to `first4…last4` inside inline code to keep the table compact; the full address remains visible in workflow logs and the validation JSON artifact.
- A missing trustline renders its balance as `` `0` — no trustline ``; a Horizon error renders `_unknown_`.

Implementation: `buildAssetTrustlineTable` in `src/markdown.ts`, wired into `formatCommentBody` via the `CommentConfig.assets` field (`src/comment.ts`), populated from the `assets_json` multi-asset check in `src/index.ts`.

---

## Circuit-breaker banner (Issue #434)

When the Horizon circuit breaker is open, `CircuitBreaker.execute` fast-fails the request **without contacting Horizon at all**. Nothing is known about the account, so the comment says so explicitly instead of rendering a list of account checks that look like ordinary failures:

```markdown
> ⚡ **Circuit breaker open**
> - This run fast-failed because the Horizon circuit breaker was open — the account was **not** checked.
> - This is a resilience safeguard, not a problem with the account. Wait for the recovery window to elapse, then re-run the workflow.
```

The banner is rendered by `buildCircuitBreakerBanner` in `src/markdown.ts` and is mutually exclusive with the normal Results bullets: when the breaker is open, the comment does not claim any per-check outcome. This preserves the existing pause semantics — a paused run never reports a false failure.
