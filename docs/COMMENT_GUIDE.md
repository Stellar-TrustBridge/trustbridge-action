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

## Maintainer tips

If contributors are confused, ask them to compare the account and issuer shown in the comment with the wallet account they intended to use. Most failures come from unfunded accounts, wrong issuers, or missing Change Trust operations.

## Golden Snapshots in Release/CI

Comment Markdown formatting is protected by golden snapshot tests (`__tests__/comment.test.ts`). Any changes to comment structure, headers, status icons, or links will cause golden snapshot verification in CI (`.github/workflows/ci.yml`) to fail unless explicitly updated via `npx jest -u`.

