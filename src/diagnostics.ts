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

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { redactStellarAddress, redactHorizonUrl, redactString } from './logger';

import * as crypto from 'crypto';
import {
  redactStellarAddress,
  redactHorizonUrl,
  redactString,
  setLogCorrelationId,
} from './logger';
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
  /**
   * Per-run correlation id (Issue #904). When set, rendered as the first row
   * of the diagnostics block so support can match the comment to the run log.
   */
  correlationId?: string;
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
// Correlation id (Issue #904)
// ---------------------------------------------------------------------------

/**
 * Environment variable a caller can set to propagate an existing correlation
 * id into this run (e.g. a reusable workflow fanning out to several jobs).
 */
export const CORRELATION_ID_ENV = 'TRUSTBRIDGE_CORRELATION_ID';

/** Prefix of every generated correlation id. */
export const CORRELATION_ID_PREFIX = 'tb-';

/** Minimum / maximum accepted correlation id length. */
export const CORRELATION_ID_MIN_LENGTH = 8;
export const CORRELATION_ID_MAX_LENGTH = 64;

/** Stable reason code logged when a propagated correlation id is rejected. */
export const CORRELATION_ID_INVALID_REASON_CODE = 'CORRELATION_ID_INVALID';

/** Hidden comment marker prefix carrying the correlation id. */
export const CORRELATION_ID_MARKER_PREFIX = '<!-- trustbridge-action:correlation-id:';

const CORRELATION_ID_CHARSET = /^[A-Za-z0-9._-]+$/;

/**
 * Generate a fresh correlation id: `tb-` followed by 16 random hex chars.
 * Random (not derived from tokens, addresses or run metadata) so it can be
 * quoted publicly without leaking anything.
 */
