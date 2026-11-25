/**
 * Failure snooze window (Issue #155).
 *
 * Prevents repeated validation failure comments from spamming an issue
 * within a configurable time window. Stores state in TrustBridge's sticky
 * comment to avoid external dependencies while maintaining per-issue snooze
 * isolation.
 *
 * ## Design
 *
 * **State Storage**: The previous check result (pass/fail) and timestamp are
 * encoded in a hidden marker in TrustBridge's sticky comment. When the action
 * runs, we parse the marker to detect snooze status.
 *
 * **Snooze Trigger**: If the current check fails AND the last check failed
 * AND we're still within the snooze window, suppress the comment update.
 * This prevents comment spam when contributors re-run workflows repeatedly
 * while fixing wallet issues.
 *
 * **Status Changes**: If the current check passes OR we're outside the
 * snooze window, post/update the comment normally. This surfaces both
 * fixes and persistent failures (user is reminded after timeout).
 *
 * **Always Update Outputs**: Even when snoozed, outputs are always set so
 * downstream workflow steps (like badge updates) reflect current state.
 *
 * **Force Post**: An optional `force_comment` input bypasses snooze logic
 * so maintainers can force an immediate comment post if needed.
 *
 * **Audit trail (Issue #908)**: Whenever a snooze skips validation, a
 * structured `snooze_skip` log line (reason_code `snoozed`) is emitted with
 * the snooze source, elapsed/remaining time, and expiry timestamp, and the
 * comment notice names the expiry — so a snooze is never silent.
 */

import { logInfo } from './logger';
import type { LogContext } from './logger';
import type { MetricsCollector } from './metrics';

/**
 * Hidden marker format in comment body:
 * <!-- trustbridge-action:snooze:status={pass|fail},timestamp={unix-ms|iso-utc}(?:,timezone={tz})? -->
 */
export const SNOOZE_MARKER_PATTERN =
  /<!-- trustbridge-action:snooze:status=(pass|fail),timestamp=([^\s,>]+)(?:,timezone=([^\s>]+))? -->/;

export interface SnoozeMarker {
  status: 'pass' | 'fail';
  timestamp: number;
  timezone?: string;
}

export interface SnoozeTimestampValidation {
  valid: boolean;
  timestamp?: number;
  utcIso?: string;
  error?: string;
}

export interface SnoozeState {
  /** Whether current run is snoozed (comment should not be posted). */
  isSnoozed: boolean;
  /** Last recorded check status from prior comment. */
  lastStatus?: 'pass' | 'fail';
  /** Timestamp of last check from prior comment (unix ms). */
  lastTimestamp?: number;
  /** Time elapsed since last check (ms). */
  elapsedMs?: number;
  /**
   * True when this run's `isSnoozed: false` is specifically because an
   * active snooze window just lapsed (Issue #799) — i.e. the prior check
   * had failed, a snooze window was in effect, and enough time has now
   * passed that the run resumes. This is distinct from "unsnoozed because
   * the check just started passing" or "unsnoozed because this is the
   * first failure" (both of those also set `isSnoozed: false` but are not
   * an *expiry*). Consumers that want to notify a dashboard only when a
   * snooze window specifically ends — rather than on every un-snoozed
   * run — should key off this flag, not `!isSnoozed`.
   */
  snoozeExpired: boolean;
}

/**
 * Maximum snooze window (Issue #962): 7 days. Unbounded snoozes would let a
 * failing Wave gate stay skipped indefinitely, so any longer configured
 * window is clamped unless a maintainer explicitly opts out.
 */
export const MAX_SNOOZE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Hard ceiling even with the maintainer override: 30 days. */
export const MAX_SNOOZE_WINDOW_OVERRIDE_MS = 30 * 24 * 60 * 60 * 1000;

/** Stable reason code logged when a snooze window is clamped. */
export const SNOOZE_CAPPED_REASON_CODE = 'snooze_window_capped' as const;

export interface SnoozeCapResult {
  windowMs: number;
  capped: boolean;
  reasonCode?: typeof SNOOZE_CAPPED_REASON_CODE;
}

