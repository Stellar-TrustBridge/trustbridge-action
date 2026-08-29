/**
 * Delta vs previous workflow-run validation artifact (Security / Issue #148).
 *
 * Consumers retain `validation.json` across runs (upload-artifact + download
 * on the next cron/dispatch). This module compares the prior snapshot to the
 * current check results and produces a structured delta for comments and JSON.
 *
 * Strategy tradeoffs (documented also in docs/USAGE.md):
 * - **Local artifact path (recommended):** workflow downloads the previous
 *   run's artifact to `previous_validation_path`. No extra API scopes; explicit
 *   matching; fails soft when the file is absent (first run).
 * - **GitHub Actions API auto-discovery (Issue #212):** when no local path is
 *   provided and `GITHUB_TOKEN` + `GITHUB_REPOSITORY` + `GITHUB_RUN_ID` are
 *   available, the action queries the Actions API for the most recent completed
 *   run that uploaded a `validation.json` artifact and downloads it in-memory.
 *   Fails open on 403 / API errors so delta is never required.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { CheckResultItem, ValidationGate, ValidationResult, buildValidationGate } from './checks';
import { redactStellarAddress, redactString } from './logger';

/** Minimal prior-check shape used for comparison (label + pass/fail). */
export interface CheckSnapshot {
  label: string;
  passed: boolean;
}

/**
 * Machine-readable validation artifact schema written to `validation.json`.
 * Compatible with the Security artifact introduced for auditing (#83).
 * Never includes tokens or auth headers.
 */
export interface ValidationArtifact {
  schemaVersion: string;
  timestamp: string;
  address: string;
  asset: {
    code: string;
    issuer: string;
  };
  horizonUrl?: string;
  readiness: ValidationGate;
  checks: CheckResultItem[];
  balances: {
    xlm: string;
  };
  /** Present when a previous artifact was loaded and compared. */
  delta?: ValidationDelta;
  /** True when addresses/issuers were privacy-redacted in this payload. */
  privacyMode?: boolean;
}

export interface ValidationDelta {
  previousTimestamp?: string;
  newlyPassed: string[];
  newlyFailed: string[];
  unchanged: string[];
  improved: boolean;
  regressed: boolean;
}

export const VALIDATION_ARTIFACT_SCHEMA_VERSION = '1.0.0';

/** Keys that must never appear in a validation / delta payload. */
const FORBIDDEN_SENSITIVE_KEYS = new Set([
  'github_token',
  'githubToken',
  'token',
  'authorization',
  'Authorization',
  'api_key',
  'apiKey',
  'password',
  'secret',
  'private_key',
  'privateKey',
  'passphrase',
]);

/**
 * Hash a Stellar address for privacy-mode JSON artifacts.
 * Returns `sha256:<16 hex chars>` so payloads stay correlatable without
 * exposing the raw G-/C-address in retained artifacts or Actions logs.
 */
export function hashAddressForPrivacy(address: string): string {
  const digest = crypto.createHash('sha256').update(address.trim()).digest('hex');
  return `sha256:${digest.slice(0, 16)}`;
}

/**
 * Apply privacy policy to a string that may contain addresses.
 * When privacyMode is on, addresses are hashed; otherwise first4…last4 redaction.
 */
export function privacyMaskAddress(address: string, privacyMode: boolean): string {
  if (!address) return address;
  if (privacyMode) return hashAddressForPrivacy(address);
  return redactStellarAddress(address);
}

/**
 * Strip forbidden sensitive keys from an arbitrary object tree (defense in depth
 * when loading a previous artifact that might have been hand-edited).
 */
export function stripSensitiveFields<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => stripSensitiveFields(item)) as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_SENSITIVE_KEYS.has(key)) continue;
      out[key] = stripSensitiveFields(child);
    }
    return out as T;
  }
  return value;
}

/**
 * Compare previous vs current checks by label.
 * Returns `null` when there is no previous snapshot (first run) — callers
 * should omit the delta section entirely rather than erroring.
 */
