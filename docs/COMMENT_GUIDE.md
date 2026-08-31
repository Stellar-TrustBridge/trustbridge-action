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


## Comment threading / reply mode (#322)

By default TrustBridge uses `comment_mode: sticky` (equivalent to the legacy `sticky_comment: true`). You can change the threading strategy per-run without changing anything else:

| Mode | Behavior | When to use |
|------|----------|-------------|
| `sticky` (default) | Update TrustBridge's previous comment in place. | Normal re-validation; avoids spam. |
| `new` | Always post a brand-new top-level comment. | Audit trail — full history of every check result. |
| `reply` | Post a new comment that references the first TrustBridge comment. | Teams that want a chronological reply chain while keeping the original summary intact. |

```yaml
- uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ steps.address.outputs.address }}
    github_token:          ${{ secrets.GITHUB_TOKEN }}
    comment_mode:          reply     # sticky | new | reply
```

**Notes:**
- `comment_mode` takes precedence over the legacy `sticky_comment` input when both are set.
- Invalid values fall back to `sticky` with a `core.warning`.
- GitHub's issue comment API does not support native in-reply-to for issue comments (only PR review comments). The `reply` mode therefore posts a normal top-level comment that includes a quoted link back to the first TrustBridge comment so reviewers can follow the chain.
- The `reply` mode still uses `findStickyComment` to locate the parent; if no prior comment is found the new comment is posted normally without a reference.

## Address-change detection (#321)

When a `validation.json` artifact from a previous run is available (via `previous_validation_path` or auto-discovery), TrustBridge can detect whether the Stellar address being validated has changed since the last run.

### How it works

1. The current address is normalised (muxed M-addresses are reduced to their base G-address).
2. The previous address is loaded from the stored artifact.
3. If they differ, an `⚠️ Stellar address changed` section is prepended to the comment body.

### Privacy handling

When `privacy_mode: true` is set, **both** the previous and current addresses are hashed with SHA-256 before comparison. The hashes are safe to embed in a public comment. Raw address values are never stored or logged.

If a previous artifact was stored under privacy mode (address is a `sha256:` hash) and the current run is not using privacy mode, TrustBridge conservatively reports a potential change (the hash cannot be reversed) and shows the stored hash as the previous value.

### Muxed addresses

Muxed M-addresses encode an underlying G-address plus a memo ID. TrustBridge strips the muxed prefix and compares only the base G-address, so rotating the memo ID without changing the underlying account is not flagged as an address change.

### Comment section example

```markdown
### ⚠️ Stellar address changed

> **The Stellar address being validated has changed since the last run.**
> Previous: `GAAA…AWHF`
> Current:  `GBBB…BBUA`
>
> If this change was intentional (e.g. you rotated your wallet), no action
> is required — the new address will be validated normally.
> If unexpected, verify that the correct address is submitted in the issue.
```
