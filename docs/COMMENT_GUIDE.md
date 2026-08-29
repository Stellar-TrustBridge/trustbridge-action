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

Matching is case-insensitive. Labels that match no keyword produce `undefined` and no FAQ link is rendered — this is intentional so custom plugin checks do not get stale links.

### docs_base_url override

Forks and mirrors can override the FAQ base URL via the `docs_base_url` action input (maps to `docsBaseUrl` in `CommentConfig`). The value must be a valid HTTPS URL; any other value falls back to the default silently so comment posting is never blocked.

---

## Adding a new FAQ entry

When adding a new failing check that warrants a FAQ section:

1. **Add a heading in `docs/FAQ.md`** with a stable `{#anchor-id}`:
   ```markdown
   ## My new topic {#my-new-topic}
   ```
2. **Add an entry to `FAQ_ANCHORS` in `src/links.ts`**:
   ```typescript
   MY_NEW_TOPIC: 'my-new-topic',
   ```
3. **Add a keyword mapping in `CHECK_TO_ANCHOR_MAP`** in `src/links.ts` if the check label has a distinct keyword:
   ```typescript
   { keyword: 'my-new-topic-keyword', anchor: FAQ_ANCHORS.MY_NEW_TOPIC },
   ```
4. **Run `npm test -- --testPathPattern 'faq'`** — the test suite will automatically verify the new anchor exists in `docs/FAQ.md`.

Do **not** invent anchor names inline in comment or markdown code. Always use `FAQ_ANCHORS` constants so the CI test catches any future divergence.

---

## Anchor rot prevention

The file `__tests__/faq-anchors.test.ts` enforces that:

- Every `FAQ_ANCHORS` value resolves to a heading in `docs/FAQ.md`.
- Every fragment emitted by `buildOnboardingChecklist` exists in `docs/FAQ.md`.
- No reference to `TROUBLESHOOTING.md` or other non-existent files appears in comment output.
- Stale anchor names (`#account-is-reported-unfunded`, `#trustline-is-missing`) are never emitted.

Run the guard with:

```bash
npm test -- --testPathPattern 'faq'
```

This is also run automatically on every CI push.

---

## Deprecated: TROUBLESHOOTING_FAQ_BASE

`src/markdown.ts` exports `TROUBLESHOOTING_FAQ_BASE` for backward compatibility. It is now an alias for `DEFAULT_FAQ_BASE_URL` (points to `docs/FAQ.md`). Do not use it in new code — import `DEFAULT_FAQ_BASE_URL` or `FAQ_ANCHORS` directly from `src/links.ts` instead.

---

## Localization

Comment strings are localized via `src/i18n.ts`. The `locale` field of `CommentConfig` controls the language (default `en`). FAQ links are always in English because they point to `docs/FAQ.md`, which is English-only. If a localized FAQ is added in the future, the `docsBaseUrl` override or a locale-aware `buildFaqLink` variant should be introduced rather than hardcoding locale-specific paths.
