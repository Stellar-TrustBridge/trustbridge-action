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
export function determineBadgeState(result: ValidationResult): BadgeState {
  return result.valid ? 'pass' : 'fail';
}

/**
 * Get the color code for a Shields.io badge based on state.
 */
function getBadgeColor(state: BadgeState): string {
  switch (state) {
    case 'pass':
      return 'brightgreen';
    case 'fail':
      return 'red';
    case 'pending':
      return 'yellow';
    case 'skipped':
      return 'lightgrey';
  }
}

/**
 * Get the human-readable label for a badge state.
 */
function getBadgeLabel(state: BadgeState): string {
  switch (state) {
    case 'pass':
      return 'Ready';
    case 'fail':
      return 'Not Ready';
    case 'pending':
      return 'Pending';
    case 'skipped':
      return 'Skipped';
  }
}

/**
 * Get the accessibility-friendly alt text for a badge state.
 *
 * The alt text is used in Markdown embeds so screen readers and
 * text-only renderers convey the badge meaning without the image.
 */
export function getBadgeAltText(state: BadgeState): string {
  return `TrustBridge ${getBadgeLabel(state)}`;
}

/**
 * Generate a Shields.io badge URL for the given state.
 *
 * Example output:
 * https://img.shields.io/badge/trustbridge-ready-brightgreen
 *
 * The URL is parameterless and contains no sensitive information (no addresses,
 * balances, or asset details).
 */
export function generateBadgeUrl(state: BadgeState, label: string = 'trustbridge'): string {
  const color = getBadgeColor(state);
  const message = getBadgeLabel(state);
  return `https://img.shields.io/badge/${encodeURIComponent(label)}-${encodeURIComponent(message)}-${color}`;
}

/**
 * Generate a Markdown-formatted badge snippet.
 *
 * Example output:
 * [![TrustBridge](https://img.shields.io/badge/trustbridge-ready-brightgreen)](https://github.com/Stellar-TrustBridge/trustbridge-action)
 *
 * The Markdown includes a link to the TrustBridge repository for context.
 */
export function generateBadgeMarkdown(state: BadgeState, label: string = 'trustbridge'): string {
  const url = generateBadgeUrl(state, label);
  const altText = getBadgeAltText(state);
  return `[![${altText}](${url})](https://github.com/Stellar-TrustBridge/trustbridge-action)`;
}

/**
 * Generate both Markdown and URL badge snippets from a ValidationResult.
 *
 * Returned object contains:
 * - markdown: A clickable Markdown badge linking to the TrustBridge repository
 * - url: A plain Shields.io badge URL suitable for embedding in static contexts
 */
export function generateBadgeSnippets(
  result: ValidationResult,
  label: string = 'trustbridge',
): { markdown: string; url: string } {
  // A run where every check was skipped (e.g. dry-run short-circuit) renders
  // the neutral 'skipped' badge instead of the red 'fail' badge, even though
  // the result itself is not valid.
  const skipped =
    result.checks.length > 0 && result.checks.every((check) => check.detail === 'Skipped');
  const state = skipped ? 'skipped' : determineBadgeState(result);
  return {
    markdown: generateBadgeMarkdown(state, label),
    url: generateBadgeUrl(state, label),
  };
}
