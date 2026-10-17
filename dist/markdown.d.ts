import { ValidationResult } from './checks';
import { Locale } from './i18n';
export declare function escapeMarkdownInline(value: string): string;
export declare function inlineCode(value: string): string;
/**
 * A single per-asset row for {@link buildAssetTrustlineTable} (Issue #552).
 *
 * Mirrors the per-asset trustline status computed for the `assets_json`
 * input (see `MultiAssetResult` in `src/index.ts` and
 * `AssetTrustlineResult` in `src/checks.ts`).
 */
export interface AssetTrustlineRow {
    /** Asset code, e.g. `USDC` (already validated by `parseAssetsJson`). */
    assetCode: string;
    /** Issuer account address (G… public key or C… contract ID). */
    assetIssuer: string;
    /** Whether the account holds a trustline for this asset. */
    trustlineExists: boolean;
    /**
     * Asset balance as reported by Horizon (7-decimal string) or `"0"` when
     * no trustline exists. `"unknown"` renders as an informational placeholder.
     */
    balance: string;
}
/**
 * Render the per-asset trustline status table for the `assets_json` input
 * (Issue #552).
 *
 * The table is appended to the TrustBridge comment as its own `###` section
 * so maintainers can see, at a glance, the trustline state of every
 * additional asset — instead of having to dig through workflow logs.
 *
 * All dynamic values are escaped through `escapeMarkdownInline` / `inlineCode`
 * so an asset code or issuer can never inject Markdown structure. The issuer
 * is truncated for readability while remaining unambiguous (first 4 + last 4
 * characters); the full issuer is not rendered to keep the table compact —
 * Horizon/stellar.explore can resolve it from the asset code if needed.
 *
 * @param rows Per-asset results. When empty, returns `''` so callers can
 *             skip the section entirely (no empty headings in comments).
 * @param options.heading Section heading (defaults to "Asset trustlines").
 * @returns Markdown section (heading + table), or `''` when `rows` is empty.
 */
export declare function buildAssetTrustlineTable(rows: AssetTrustlineRow[], options?: {
    heading?: string;
}): string;
/**
 * Canonical (locale-independent) keys used in the Map returned by
 * `extractChecklistState` and accepted by `buildOnboardingChecklist` via
 * `options.previousChecks`.
 *
 * These are *stable identifiers*, not rendered text — a comment written in
 * `es` and re-rendered in `en` still maps onto the same key, which is what
 * makes checklist state survive a locale switch (Issue #436).
 */
export declare const CHECKLIST_FUND_KEY = "Fund account";
export declare const CHECKLIST_RESERVE_KEY = "Verify XLM balance";
/**
 * The fixed set of checklist label keys used in the onboarding checklist.
 * These are the only keys that extractChecklistState will recognise so that
 * a malicious comment body can never inject unexpected checked state.
 *
 * @internal Exported for testing.
 */
export declare const CHECKLIST_LABEL_KEYS: readonly ["Fund account", "Verify XLM balance"];
/**
 * Sentinel prefix used to match the trustline checklist label regardless of
 * the asset code.  The parser matches any line whose bold label *starts with*
 * this prefix (up to the next ` trustline` suffix pattern) so asset codes
 * containing markdown-safe characters are matched correctly.
 *
 * @deprecated Locale-aware affixes are derived from the i18n string
 * `checklistTrustlineLabel`; these remain as the English defaults.
 */
export declare const CHECKLIST_TRUSTLINE_LABEL_PREFIX = "Add ";
/** @deprecated See {@link CHECKLIST_TRUSTLINE_LABEL_PREFIX}. */
export declare const CHECKLIST_TRUSTLINE_LABEL_SUFFIX = " trustline";
/**
 * Key used to store the trustline checked state inside the Map returned by
 * extractChecklistState, regardless of the actual asset code.
 */
export declare const CHECKLIST_TRUSTLINE_KEY = "trustline";
export interface OnboardingChecklistOptions {
    /** Asset code shown in the trustline checklist item (already escaped for Markdown). */
    assetCode: string;
    /** Minimum XLM reserve shown in the balance checklist item. */
    minXlmReserve: number;
    /**
     * Locale for the checklist headings and labels (Issue #436). Defaults to
     * `en`. Only affects rendered copy — the canonical keys are unchanged.
     */
    locale?: Locale | string;
    /**
     * Checked state extracted from a previous comment body (Issue #311).
     *
     * When provided, a box is rendered as checked (`[x]`) if EITHER the live
     * `ValidationResult` says the step passed OR this map records the box as
     * previously checked.  This ensures manually-checked boxes survive sticky
     * comment updates even when the live Horizon state has not yet caught up.
     *
     * Keys are the canonical label keys: `CHECKLIST_FUND_KEY`,
     * `CHECKLIST_TRUSTLINE_KEY`, and `CHECKLIST_RESERVE_KEY` — they are
     * locale-independent, so state survives a locale switch.
     *
     * Entries are only honoured for the three known canonical keys — any other
     * keys in the map are silently ignored.
     */
    previousChecks?: Map<string, boolean>;
}
export interface ExtractChecklistOptions {
    /**
     * Restrict parsing to a single locale. When omitted (the default) every
     * supported locale is accepted, so switching `locale` between runs does not
     * lose manually-checked boxes (Issue #436).
     */
    locale?: Locale | string;
}
/**
 * Parse an existing TrustBridge comment body and extract the checked/unchecked
 * state of each onboarding checklist item (Issue #311).
 *
 * Only lines that match one of the known checklist label patterns are
 * recognised — no user-controlled text is used as a map key, so a maliciously
 * crafted comment body cannot inject unexpected state. Labels are matched
 * against the built-in locale allowlist (or a single locale when
 * `options.locale` is supplied).
 *
 * The function is intentionally permissive about whitespace and case so that
 * minor formatting differences between action versions do not break persistence.
 *
 * @param body   Raw markdown body of an existing TrustBridge comment.
 * @param options Optional locale restriction.
 * @returns      A Map from canonical label key to checked boolean.
 *               Keys: `CHECKLIST_FUND_KEY`, `CHECKLIST_TRUSTLINE_KEY`,
 *               `CHECKLIST_RESERVE_KEY`.
 *               Only items found in the body are included — callers should
 *               treat a missing key as "no previous state".
 */
export declare function extractChecklistState(body: string, options?: ExtractChecklistOptions): Map<string, boolean>;
/**
 * Render a GitHub Markdown task-list checklist whose boxes reflect live
 * `ValidationResult` state (fund → trustline → verify balance).
 *
 * All headings and labels come from the locale string pack (Issue #436) so a
 * non-`en` comment no longer mixes English checklist copy into a translated
 * comment.
 *
 * When `options.previousChecks` is supplied (extracted from a prior sticky
 * comment via `extractChecklistState`), a box is checked if EITHER the live
 * result says it passed OR the previous comment had the box checked.  This
 * preserves contributor-manually-checked boxes across sticky comment updates
 * (Issue #311).
 *
 * Checkboxes are comment-only (no GitHub Projects task-list API sync).
 */
export declare function buildOnboardingChecklist(result: ValidationResult, options: OnboardingChecklistOptions): string;