export function generateCorrelationId(): string {
  return `${CORRELATION_ID_PREFIX}${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Validate a correlation id. Returns `undefined` when valid, otherwise a
 * stable human-readable reason. A value is rejected when it is empty,
 * shorter than {@link CORRELATION_ID_MIN_LENGTH} or longer than
 * {@link CORRELATION_ID_MAX_LENGTH}, uses characters outside
 * `[A-Za-z0-9._-]`, or would be altered by the log redaction policy
 * (i.e. it looks like a token, secret, or Stellar address).
 */
export function validateCorrelationId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return 'correlation id must be a non-empty string';
  }
  if (value.length < CORRELATION_ID_MIN_LENGTH || value.length > CORRELATION_ID_MAX_LENGTH) {
    return `correlation id must be ${CORRELATION_ID_MIN_LENGTH}-${CORRELATION_ID_MAX_LENGTH} characters (got ${value.length})`;
  }
  if (!CORRELATION_ID_CHARSET.test(value)) {
    return 'correlation id may only contain letters, digits, ".", "_" and "-"';
  }
  if (redactString(value) !== value) {
    return 'correlation id resembles a secret or Stellar address and would be redacted';
  }
  return undefined;
}

/** True when `value` is an acceptable correlation id. */
export function isValidCorrelationId(value: unknown): value is string {
  return validateCorrelationId(value) === undefined;
}

let currentCorrelationId: string | undefined;
let currentCorrelationInit: CorrelationIdInit | undefined;

/** Result of {@link initCorrelationId}. */
export interface CorrelationIdInit {
  correlationId: string;
  /** Where the id came from. */
  source: 'env' | 'generated';
  /** Set when a propagated id was present but rejected (it is never echoed). */
  rejectedReason?: string;
}

/**
 * Resolve this run's correlation id and propagate it to the logger so every
 * structured log line carries `correlation_id` (Issue #904).
 *
 * A valid `TRUSTBRIDGE_CORRELATION_ID` is reused; a missing value yields a
 * freshly generated id; a malformed value is **not** used or echoed — a new
 * id is generated and `rejectedReason` explains why. Idempotent: repeated
 * calls in the same process return the same id until
 * {@link resetCorrelationId} is called.
 */
export function initCorrelationId(
  env: Record<string, string | undefined> = process.env,
): CorrelationIdInit {
  if (currentCorrelationInit) {
    return currentCorrelationInit;
  }
  const raw = env[CORRELATION_ID_ENV]?.trim();
  let result: CorrelationIdInit;
  if (raw) {
    const reason = validateCorrelationId(raw);
    result = reason
      ? { correlationId: generateCorrelationId(), source: 'generated', rejectedReason: reason }
      : { correlationId: raw, source: 'env' };
  } else {
    result = { correlationId: generateCorrelationId(), source: 'generated' };
  }
  currentCorrelationInit = result;
  currentCorrelationId = result.correlationId;
  setLogCorrelationId(currentCorrelationId);
  return result;
}

/** The current run's correlation id, or `undefined` before {@link initCorrelationId}. */
export function getCorrelationId(): string | undefined {
  return currentCorrelationId;
}

/** Forget the current correlation id (tests / a new run in the same process). */
export function resetCorrelationId(): void {
  currentCorrelationId = undefined;
  currentCorrelationInit = undefined;
  setLogCorrelationId(undefined);
}

/**
 * Hidden marker embedding the correlation id in a comment body, so support
 * tooling can grep it even when the visible footer is not rendered.
 * Returns an empty string for an invalid id.
 */
export function formatCorrelationMarker(correlationId: string | undefined): string {
  if (!isValidCorrelationId(correlationId)) return '';
  return `${CORRELATION_ID_MARKER_PREFIX}${correlationId} -->`;
}

/** Extract a correlation id from a comment body's hidden marker, if present. */
export function parseCorrelationMarker(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const match = /<!-- trustbridge-action:correlation-id:([A-Za-z0-9._-]{8,64}) -->/.exec(body);
  return match ? match[1] : undefined;
}

/**
 * Visible comment footer line quoting the correlation id. Returns an empty
 * string for an invalid id so callers can append unconditionally.
 */
export function formatCorrelationFooter(correlationId: string | undefined): string {
  if (!isValidCorrelationId(correlationId)) return '';
  return `<sub>Correlation ID: \`${correlationId}\` — quote this when contacting support.</sub>`;
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
  'webhook_secret_previous',
  'webhookSecretPrevious',
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

export { DIAGNOSTICS_OPEN_MARKER, DIAGNOSTICS_CLOSE_MARKER };

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

  // --- Correlation id (Issue #904) ---
  if (isValidCorrelationId(config.correlationId)) {
    lines.push(`**Correlation ID:** \`${config.correlationId}\``, '');
  }

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
// Optional diagnostics bundle (zip) for artifact upload
//
// When `diagnostics_zip_path` is set, the action writes a single redacted zip
// to that workspace path. Attach it with `actions/upload-artifact`. The writer
// is dependency-free (STORE/DEFLATE only) and deterministic: identical inputs
// produce byte-identical archives, so repeated runs are idempotent.
// ---------------------------------------------------------------------------

/** Default cap on the finished zip, in bytes. */
export const DIAGNOSTICS_ZIP_DEFAULT_MAX_BYTES = 1024 * 1024;
/** Smallest cap that can hold the mandatory `manifest.json` + `inputs.json`. */
export const DIAGNOSTICS_ZIP_MIN_BYTES = 4 * 1024;
/** Hard ceiling for the cap, so a typo cannot ask for an unbounded artifact. */
export const DIAGNOSTICS_ZIP_MAX_BYTES_CEILING = 50 * 1024 * 1024;
/** Any single bundled text file is truncated to this many bytes. */
export const DIAGNOSTICS_ZIP_MAX_ENTRY_BYTES = 256 * 1024;

export const DIAGNOSTICS_ZIP_MANIFEST_SCHEMA = 'trustbridge.diagnostics.bundle/v1';

/**
 * Stable, documented outcome codes (docs/TROUBLESHOOTING.md#diagnostics-bundle).
 * Surfaced as the `diagnostics_zip_status` output.
 */
export const DIAGNOSTICS_ZIP_REASONS = {
  written: 'written',
  unchanged: 'unchanged',
  disabled: 'disabled',
  invalidPath: 'invalid_path',
  invalidMaxBytes: 'invalid_max_bytes',
  tooLarge: 'too_large',
  writeFailed: 'write_failed',
} as const;

export type DiagnosticsZipReason =
  (typeof DIAGNOSTICS_ZIP_REASONS)[keyof typeof DIAGNOSTICS_ZIP_REASONS];

export class DiagnosticsZipError extends Error {
  constructor(
    public readonly reason: DiagnosticsZipReason,
    message: string,
  ) {
    super(message);
    this.name = 'DiagnosticsZipError';
  }
}

export interface DiagnosticsZipExtraFile {
  /** File name inside `extra/` (letters, digits, `.`, `_`, `-`; max 64 chars). */
  name: string;
  content: string;
}

export interface DiagnosticsZipOptions {
  config: DiagnosticsConfig;
  /** Destination, relative to the workspace (or absolute inside it). Must end in `.zip`. */
  outputPath: string;
  /** Size cap for the finished archive. Defaults to {@link DIAGNOSTICS_ZIP_DEFAULT_MAX_BYTES}. */
  maxBytes?: number;
  /** Workspace root the output must stay inside. Defaults to `GITHUB_WORKSPACE`, then `cwd`. */
  workspaceRoot?: string;
  /** Extra text files (for example a log tail); redacted and size-capped like everything else. */
  extraFiles?: DiagnosticsZipExtraFile[];
  /** Recorded in the manifest. Omit for a fully reproducible archive. */
  now?: Date;
  actionVersion?: string;
}

export interface DiagnosticsZipResult {
  status: 'written' | 'unchanged' | 'skipped' | 'failed';
  reason: DiagnosticsZipReason;
  /** Absolute path of the archive when one exists after this call. */
  path?: string;
  bytes?: number;
  /** Names of the files inside the archive. */
  entries?: string[];
  /** Names dropped to stay under the cap. */
  omitted?: string[];
  /** Actionable, already-redacted message. */
  message: string;
}

/** Linear-time patterns: Stellar secret seeds and common token shapes. */
function redactLinear(value: string): string {
  return value
    .replace(/\bS[A-D][A-Z2-7]{54}\b/g, '[REDACTED_SECRET_SEED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_TOKEN]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED_TOKEN]');
}

/** Defence in depth on top of `redactString`: seeds and common token shapes. */
export function redactBundleText(value: string): string {
  return redactString(redactLinear(value));
}

/** Lines longer than this are cut before the (backtracking) `redactString` pass. */
export const DIAGNOSTICS_ZIP_MAX_LINE_CHARS = 1024;

function boundLineLengths(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line.length > DIAGNOSTICS_ZIP_MAX_LINE_CHARS
        ? `${line.slice(0, DIAGNOSTICS_ZIP_MAX_LINE_CHARS)}...[line truncated]`
        : line,
    )
    .join('\n');
}