/**
 * Clamp a snooze window to the configured cap (Issue #962).
 *
 * - Non-finite or negative windows become 0 (snooze disabled).
 * - Windows above {@link MAX_SNOOZE_WINDOW_MS} are clamped, unless
 *   `maintainerOverride` is set, in which case the ceiling is
 *   {@link MAX_SNOOZE_WINDOW_OVERRIDE_MS}. The override never removes the cap.
 */
export function capSnoozeWindow(
  windowMs: number,
  options: { maintainerOverride?: boolean } = {},
): SnoozeCapResult {
  if (!Number.isFinite(windowMs) || windowMs <= 0) return { windowMs: 0, capped: false };
  const cap = options.maintainerOverride ? MAX_SNOOZE_WINDOW_OVERRIDE_MS : MAX_SNOOZE_WINDOW_MS;
  if (windowMs > cap) return { windowMs: cap, capped: true, reasonCode: SNOOZE_CAPPED_REASON_CODE };
  return { windowMs: Math.floor(windowMs), capped: false };
}

/**
 * Stable reason_code emitted when validation is skipped because the issue is
 * within an active snooze window (Issue #754).
 */
export const SNOOZE_REASON_CODE = 'snoozed' as const;

/**
 * Normalizes any timestamp representation (unix-ms number, Date instance,
 * ISO 8601 UTC string with Z, ISO 8601 with explicit timezone offset, or
 * date/time string stored without timezone context) to UTC epoch milliseconds.
 *
 * ### Timezone & DST Boundary Enforcement (Issue #873)
 *
 * Snooze windows that cross DST boundaries or are stored without timezone context
 * can reopen early or late when parsed by naive local-time parsers (such as `new Date(str)`).
 * This function normalizes all inputs to UTC epoch milliseconds:
 * - If an ISO string lacks timezone context (e.g. "2026-11-01T01:30:00"), it is treated
 *   strictly as UTC rather than runner-local time.
 * - If an explicit timezone name or offset is provided, it is resolved to the exact UTC epoch instant.
 * - Negative, non-finite, oversized, or malformed inputs return undefined (fail closed).
 */
export function normalizeToUtc(
  raw: number | string | Date | undefined | null,
  timezone?: string,
): number | undefined {
  if (raw === undefined || raw === null) return undefined;

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0 || raw > 8.64e15) return undefined;
    return Math.floor(raw);
  }

  if (raw instanceof Date) {
    const time = raw.getTime();
    if (isNaN(time) || time < 0 || time > 8.64e15) return undefined;
    return time;
  }

  if (typeof raw !== 'string') return undefined;

  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // Pure digits: unix timestamp in ms
  if (/^\d+$/.test(trimmed)) {
    const num = Number(trimmed);
    if (!Number.isFinite(num) || num < 0 || num > 8.64e15) return undefined;
    return Math.floor(num);
  }

  // Explicit negative number: invalid
  if (/^-\d+$/.test(trimmed)) return undefined;

  // Explicit UTC indicator (Z or z)
  if (/[Zz]$/.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 8.64e15) return parsed;
    return undefined;
  }

  // Explicit timezone offset (+HH:MM, -HH:MM, +HHMM, -HHMM, +HH, -HH)
  if (/[+-]\d{2}(?::?\d{2})?$/.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 8.64e15) return parsed;
    return undefined;
  }

  // Naive date or date-time string without timezone context (e.g. "2026-11-01", "2026-11-01T01:30:00", "2026-11-01 01:30:00")
  if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)?$/.test(trimmed)) {
    const normalizedIso = trimmed.replace(' ', 'T');
    const withTime = normalizedIso.includes('T') ? normalizedIso : `${normalizedIso}T00:00:00.000`;

    // If an explicit timezone is given and it's not UTC/Z/GMT, resolve through IANA timezone
    if (timezone && !['UTC', 'ETC/UTC', 'Z', 'GMT'].includes(timezone.toUpperCase())) {
      try {
        const utcMs = Date.parse(`${withTime}Z`);
        if (isNaN(utcMs)) return undefined;
        const offsetMs = getTimezoneOffsetMs(utcMs, timezone);
        const resolved = utcMs - offsetMs;
        if (Number.isFinite(resolved) && resolved >= 0 && resolved <= 8.64e15) {
          return resolved;
        }
      } catch {
        // Fall back to UTC if timezone lookup fails
      }
    }

    // Default: Normalize to UTC by appending 'Z'
    const parsed = Date.parse(`${withTime}Z`);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 8.64e15) return parsed;
    return undefined;
  }

  // Generic ISO parse attempt
  const fallback = Date.parse(trimmed);
  if (!isNaN(fallback) && fallback >= 0 && fallback <= 8.64e15) {
    return fallback;
  }

  return undefined;
}

