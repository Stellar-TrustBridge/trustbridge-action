import { ValidationResult } from './checks';

export function escapeMarkdownInline(value: string): string {
  // Escape Markdown control characters that can break comment structure or
  // enable link/emphasis injection. Dots and hyphens are left alone so domains
  // and URLs remain readable inside and outside inline code spans.
  return value.replace(/([`*_{}[\]()#+!|>~])/g, '\\$1');
}

export function inlineCode(value: string): string {
  return `\`${value.replace(/`/g, '\\`')}\``;
}

/** Base URL for FAQ anchors linked from the onboarding checklist. */
export const TROUBLESHOOTING_FAQ_BASE =
  'https://github.com/Stellar-TrustBridge/trustbridge-action/blob/main/docs/TROUBLESHOOTING.md';

/**
 * The fixed set of checklist label keys used in the onboarding checklist.
 * These are the only labels that extractChecklistState will recognise so that
 * a malicious comment body can never inject unexpected checked state. The
 * values are exact substrings of the bold label text rendered by
 * buildOnboardingChecklist (e.g. `**Fund account**`).
 *
 * @internal Exported for testing.
 */
export const CHECKLIST_LABEL_KEYS = [
  'Fund account',
  // trustline label is dynamic (includes asset code), handled separately
  'Verify XLM balance',
] as const;

/**
 * Sentinel prefix used to match the trustline checklist label regardless of
 * the asset code.  The parser matches any line whose bold label *starts with*
 * this prefix (up to the next ` trustline` suffix pattern) so asset codes
 * containing markdown-safe characters are matched correctly.
 */
export const CHECKLIST_TRUSTLINE_LABEL_PREFIX = 'Add ';
export const CHECKLIST_TRUSTLINE_LABEL_SUFFIX = ' trustline';

/**
 * Key used to store the trustline checked state inside the Map returned by
 * extractChecklistState, regardless of the actual asset code.
 */
export const CHECKLIST_TRUSTLINE_KEY = 'trustline';

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
export function extractChecklistState(body: string): Map<string, boolean> {
  const state = new Map<string, boolean>();

  if (!body || typeof body !== 'string') {
    return state;
  }

  // Locate the onboarding checklist section so we only parse lines inside it.
  // This prevents false positives from other task-list items in the comment.
  const checklistHeaderPattern = /^###\s+Onboarding checklist\s*$/im;
  const headerMatch = checklistHeaderPattern.exec(body);
  if (!headerMatch) {
    return state;
  }

  // Take only the text after the header.  Stop at the next `###` heading so we
  // never read checklist state from an unrelated section.
  const afterHeader = body.slice(headerMatch.index + headerMatch[0].length);
  const nextHeaderMatch = /^###\s+/m.exec(afterHeader);
  const checklistSection = nextHeaderMatch
    ? afterHeader.slice(0, nextHeaderMatch.index)
    : afterHeader;

  // Parse task-list lines: `- [x]` or `- [ ]` followed by `**<label>**`.
  // The label text after `**` is matched against the known allowlist.
  //
  // Pattern breakdown:
  //   ^                 — start of line
  //   [ \t]*-[ \t]+     — list marker with optional indent
  //   \[(x| )\]         — checkbox: `[x]` = checked, `[ ]` = unchecked
  //   [ \t]+            — space after checkbox
  //   \*\*([^*]+)\*\*   — bold label text (no asterisks inside)
  const linePattern = /^[ \t]*-[ \t]+\[(x| )\][ \t]+\*\*([^*]+)\*\*/gim;
  let match: RegExpExecArray | null;

  while ((match = linePattern.exec(checklistSection)) !== null) {
    const checked = match[1] === 'x';
    const rawLabel = match[2].trim();

    // Fund account — exact match (allowlisted)
    if (rawLabel === 'Fund account') {
      state.set('Fund account', checked);
      continue;
    }

    // Verify XLM balance — exact match (allowlisted)
    if (rawLabel === 'Verify XLM balance') {
      state.set('Verify XLM balance', checked);
      continue;
    }

    // Trustline — dynamic label "Add <ASSET_CODE> trustline"; match by prefix+suffix
    // Only ASCII printable characters are allowed in the asset code portion to
    // prevent injection via embedded newlines or control characters.
    if (
      rawLabel.startsWith(CHECKLIST_TRUSTLINE_LABEL_PREFIX) &&
      rawLabel.endsWith(CHECKLIST_TRUSTLINE_LABEL_SUFFIX) &&
      // The asset code portion between prefix and suffix must be pure ASCII
      // printable (no control chars, no Unicode shenanigans).
      /^[\x20-\x7E]+$/.test(rawLabel)
    ) {
      state.set(CHECKLIST_TRUSTLINE_KEY, checked);
    }
    // Any other bold label text is silently ignored.
  }

  return state;
}

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
export function buildOnboardingChecklist(
  result: ValidationResult,
  options: OnboardingChecklistOptions,
): string {
  const safeAsset = escapeMarkdownInline(options.assetCode);
  const fundFaq = `${TROUBLESHOOTING_FAQ_BASE}#account-is-reported-unfunded`;
  const trustFaq = `${TROUBLESHOOTING_FAQ_BASE}#trustline-is-missing`;
  const reserveFaq = `${TROUBLESHOOTING_FAQ_BASE}#xlm-reserve-too-low`;

  const prev = options.previousChecks;

  // Resolve each checkbox state: live result OR previously-checked.
  const fundChecked =
    result.accountFunded || (prev?.get('Fund account') === true);
  const trustChecked =
    result.trustlineExists || (prev?.get(CHECKLIST_TRUSTLINE_KEY) === true);
  const reserveChecked =
    result.xlmReserveMet || (prev?.get('Verify XLM balance') === true);

  const lines = [
    '### Onboarding checklist',
    '',
    '_Complete these steps in order. Boxes update automatically from live Horizon checks._',
    '',
    `- [${fundChecked ? 'x' : ' '}] **Fund account** — Activate the account with XLM. ([FAQ](${fundFaq}))`,
    `- [${trustChecked ? 'x' : ' '}] **Add ${safeAsset} trustline** — Configure the asset trustline. ([FAQ](${trustFaq}))`,
    `- [${reserveChecked ? 'x' : ' '}] **Verify XLM balance** — Meet the **${options.minXlmReserve} XLM** reserve. ([FAQ](${reserveFaq}))`,
  ];

  return lines.join('\n');
}