/** Parse the `diagnostics_zip_max_bytes` input. Empty means the default. */
export function parseDiagnosticsZipMaxBytes(
  raw: string | undefined,
): { ok: true; value: number } | { ok: false; message: string } {
  const text = (raw ?? '').trim();
  if (text === '') return { ok: true, value: DIAGNOSTICS_ZIP_DEFAULT_MAX_BYTES };
  if (!/^\d+$/.test(text)) {
    return { ok: false, message: `diagnostics_zip_max_bytes must be a whole number of bytes, got "${redactString(text)}"` };
  }
  const value = Number(text);
  if (value < DIAGNOSTICS_ZIP_MIN_BYTES || value > DIAGNOSTICS_ZIP_MAX_BYTES_CEILING) {
    return {
      ok: false,
      message: `diagnostics_zip_max_bytes must be between ${DIAGNOSTICS_ZIP_MIN_BYTES} and ${DIAGNOSTICS_ZIP_MAX_BYTES_CEILING} bytes, got ${value}`,
    };
  }
  return { ok: true, value };
}

// --- minimal zip writer ----------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

// Fixed timestamp (2000-01-01 00:00:00) so archives are reproducible.
const DOS_TIME = 0;
const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1;

function assertSafeEntryName(name: string): void {
  if (
    !name ||
    name.length > 128 ||
    name.startsWith('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    name.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new DiagnosticsZipError(DIAGNOSTICS_ZIP_REASONS.writeFailed, `unsafe zip entry name: ${JSON.stringify(redactString(name))}`);
  }
}

/** Build a zip archive in memory. Entries are written sorted by name. */
export function buildZip(entries: ZipEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const seen = new Set<string>();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of sorted) {
    assertSafeEntryName(entry.name);
    if (seen.has(entry.name)) {
      throw new DiagnosticsZipError(DIAGNOSTICS_ZIP_REASONS.writeFailed, `duplicate zip entry: ${entry.name}`);
    }
    seen.add(entry.name);

    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const deflated = zlib.deflateRawSync(entry.data, { level: 9 });
    const useDeflate = deflated.length < entry.data.length;
    const payload = useDeflate ? deflated : entry.data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: unix, v2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((0o100644 << 16) >>> 0), 38); // regular file, rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + payload.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  const marker = '\n[truncated by trustbridge-action]\n';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  // Cut on a character boundary: slice bytes, then drop any partial trailing code point.
  const cut = Buffer.from(text, 'utf8').subarray(0, budget).toString('utf8').replace(/�$/, '');
  return { text: cut + marker, truncated: true };
}