export function computeValidationDelta(
  previous: { checks: CheckSnapshot[]; timestamp?: string } | null | undefined,
  current: { checks: CheckSnapshot[] },
): ValidationDelta | null {
  if (!previous || !Array.isArray(previous.checks) || previous.checks.length === 0) {
    return null;
  }

  const previousByLabel = new Map<string, boolean>();
  for (const check of previous.checks) {
    if (check && typeof check.label === 'string') {
      previousByLabel.set(check.label, Boolean(check.passed));
    }
  }

  const newlyPassed: string[] = [];
  const newlyFailed: string[] = [];
  const unchanged: string[] = [];

  for (const check of current.checks) {
    const prior = previousByLabel.get(check.label);
    if (prior === undefined) {
      // New check label not present previously — treat as newly passed/failed.
      if (check.passed) newlyPassed.push(check.label);
      else newlyFailed.push(check.label);
      continue;
    }
    if (prior === check.passed) {
      unchanged.push(check.label);
    } else if (check.passed && !prior) {
      newlyPassed.push(check.label);
    } else if (!check.passed && prior) {
      newlyFailed.push(check.label);
    }
  }

  return {
    previousTimestamp: previous.timestamp,
    newlyPassed,
    newlyFailed,
    unchanged,
    improved: newlyPassed.length > 0,
    regressed: newlyFailed.length > 0,
  };
}

/**
 * Load a previous `validation.json` from disk. Returns `null` (no throw) when
 * the path is empty, the file is missing, or JSON is unreadable/invalid —
 * first-run and artifact-miss cases must never fail the action.
 */
