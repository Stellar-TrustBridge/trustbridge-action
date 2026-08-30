# Issue Comment Guide

TrustBridge comments are designed to be actionable for contributors and auditable for maintainers.

## Sticky comment upsert

By default (`sticky_comment: true`), TrustBridge does not post a new comment on every run. Each comment body embeds a hidden marker (`<!-- trustbridge-action:sticky-comment -->` or `<!-- trustbridge-action:sticky-comment:v1 -->`). On subsequent runs, the action:

1. Queries the issue's comments using GraphQL pagination (100 comments per page, up to a documented cap of **10 pages / 1,000 comments** via `MAX_STICKY_COMMENT_SEARCH_PAGES`).
2. Looks for a comment containing the stable HTML marker or TrustBridge footer.
3. Updates that comment in place if found; otherwise creates a new one.

### Pagination and rate limit protections (Issue #226)
- **GraphQL efficiency**: Uses targeted GraphQL queries requesting only the comment ID and body to minimize network payload on high-traffic threads.
- **Page cap**: Paginates up to a maximum cap of 10 pages (1,000 comments). This bounds API usage, avoids secondary rate limits, and prevents infinite pagination loops on extremely busy Wave issues.
- **Marker stability**: HTML comment markers remain stable across releases so comments posted by older action versions continue to be updated in place.
- **REST fallback**: If the GraphQL API is unavailable or returns an error, TrustBridge gracefully falls back to REST pagination (also capped).

This keeps re-runs (e.g. after a contributor funds their wallet) from spamming the issue with duplicate check results — the same comment simply flips from ❌ to ✅.

If the comment lookup itself fails (rate limit, permission issue, transient API error), the action logs a warning and falls back to posting a new comment rather than failing the whole run.

Set `sticky_comment: false` to always post a new comment (e.g. if you want a full audit trail of every check in the issue timeline).

## Reaction-based snooze (:zzz:) (Issue #227)

Maintainers can snooze noisy failure notifications directly from the GitHub UI by reacting to TrustBridge's sticky comment with the **`:zzz:`** (or `eyes` / `💤`) emoji.

### How reaction snooze works:
- **UI control**: Maintainers can click the reaction button on the bot comment and add `:zzz:` or `eyes`. TrustBridge detects this reaction and suppresses subsequent failure comments on that issue for `snooze_window_minutes` (default 30 min).
- **Expiry honored**: The reaction timestamp is parsed; once `snooze_window_minutes` elapses from when the reaction was added, the snooze expires and reminder comments resume.
- **Specific emoji only**: Only designated snooze emojis (`:zzz:`, `zzz`, `eyes`, `💤`) trigger snooze. Random reactions (such as `👍`, `❤️`, `🎉`, `🚀`) are ignored.
- **Bot reactions ignored**: Reactions added by automated bot accounts (`type: Bot` or `*[bot]`) are ignored.
- **Auto-unsnooze on fix**: As soon as the contributor resolves the issue and checks pass (`ready: true`), TrustBridge immediately updates the comment from ❌ to ✅ regardless of snooze state.
- **Bypass with force_comment**: Maintainers can bypass reaction snooze anytime using `force_comment: true`.

## What the comment includes

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

Snapshots for this section are in `__tests__/comment.test.ts` (golden snapshots for dashboard link and XDR snippet).

## Maintainer tips

If contributors are confused, ask them to compare the account and issuer shown in the comment with the wallet account they intended to use. Most failures come from unfunded accounts, wrong issuers, or missing Change Trust operations.

## Golden Snapshots in Release/CI

Comment Markdown formatting is protected by golden snapshot tests (`__tests__/comment.test.ts`). Any changes to comment structure, headers, status icons, or links will cause golden snapshot verification in CI (`.github/workflows/ci.yml`) to fail unless explicitly updated via `npx jest -u`.