interface BundleFile {
  name: string;
  data: Buffer;
  truncated: boolean;
  /** Lower number is dropped last. */
  priority: number;
}

function textFile(name: string, text: string, priority: number): BundleFile {
  // Seeds/tokens first (linear), then bound line length so the backtracking
  // secret-assignment pattern in `redactString` cannot go quadratic on a huge
  // unbroken blob, then the full redaction pass.
  const safe = truncateText(redactString(boundLineLengths(redactLinear(text))), DIAGNOSTICS_ZIP_MAX_ENTRY_BYTES);
  return { name, data: Buffer.from(safe.text, 'utf8'), truncated: safe.truncated, priority };
}

/**
 * Assemble the bundle in memory. Throws {@link DiagnosticsZipError} with
 * reason `too_large` when even the mandatory files cannot fit under `maxBytes`.
 */
export function buildDiagnosticsZip(options: DiagnosticsZipOptions): {
  zip: Buffer;
  entries: string[];
  omitted: string[];
} {
  const maxBytes = options.maxBytes ?? DIAGNOSTICS_ZIP_DEFAULT_MAX_BYTES;
  const { config } = options;

  const optional: BundleFile[] = [];
  const mandatory: BundleFile[] = [
    textFile('inputs.json', JSON.stringify(buildSafeInputsSnapshot(config.inputs), null, 2), 0),
  ];

  optional.push(textFile('diagnostics.md', buildDiagnosticsBlock(config), 1));
  if (config.runInfo) {
    optional.push(
      textFile(
        'run-info.json',
        JSON.stringify(
          { ...config.runInfo, horizonError: config.runInfo.horizonError ? redactBundleText(config.runInfo.horizonError) : undefined },
          null,
          2,
        ),
        2,
      ),
    );
  }
  for (const extra of options.extraFiles ?? []) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(extra.name) || extra.name.startsWith('.')) {
      throw new DiagnosticsZipError(DIAGNOSTICS_ZIP_REASONS.writeFailed, `invalid extra file name: ${JSON.stringify(redactString(extra.name))}`);
    }
    optional.push(textFile(`extra/${extra.name}`, extra.content, 3));
  }

  const omitted: Array<{ name: string; reason: 'size_cap' }> = [];
  const render = (files: BundleFile[]): Buffer => {
    const manifest = {
      schema: DIAGNOSTICS_ZIP_MANIFEST_SCHEMA,
      generatedAt: options.now ? options.now.toISOString() : undefined,
      actionVersion: options.actionVersion,
      maxBytes,
      redaction: {
        policy: 'logger.redactString + secret-field blocklist + seed/token patterns',
        addressesMasked: true,
        secretsIncluded: false,
      },
      files: files
        .map((f) => ({
          name: f.name,
          bytes: f.data.length,
          sha256: createHash('sha256').update(f.data).digest('hex'),
          truncated: f.truncated,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1)),
      omitted: [...omitted].sort((a, b) => (a.name < b.name ? -1 : 1)),
    };
    const manifestFile = textFile('manifest.json', JSON.stringify(manifest, null, 2), 0);
    return buildZip([...files, manifestFile].map((f) => ({ name: f.name, data: f.data })));
  };

  let included = [...mandatory, ...optional];
  let zip = render(included);
  // Drop the least valuable (highest priority number, then largest) optional files until it fits.
  while (zip.length > maxBytes) {
    const droppable = included.filter((f) => f.priority > 0);
    if (droppable.length === 0) {
      throw new DiagnosticsZipError(
        DIAGNOSTICS_ZIP_REASONS.tooLarge,
        `diagnostics bundle needs ${zip.length} bytes for its mandatory files but diagnostics_zip_max_bytes is ${maxBytes}; raise the cap or reduce inputs`,
      );
    }
    droppable.sort((a, b) => b.priority - a.priority || b.data.length - a.data.length || (a.name < b.name ? -1 : 1));
    const drop = droppable[0];
    omitted.push({ name: drop.name, reason: 'size_cap' });
    included = included.filter((f) => f !== drop);
    zip = render(included);
  }

  return {
    zip,
    entries: [...included.map((f) => f.name), 'manifest.json'].sort(),
    omitted: omitted.map((o) => o.name),
  };
}

