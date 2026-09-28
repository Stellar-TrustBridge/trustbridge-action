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
- **`off`**: Completely skip comment generation.

> **Backwards compatibility:** If `posting_mode` is omitted and `comment_mode` is set to `post`, `dry-run`, or `off`, TrustBridge automatically falls back to treating `comment_mode` as the posting policy.

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

## Circuit-breaker banner (Issue #434)

When the Horizon circuit breaker is open, `CircuitBreaker.execute` fast-fails the request **without contacting Horizon at all**. Nothing is known about the account, so the comment says so explicitly instead of rendering a list of account checks that look like ordinary failures:

```markdown
> ⚡ **Circuit breaker open**
> - This run fast-failed because the Horizon circuit breaker was open — the account was **not** checked.
> - This is a resilience safeguard, not a problem with the account. Wait for the recovery window to elapse, then re-run the workflow. …
> - Reason code: `CIRCUIT_OPEN`
```

Key properties:

- **Distinct reason code.** `CIRCUIT_OPEN`, not `HORIZON_ERROR`. A `HORIZON_ERROR` implies Horizon answered and the answer was bad; a tripped circuit means the request never left the process. Conflating the two sends triagers hunting for a broken endpoint or a misconfigured account that may not exist.
- **Fails closed.** `ready: false`, `accountFunded: false`, and all balances `unknown`. Unknown is reported as unknown rather than as zero.
- **Recovery hint.** The banner tells the contributor to wait for the recovery window and re-run, and points at `horizon_url` / `max_retries` if it keeps happening.
- **PII-safe.** The banner carries no account address, issuer, balance, or endpoint URL — only the fact that the breaker tripped. Balances stay `_unknown_` rather than leaking a stale figure.
- **Localized.** Rendered from the `circuitBreaker*` string pack in `src/i18n.ts`.

The signal flows `CircuitOpenError` (`src/resilience.ts`) → `HorizonCircuitOpenError` (`src/horizon.ts`) → `circuitOpenFailureResult` (`src/checks.ts`) → `ValidationResult.circuitOpen` → this banner (`src/comment.ts`). `HorizonCircuitOpenError` extends `HorizonError`, so existing `instanceof HorizonError` handling keeps working.

---

## Onboarding checklist

When `onboarding_checklist` is enabled (the default), the comment includes a concise guided path:

1. Fund account
2. Add trustline
3. Verify XLM balance

Each item is a GitHub Markdown task-list checkbox (`- [x]` / `- [ ]`) driven by `accountFunded`, `trustlineExists`, and `xlmReserveMet`. Boxes are comment-only — they are not synced via the GitHub Projects task-list API. FAQ links point at [FAQ.md](FAQ.md) anchors.

Set `onboarding_checklist: false` to omit the section entirely (e.g. for expert-only workflows).

### Localized checklist labels (Issue #436)

The checklist heading and all three labels come from the locale string pack in `src/i18n.ts` (`checklistHeading`, `checklistFundAccountLabel`, `checklistTrustlineLabel`, `checklistReserveLabel`, …), so a `locale: es` comment no longer mixes English checklist copy into a translated comment:

```markdown
### Lista de incorporación

_Completa estos pasos en orden. Las casillas se actualizan automáticamente con las comprobaciones de Horizon._

- [x] **Financiar la cuenta** — Activa la cuenta con XLM. ([FAQ](…#account-not-funded))
- [ ] **Añadir línea de confianza USDC** — Configura la línea de confianza del activo. ([FAQ](…#trustline-missing))
- [x] **Verificar saldo XLM** — Alcanza la reserva de **1.5 XLM**. ([FAQ](…#xlm-reserve-too-low))
```

All six locales ship the checklist strings; the import-time guard in `src/i18n.ts` fails fast if a new locale is added without them.

**Extraction is locale-resilient.** `extractChecklistState` recognises the checklist heading and labels in *every* supported locale by default, so switching `locale` between runs does not silently discard manually-checked boxes. Pass `{ locale }` to restrict parsing to a single locale.

The per-locale trustline label is dynamic (it embeds the asset code), so the parser derives the literal prefix/suffix around the asset code from the locale's own label template instead of hard-coding per-locale affixes. State is keyed on the locale-independent canonical keys (`Fund account`, `trustline`, `Verify XLM balance`), which is what makes state survive a locale switch.

### Checklist state persistence across sticky updates (Issue #311)

