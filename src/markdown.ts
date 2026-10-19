import { ValidationResult } from './checks';
import { DEFAULT_FAQ_BASE_URL, FAQ_ANCHORS } from './links';
import { Locale, getStrings, SUPPORTED_LOCALES } from './i18n';

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
export function buildAssetTrustlineTable(
  rows: AssetTrustlineRow[],
  options: { heading?: string } = {},
): string {
  if (!Array.isArray(rows) || rows.length === 0) {
    return '';
  }

  const heading = options.heading ?? 'Asset trustlines';

  const shortenIssuer = (issuer: string): string => {
    if (issuer.length <= 12) return issuer;
    return `${issuer.slice(0, 4)}…${issuer.slice(-4)}`;
  };

  const formatBalance = (row: AssetTrustlineRow): string => {
    if (row.balance === 'unknown') return '_unknown_';
    if (!row.trustlineExists) return '`0` — no trustline';
    return `\`${row.balance}\``;
  };

  const lines: string[] = [
    `### ${escapeMarkdownInline(heading)}`,
    '',
    '| Asset | Trustline | Balance | Issuer |',
    '| --- | --- | --- | --- |',
  ];

  for (const row of rows) {
    const asset = escapeMarkdownInline(row.assetCode);
    const status = row.trustlineExists ? '✅ exists' : '❌ missing';
    const issuer = inlineCode(shortenIssuer(row.assetIssuer));
    lines.push(`| ${asset} | ${status} | ${formatBalance(row)} | ${issuer} |`);
  }

  return lines.join('\n');
}



/**
 * Canonical (locale-independent) keys used in the Map returned by
 * `extractChecklistState` and accepted by `buildOnboardingChecklist` via
 * `options.previousChecks`.
 *
 * These are *stable identifiers*, not rendered text — a comment written in
 * `es` and re-rendered in `en` still maps onto the same key, which is what
 * makes checklist state survive a locale switch (Issue #436).
 */
export const CHECKLIST_FUND_KEY = 'Fund account';
export const CHECKLIST_RESERVE_KEY = 'Verify XLM balance';

/**
 * The fixed set of checklist label keys used in the onboarding checklist.
 * These are the only keys that extractChecklistState will recognise so that
 * a malicious comment body can never inject unexpected checked state.
 *
 * @internal Exported for testing.
 */
export const CHECKLIST_LABEL_KEYS = [
  CHECKLIST_FUND_KEY,
  // trustline label is dynamic (includes asset code), handled separately
  CHECKLIST_RESERVE_KEY,
] as const;

/**
 * Sentinel prefix used to match the trustline checklist label regardless of
 * the asset code.  The parser matches any line whose bold label *starts with*
 * this prefix (up to the next ` trustline` suffix pattern) so asset codes
 * containing markdown-safe characters are matched correctly.
 *
 * @deprecated Locale-aware affixes are derived from the i18n string
 * `checklistTrustlineLabel`; these remain as the English defaults.
 */
export const CHECKLIST_TRUSTLINE_LABEL_PREFIX = 'Add ';
/** @deprecated See {@link CHECKLIST_TRUSTLINE_LABEL_PREFIX}. */
export const CHECKLIST_TRUSTLINE_LABEL_SUFFIX = ' trustline';

/**
 * Key used to store the trustline checked state inside the Map returned by
 * extractChecklistState, regardless of the actual asset code.
 */
export const CHECKLIST_TRUSTLINE_KEY = 'trustline';

/**
 * Marker injected into a localized trustline label template so the literal
 * prefix/suffix around the asset code can be derived without hard-coding
 * per-locale affixes.
 */
const ASSET_CODE_SENTINEL = '\u0001';

/**
 * Prefix/suffix pairs for the dynamic "<asset> trustline" checklist label,
 * derived from the locale's own label template.
 */
interface TrustlineAffixes {
  prefix: string;
  suffix: string;
}

/**
 * Derive the literal affixes around the asset code for a given locale by
 * rendering the localized label template with a sentinel "asset code".
 */
function trustlineAffixes(locale: Locale | string): TrustlineAffixes {
  const template = getStrings(locale).checklistTrustlineLabel(ASSET_CODE_SENTINEL);
  const index = template.indexOf(ASSET_CODE_SENTINEL);
  // A locale pack that drops the placeholder still yields a usable (possibly
  // empty) affix pair — the label simply becomes a literal match.
  const safeIndex = index === -1 ? template.length : index;
  return {
    prefix: template.slice(0, safeIndex),
    suffix: index === -1 ? '' : template.slice(safeIndex + 1),
  };
}

/**
 * Every label that `extractChecklistState` will accept for one locale,
 * together with the canonical key each label maps to.
 */
interface LocaleLabelSet {
  heading: string;
  fund: string;
  reserve: string;
  trustline: TrustlineAffixes;
}