/**
 * Calculates the UTC offset in milliseconds for a given UTC timestamp and IANA timeZone.
 */
export function getTimezoneOffsetMs(utcTimestamp: number, timeZone: string): number {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    const parts = formatter.formatToParts(new Date(utcTimestamp));
    const getPart = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const asUtc = Date.UTC(
      getPart('year'),
      getPart('month') - 1,
      getPart('day'),
      getPart('hour'),
      getPart('minute'),
      getPart('second'),
    );
    return asUtc - utcTimestamp;
  } catch {
    return 0;
  }
}

/**
 * Alias for {@link normalizeToUtc} specific to snooze timestamps.
 */
export const normalizeSnoozeTimestamp = normalizeToUtc;

/**
 * Validates a snooze timestamp and returns structured validation status.
 * Fails closed on empty, oversized, negative, or malformed inputs.
 */
export function validateSnoozeTimestamp(raw: unknown): SnoozeTimestampValidation {
  if (raw === undefined || raw === null || raw === '') {
    return { valid: false, error: 'Snooze timestamp cannot be empty' };
  }
  if (typeof raw !== 'string' && typeof raw !== 'number' && !(raw instanceof Date)) {
    return { valid: false, error: 'Snooze timestamp must be a number, string, or Date' };
  }
  const ms = normalizeToUtc(raw as number | string | Date);
  if (ms === undefined) {
    return {
      valid: false,
      error: `Malformed snooze timestamp: "${String(raw)}" is not a valid unix ms or ISO 8601 UTC date`,
    };
  }
  return {
    valid: true,
    timestamp: ms,
    utcIso: new Date(ms).toISOString(),
  };
}

/**
 * Formats a timestamp into canonical operator ISO 8601 UTC format (`YYYY-MM-DDTHH:mm:ss.sssZ`).
 */
export function formatSnoozeTimestampUtc(timestamp: number | string | Date): string {
  const ms = normalizeToUtc(timestamp);
  if (ms === undefined) {
    throw new Error(`Cannot format invalid snooze timestamp: "${String(timestamp)}"`);
  }
  return new Date(ms).toISOString();
}

/**
 * Evaluates whether a physical duration has elapsed between startTimestamp and now,
 * evaluated strictly in UTC milliseconds to ensure invariance across DST boundaries.
 */
export function isWithinSnoozeWindow(
  startTimestamp: number | string | Date,
  snoozeWindowMs: number,
  now: number | string | Date = Date.now(),
): boolean {
  const startMs = normalizeToUtc(startTimestamp);
  const nowMs = normalizeToUtc(now) ?? Date.now();
  if (startMs === undefined || snoozeWindowMs <= 0) return false;
  const elapsed = nowMs - startMs;
  return elapsed >= 0 && elapsed < snoozeWindowMs;
}

/**
 * Extract snooze marker from a comment body. Returns undefined if marker
 * not found or if the timestamp is malformed/invalid (backward compatible with older comments).
 */