By default, every sticky update rebuilds the checklist from live Horizon data. This means that if a contributor manually checks a box in GitHub (e.g. they have funded their account but Horizon hasn't indexed the transaction yet), the next run could overwrite their check with an unchecked state.

**TrustBridge now preserves checked boxes across sticky updates.** When a sticky update runs, the action:

1. Fetches the existing sticky comment body.
2. Parses the previous checklist section with `extractChecklistState()` to recover which boxes were checked.
3. Merges that prior state into the new checklist: a box is checked if **either** the live Horizon check passes **or** the previous comment had the box checked.

This ensures contributor-manually-checked boxes survive re-runs even when Horizon hasn't caught up yet — including across a change of `locale`.

#### Merge semantics

| Live Horizon result | Previous box state | Final rendered state |
|--------------------|--------------------|---------------------|
| ✅ pass | checked or unchecked | `[x]` (live truth wins) |
| ❌ fail | checked | `[x]` (manual check preserved) |
| ❌ fail | unchecked | `[ ]` (stays unchecked) |
| ❌ fail | (no prior state) | `[ ]` (stays unchecked) |

A live pass always checks the box, regardless of prior state. A live fail only checks the box if the contributor (or a previous run) had it checked before.

#### Security: injection guard

The checklist parser is scoped to the checklist section only (it stops at the next `###` heading) and matches only a fixed allowlist of known label names, in every supported locale:

- `Fund account` / localized equivalents
- `Add <ASSET_CODE> trustline` and its per-locale equivalents (asset code must be ASCII-printable)
- `Verify XLM balance` / localized equivalents

No user-controlled label text is used as a map key. A maliciously crafted comment body cannot inject unexpected checked state for arbitrary labels or sections. Asset code strings with non-ASCII or control characters are rejected silently.

## SEP-0010 challenge proof (Issue #252)

To prove wallet control, you can include a SEP-0010 challenge snippet in the comment:

- **Dashboard Freighter proof (preferred):** set `sep0010_dashboard_url` to an `https` dashboard URL (e.g. `https://your-dashboard.example/verify?address=G…`). The comment shows: *“Proof of wallet control (SEP-0010) — [Open dashboard proof](url)”* with network context. The link is informational and **does not block `ready`** unless your workflow explicitly gates on it. The URL must be `https` and not a private/loopback host; invalid URLs are silently omitted so comment posting is never blocked.
- **Raw challenge XDR (fallback):** set `sep0010_challenge_xdr` to a base64 XDR string. The comment shows a truncated `24…8` snippet with signing instructions and a SEP-0010 link. Raw nonces are truncated in the comment and never logged; do not reuse a challenge — prefer the dashboard link when possible.

When both are set, the dashboard link wins (no raw XDR rendered). The section is size-capped; if the total comment exceeds GitHub’s 65k limit, the snippet is included in the truncated report (`trustbridge-report.md`). See `src/links.ts:buildSep0010ChallengeSnippet` and `src/comment.ts` for the exact rendering.

```yaml
with:
  sep0010_dashboard_url: https://your-dashboard.example/verify?address=GABC...
  # or
  sep0010_challenge_xdr: AAAA...
```

Every value maps 1-to-1 to a heading in `docs/FAQ.md` that uses the explicit `{#anchor-id}` syntax, for example:

```markdown
## Account not funded {#account-not-funded}
```

### Check label → anchor mapping

`getFaqAnchorForCheck(checkLabel)` in `src/links.ts` maps check labels to FAQ anchors by keyword:

| Keyword in label | FAQ anchor |
|-----------------|-----------|
| `funded` | `account-not-funded` |
| `trustline` | `trustline-missing` |
| `reserve` | `xlm-reserve-too-low` |
| `xlm` | `xlm-reserve-too-low` |
| `horizon` | `horizon-error` |

---

## Custom comment templates (markdown partials) (#312)

Organisations that want to add Wave-specific help, campaign links, or custom remediation guidance without forking the action can supply a **Markdown partial** file. TrustBridge loads the partial, runs safe interpolation, and appends it just before the action footer.

### Quick start

```yaml
- uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ steps.address.outputs.address }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    custom_comment_template_path: .trustbridge/comment-help.md
```

Create `.trustbridge/comment-help.md` in your repository:

```markdown
### Wave-specific help

This run validated account {{account}} for the **{{asset}}** token on {{network}}.
Current status: {{status}}

Need help? Join [#wave-support](https://discord.example/wave-support) on Discord.
See the [campaign FAQ](https://your-org.example/wave/faq) for trustline setup instructions.
```

### Available template variables

| Variable | Value | Notes |
|----------|-------|-------|
| `{{account}}` | Checked Stellar address | Escaped for Markdown |
| `{{asset}}` | Asset code (e.g. `USDC`) | Escaped for Markdown |
| `{{issuer}}` | Asset issuer address | Escaped for Markdown |
| `{{network}}` | Inferred network (`mainnet` / `testnet` / `unknown`) | Escaped for Markdown |
| `{{horizon}}` | Horizon base URL | Escaped for Markdown |
| `{{status}}` | `✅ ready` or `❌ blocked` | Safe emoji string — not escaped |
| `{{locale:KEY}}` | i18n string for `KEY` in the active locale | See i18n keys below |

All variable values (except `{{status}}`) are run through `escapeMarkdownInline` before substitution, so contributor-supplied strings (addresses, asset codes, etc.) cannot inject Markdown structures such as links, emphasis, headings, or code spans.

### i18n string variables (`{{locale:KEY}}`)

Use `{{locale:KEY}}` to embed a translated string from the active locale (`en`, `es`, `pt`). For example:

```markdown
### {{locale:remediationHeading}}

{{locale:readyToProceed}}
```

Only `string`-typed fields of `CommentStrings` are supported (function-typed check helpers are excluded and resolve to an empty string). Unknown keys also produce an empty string.

### Security guarantees

| Threat | Defence |
|--------|---------|
| **Path traversal** | The resolved path must stay inside the workspace root. `../../etc/passwd`-style paths throw immediately before any file read. |
| **Oversized file** | Files larger than **8 KB** are rejected before content is read. |
| **HTML/XSS injection** | Templates containing `<script`, `javascript:`, `vbscript:`, `data:text/html`, or inline event handlers (`onclick=`, `onload=`, etc.) are rejected. |
| **Prototype-chain placeholders** | `{{constructor}}`, `{{__proto__}}`, `{{prototype}}`, `{{__defineGetter__}}`, `{{__defineSetter__}}`, `{{__lookupGetter__}}`, `{{__lookupSetter__}}` throw a hard error before any substitution occurs. |
| **Unknown placeholder leakage** | Any `{{unknown}}` placeholder (not in the supported variable set and not a valid `{{locale:KEY}}`) is replaced with an empty string, never echoed back. |
| **Markdown injection via values** | All substituted values (except the safe `{{status}}`) are escaped through `escapeMarkdownInline`. A contributor address like `][evil](https://malicious.example)` becomes `\\]\\[evil\\]\\(https://malicious.example\\)`. |
| **Template failure isolation** | Any template loading or validation error emits a `core.warning` and omits the partial. The rest of the comment (i18n core sections) and the footer are always posted. |

### Constraints

- The template file must be **inside the workspace root** (the repository checkout directory). Absolute paths outside the workspace are rejected.
- Maximum template size: **8 KB**. Keep partials focused to avoid hitting GitHub's 65 KB comment size limit alongside the full TrustBridge comment body.
- The feature is opt-in. Leave `custom_comment_template_path` empty (the default) to disable it.
- i18n core sections are produced by `formatCommentBody` using `getStrings()` and are not affected by the template.

### Implementation reference

- Template loader: `src/template.ts` (`loadCommentTemplate`, `validateTemplatePath`, `validateTemplateContent`, `interpolateTemplate`, `buildTemplateContext`)
- Integration point: `formatCommentBody` in `src/comment.ts` — partial injected before `---` footer
- Tests: `__tests__/template.test.ts` (unit), `__tests__/comment.test.ts` (integration, injection scenarios)

## Local Comment Preview

Contributors can preview how a comment will render locally without needing to run the full action or post to a live issue. This is useful when modifying `src/comment.ts` or testing custom comment templates.

Run the preview script against any JSON fixture from the `fixtures/` directory:

```bash
npm run preview-comment fixtures/account-funded.json
```

By default, the script prints the generated Markdown to `stdout`. To save the output to a file, provide a second argument:

```bash
npm run preview-comment fixtures/account-funded.json preview.md
```

You can customize the check configuration by setting `INPUT_*` environment variables before running the script:

```bash
INPUT_ASSET_CODE="EURC" INPUT_MIN_XLM_RESERVE="2.5" npm run preview-comment fixtures/account-funded.json
```