export function loadPreviousValidationArtifact(
  previousPath: string,
  workspaceRoot?: string,
): ValidationArtifact | null {
  const trimmed = (previousPath || '').trim();
  if (!trimmed) return null;

  const root = workspaceRoot || process.env.GITHUB_WORKSPACE || process.cwd();
  const absolutePath = path.isAbsolute(trimmed) ? trimmed : path.resolve(root, trimmed);

  try {
    if (!fs.existsSync(absolutePath)) {
      return null;
    }
    const raw = fs.readFileSync(absolutePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;

    const cleaned = stripSensitiveFields(parsed) as Partial<ValidationArtifact>;
    if (!Array.isArray(cleaned.checks)) return null;

    return {
      schemaVersion: cleaned.schemaVersion || VALIDATION_ARTIFACT_SCHEMA_VERSION,
      timestamp: typeof cleaned.timestamp === 'string' ? cleaned.timestamp : '',
      address: typeof cleaned.address === 'string' ? cleaned.address : '',
      asset: {
        code: cleaned.asset?.code ?? '',
        issuer: cleaned.asset?.issuer ?? '',
      },
      horizonUrl: cleaned.horizonUrl,
      readiness: cleaned.readiness ?? {
        ready: false,
        totalChecks: cleaned.checks.length,
        passedChecks: cleaned.checks.filter((c) => c.passed).length,
        failedChecks: cleaned.checks.filter((c) => !c.passed).length,
        failedLabels: cleaned.checks.filter((c) => !c.passed).map((c) => c.label),
      },
      checks: cleaned.checks.map((c) => ({
        label: c.label,
        passed: Boolean(c.passed),
        detail: typeof c.detail === 'string' ? redactString(c.detail) : '',
      })),
      balances: {
        xlm: cleaned.balances?.xlm ?? 'unknown',
      },
      delta: cleaned.delta,
      privacyMode: cleaned.privacyMode,
    };
  } catch {
    return null;
  }
}

export interface BuildValidationArtifactOptions {
  result: ValidationResult;
  stellarAddress: string;
  assetCode: string;
  assetIssuer: string;
  horizonUrl?: string;
  delta?: ValidationDelta | null;
  privacyMode?: boolean;
  timestamp?: string;
}

/**
 * Build the validation.json payload. Applies privacy masking to addresses
 * and strips any accidental sensitive fields. Never embeds tokens.
 */
export function buildValidationArtifact(options: BuildValidationArtifactOptions): ValidationArtifact {
  const privacyMode = Boolean(options.privacyMode);
  // Full addresses by default (auditing). Privacy mode hashes them for retained artifacts.
  const address = privacyMode
    ? privacyMaskAddress(options.stellarAddress, true)
    : options.stellarAddress;
  const issuer = privacyMode
    ? privacyMaskAddress(options.assetIssuer, true)
    : options.assetIssuer;

  const checks: CheckResultItem[] = options.result.checks.map((c) => ({
    label: c.label,
    passed: c.passed,
    detail: privacyMode
      ? redactString(c.detail).replace(/\b([GC][A-Z2-7]{55})\b/g, (m) => hashAddressForPrivacy(m))
      : c.detail,
  }));

  const artifact: ValidationArtifact = {
    schemaVersion: VALIDATION_ARTIFACT_SCHEMA_VERSION,
    timestamp: options.timestamp ?? new Date().toISOString(),
    address,
    asset: {
      code: options.assetCode,
      issuer,
    },
    horizonUrl: options.horizonUrl
      ? privacyMode
        ? redactString(options.horizonUrl).replace(/\b([GC][A-Z2-7]{55})\b/g, (m) =>
            hashAddressForPrivacy(m),
          )
        : options.horizonUrl
      : undefined,
    readiness: buildValidationGate(options.result),
    checks,
    balances: {
      xlm: options.result.xlmBalance,
    },
    privacyMode: privacyMode || undefined,
  };

  if (options.delta) {
    artifact.delta = options.delta;
  }

  return stripSensitiveFields(artifact);
}

/**
 * Render a Markdown delta section for the issue comment.
 * Returns an empty string when there is no delta (first run).
 */
export function formatDeltaMarkdown(delta: ValidationDelta | null | undefined): string {
  if (!delta) return '';

  const lines: string[] = [
    '### Delta vs previous run',
    '',
  ];

  if (delta.previousTimestamp) {
    lines.push(`_Compared to previous artifact from \`${delta.previousTimestamp}\`._`, '');
  }

  if (delta.newlyPassed.length === 0 && delta.newlyFailed.length === 0) {
    lines.push('- No check status changes since the previous run.');
  } else {
    if (delta.newlyPassed.length > 0) {
      lines.push(`- ✅ **Newly passed:** ${delta.newlyPassed.join(', ')}`);
    }
    if (delta.newlyFailed.length > 0) {
      lines.push(`- ❌ **Newly failed:** ${delta.newlyFailed.join(', ')}`);
    }
  }

  if (delta.unchanged.length > 0) {
    lines.push(`- Unchanged: ${delta.unchanged.length} check(s)`);
  }

  if (delta.regressed) {
    lines.push('', '_Regression detected — one or more checks that previously passed now fail._');
  } else if (delta.improved && !delta.regressed) {
    lines.push('', '_Improvement — checks newly passing with no new failures._');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Issue #212 — Auto-discover previous validation.json artifact via Actions API
// ---------------------------------------------------------------------------

/**
 * Attempt to auto-discover and download the most recent `validation.json`
 * artifact from prior workflow runs via the GitHub Actions REST API.
 *
 * This is a best-effort, fail-open operation:
 * - Returns `null` when required context is missing (non-Actions env).
 * - Returns `null` on API errors (403, rate limit, network).
 * - Returns `null` when no prior artifact is found (first run).
 *
 * Requires `GITHUB_TOKEN` with `actions: read` permission. When the token
 * lacks this scope, the function returns `null` gracefully so delta is
 * never a hard requirement.
 */
export async function discoverPreviousValidationArtifact(
  githubToken: string,
  artifactName: string = 'validation-json',
): Promise<ValidationArtifact | null> {
  const repoFullName = process.env.GITHUB_REPOSITORY;
  const currentRunId = process.env.GITHUB_RUN_ID;
  const apiBase = process.env.GITHUB_API_URL || 'https://api.github.com';

  if (!repoFullName || !currentRunId || !githubToken) {
    return null;
  }

  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo) return null;

  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${githubToken}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };

  try {
    // List recent workflow runs (newest first), excluding the current run.
    const runsUrl = `${apiBase}/repos/${owner}/${repo}/actions/runs?status=completed&per_page=10&exclude_pull_requests=true`;
    const runsResp = await fetch(runsUrl, { headers });
    if (!runsResp.ok) return null;

    const runsData = (await runsResp.json()) as {
      workflow_runs?: Array<{ id: number }>;
    };
    const runs = runsData.workflow_runs ?? [];
    const priorRuns = runs.filter((r) => r.id !== Number(currentRunId));

    for (const run of priorRuns) {
      // List artifacts for this run.
      const artifactsUrl = `${apiBase}/repos/${owner}/${repo}/actions/runs/${run.id}/artifacts?per_page=10`;
      const artifactsResp = await fetch(artifactsUrl, { headers });
      if (!artifactsResp.ok) continue;

      const artifactsData = (await artifactsResp.json()) as {
        artifacts?: Array<{ name: string; id: number; expired: boolean }>;
      };
      const artifacts = artifactsData.artifacts ?? [];
      const target = artifacts.find(
        (a) => a.name === artifactName && !a.expired,
      );
      if (!target) continue;

      // Download the artifact zip.
      const downloadUrl = `${apiBase}/repos/${owner}/${repo}/actions/artifacts/${target.id}/zip`;
      const downloadResp = await fetch(downloadUrl, { headers });
      if (!downloadResp.ok) continue;

      // The artifact zip contains the file(s). Parse the zip to extract validation.json.
      const zipBuffer = Buffer.from(await downloadResp.arrayBuffer());
      const validationJson = extractFromZip(zipBuffer, 'validation.json');
      if (!validationJson) continue;

      const parsed = JSON.parse(validationJson) as unknown;
      if (!parsed || typeof parsed !== 'object') continue;

      const cleaned = stripSensitiveFields(parsed) as Partial<ValidationArtifact>;
      if (!Array.isArray(cleaned.checks)) continue;

      return {
        schemaVersion: cleaned.schemaVersion || VALIDATION_ARTIFACT_SCHEMA_VERSION,
        timestamp: typeof cleaned.timestamp === 'string' ? cleaned.timestamp : '',
        address: typeof cleaned.address === 'string' ? cleaned.address : '',
        asset: {
          code: cleaned.asset?.code ?? '',
          issuer: cleaned.asset?.issuer ?? '',
        },
        horizonUrl: cleaned.horizonUrl,
        readiness: cleaned.readiness ?? {
          ready: false,
          totalChecks: cleaned.checks.length,
          passedChecks: cleaned.checks.filter((c) => c.passed).length,
          failedChecks: cleaned.checks.filter((c) => !c.passed).length,
          failedLabels: cleaned.checks.filter((c) => !c.passed).map((c) => c.label),
        },
        checks: cleaned.checks.map((c) => ({
          label: c.label,
          passed: Boolean(c.passed),
          detail: typeof c.detail === 'string' ? redactString(c.detail) : '',
        })),
        balances: {
          xlm: cleaned.balances?.xlm ?? 'unknown',
        },
        delta: cleaned.delta,
        privacyMode: cleaned.privacyMode,
      };
    }

    return null;
  } catch {
    // Fail open: auto-discovery errors must never block the action.
    return null;
  }
}

/**
 * Minimal ZIP extraction for a single named file.
 * Parses the ZIP local file headers to find and decompress the target file.
 * Returns the file content as a UTF-8 string, or null if not found.
 *
 * @internal Exported for testing.
 */
export function extractFromZip(
  zipBuffer: Buffer,
  targetFileName: string,
): string | null {
  // ZIP magic number: PK\x03\x04
  const LOCAL_FILE_HEADERSignature = 0x04034b50;
  let offset = 0;

  while (offset + 30 <= zipBuffer.length) {
    const sig = zipBuffer.readUInt32LE(offset);
    if (sig !== LOCAL_FILE_HEADERSignature) break;

    const compressionMethod = zipBuffer.readUInt16LE(offset + 8);
    const compressedSize = zipBuffer.readUInt32LE(offset + 18);
    const uncompressedSize = zipBuffer.readUInt32LE(offset + 22);
    const fileNameLength = zipBuffer.readUInt16LE(offset + 26);
    const extraFieldLength = zipBuffer.readUInt16LE(offset + 28);
    const fileName = zipBuffer.toString('utf8', offset + 30, offset + 30 + fileNameLength);
    const dataStart = offset + 30 + fileNameLength + extraFieldLength;

    if (fileName === targetFileName || fileName.endsWith('/' + targetFileName)) {
      const compressedData = zipBuffer.subarray(dataStart, dataStart + compressedSize);

      if (compressionMethod === 0) {
        // Stored (no compression)
        return compressedData.toString('utf8');
      } else if (compressionMethod === 8) {
        // Deflate
        try {
          const { inflateSync } = require('zlib');
          const decompressed = inflateSync(compressedData);
          return decompressed.toString('utf8');
        } catch {
          return null;
        }
      }
      // Unsupported compression method
      return null;
    }

    offset = dataStart + compressedSize;
  }

  return null;
}

// ---------------------------------------------------------------------------
// #321 — Address-change detection vs last successful validation
// ---------------------------------------------------------------------------

/**
 * Result of comparing the current Stellar address against the address stored
 * in the previous `validation.json` artifact.
 */
export interface AddressChangeResult {
  /** True when a previous address was found and it differs from the current. */
  changed: boolean;
  /**
   * The previous address as stored/displayed. When `privacyMode` is true this
   * will be the hashed form (`sha256:<16 hex>`) so the raw prior address is
   * never logged or commented publicly.
   */
  previousAddress: string | null;
  /**
   * The current address as stored/displayed (same masking policy as above).
   */
  currentAddress: string;
  /** True when the comparison was done against hashed values (privacy mode). */
  privacyMode: boolean;
}

/**
 * Detect whether the Stellar address has changed since the last successful
 * validation run.
 *
 * Strategy:
 * - When `privacyMode` is **off** (default), addresses are compared and
 *   stored in plain form (`G…`) in the result for display in the comment.
 * - When `privacyMode` is **on**, both the current and previous addresses are
 *   hashed with SHA-256 and only the hashes are compared/stored. This means
 *   the raw prior address is never placed into a public issue comment.
 *
 * Muxed accounts (M…): muxed addresses encode an underlying G-address and a
 * memo id. Two different muxed addresses over the *same* G-address are treated
 * as the *same* address for comparison purposes — only the base G-address
 * (`[GC][A-Z2-7]{55}`) is extracted for comparison.
 *
 * First-run handling: when `previousArtifact` is null/undefined (no previous
 * run), the function returns `changed: false` so the action never emits a
 * spurious "address changed" warning on first run.
 *
 * @param currentAddress     The Stellar address being validated this run.
 * @param previousArtifact   The loaded previous `validation.json` artifact, or null.
 * @param privacyMode        When true, hash addresses before comparing/storing.
 */
export function detectAddressChange(
  currentAddress: string,
  previousArtifact: ValidationArtifact | null | undefined,
  privacyMode = false,
): AddressChangeResult {
  // Normalise: extract base G/C address (strip muxed M-prefix memo id).
  const normalise = (addr: string): string => {
    const match = /([GC][A-Z2-7]{55})/.exec(addr);
    return match ? match[1] : addr;
  };

  const normCurrent = normalise(currentAddress);

  if (!previousArtifact || !previousArtifact.address) {
    // First run — no previous address to compare.
    return {
      changed: false,
      previousAddress: null,
      currentAddress: privacyMode ? hashAddressForPrivacy(normCurrent) : normCurrent,
      privacyMode,
    };
  }

  // The stored address in the artifact may already be hashed (if a prior run
  // used privacy mode). Detect this by checking for the sha256: prefix.
  const previousRaw = previousArtifact.address;
  const previousIsHashed = previousRaw.startsWith('sha256:');

  let addressesMatch: boolean;
  let displayPrevious: string;
  let displayCurrent: string;

  if (privacyMode) {
    // Compare hashes — always safe to log.
    const currentHash = hashAddressForPrivacy(normCurrent);
    const previousHash = previousIsHashed
      ? previousRaw
      : hashAddressForPrivacy(normalise(previousRaw));
    addressesMatch = currentHash === previousHash;
    displayPrevious = previousHash;
    displayCurrent = currentHash;
  } else {
    // Compare plain addresses (normalised). If the previous was hashed we
    // cannot reverse it — treat as different to be conservative.
    if (previousIsHashed) {
      // Previous was hashed, current is not — we can't compare directly.
      // Treat as possibly changed; surface a note in the comment.
      addressesMatch = false;
      displayPrevious = previousRaw; // keep hash for display
      displayCurrent = normCurrent;
    } else {
      const normPrevious = normalise(previousRaw);
      addressesMatch = normCurrent === normPrevious;
      displayPrevious = normPrevious;
      displayCurrent = normCurrent;
    }
  }

  return {
    changed: !addressesMatch,
    previousAddress: displayPrevious,
    currentAddress: displayCurrent,
    privacyMode,
  };
}

/**
 * Render a Markdown warning section for the issue comment when an address
 * change is detected.
 *
 * Returns an empty string when `changeResult.changed` is false so callers
 * can unconditionally append the result.
 */
export function formatAddressChangeWarning(
  changeResult: AddressChangeResult,
): string {
  if (!changeResult.changed) return '';

  const prevDisplay = changeResult.previousAddress ?? '_unknown_';
  const currDisplay = changeResult.currentAddress;
  const privacyNote = changeResult.privacyMode
    ? ' _(addresses shown as privacy hashes — raw values not stored)_'
    : '';

  return [
    '### ⚠️ Stellar address changed',
    '',
    '> **The Stellar address being validated has changed since the last run.**',
    `> Previous: \`${prevDisplay}\`${privacyNote}`,
    `> Current:  \`${currDisplay}\``,
    '>',
    '> If this change was intentional (e.g. you rotated your wallet), no action',
    '> is required — the new address will be validated normally.',
    '> If unexpected, verify that the correct address is submitted in the issue.',
  ].join('\n');
}
