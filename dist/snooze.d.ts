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
export declare const SNOOZE_MARKER_PATTERN: RegExp;
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
 * Stable reason_code emitted when validation is skipped because the issue is
 * within an active snooze window (Issue #754).
 */
export declare const SNOOZE_REASON_CODE: "snoozed";
/**
 * Extract snooze marker from a comment body. Returns undefined if marker
 * not found (backward compatible with older comments).
 */
export declare function parseSnoozeMarker(commentBody: string | undefined): SnoozeMarker | undefined;
/**
 * Generate a snooze marker string to embed in comment body.
 */
export declare function formatSnoozeMarker(status: 'pass' | 'fail', timestamp?: number): string;
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
export declare function evaluateSnoozeState(currentPassed: boolean, lastMarker: SnoozeMarker | undefined, snoozeWindowMs: number): SnoozeState;
/**
 * Supported reaction emojis/identifiers that trigger a snooze:
 * - 'zzz' / ':zzz:' / '💤' — maintainer sleep/snooze reaction
 * - 'eyes' / ':eyes:' — maintainer reviewing/monitoring reaction
 *
 * Random reactions (such as '+1', '👍', 'heart', 'rocket', 'laugh') do NOT snooze.
 */
export declare const SNOOZE_REACTIONS: readonly ["zzz", ":zzz:", "eyes", ":eyes:", "💤"];
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
export declare function isSnoozeReaction(content: string | undefined | null): boolean;
/**
 * Evaluates whether any user (non-bot) reactions on the comment trigger an active snooze.
 */
export declare function evaluateReactionSnooze(currentPassed: boolean, reactions: CommentReaction[] | undefined | null, snoozeWindowMs: number, now?: number): SnoozeState;
/**
 * Evaluates snooze state combining both hidden body marker and UI reactions.
 *
 * An issue comment is snoozed if:
 * 1. Current check fails (not passed), AND
 * 2. Either an active failure marker OR a maintainer :zzz:/eyes reaction exists within the snooze window.
 */
export declare function evaluateCombinedSnoozeState(currentPassed: boolean, lastMarker: SnoozeMarker | undefined, reactions: CommentReaction[] | undefined | null, snoozeWindowMs: number, now?: number): SnoozeState;
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
}
/**
 * Format a human-readable duration for snooze notices (e.g. "2h 15m").
 */
export declare function formatSnoozeDuration(ms: number | undefined): string;
/**
 * Enforce a snooze window at the validation call site (Issue #754).
 *
 * Wraps {@link evaluateCombinedSnoozeState} and, when the issue is within an
 * active snooze window, returns a stable `reason_code` (`snoozed`) plus a
 * user-visible comment notice. Callers should skip validation and post the
 * notice instead of failing the assignee.
 *
 * `forceComment` bypasses enforcement so maintainers can force a run.
 */
export declare function enforceSnoozeWindow(currentPassed: boolean, lastMarker: SnoozeMarker | undefined, reactions: CommentReaction[] | undefined | null, snoozeWindowMs: number, options?: {
    forceComment?: boolean;
    now?: number;
}): SnoozeEnforcement;
