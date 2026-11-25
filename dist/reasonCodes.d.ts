/**
 * Frozen catalog of every `reason_code` the Action's per-account validation
 * path (src/checks.ts) can emit on `ValidationResult.reasonCode`.
 *
 * This is the TypeScript mirror of the public API surface documented at
 * schemas/reason-codes.json (the JSON catalog consumed by dashboards and
 * CI drift checks — see docs/USAGE.md#reason-code-reference). Keeping a
 * compile-time union here means a new check branch that returns a string
 * not in this list fails `tsc` immediately, instead of silently reaching
 * downstream consumers as an undocumented code.
 *
 * `__tests__/reason-codes.test.ts` asserts `REASON_CODES` and the JSON
 * catalog list the exact same codes, so the two sources of truth cannot
 * drift apart.
 */
export declare const REASON_CODES: readonly ["SUCCESS", "TRUSTLINE_MISSING", "RESERVE_TOO_LOW", "TRUSTLINE_LIMIT_TOO_LOW", "ACCOUNT_NOT_FUNDED", "HORIZON_TIMEOUT", "HORIZON_ERROR", "TLS_ERROR", "FAILED", "TRUSTLINE_UNAUTHORIZED", "CLAWBACK_BLOCKED", "CIRCUIT_OPEN", "RATE_BUDGET_EXHAUSTED", "HOME_DOMAIN_MISMATCH", "HOME_DOMAIN_MISSING", "MILESTONE_GATE_SKIPPED", "REQUIRED_LABELS_MISSING", "MAINTAINER_SKIPPED", "SAC_ISSUER_NOT_VERIFIABLE", "HORIZON_WAIT_BUDGET_EXHAUSTED", "EXTRA_TRUSTLINE_MISSING"];
/** Every value `ValidationResult.reasonCode` (src/checks.ts) may hold. */
export type ReasonCode = (typeof REASON_CODES)[number];
/** Codes that only appear on batch rows (`batch_summary_json`), never on the run-level `reason_code`. */
export declare const BATCH_ONLY_REASON_CODES: readonly ["INVALID_ADDRESS", "FATAL_AUTH", "FATAL_CONFIG", "FATAL_CANCELLED", "CLAWBACK_STRICT_MODE", "CANCELLED", "ADDRESS_TIMEOUT"];
export type BatchReasonCode = ReasonCode | (typeof BATCH_ONLY_REASON_CODES)[number];
/** Subset of the catalog emitted per asset in webhook payloads. */
export declare const ASSET_REASON_CODES: readonly ["SUCCESS", "TRUSTLINE_MISSING", "CLAWBACK_BLOCKED"];
export type AssetReasonCode = (typeof ASSET_REASON_CODES)[number];
/** Codes reported on `WebhookDeliveryResult.reason`. */
export declare const WEBHOOK_DELIVERY_REASON_CODES: readonly ["WEBHOOK_PAYLOAD_TRUNCATED", "WEBHOOK_SIZE_LIMIT_EXCEEDED"];
/** Run-level code when a check did not set one explicitly. */
export declare function effectiveReasonCode(result: {
    reasonCode?: ReasonCode;
    valid: boolean;
}): ReasonCode;
/** A renamed code and the window during which the old name is still emitted. */
export interface ReasonCodeAlias {
    deprecated: string;
    canonical: ReasonCode;
    /** First day (UTC, YYYY-MM-DD) both names are emitted. */
    deprecatedOn: string;
    /** Last day (UTC, inclusive) both names are emitted; CI fails afterwards. */
    removeAfter: string;
}
/** Active renames. Keep in sync with the calendar in docs/BREAKING_CHANGES.md. */
export declare const REASON_CODE_ALIASES: readonly ReasonCodeAlias[];
/** Deprecated names to emit next to `code` today. Empty outside the window. */
export declare function deprecatedReasonCodesFor(code: ReasonCode, now?: Date, aliases?: readonly ReasonCodeAlias[]): string[];
/** Problems with the alias registry, including expired windows. CI requires none. */
export declare function validateReasonCodeAliases(aliases?: readonly ReasonCodeAlias[], now?: Date): string[];
/** Type guard: narrows an arbitrary string to `ReasonCode` when it is cataloged. */
export declare function isReasonCode(value: string): value is ReasonCode;
/**
 * Exhaustiveness guard for `switch`/`if`-chains over `ReasonCode`.
 *
 * Call this in the `default`/final branch of a chain that is meant to
 * handle every cataloged code. If `REASON_CODES` gains a new entry and the
 * chain is not updated, the argument type at that call site stops being
 * `never` and `tsc` fails the build — see
 * `__tests__/reason-codes.test.ts` for the compiled proof.
 */
export declare function assertExhaustiveReasonCode(code: never): never;