export function parseSnoozeMarker(commentBody: string | undefined): SnoozeMarker | undefined {
  if (!commentBody) return undefined;
  const match = commentBody.match(SNOOZE_MARKER_PATTERN);
  if (!match) return undefined;
  const rawTimestamp = match[2];
  const timezone = match[3];
  const timestamp = normalizeToUtc(rawTimestamp, timezone);
  if (timestamp === undefined) return undefined;
  const marker: SnoozeMarker = {
    status: match[1] as 'pass' | 'fail',
    timestamp,
  };
  if (timezone) {
    marker.timezone = timezone;
  }
  return marker;
}

/**
 * Generate a snooze marker string to embed in comment body.
 */
export function formatSnoozeMarker(
  status: 'pass' | 'fail',
  timestamp: number | string | Date = Date.now(),
): string {
  const normalized = typeof timestamp === 'number'
    ? timestamp
    : (normalizeToUtc(timestamp) ?? Date.now());
  return `<!-- trustbridge-action:snooze:status=${status},timestamp=${normalized} -->`;
}

/**
 * Determine snooze state based on current result, last marker, and snooze duration.
 *
 * ### Decision Logic
 *
 * - If current result **passes**: always post (unsnooze on success).
 * - If current result **fails** AND no prior marker: always post (first failure).
 * - If current result **fails** AND prior status **passed**: always post (status changed).
 * - If current result **fails** AND prior status **failed** AND elapsed < snoozeMs:
 *   - **Snoozed** (suppress comment, but still update outputs).
 * - If current result **fails** AND prior status **failed** AND elapsed >= snoozeMs:
 *   - **Post** (reminder after timeout; reset timer).
 *
 * Both `now` and `lastMarker.timestamp` are evaluated in normalized UTC epoch milliseconds,
 * guaranteeing physical duration invariance across DST boundaries.
 */
export function evaluateSnoozeState(
  currentPassed: boolean,
  lastMarker: SnoozeMarker | undefined,
  snoozeWindowMs: number,
  now: number | string | Date = Date.now(),
): SnoozeState {
  const nowMs = normalizeToUtc(now) ?? Date.now();

  // If current check passes, always post (unsnooze) — not an expiry, the
  // check itself changed outcome.
  if (currentPassed) {
    return {
      isSnoozed: false,
      snoozeExpired: false,
      lastStatus: lastMarker?.status,
      lastTimestamp: lastMarker?.timestamp,
    };
  }

  // Current check failed.
  // If no prior marker, this is the first failure — post it. Not an
  // expiry: there was never an active snooze window to expire.
  if (!lastMarker) {
    return {
      isSnoozed: false,
      snoozeExpired: false,
      lastStatus: undefined,
      lastTimestamp: undefined,
    };
  }

  // Current failed, prior status known.
  // Both nowMs and lastMarker.timestamp are normalized to UTC epoch milliseconds,
  // ensuring physical elapsed time is invariant across daylight saving time (DST)
  // boundaries and host timezones.
  const elapsedMs = nowMs - lastMarker.timestamp;

  // Status changed from pass to fail — post it. Not an expiry: this is a
  // fresh failure, not a resumed one.
  if (lastMarker.status === 'pass') {
    return {
      isSnoozed: false,
      snoozeExpired: false,
      lastStatus: lastMarker.status,
      lastTimestamp: lastMarker.timestamp,
      elapsedMs,
    };
  }

  // Status remains failed. `withinWindow === false` is the expiry case:
  // the prior run was (or would have been) snoozed and the window has now
  // lapsed, so this run resumes normal posting.
  const withinWindow = elapsedMs < snoozeWindowMs;

  return {
    isSnoozed: withinWindow,
    snoozeExpired: !withinWindow,
    lastStatus: lastMarker.status,
    lastTimestamp: lastMarker.timestamp,
    elapsedMs,
  };
}

/**
 * Supported reaction emojis/identifiers that trigger a snooze:
 * - 'zzz' / ':zzz:' / '💤' — maintainer sleep/snooze reaction
 * - 'eyes' / ':eyes:' — maintainer reviewing/monitoring reaction
 *
 * Random reactions (such as '+1', '👍', 'heart', 'rocket', 'laugh') do NOT snooze.
 */
export const SNOOZE_REACTIONS = ['zzz', ':zzz:', 'eyes', ':eyes:', '💤'] as const;

