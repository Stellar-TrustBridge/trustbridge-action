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

