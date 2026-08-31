import { ValidationResult } from './checks';
export declare function escapeMarkdownInline(value: string): string;
export declare function inlineCode(value: string): string;
/**
 * Base URL for FAQ anchors linked from the onboarding checklist.
 * Points to docs/FAQ.md in the trustbridge-action repository.
 * @deprecated Use DEFAULT_FAQ_BASE_URL from links.ts directly.
 */
export declare const TROUBLESHOOTING_FAQ_BASE = "https://github.com/Stellar-TrustBridge/trustbridge-action/blob/main/docs/FAQ.md";
export interface OnboardingChecklistOptions {
    /** Asset code shown in the trustline checklist item (already escaped for Markdown). */
    assetCode: string;
    /** Minimum XLM reserve shown in the balance checklist item. */
    minXlmReserve: number;
}
/**
 * Render a GitHub Markdown task-list checklist whose boxes reflect live
 * `ValidationResult` state (fund → trustline → verify balance).
 *
 * Checkboxes are comment-only (no GitHub Projects task-list API sync).
 */
export declare function buildOnboardingChecklist(result: ValidationResult, options: OnboardingChecklistOptions): string;
