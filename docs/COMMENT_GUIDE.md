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


## Locale-aware comments (i18n) — Issue #291

TrustBridge renders issue comments in the contributor's preferred language using
the `locale` config input. Three locales are currently supported:

| Locale | Language |
|--------|----------|
| `en` | English (default) |
| `es` | Spanish |
| `pt` | Portuguese |

### How locale selection works

Set `locale` in the workflow step:

```yaml
- uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ steps.address.outputs.address }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    locale: es   # 'en' | 'es' | 'pt'
```

Unknown or unset locales fall back to `en` automatically — the action never fails
due to an unsupported locale value.

### String architecture

All locale strings are defined in `src/i18n.ts` as `CommentStrings` objects:
- Plain string keys (headings, labels, column names) are static strings.
- Function keys (detail messages, remediation copy) accept address/balance args
  and return translated strings with interpolated values.

The `getStrings(locale)` function returns the correct `CommentStrings` object
for the requested locale, falling back to `EN` when the locale is unsupported.

### Adding a new locale

1. Add the new locale code to `export type Locale` in `src/i18n.ts`.
2. Create a new `const XX: CommentStrings = { ... }` object implementing every
   key in the `CommentStrings` interface (TypeScript enforces completeness).
3. Register it in the `LOCALES` map at the bottom of `src/i18n.ts`.
4. Run `npm test -- --testPathPattern 'i18n-comment-snapshots' --updateSnapshot`
   to generate golden snapshots for the new locale.
5. Verify key parity: `npm test -- --testPathPattern 'i18n'` — the key parity
   tests in `__tests__/i18n-comment-snapshots.test.ts` will fail if any key is
   missing or empty.

### Golden snapshots for i18n comment rendering

`__tests__/i18n-comment-snapshots.test.ts` stores golden snapshots for each
supported locale × scenario (success / unfunded-failure). These snapshots live in
`__tests__/__snapshots__/i18n-comment-snapshots.test.ts.snap`.

If a translation changes or the comment template is updated, regenerate:

```bash
npm test -- --testPathPattern 'i18n-comment-snapshots' --updateSnapshot
```

Always commit the updated snapshot alongside the translation change so CI stays
green. A snapshot mismatch in CI means a locale string or comment template
changed without updating the golden file.

### Key parity enforcement

The key parity tests verify that every string key defined in the English
`CommentStrings` interface is also present and non-empty in every other locale.
A missing translation key causes a descriptive test failure:

```
Locale "es" is missing 2 key(s): newHeading, newLabel
```

This ensures that adding a new string to `CommentStrings` without translating
it into all locales fails fast in CI rather than silently rendering an empty
string in contributors' issue comments.
