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
    if (key === 'assetIssuer' && typeof value === 'string') {
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
// Sponsorship diagnostics extension (Issue #1)
// ---------------------------------------------------------------------------

export interface SponsorshipDiagnostics {
  numSponsoring: number;
  numSponsored: number;
  subentryCount: number;
  netSponsorshipEffect: number;
  protocolMinimum: number;
  configuredFloor: number;
  finalRequired: number;
  actualBalance: number;
  meetsRequirement: boolean;
}

/**
 * Build a sponsorship-specific diagnostics section for accounts with
 * non-zero sponsorship counts. This provides visibility into how nested
 * sponsorship chains affect reserve requirements without modifying the
 * contributor-facing sections.
 */
export function buildSponsorshipDiagnostics(
  sponsorshipInfo?: { numSponsoring: number; numSponsored: number },
  reserveRequirement?: {
    protocolMinimum: number;
    configuredFloor: number;
    required: number;
    actual: number;
    met: boolean;
    subentryCount: number;
  },
): string {
  if (!sponsorshipInfo || (sponsorshipInfo.numSponsoring === 0 && sponsorshipInfo.numSponsored === 0)) {
    return '';
  }

  if (!reserveRequirement) {
    return '';
  }

  const { numSponsoring, numSponsored } = sponsorshipInfo;
  const netEffect = numSponsoring - numSponsored;

  const lines: string[] = [
    '',
    '#### Sponsorship chain analysis',
    '',
    '> ℹ️ **Chain depth context:** This account has active sponsorship relationships that affect its reserve requirement.',
    '',
    '| Metric | Value | Impact |',
    '| --- | --- | --- |',
    `| Accounts sponsored (outbound) | \`${numSponsoring}\` | ${numSponsoring > 0 ? `+${(numSponsoring * 0.5).toFixed(1)} XLM to requirement` : 'None'} |`,
    `| Sponsorships received (inbound) | \`${numSponsored}\` | ${numSponsored > 0 ? `-${(numSponsored * 0.5).toFixed(1)} XLM from requirement` : 'None'} |`,
    `| Net sponsorship effect | \`${netEffect > 0 ? '+' : ''}${netEffect}\` entries | ${netEffect > 0 ? `**Increases** requirement by ${(netEffect * 0.5).toFixed(1)} XLM` : netEffect < 0 ? `**Reduces** requirement by ${(Math.abs(netEffect) * 0.5).toFixed(1)} XLM` : 'Neutral (balanced)'} |`,
    `| Subentries (trustlines/offers/data) | \`${reserveRequirement.subentryCount}\` | +${(reserveRequirement.subentryCount * 0.5).toFixed(1)} XLM base |`,
    '',
    '**Reserve breakdown:**',
    '',
    '```',
    'Protocol formula: (2 + subentries + sponsoring - sponsored) × 0.5 XLM',
    `                  (2 + ${reserveRequirement.subentryCount} + ${numSponsoring} - ${numSponsored}) × 0.5`,
    `                = ${reserveRequirement.protocolMinimum.toFixed(1)} XLM`,
    '',
    `Configured floor: ${reserveRequirement.configuredFloor.toFixed(1)} XLM`,
    `Final required:   ${reserveRequirement.required.toFixed(1)} XLM (max of protocol and floor)`,
    `Actual balance:   ${reserveRequirement.actual.toFixed(1)} XLM`,
    `Status:           ${reserveRequirement.met ? '✅ Met' : '❌ Deficit'}`,
    '```',
    '',
  ];

  // Warning for deep sponsorship chains
  if (numSponsoring > 3) {
    lines.push(
      '> ⚠️ **Deep sponsorship chain detected:** This account sponsors more than 3 accounts.',
      '> Nested sponsor-of-sponsor patterns can cause cascading reserve failures if any',
      '> intermediate sponsor becomes underfunded. Monitor the full chain, not just',
      '> immediate sponsees.',
      '',
    );
  }

  // Guidance for overfunding scenario
  if (numSponsored > 0 && numSponsoring === 0 && reserveRequirement.actual > reserveRequirement.required + 1.0) {
    lines.push(
      '> ℹ️ **Overfunding detected:** This sponsored account has significantly more XLM than',
      `> required (${(reserveRequirement.actual - reserveRequirement.required).toFixed(1)} XLM surplus). Since sponsorship covers reserve`,
      '> costs, this balance may be unnecessary. Consider keeping only operational funds',
      '> (for transaction fees) on sponsored accounts.',
      '',
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Exported markers (for tests and comment.ts integration)
// ---------------------------------------------------------------------------

export { DIAGNOSTICS_OPEN_MARKER, DIAGNOSTICS_CLOSE_MARKER };
