/**
 * Expert-mode diagnostics block for TrustBridge issue comments (Issue #102).
 *
 * When `debug_mode: true` (or the forthcoming `expert_mode: true`) is set,
 * a clearly-separated diagnostics section is appended to the issue comment
 * after the normal contributor-facing content. The contributor-facing section
 * is never modified or cluttered by this addition.
 *
 * ## What the diagnostics block contains
 * - Horizon status code and round-trip latency
 * - Normalized resolved inputs (redacted — no raw secrets)
 * - Check-level detail rows showing each assertion, its pass/fail state, and
 *   the underlying data value that drove the decision
 * - Error messages from failed Horizon calls (redacted)
 *
 * ## Security guarantees
 * - `github_token`, `webhook_secret`, and any other secret-classified fields
 *   are **never** included. The secret-field block-list mirrors the one in
 *   `src/configReader.ts`.
 * - Stellar addresses are redacted via `redactStellarAddress` (first-4/last-4).
 * - Horizon URLs are redacted via `redactHorizonUrl`.
 * - Free-form error messages are scanned with `redactString` before inclusion.
 */

import { redactStellarAddress, redactHorizonUrl, redactString } from './logger';
import { escapeMarkdownInline as escapeMarkdown } from './markdown';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiagnosticsInputSnapshot {
  horizonUrl: string;
  horizonUrlFallback?: string;
  assetCode: string;
  assetIssuer: string;
  minXlmReserve: string | number;
  horizonTimeoutMs: number;
  useCache: boolean;
  cacheTtlMs?: number;
  allowCrossNetworkFallback: boolean;
  debugMode: boolean;
  /** Any additional resolved scalar inputs to surface. */
  [key: string]: unknown;
}

export interface DiagnosticsRunInfo {
  /** HTTP status code returned by Horizon (undefined when cached or not reached). */
  horizonStatusCode?: number;
  /** Round-trip latency to Horizon in milliseconds. */
  horizonLatencyMs?: number;
  /** Primary Horizon error message, if any (will be redacted). */
  horizonError?: string;
  /** Whether the result was served from the in-memory cache. */
  fromCache?: boolean;
  /** Whether the fallback URL was used for this request. */
  usedFallback?: boolean;
  /** Number of retry attempts made before a final response. */
  retryCount?: number;
}

export interface DiagnosticsConfig {
  /** Resolved action inputs snapshot. */
  inputs: DiagnosticsInputSnapshot;
  /** Runtime information about the Horizon request. */
  runInfo?: DiagnosticsRunInfo;
  /** Whether to include the full normalized-inputs table (default true). */
  showInputs?: boolean;
  /** Optional sponsorship info for chain analysis. */
  sponsorshipInfo?: { numSponsoring: number; numSponsored: number };
  /** Optional reserve requirement for sponsorship breakdown. */
  reserveRequirement?: {
    protocolMinimum: number;
    configuredFloor: number;
    required: number;
    actual: number;
    met: boolean;
    subentryCount: number;
  };
}

// ---------------------------------------------------------------------------
// Secret field block-list (mirrors configReader.ts)
// ---------------------------------------------------------------------------

const SECRET_FIELD_NAMES = new Set([
  'github_token',
  'githubToken',
  'api_key',
  'apiKey',
  'secret',
  'webhook_secret',
  'webhookSecret',
  'password',
  'token',
  'private_key',
  'privateKey',
  'passphrase',
]);

function isSecretField(key: string): boolean {
  return SECRET_FIELD_NAMES.has(key) || key.toLowerCase().includes('secret') ||
    key.toLowerCase().includes('token') || key.toLowerCase().includes('password');
}

// ---------------------------------------------------------------------------
// Address field detection
// ---------------------------------------------------------------------------

/**
 * Field names whose values are Stellar G/C addresses and must be redacted.
 * Matched case-insensitively; also catches any key ending in `address`,
 * `issuer`, or `account` so new address-shaped inputs are covered by default.
 */
const ADDRESS_FIELD_NAMES = new Set([
  'assetissuer',
  'issuer',
  'sourceaccount',
  'source_account',
  'destinationaccount',
  'destination_account',
  'account',
  'accountid',
  'account_id',
  'address',
  'stellaraddress',
  'stellar_address',
]);

function isAddressField(key: string): boolean {
  const lower = key.toLowerCase();
  return ADDRESS_FIELD_NAMES.has(lower) ||
    lower.endsWith('address') ||
    lower.endsWith('issuer') ||
    lower.endsWith('account');
}

// ---------------------------------------------------------------------------
// Safe snapshot builder
// ---------------------------------------------------------------------------

/**
 * Build a redacted, safe-to-log copy of the inputs snapshot.
 * Secret-classified fields are replaced with `***`.
 * Address and URL fields are redacted using the standard policy.
 */
