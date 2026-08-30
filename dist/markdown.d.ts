import { ValidationResult } from './checks';
export declare function escapeMarkdownInline(value: string): string;
export declare function inlineCode(value: string): string;
/** Base URL for FAQ anchors linked from the onboarding checklist. */
export declare const TROUBLESHOOTING_FAQ_BASE = "https://github.com/Stellar-TrustBridge/trustbridge-action/blob/main/docs/TROUBLESHOOTING.md";
/**
 * The fixed set of checklist label keys used in the onboarding checklist.
 * These are the only labels that extractChecklistState will recognise so that
 * a malicious comment body can never inject unexpected checked state. The
 * values are exact substrings of the bold label text rendered by
 * buildOnboardingChecklist (e.g. `**Fund account**`).
 *
 * @internal Exported for testing.
 */
export declare const CHECKLIST_LABEL_KEYS: readonly ["Fund account", "Verify XLM balance"];
/**
 * Sentinel prefix used to match the trustline checklist label regardless of
 * the asset code.  The parser matches any line whose bold label *starts with*
 * this prefix (up to the next ` trustline` suffix pattern) so asset codes
 * containing markdown-safe characters are matched correctly.
 */
export declare const CHECKLIST_TRUSTLINE_LABEL_PREFIX = "Add ";
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
     * Checked state extracted from a previous comment body (Issue #311).
     *
     * When provided, a box is rendered as checked (`[x]`) if EITHER the live
     * `ValidationResult` says the step passed OR this map records the box as
     * previously checked.  This ensures manually-checked boxes survive sticky
     * comment updates even when the live Horizon state has not yet caught up.
     *
     * Keys are the canonical label keys: `"Fund account"`, `"trustline"`, and
     * `"Verify XLM balance"`.
     *
     * Entries are only honoured for the three known label keys — any other keys
     * in the map are silently ignored.
     */
    previousChecks?: Map<string, boolean>;
}
/**
 * Parse an existing TrustBridge comment body and extract the checked/unchecked
 * state of each onboarding checklist item (Issue #311).
 *
 * Only lines that match one of the known checklist label patterns are
 * recognised — no user-controlled text is used as a map key, so a maliciously
 * crafted comment body cannot inject unexpected state.
 *
 * The function is intentionally permissive about whitespace and case so that
 * minor formatting differences between action versions do not break persistence.
 *
 * @param body   Raw markdown body of an existing TrustBridge comment.
 * @returns      A Map from canonical label key to checked boolean.
 *               Keys: `"Fund account"`, `"trustline"`, `"Verify XLM balance"`.
 *               Only items found in the body are included — callers should
 *               treat a missing key as "no previous state".
 */
export declare function extractChecklistState(body: string): Map<string, boolean>;
/**
 * Render a GitHub Markdown task-list checklist whose boxes reflect live
 * `ValidationResult` state (fund → trustline → verify balance).
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
