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
 */

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
}

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
): SnoozeState {
  const now = Date.now();

  // If current check passes, always post (unsnooze).
  if (currentPassed) {
    return {
      isSnoozed: false,
      lastStatus: lastMarker?.status,
      lastTimestamp: lastMarker?.timestamp,
    };
  }

  // Current check failed.
  // If no prior marker, this is the first failure — post it.
  if (!lastMarker) {
    return {
      isSnoozed: false,
      lastStatus: undefined,
      lastTimestamp: undefined,
    };
  }

  // Current failed, prior status known.
  const elapsedMs = now - lastMarker.timestamp;

  // Status changed from pass to fail — post it.
  if (lastMarker.status === 'pass') {
    return {
      isSnoozed: false,
      lastStatus: lastMarker.status,
      lastTimestamp: lastMarker.timestamp,
      elapsedMs,
    };
  }

  // Status remains failed.
  const withinWindow = elapsedMs < snoozeWindowMs;

  return {
    isSnoozed: withinWindow,
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
    return { isSnoozed: false };
  }

  // Filter out bot reactions and non-snooze emojis
  const eligibleReactions = reactions.filter((r) => {
    const isBot =
      r.user?.type === 'Bot' ||
      (r.user?.login ? r.user.login.endsWith('[bot]') : false);
    return !isBot && isSnoozeReaction(r.content);
  });

  if (eligibleReactions.length === 0) {
    return { isSnoozed: false };
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
    return { isSnoozed: false };
  }

  const markerState = evaluateSnoozeState(currentPassed, lastMarker, snoozeWindowMs);
  const reactionState = evaluateReactionSnooze(currentPassed, reactions, snoozeWindowMs, now);

  if (reactionState.isSnoozed) {
    return reactionState;
  }
  if (markerState.isSnoozed) {
    return markerState;
  }

  return {
    isSnoozed: false,
    lastStatus: markerState.lastStatus,
    lastTimestamp: reactionState.lastTimestamp ?? markerState.lastTimestamp,
    elapsedMs: reactionState.elapsedMs ?? markerState.elapsedMs,
  };
}