export interface CommentReaction {
  content: string;
  created_at?: string;
  createdAt?: string;
  user?: {
    login?: string;
    type?: string;
  } | null;
}

/**
 * Checks whether a reaction content string corresponds to a valid snooze trigger emoji.
 */
export function isSnoozeReaction(content: string | undefined | null): boolean {
  if (!content) return false;
  const normalized = content.trim().toLowerCase();
  return (
    normalized === 'zzz' ||
    normalized === ':zzz:' ||
    normalized === 'eyes' ||
    normalized === ':eyes:' ||
    normalized === '💤' ||
    normalized === ':zzz' ||
    normalized.startsWith('zzz')
  );
}

/**
 * Evaluates whether any user (non-bot) reactions on the comment trigger an active snooze.
 * Reaction timestamps are normalized to UTC to prevent DST early/late reopen.
 */
export function evaluateReactionSnooze(
  currentPassed: boolean,
  reactions: CommentReaction[] | undefined | null,
  snoozeWindowMs: number,
  now: number | string | Date = Date.now(),
): SnoozeState {
  const nowMs = normalizeToUtc(now) ?? Date.now();

  if (currentPassed || !reactions || reactions.length === 0) {
    return { isSnoozed: false, snoozeExpired: false };
  }

  // Filter out bot reactions and non-snooze emojis
  const eligibleReactions = reactions.filter((r) => {
    const isBot =
      r.user?.type === 'Bot' ||
      (r.user?.login ? r.user.login.endsWith('[bot]') : false);
    return !isBot && isSnoozeReaction(r.content);
  });

  if (eligibleReactions.length === 0) {
    return { isSnoozed: false, snoozeExpired: false };
  }

  // Extract timestamps (supporting both REST created_at and GraphQL createdAt)
  // Normalized to UTC to ensure invariance across DST boundaries.
  const timestamps = eligibleReactions
    .map((r) => {
      const raw = r.created_at || r.createdAt;
      const parsed = raw ? normalizeToUtc(raw) : nowMs;
      return parsed !== undefined ? parsed : nowMs;
    })
    .sort((a, b) => b - a);

  const latestTimestamp = timestamps[0];
  const elapsedMs = nowMs - latestTimestamp;
  const withinWindow = elapsedMs >= 0 && elapsedMs < snoozeWindowMs;

  return {
    isSnoozed: withinWindow,
    // A reaction-based snooze that has lapsed (the reaction is older than
    // the window) is an expiry in the same sense as the marker-based path.
    snoozeExpired: !withinWindow,
    lastTimestamp: latestTimestamp,
    elapsedMs,
  };
}

/**
 * Evaluates snooze state combining both hidden body marker and UI reactions.
 *
 * An issue comment is snoozed if:
 * 1. Current check fails (not passed), AND
 * 2. Either an active failure marker OR a maintainer :zzz:/eyes reaction exists within the snooze window.
 *
 * Evaluated in UTC physical milliseconds to prevent DST transition discrepancies.
 */
export function evaluateCombinedSnoozeState(
  currentPassed: boolean,
  lastMarker: SnoozeMarker | undefined,
  reactions: CommentReaction[] | undefined | null,
  snoozeWindowMs: number,
  now: number | string | Date = Date.now(),
): SnoozeState {
  const nowMs = normalizeToUtc(now) ?? Date.now();

  if (currentPassed) {
    return { isSnoozed: false, snoozeExpired: false };
  }

  const markerState = evaluateSnoozeState(currentPassed, lastMarker, snoozeWindowMs, nowMs);
  const reactionState = evaluateReactionSnooze(currentPassed, reactions, snoozeWindowMs, nowMs);

  if (reactionState.isSnoozed) {
    return reactionState;
  }
  if (markerState.isSnoozed) {
    return markerState;
  }

  // Neither mechanism is currently snoozing. It's an expiry if either one
  // specifically just lapsed (rather than never having been active).
  return {
    isSnoozed: false,
    snoozeExpired: reactionState.snoozeExpired || markerState.snoozeExpired,
    lastStatus: markerState.lastStatus,
    lastTimestamp: reactionState.lastTimestamp ?? markerState.lastTimestamp,
    elapsedMs: reactionState.elapsedMs ?? markerState.elapsedMs,
  };
}

