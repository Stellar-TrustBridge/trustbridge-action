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
 * A single failed check contributing to a multi-check failure summary
 * (Issue #761).
 *
 * Mirrors the shape of a `ValidationResult` failure so callers can pass the
 * failing checks straight through without reshaping them. `category` is a
 * short, stable label (e.g. `multi-asset`, `clawback`, `unauthorized`) used
 * to group failures in the rendered summary.
 */
export interface FailureSummaryEntry {
  /** Short stable category label, e.g. `multi-asset`, `clawback`, `unauthorized`. */
  category: string;
  /** Human-readable check name, e.g. `USDC trustline`. */
  check: string;
  /** Actionable remediation message for the assignee. */
  message: string;
}

/**
 * Render a consolidated multi-check failure summary (Issue #761).
 *
 * When several checks fail at once — the common Wave case of multi-asset
 * trustlines plus a clawback-enabled asset plus an unauthorized issuer —
 * posting one comment per failure is noisy and makes remediation ambiguous.
 * This helper renders a single `###` section that groups failures by
 * category, so the assignee sees every blocker and its fix in one place.
 *
 * All dynamic values are escaped through `escapeMarkdownInline` so a check
 * name or message can never inject Markdown structure. When `entries` is
 * empty the function returns `''` so callers can skip the section entirely
 * (no empty headings in comments).
 *
 * @param entries Failed checks to summarize.
 * @param options.heading Section heading (defaults to "Failure summary").
 * @returns Markdown section (heading + grouped list), or `''` when empty.
 */
export function buildFailureSummary(
  entries: FailureSummaryEntry[],
  options: { heading?: string } = {},
): string {
  if (!Array.isArray(entries) || entries.length === 0) {
    return '';
  }

  const heading = options.heading ?? 'Failure summary';

  // Group by category while preserving first-seen order for stable output.
  const groups = new Map<string, FailureSummaryEntry[]>();
  for (const entry of entries) {
    const category = entry.category || 'other';
    const bucket = groups.get(category);
    if (bucket) {
      bucket.push(entry);
    } else {
      groups.set(category, [entry]);
    }
  }

  const lines: string[] = [
    `### ${escapeMarkdownInline(heading)}`,
    '',
    `${entries.length} check${entries.length === 1 ? '' : 's'} failed:`,
    '',
  ];

  for (const [category, bucket] of groups) {
    lines.push(`**${escapeMarkdownInline(category)}**`);
    for (const entry of bucket) {
      lines.push(
        `- ${escapeMarkdownInline(entry.check)}: ${escapeMarkdownInline(entry.message)}`,
      );
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
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
   * previously checked.  This ensures manually-checked boxes

/* … truncated 7423 chars — edit only what you need near the top … */
