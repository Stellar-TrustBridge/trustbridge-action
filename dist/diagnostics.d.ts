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
    sponsorshipInfo?: {
        numSponsoring: number;
        numSponsored: number;
    };
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
/**
 * Environment variable a caller can set to propagate an existing correlation
 * id into this run (e.g. a reusable workflow fanning out to several jobs).
 */
export declare const CORRELATION_ID_ENV = "TRUSTBRIDGE_CORRELATION_ID";
/** Prefix of every generated correlation id. */
export declare const CORRELATION_ID_PREFIX = "tb-";
/** Minimum / maximum accepted correlation id length. */
export declare const CORRELATION_ID_MIN_LENGTH = 8;
export declare const CORRELATION_ID_MAX_LENGTH = 64;
/** Stable reason code logged when a propagated correlation id is rejected. */
export declare const CORRELATION_ID_INVALID_REASON_CODE = "CORRELATION_ID_INVALID";
/** Hidden comment marker prefix carrying the correlation id. */
export declare const CORRELATION_ID_MARKER_PREFIX = "<!-- trustbridge-action:correlation-id:";
/**
 * Generate a fresh correlation id: `tb-` followed by 16 random hex chars.
 * Random (not derived from tokens, addresses or run metadata) so it can be
 * quoted publicly without leaking anything.
 */
export declare function generateCorrelationId(): string;
/**
 * Validate a correlation id. Returns `undefined` when valid, otherwise a
 * stable human-readable reason. A value is rejected when it is empty,
 * shorter than {@link CORRELATION_ID_MIN_LENGTH} or longer than
 * {@link CORRELATION_ID_MAX_LENGTH}, uses characters outside
 * `[A-Za-z0-9._-]`, or would be altered by the log redaction policy
 * (i.e. it looks like a token, secret, or Stellar address).
 */
export declare function validateCorrelationId(value: unknown): string | undefined;
/** True when `value` is an acceptable correlation id. */
export declare function isValidCorrelationId(value: unknown): value is string;
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
export declare function initCorrelationId(env?: Record<string, string | undefined>): CorrelationIdInit;
/** The current run's correlation id, or `undefined` before {@link initCorrelationId}. */
export declare function getCorrelationId(): string | undefined;
/** Forget the current correlation id (tests / a new run in the same process). */
export declare function resetCorrelationId(): void;
/**
 * Hidden marker embedding the correlation id in a comment body, so support
 * tooling can grep it even when the visible footer is not rendered.
 * Returns an empty string for an invalid id.
 */
export declare function formatCorrelationMarker(correlationId: string | undefined): string;
/** Extract a correlation id from a comment body's hidden marker, if present. */
export declare function parseCorrelationMarker(body: string | undefined): string | undefined;
/**
 * Visible comment footer line quoting the correlation id. Returns an empty
 * string for an invalid id so callers can append unconditionally.
 */
export declare function formatCorrelationFooter(correlationId: string | undefined): string;
/**
 * Build a redacted, safe-to-log copy of the inputs snapshot.
 * Secret-classified fields are replaced with `***`.
 * Address and URL fields are redacted using the standard policy.
 */
export declare function buildSafeInputsSnapshot(inputs: DiagnosticsInputSnapshot): Record<string, unknown>;
declare const DIAGNOSTICS_OPEN_MARKER = "<!-- trustbridge-action:diagnostics-start -->";
declare const DIAGNOSTICS_CLOSE_MARKER = "<!-- trustbridge-action:diagnostics-end -->";
export { DIAGNOSTICS_OPEN_MARKER, DIAGNOSTICS_CLOSE_MARKER };
/**
 * Build the expert diagnostics collapsible Markdown block.
 *
 * Returns an empty string when neither `inputs` nor `runInfo` has meaningful
 * content, so callers can append unconditionally.
 */
export declare function buildDiagnosticsBlock(config: DiagnosticsConfig): string;
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
export declare function buildSponsorshipDiagnostics(sponsorshipInfo?: {
    numSponsoring: number;
    numSponsored: number;
}, reserveRequirement?: {
    protocolMinimum: number;
    configuredFloor: number;
    required: number;
    actual: number;
    met: boolean;
    subentryCount: number;
}): string;
