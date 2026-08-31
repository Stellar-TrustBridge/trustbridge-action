# TrustBridge Comment Guide

This document describes how TrustBridge formats issue comments, how FAQ deep links are generated and kept in sync, and the rules contributors must follow when adding new check CTAs.

---

## Comment structure

Every TrustBridge issue comment follows a fixed section order:

1. **Hidden markers** — `<!-- trustbridge-action:sticky-comment:schema-v… -->` and a snooze marker. Used for upsert detection and snooze state.
2. **Header** — `## TrustBridge — Stellar Account Check`
3. **Account/Horizon/Asset summary** — checked account address, Horizon URL, and asset identity.
4. **Results** — one bullet per check (`✅`/`❌`), with a `[→ FAQ]` link on each failing check.
5. **Onboarding checklist** — a GitHub Markdown task-list showing fund → trustline → verify balance (default `on`, disable via `onboarding_checklist: false`).
6. **Optional sections** (in order): ledger freshness alert, balances, setup cost estimate, Stellar Lab links, remediation, SEP-0007 deep links, SEP-0010 proof, configuration summary, action outputs reference, delta section, expert diagnostics (debug mode only), metrics snapshot.
7. **Footer** — `_Posted by [trustbridge-action](…)_`

---

## FAQ deep links

### How they work

Every failing check bullet in the **Results** section automatically appends a `[→ FAQ]` link that takes contributors straight to the relevant section of `docs/FAQ.md`. This is implemented in `src/comment.ts` via `buildFaqLinkForCheck` from `src/links.ts`.

The onboarding checklist items (Fund account / Add trustline / Verify XLM balance) also carry FAQ links, generated in `src/markdown.ts` via `buildOnboardingChecklist`.

### Anchor registry

All FAQ anchor names are declared in `src/links.ts` in the `FAQ_ANCHORS` constant:

- The checked Stellar account.
- The Horizon endpoint used for verification.
- The target asset code and issuer.
- Per-check status for funding, trustline readiness, and XLM reserve.
- An optional **Onboarding checklist** (default on via `onboarding_checklist: true`) with Markdown task-list checkboxes that auto-check from live `ValidationResult` state, plus FAQ links for each step.
- A machine-readable validation-gate summary that callers can use to tell whether the run is release-ready or blocked.
- Links to Stellar Laboratory and LOBSTR for remediation.

## Onboarding checklist

When `onboarding_checklist` is enabled (the default), the comment includes a concise guided path:

1. Fund account
2. Add trustline
3. Verify XLM balance

Each item is a GitHub Markdown task-list checkbox (`- [x]` / `- [ ]`) driven by `accountFunded`, `trustlineExists`, and `xlmReserveMet`. Boxes are comment-only — they are not synced via the GitHub Projects task-list API. FAQ links point at [TROUBLESHOOTING.md](TROUBLESHOOTING.md) anchors.

Set `onboarding_checklist: false` to omit the section entirely (e.g. for expert-only workflows).

### Checklist state persistence across sticky updates (Issue #311)

By default, every sticky update rebuilds the checklist from live Horizon data. This means that if a contributor manually checks a box in GitHub (e.g. they have funded their account but Horizon hasn't indexed the transaction yet), the next run could overwrite their check with an unchecked state.

**TrustBridge now preserves checked boxes across sticky updates.** When a sticky update runs, the action:

1. Fetches the existing sticky comment body.
2. Parses the previous `### Onboarding checklist` section with `extractChecklistState()` to recover which boxes were checked.
3. Merges that prior state into the new checklist: a box is checked if **either** the live Horizon check passes **or** the previous comment had the box checked.

This ensures contributor-manually-checked boxes survive re-runs even when Horizon hasn't caught up yet.

#### Merge semantics

| Live Horizon result | Previous box state | Final rendered state |
|--------------------|--------------------|---------------------|
| ✅ pass | checked or unchecked | `[x]` (live truth wins) |
| ❌ fail | checked | `[x]` (manual check preserved) |
| ❌ fail | unchecked | `[ ]` (stays unchecked) |
| ❌ fail | (no prior state) | `[ ]` (stays unchecked) |

A live pass always checks the box, regardless of prior state. A live fail only checks the box if the contributor (or a previous run) had it checked before.

#### Security: injection guard

The checklist parser is scoped to the `### Onboarding checklist` section only (it stops at the next `###` heading) and matches only a fixed allowlist of known label names:

- `Fund account`
- `Add <ASSET_CODE> trustline` (any asset code that is ASCII-printable)
- `Verify XLM balance`

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

