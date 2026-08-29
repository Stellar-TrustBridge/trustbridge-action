import { ValidationResult } from './checks';
import { DEFAULT_FAQ_BASE_URL, FAQ_ANCHORS } from './links';

export function escapeMarkdownInline(value: string): string {
  // Escape Markdown control characters that can break comment structure or
  // enable link/emphasis injection. Dots and hyphens are left alone so domains
  // and URLs remain readable inside and outside inline code spans.
  return value.replace(/([`*_{}[\]()#+!|>~])/g, '\\$1');
}

export function inlineCode(value: string): string {
  return `\`${value.replace(/`/g, '\\`')}\``;
}

/**
 * Base URL for FAQ anchors linked from the onboarding checklist.
 * Points to docs/FAQ.md in the trustbridge-action repository.
 * @deprecated Use DEFAULT_FAQ_BASE_URL from links.ts directly.
 */
export const TROUBLESHOOTING_FAQ_BASE = DEFAULT_FAQ_BASE_URL;

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
export function buildOnboardingChecklist(
  result: ValidationResult,
  options: OnboardingChecklistOptions,
): string {
  const safeAsset = escapeMarkdownInline(options.assetCode);
  const fundFaq = `${DEFAULT_FAQ_BASE_URL}#${FAQ_ANCHORS.ACCOUNT_NOT_FUNDED}`;
  const trustFaq = `${DEFAULT_FAQ_BASE_URL}#${FAQ_ANCHORS.TRUSTLINE_MISSING}`;
  const reserveFaq = `${DEFAULT_FAQ_BASE_URL}#${FAQ_ANCHORS.XLM_RESERVE_TOO_LOW}`;

  const lines = [
    '### Onboarding checklist',
    '',
    '_Complete these steps in order. Boxes update automatically from live Horizon checks._',
    '',
    `- [${result.accountFunded ? 'x' : ' '}] **Fund account** — Activate the account with XLM. ([FAQ](${fundFaq}))`,
    `- [${result.trustlineExists ? 'x' : ' '}] **Add ${safeAsset} trustline** — Configure the asset trustline. ([FAQ](${trustFaq}))`,
    `- [${result.xlmReserveMet ? 'x' : ' '}] **Verify XLM balance** — Meet the **${options.minXlmReserve} XLM** reserve. ([FAQ](${reserveFaq}))`,
  ];

  return lines.join('\n');
}
