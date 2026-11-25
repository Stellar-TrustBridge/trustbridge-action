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
import type { LogContext } from './logger';
import type { MetricsCollector } from './metrics';
/**
 * Hidden marker format in comment body:
 * <!-- trustbridge-action:snooze:status={pass|fail},timestamp={unix-ms|iso-utc}(?:,timezone={tz})? -->
 */
export declare const SNOOZE_MARKER_PATTERN: RegExp;
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
export declare const MAX_SNOOZE_WINDOW_MS: number;
/** Hard ceiling even with the maintainer override: 30 days. */
export declare const MAX_SNOOZE_WINDOW_OVERRIDE_MS: number;
/** Stable reason code logged when a snooze window is clamped. */
export declare const SNOOZE_CAPPED_REASON_CODE: "snooze_window_capped";
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
export declare function capSnoozeWindow(windowMs: number, options?: {
    maintainerOverride?: boolean;
}): SnoozeCapResult;
/**
 * Stable reason_code emitted when validation is skipped because the issue is
 * within an active snooze window (Issue #754).
 */
export declare const SNOOZE_REASON_CODE: "snoozed";
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
export declare function normalizeToUtc(raw: number | string | Date | undefined | null, timezone?: string): number | undefined;
/**
 * Calculates the UTC offset in milliseconds for a given UTC timestamp and IANA timeZone.
 */
export declare function getTimezoneOffsetMs(utcTimestamp: number, timeZone: string): number;
/**
 * Alias for {@link normalizeToUtc} specific to snooze timestamps.
 */
export declare const normalizeSnoozeTimestamp: typeof normalizeToUtc;
/**
 * Validates a snooze timestamp and returns structured validation status.
 * Fails closed on empty, oversized, negative, or malformed inputs.
 */
export declare function validateSnoozeTimestamp(raw: unknown): SnoozeTimestampValidation;
/**
 * Formats a timestamp into canonical operator ISO 8601 UTC format (`YYYY-MM-DDTHH:mm:ss.sssZ`).
 */
export declare function formatSnoozeTimestampUtc(timestamp: number | string | Date): string;
/**
 * Evaluates whether a physical duration has elapsed between startTimestamp and now,
 * evaluated strictly in UTC milliseconds to ensure invariance across DST boundaries.
 */
export declare function isWithinSnoozeWindow(startTimestamp: number | string | Date, snoozeWindowMs: number, now?: number | string | Date): boolean;
/**
 * Extract snooze marker from a comment body. Returns undefined if marker
 * not found or if the timestamp is malformed/invalid (backward compatible with older comments).
 */
export declare function parseSnoozeMarker(commentBody: string | undefined): SnoozeMarker | undefined;
/**
 * Generate a snooze marker string to embed in comment body.
 */
export declare function formatSnoozeMarker(status: 'pass' | 'fail', timestamp?: number | string | Date): string;
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
export declare function evaluateSnoozeState(currentPassed: boolean, lastMarker: SnoozeMarker | undefined, snoozeWindowMs: number, now?: number | string | Date): SnoozeState;
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
 * Reaction timestamps are normalized to UTC to prevent DST early/late reopen.
 */
export declare function evaluateReactionSnooze(currentPassed: boolean, reactions: CommentReaction[] | undefined | null, snoozeWindowMs: number, now?: number | string | Date): SnoozeState;
/**
 * Evaluates snooze state combining both hidden body marker and UI reactions.
 *
 * An issue comment is snoozed if:
 * 1. Current check fails (not passed), AND
 * 2. Either an active failure marker OR a maintainer :zzz:/eyes reaction exists within the snooze window.
 *
 * Evaluated in UTC physical milliseconds to prevent DST transition discrepancies.
 */
export declare function evaluateCombinedSnoozeState(currentPassed: boolean, lastMarker: SnoozeMarker | undefined, reactions: CommentReaction[] | undefined | null, snoozeWindowMs: number, now?: number | string | Date): SnoozeState;
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
export declare const SNOOZE_AUDIT_EVENT: "snooze_skip";
/** Stable `check` label on the snooze audit log line (Issue #908). */
export declare const SNOOZE_AUDIT_CHECK: "snooze";
/** In-process counter incremented once per snooze-skipped run (Issue #908). */
export declare const SNOOZE_SKIPPED_COUNTER: "snooze_skipped";
/**
 * Format a unix-ms timestamp as an ISO-8601 string, or `'unknown'` when the
 * value is missing or not a valid date.
 */
export declare function formatSnoozeExpiry(expiresAt: number | undefined): string;
/**
 * Build the structured log context for a snooze-skip audit line (Issue #908).
 *
 * The context carries only bounded, non-sensitive fields (no addresses, no
 * reaction user logins), and always includes the stable `reason_code`
 * (`snoozed`) and `check` (`snooze`) keys so Wave operators can grep for it.
 */
export declare function buildSnoozeAuditLogContext(enforcement: SnoozeEnforcement, snoozeWindowMs: number, extra?: {
    issueNumber?: number;
}): LogContext;
/**
 * Emit the structured snooze-skip audit log line (Issue #908). No-op when
 * the enforcement did not skip validation.
 */
export declare function emitSnoozeAuditLog(enforcement: SnoozeEnforcement, snoozeWindowMs: number, extra?: {
    issueNumber?: number;
}): void;
/**
 * Format a human-readable duration for snooze notices (e.g. "2h 15m").
 */
export declare function formatSnoozeDuration(ms: number | undefined): string;
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
export declare function enforceSnoozeWindow(currentPassed: boolean, lastMarker: SnoozeMarker | undefined, reactions: CommentReaction[] | undefined | null, snoozeWindowMs: number, options?: {
    forceComment?: boolean;
    now?: number | string | Date;
    audit?: boolean;
    metrics?: MetricsCollector;
    issueNumber?: number;
    maintainerOverride?: boolean;
}): SnoozeEnforcement;