export function buildSafeInputsSnapshot(
  inputs: DiagnosticsInputSnapshot,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputs)) {
    if (isSecretField(key)) {
      safe[key] = '***';
      continue;
    }
    if (key === 'horizonUrl' || key === 'horizonUrlFallback') {
      safe[key] = typeof value === 'string' ? redactHorizonUrl(value) : value;
      continue;
    }
    if (isAddressField(key) && typeof value === 'string') {
      safe[key] = redactStellarAddress(value) || redactString(value);
      continue;
    }
    if (typeof value === 'string') {
      safe[key] = redactString(value);
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

// ---------------------------------------------------------------------------
// Markdown block builder
// ---------------------------------------------------------------------------

const DIAGNOSTICS_OPEN_MARKER = '<!-- trustbridge-action:diagnostics-start -->';
const DIAGNOSTICS_CLOSE_MARKER = '<!-- trustbridge-action:diagnostics-end -->';

/**
 * Build the expert diagnostics collapsible Markdown block.
 *
 * Returns an empty string when neither `inputs` nor `runInfo` has meaningful
 * content, so callers can append unconditionally.
 */
export function buildDiagnosticsBlock(config: DiagnosticsConfig): string {
  const showInputs = config.showInputs !== false;
  const { inputs, runInfo, sponsorshipInfo, reserveRequirement } = config;

  const lines: string[] = [
    '',
    DIAGNOSTICS_OPEN_MARKER,
    '',
    '<details>',
    '<summary>🔬 <strong>Expert diagnostics</strong> — expand for Horizon details and normalized inputs</summary>',
    '',
    '> ℹ️ This section is only visible when `debug_mode: true` is set.',
    '> It is intended for maintainers and contributors debugging validation failures.',
    '> **No secrets are included.** All addresses are redacted to first-4/last-4.',
    '',
  ];

  // --- Horizon run info ---
  if (runInfo) {
    lines.push('#### Horizon request details', '');
    lines.push('| Field | Value |');
    lines.push('| --- | --- |');

    if (runInfo.horizonStatusCode !== undefined) {
      const statusLabel = runInfo.horizonStatusCode >= 200 && runInfo.horizonStatusCode < 300
        ? `✅ ${runInfo.horizonStatusCode}`
        : `❌ ${runInfo.horizonStatusCode}`;
      lines.push(`| HTTP status | \`${statusLabel}\` |`);
    }
    if (runInfo.horizonLatencyMs !== undefined) {
      lines.push(`| Round-trip latency | \`${runInfo.horizonLatencyMs} ms\` |`);
    }
    if (runInfo.fromCache !== undefined) {
      lines.push(`| Served from cache | \`${runInfo.fromCache}\` |`);
    }
    if (runInfo.usedFallback !== undefined) {
      lines.push(`| Used fallback URL | \`${runInfo.usedFallback}\` |`);
    }
    if (runInfo.retryCount !== undefined) {
      lines.push(`| Retry attempts | \`${runInfo.retryCount}\` |`);
    }
    if (runInfo.horizonError) {
      const safeError = escapeMarkdown(redactString(runInfo.horizonError));
      lines.push(`| Horizon error | ${safeError} |`);
    }

    lines.push('');
  }

  // --- Sponsorship chain analysis (Issue #1) ---
  const sponsorshipSection = buildSponsorshipDiagnostics(sponsorshipInfo, reserveRequirement);
  if (sponsorshipSection) {
    lines.push(sponsorshipSection);
  }

  // --- Normalized inputs ---
  if (showInputs) {
    const safe = buildSafeInputsSnapshot(inputs);
    lines.push('#### Normalized inputs', '');
    lines.push('| Input | Resolved value |');
    lines.push('| --- | --- |');
    for (const [key, value] of Object.entries(safe)) {
      const displayValue = value === '***'
        ? '`***` _(redacted)_'
        : `\`${escapeMarkdown(String(value))}\``;
      lines.push(`| \`${escapeMarkdown(key)}\` | ${displayValue} |`);
    }
    lines.push('');
  }

  lines.push('</details>', '', DIAGNOSTICS_CLOSE_MARKER, '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Sponsorship diagnostics (Issue #1)
// ---------------------------------------------------------------------------

function buildSponsorshipDiagnostics(
  sponsorshipInfo?: { numSponsoring: number; numSponsored: number },
  reserveRequirement?: DiagnosticsConfig['reserveRequirement'],
): string {
  if (!sponsorshipInfo && !reserveRequirement) {
    return '';
  }

  const lines: string[] = ['#### Sponsorship & reserve analysis', ''];
  lines.push('| Field | Value |');
  lines.push('| --- | --- |');

  if (sponsorshipInfo) {
    lines.push(`| Sponsoring subentries | \`${sponsorshipInfo.numSponsoring}\` |`);
    lines.push(`| Sponsored subentries | \`${sponsorshipInfo.numSponsored}\` |`);
  }

  if (reserveRequirement) {
    const { protocolMinimum, configuredFloor, required, actual, met, subentryCount } = reserveRequirement;
    lines.push(`| Protocol minimum reserve | \`${protocolMinimum} XLM\` |`);
    lines.push(`| Configured reserve floor | \`${configuredFloor} XLM\` |`);
    lines.push(`| Required reserve | \`${required} XLM\` |`);
    lines.push(`| Actual balance | \`${actual} XLM\` |`);
    lines.push(`| Subentry count | \`${subentryCount}\` |`);
    lines.push(`| Reserve met | \`${met ? '✅ yes' : '❌ no'}\` |`);
  }

  lines.push('');
  return lines.join('\n');
}
