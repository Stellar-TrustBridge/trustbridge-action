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
 * <!-- trustbridge-action:snooze:status={pass|fail},timestamp={unix-ms} -->
 */
export const SNOOZE_MARKER_PATTERN =
  /<!-- trustbridge-action:snooze:status=(pass|fail),timestamp=(\d+) -->/;

export interface SnoozeMarker {
  status: 'pass' | 'fail';
  timestamp: number;
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
 * Stable reason_code emitted when validation is skipped because the issue is
 * within an active snooze window (Issue #754).
 */
export const SNOOZE_REASON_CODE = 'snoozed' as const;

/**
 * Extract snooze marker from a comment body. Returns undefined if marker
 * not found (backward compatible with older comments).
 */
export function parseSnoozeMarker(commentBody: string | undefined): SnoozeMarker | undefined {
  if (!commentBody) return undefined;
  const match = commentBody.match(SNOOZE_MARKER_PATTERN);
  if (!match) return undefined;
  return {
    status: match[1] as 'pass' | 'fail',
    timestamp: Number(match[2]),
  };
}

/**
 * Generate a snooze marker string to embed in comment body.
 */
export function formatSnoozeMarker(status: 'pass' | 'fail', timestamp: number = Date.now()): string {
  return `<!-- trustbridge-action:snooze:status=${status},timestamp=${timestamp} -->`;
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
 */
export function evaluateSnoozeState(
  currentPassed: boolean,
  lastMarker: SnoozeMarker | undefined,
  snoozeWindowMs: number,
  now: number = Date.now(),
): SnoozeState {

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
  const elapsedMs = now - lastMarker.timestamp;

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
 */
export function evaluateReactionSnooze(
  currentPassed: boolean,
  reactions: CommentReaction[] | undefined | null,
  snoozeWindowMs: number,
  now: number = Date.now(),
): SnoozeState {
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
  const timestamps = eligibleReactions
    .map((r) => {
      const raw = r.created_at || r.createdAt;
      const parsed = raw ? new Date(raw).getTime() : now;
      return isNaN(parsed) ? now : parsed;
    })
    .sort((a, b) => b - a);

  const latestTimestamp = timestamps[0];
  const elapsedMs = now - latestTimestamp;
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
 */
export function evaluateCombinedSnoozeState(
  currentPassed: boolean,
  lastMarker: SnoozeMarker | undefined,
  reactions: CommentReaction[] | undefined | null,
  snoozeWindowMs: number,
  now: number = Date.now(),
): SnoozeState {
  if (currentPassed) {
    return { isSnoozed: false, snoozeExpired: false };
  }

  const markerState = evaluateSnoozeState(currentPassed, lastMarker, snoozeWindowMs, now);
  const reactionState = evaluateReactionSnooze(currentPassed, reactions, snoozeWindowMs, now);

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
 * Enforce a snooze window at the validation call site (Issue #754).
 *
 * Wraps {@link evaluateCombinedSnoozeState} and, when the issue is within an
 * active snooze window, returns a stable `reason_code` (`snoozed`) plus a
 * user-visible comment notice. Callers should skip validation and post the
 * notice instead of failing the assignee.
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
    now?: number;
    audit?: boolean;
    metrics?: MetricsCollector;
    issueNumber?: number;
  } = {},
): SnoozeEnforcement {
  const now = options.now ?? Date.now();
  const state = evaluateCombinedSnoozeState(
    currentPassed,
    lastMarker,
    reactions,
    snoozeWindowMs,
    now,
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
        ? now + remainingMs
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
