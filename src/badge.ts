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
export type BadgeState = 'pass' | 'fail' | 'pending';

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
  }
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
  const altText = `TrustBridge ${getBadgeLabel(state)}`;
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
  const state = determineBadgeState(result);
  return {
    markdown: generateBadgeMarkdown(state, label),
    url: generateBadgeUrl(state, label),
  };
}
