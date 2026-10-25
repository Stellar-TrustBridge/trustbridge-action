/**
 * Readiness badge generation for TrustBridge validation results.
 *
 * Generates Markdown and URL-based badge snippets suitable for embedding
 * in READMEs, maintainer dashboards, or other documentation. The badge
 * reflects pass/fail/pending states without exposing PII or sensitive data.
 */
import { ValidationResult } from './checks';
/**
 * Badge state representing the outcome of validation checks.
 */
export type BadgeState = 'pass' | 'fail' | 'pending' | 'skipped';
/**
 * Shields.io badge configuration for rendering validation status.
 */
export interface BadgeConfig {
    state: BadgeState;
    label?: string;
}
/**
 * Determine the badge state from a ValidationResult.
 * - 'pass': All checks passed (valid === true)
 * - 'fail': One or more checks failed (valid === false)
 * - 'pending': Result is unknown or in-progress (never set by normal flow, but available for consumer use)
 *
 * Note: the 'skipped' state (every check detail is 'Skipped') is detected by
 * {@link generateBadgeSnippets}, not here — a skipped run is still
 * `valid === false`, so this function reports 'fail' for it.
 */
export declare function determineBadgeState(result: ValidationResult): BadgeState;
/**
 * Get the accessibility-friendly alt text for a badge state.
 *
 * The alt text is used in Markdown embeds so screen readers and
 * text-only renderers convey the badge meaning without the image.
 */
export declare function getBadgeAltText(state: BadgeState): string;
/**
 * Generate a Shields.io badge URL for the given state.
 *
 * Example output:
 * https://img.shields.io/badge/trustbridge-ready-brightgreen
 *
 * The URL is parameterless and contains no sensitive information (no addresses,
 * balances, or asset details).
 */
export declare function generateBadgeUrl(state: BadgeState, label?: string): string;
/**
 * Generate a Markdown-formatted badge snippet.
 *
 * Example output:
 * [![TrustBridge](https://img.shields.io/badge/trustbridge-ready-brightgreen)](https://github.com/Stellar-TrustBridge/trustbridge-action)
 *
 * The Markdown includes a link to the TrustBridge repository for context.
 */
export declare function generateBadgeMarkdown(state: BadgeState, label?: string): string;
/**
 * Generate both Markdown and URL badge snippets from a ValidationResult.
 *
 * Returned object contains:
 * - markdown: A clickable Markdown badge linking to the TrustBridge repository
 * - url: A plain Shields.io badge URL suitable for embedding in static contexts
 */
export declare function generateBadgeSnippets(result: ValidationResult, label?: string): {
    markdown: string;
    url: string;
};