/** Resolve and validate the destination. Throws `invalid_path` with an actionable message. */
export function resolveDiagnosticsZipPath(outputPath: string, workspaceRoot?: string): string {
  const raw = (outputPath ?? '').trim();
  if (!raw) {
    throw new DiagnosticsZipError(DIAGNOSTICS_ZIP_REASONS.invalidPath, 'diagnostics_zip_path is empty');
  }
  if (raw.includes('\0')) {
    throw new DiagnosticsZipError(DIAGNOSTICS_ZIP_REASONS.invalidPath, 'diagnostics_zip_path contains a NUL byte');
  }
  if (!raw.toLowerCase().endsWith('.zip')) {
    throw new DiagnosticsZipError(DIAGNOSTICS_ZIP_REASONS.invalidPath, 'diagnostics_zip_path must end in ".zip"');
  }
  const root = path.resolve(workspaceRoot || process.env.GITHUB_WORKSPACE || process.cwd());
  const resolved = path.resolve(root, raw);
  const inside = (base: string, target: string): boolean => {
    const rel = path.relative(base, target);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  if (!inside(root, resolved)) {
    throw new DiagnosticsZipError(
      DIAGNOSTICS_ZIP_REASONS.invalidPath,
      'diagnostics_zip_path must resolve inside GITHUB_WORKSPACE (path traversal and absolute paths outside it are rejected)',
    );
  }
  // A symlinked parent could still point outside the workspace.
  try {
    let probe = path.dirname(resolved);
    while (!fs.existsSync(probe) && probe !== root) probe = path.dirname(probe);
    if (fs.existsSync(probe) && !inside(fs.realpathSync(root), fs.realpathSync(probe)) && fs.realpathSync(probe) !== fs.realpathSync(root)) {
      throw new DiagnosticsZipError(DIAGNOSTICS_ZIP_REASONS.invalidPath, 'diagnostics_zip_path resolves outside GITHUB_WORKSPACE through a symlink');
    }
  } catch (err) {
    if (err instanceof DiagnosticsZipError) throw err;
  }
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    throw new DiagnosticsZipError(DIAGNOSTICS_ZIP_REASONS.invalidPath, 'diagnostics_zip_path points at a directory');
  }
  return resolved;
}