/**
 * Result of enforcing a snooze window at the validation call site (Issue #754).
 *
 * When `skipValidation` is true, the caller must NOT run validation and must
 * NOT fail the assignee; instead it should surface `reasonCode` in outputs and
 * post the `commentNotice` so the user understands why nothing happened.
 */
export interface SnoozeEnforcement {
  /** Whether validation should be skipped for this run. */
  skipValidation: boolean;
  /** Stable reason_code to emit in outputs when validation is skipped. */
  reasonCode?: typeof SNOOZE_REASON_CODE;
  /** User-visible comment notice to post when validation is skipped. */
  commentNotice?: string;
  /** Underlying snooze state that produced this decision. */
  state: SnoozeState;
  /** Which mechanism is holding the snooze (set when `skipValidation`). */
  source?: SnoozeSource;
  /** Remaining snooze time in ms (set when `skipValidation`). */
  remainingMs?: number;
  /** Unix-ms timestamp at which the snooze window expires (set when `skipValidation`). */
  expiresAt?: number;
}

/** Mechanism that put an issue into snooze (Issue #908). */
export type SnoozeSource = 'marker' | 'reaction';

/** Stable `event` field on the snooze audit log line (Issue #908). */
export const SNOOZE_AUDIT_EVENT = 'snooze_skip' as const;

/** Stable `check` label on the snooze audit log line (Issue #908). */
export const SNOOZE_AUDIT_CHECK = 'snooze' as const;

/** In-process counter incremented once per snooze-skipped run (Issue #908). */
export const SNOOZE_SKIPPED_COUNTER = 'snooze_skipped' as const;

/**
 * Format a unix-ms timestamp as an ISO-8601 string, or `'unknown'` when the
 * value is missing or not a valid date.
 */
export function formatSnoozeExpiry(expiresAt: number | undefined): string {
  if (expiresAt === undefined || !Number.isFinite(expiresAt)) return 'unknown';
  const date = new Date(expiresAt);
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toISOString();
}

/**
 * Build the structured log context for a snooze-skip audit line (Issue #908).
 *
 * The context carries only bounded, non-sensitive fields (no addresses, no
 * reaction user logins), and always includes the stable `reason_code`
 * (`snoozed`) and `check` (`snooze`) keys so Wave operators can grep for it.
 */
export function buildSnoozeAuditLogContext(
  enforcement: SnoozeEnforcement,
  snoozeWindowMs: number,
  extra: { issueNumber?: number } = {},
): LogContext {
  const context: LogContext = {
    component: 'snooze',
    event: SNOOZE_AUDIT_EVENT,
    reason_code: SNOOZE_REASON_CODE,
    check: SNOOZE_AUDIT_CHECK,
    source: enforcement.source ?? 'unknown',
    snoozeWindowMs,
    elapsedMs: enforcement.state.elapsedMs ?? null,
    remainingMs: enforcement.remainingMs ?? null,
    expiresAt: formatSnoozeExpiry(enforcement.expiresAt),
  };
  if (extra.issueNumber !== undefined) {
    context['issueNumber'] = extra.issueNumber;
  }
  return context;
}

/**
 * Emit the structured snooze-skip audit log line (Issue #908). No-op when
 * the enforcement did not skip validation.
 */
export function emitSnoozeAuditLog(
  enforcement: SnoozeEnforcement,
  snoozeWindowMs: number,
  extra: { issueNumber?: number } = {},
): void {
  if (!enforcement.skipValidation) return;
  const expiry = formatSnoozeExpiry(enforcement.expiresAt);
  logInfo(
    `Validation skipped: issue is within an active snooze window (source=${enforcement.source ?? 'unknown'}, expires ${expiry}).`,
    buildSnoozeAuditLogContext(enforcement, snoozeWindowMs, extra),
  );
}