function localeLabelSet(locale: Locale | string): LocaleLabelSet {
  const strings = getStrings(locale);
  return {
    heading: strings.checklistHeading,
    fund: strings.checklistFundAccountLabel,
    reserve: strings.checklistReserveLabel,
    trustline: trustlineAffixes(locale),
  };
}

/**
 * All locale label sets, in canonical order. Used by `extractChecklistState`
 * so a comment body written in one locale is still parsed after the workflow
 * switches `locale` (Issue #436).
 */
function allLocaleLabelSets(): LocaleLabelSet[] {
  return SUPPORTED_LOCALES.map((locale) => localeLabelSet(locale));
}

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
export function extractChecklistState(
  body: string,
  options: ExtractChecklistOptions = {},
): Map<string, boolean> {
  const state = new Map<string, boolean>();

  if (!body || typeof body !== 'string') {
    return state;
  }

  const labelSets = options.locale
    ? [localeLabelSet(options.locale)]
    : allLocaleLabelSets();

  // Locate the onboarding checklist section so we only parse lines inside it.
  // This prevents false positives from other task-list items in the comment.
  // Every known locale heading is accepted so a locale switch does not hide
  // the section (Issue #436).
  const headingPattern = new RegExp(
    `^###[ \\t]+(?:${labelSets
      .map((set) => escapeRegExp(set.heading))
      .join('|')})[ \\t]*$`,
    'im',
  );
  const headerMatch = headingPattern.exec(body);
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

  const fundLabels = new Set(labelSets.map((set) => set.fund));
  const reserveLabels = new Set(labelSets.map((set) => set.reserve));

  while ((match = linePattern.exec(checklistSection)) !== null) {
    const checked = match[1] === 'x';
    const rawLabel = match[2].trim();

    // Fund account — exact match against the locale allowlist
    if (fundLabels.has(rawLabel)) {
      state.set(CHECKLIST_FUND_KEY, checked);
      continue;
    }

    // Verify XLM balance — exact match against the locale allowlist
    if (reserveLabels.has(rawLabel)) {
      state.set(CHECKLIST_RESERVE_KEY, checked);
      continue;
    }

    // Trustline — dynamic label "<prefix><ASSET_CODE><suffix>"; match by affixes.
    // Only ASCII printable characters are allowed in the asset code portion to
    // prevent injection via embedded newlines or control characters.
    for (const set of labelSets) {
      const { prefix, suffix } = set.trustline;
      if (!prefix && !suffix) continue;
      if (!rawLabel.startsWith(prefix) || !rawLabel.endsWith(suffix)) continue;
      const assetCode = rawLabel.slice(
        prefix.length,
        rawLabel.length - suffix.length,
      );
      if (assetCode.length === 0) continue;
      if (!/^[\x20-\x7E]+$/.test(assetCode)) continue;
      state.set(CHECKLIST_TRUSTLINE_KEY, checked);
      break;
    }
    // Any other bold label text is silently ignored.
  }

  return state;
}

/**
 * Escape a string for safe use inside a regular expression.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
export function buildOnboardingChecklist(
  result: ValidationResult,
  options: OnboardingChecklistOptions,
): string {
  const strings = getStrings(options.locale ?? 'en');
  const safeAsset = escapeMarkdownInline(options.assetCode);
  const fundFaq = `${DEFAULT_FAQ_BASE_URL}#${FAQ_ANCHORS.ACCOUNT_NOT_FUNDED}`;
  const trustFaq = `${DEFAULT_FAQ_BASE_URL}#${FAQ_ANCHORS.TRUSTLINE_MISSING}`;
  const reserveFaq = `${DEFAULT_FAQ_BASE_URL}#${FAQ_ANCHORS.XLM_RESERVE_TOO_LOW}`;

  const prev = options.previousChecks;

  // Resolve each checkbox state: live result OR previously-checked.
  const fundChecked =
    result.accountFunded || (prev?.get(CHECKLIST_FUND_KEY) === true);
  const trustChecked =
    result.trustlineExists || (prev?.get(CHECKLIST_TRUSTLINE_KEY) === true);
  const reserveChecked =
    result.xlmReserveMet || (prev?.get(CHECKLIST_RESERVE_KEY) === true);

  const lines = [
    `### ${strings.checklistHeading}`,
    '',
    strings.checklistIntro,
    '',
    `- [${fundChecked ? 'x' : ' '}] **${strings.checklistFundAccountLabel}** — ${strings.checklistFundAccountDetail} ([FAQ](${fundFaq}))`,
    `- [${trustChecked ? 'x' : ' '}] **${strings.checklistTrustlineLabel(safeAsset)}** — ${strings.checklistTrustlineDetail} ([FAQ](${trustFaq}))`,
    `- [${reserveChecked ? 'x' : ' '}] **${strings.checklistReserveLabel}** — ${strings.checklistReserveDetail(String(options.minXlmReserve))} ([FAQ](${reserveFaq}))`,
  ];

  return lines.join('\n');
}