/**
 * Write the diagnostics bundle. Never throws: failures come back as
 * `status: 'failed'` with a stable `reason` and an actionable message, so the
 * caller can warn without affecting the validation verdict.
 *
 * The archive is written to a temporary file and renamed into place, so an
 * interrupted run never leaves a truncated zip. When the existing file is
 * already byte-identical the call is a no-op (`unchanged`).
 */
export function writeDiagnosticsZip(options: DiagnosticsZipOptions): DiagnosticsZipResult {
  let resolved: string;
  try {
    resolved = resolveDiagnosticsZipPath(options.outputPath, options.workspaceRoot);
  } catch (err) {
    const e = err as DiagnosticsZipError;
    return { status: 'failed', reason: e.reason ?? DIAGNOSTICS_ZIP_REASONS.invalidPath, message: e.message };
  }

  let built: ReturnType<typeof buildDiagnosticsZip>;
  try {
    built = buildDiagnosticsZip(options);
  } catch (err) {
    if (err instanceof DiagnosticsZipError) return { status: 'failed', reason: err.reason, message: err.message };
    return { status: 'failed', reason: DIAGNOSTICS_ZIP_REASONS.writeFailed, message: redactBundleText(err instanceof Error ? err.message : String(err)) };
  }

  const base = { path: resolved, bytes: built.zip.length, entries: built.entries, omitted: built.omitted };
  try {
    if (fs.existsSync(resolved) && fs.readFileSync(resolved).equals(built.zip)) {
      return { status: 'unchanged', reason: DIAGNOSTICS_ZIP_REASONS.unchanged, ...base, message: `Diagnostics bundle already up to date at ${resolved}` };
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const tmp = `${resolved}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, built.zip);
      fs.renameSync(tmp, resolved);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* best effort */
      }
      throw err;
    }
    const dropped = built.omitted.length ? ` (omitted to fit the size cap: ${built.omitted.join(', ')})` : '';
    return { status: 'written', reason: DIAGNOSTICS_ZIP_REASONS.written, ...base, message: `Wrote diagnostics bundle (${built.zip.length} bytes) to ${resolved}${dropped}` };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const hint = code === 'EACCES' || code === 'EPERM' ? ' (permission denied: check the workspace is writable)' : code === 'ENOSPC' ? ' (disk full)' : '';
    return {
      status: 'failed',
      reason: DIAGNOSTICS_ZIP_REASONS.writeFailed,
      message: `Could not write diagnostics bundle to ${resolved}${hint}: ${redactBundleText(err instanceof Error ? err.message : String(err))}`,
    };
  }

/**
 * Render captured plugin stderr (Issue #954) as a Markdown diagnostics
 * section. Captures arrive already capped and redacted by
 * `captureStderr` in `src/pluginRunner.ts`; this only formats them, and
 * returns an empty string when no plugin wrote to stderr.
 */
export function buildPluginStderrDiagnostics(
  captures: ReadonlyArray<{ pluginId: string; text: string; totalBytes: number; truncated: boolean }>,
): string {
  const nonEmpty = captures.filter((c) => c.totalBytes > 0);
  if (nonEmpty.length === 0) return '';
  const lines = ['### Plugin stderr'];
  for (const c of nonEmpty) {
    lines.push(
      '',
      `**\`${c.pluginId}\`** — ${c.totalBytes} byte(s)${c.truncated ? ', truncated' : ''}`,
      '```text',
      c.text.replace(/```/g, '`​``'),
      '```',
    );
  }
  return lines.join('\n');
}