/**
 * Format a human-readable duration for snooze notices (e.g. "2h 15m").
 */
export function formatSnoozeDuration(ms: number | undefined): string {
  if (ms === undefined || !isFinite(ms) || ms <= 0) return '0m';
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Enforce a snooze window at the validation call site (Issue #754, Issue #873).
 *
 * Wraps {@link evaluateCombinedSnoozeState} and, when the issue is within an
 * active snooze window, returns a stable `reason_code` (`snoozed`) plus a
 * user-visible comment notice. Callers should skip validation and post the
 * notice instead of failing the assignee.
 *
 * Normalizes all timestamps and `options.now` to UTC physical milliseconds,
 * guaranteeing snooze duration integrity across DST boundaries.
 *
 * `forceComment` bypasses enforcement so maintainers can force a run.
 *
 * When validation is skipped (Issue #908):
 * - a structured `snooze_skip` audit log line is emitted (disable with
 *   `audit: false` when the caller emits it itself);
 * - the comment notice states the expiry time (ISO-8601, UTC);
 * - when `metrics` is passed, the `snooze_skipped` counter is incremented, a
 *   `snooze_skipped` metric tagged with the source is recorded, and the job
 *   outcome is recorded as `skipped`.
 */
export function enforceSnoozeWindow(
  currentPassed: boolean,
  lastMarker: SnoozeMarker | undefined,
  reactions: CommentReaction[] | undefined | null,
  snoozeWindowMs: number,
  options: {
    forceComment?: boolean;
    now?: number | string | Date;
    audit?: boolean;
    metrics?: MetricsCollector;
    issueNumber?: number;
    maintainerOverride?: boolean;
  } = {},
): SnoozeEnforcement {
  snoozeWindowMs = capSnoozeWindow(snoozeWindowMs, { maintainerOverride: options.maintainerOverride }).windowMs;
  const nowMs =
    options.now !== undefined ? (normalizeToUtc(options.now) ?? Date.now()) : Date.now();
  const state = evaluateCombinedSnoozeState(
    currentPassed,
    lastMarker,
    reactions,
    snoozeWindowMs,
    nowMs,
  );

  if (options.forceComment || !state.isSnoozed) {
    return { skipValidation: false, state };
  }

  const remainingMs =
    state.elapsedMs !== undefined ? Math.max(0, snoozeWindowMs - state.elapsedMs) : undefined;
  const remaining = formatSnoozeDuration(remainingMs);
  const expiresAt =
    state.lastTimestamp !== undefined
      ? state.lastTimestamp + snoozeWindowMs
      : remainingMs !== undefined
        ? nowMs + remainingMs
        : undefined;
  // The marker path records the prior check status; the reaction path does not.
  const source: SnoozeSource = state.lastStatus !== undefined ? 'marker' : 'reaction';
  const expiry = formatSnoozeExpiry(expiresAt);

  const commentNotice =
    `⏸️ **Validation snoozed** — this issue is within an active snooze window ` +
    `(reason_code: \`${SNOOZE_REASON_CODE}\`). Validation will resume automatically ` +
    `in ~${remaining}` +
    (expiry !== 'unknown' ? ` (snooze expires \`${expiry}\`)` : '') +
    `. Remove the :zzz:/:eyes: reaction or wait for the window to ` +
    `expire to re-run validation.`;

  const enforcement: SnoozeEnforcement = {
    skipValidation: true,
    reasonCode: SNOOZE_REASON_CODE,
    commentNotice,
    state,
    source,
    remainingMs,
    expiresAt,
  };

  if (options.audit !== false) {
    emitSnoozeAuditLog(enforcement, snoozeWindowMs, { issueNumber: options.issueNumber });
  }

  if (options.metrics) {
    options.metrics.incrementCounter(SNOOZE_SKIPPED_COUNTER);
    options.metrics.recordMetric(SNOOZE_SKIPPED_COUNTER, 1, 'count', { source });
    options.metrics.recordJobOutcome('skipped');
  }

  return enforcement;
}
