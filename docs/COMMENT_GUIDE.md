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

```typescript
export const FAQ_ANCHORS = {
  ACCOUNT_NOT_FUNDED:   'account-not-funded',
  TRUSTLINE_MISSING:    'trustline-missing',
  XLM_RESERVE_TOO_LOW:  'xlm-reserve-too-low',
  TESTING_ON_TESTNET:   'testing-on-testnet',
  HORIZON_ERROR:        'horizon-error',
  DEBUG_MODE:           'debug-mode',
  WEBHOOK_NOT_RECEIVED: 'webhook-not-received',
} as const;
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
