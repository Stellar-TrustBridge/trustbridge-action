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
export const REASON_CODES = [
  'SUCCESS',
  'TRUSTLINE_MISSING',
  'RESERVE_TOO_LOW',
  'TRUSTLINE_LIMIT_TOO_LOW',
  'ACCOUNT_NOT_FUNDED',
  'HORIZON_TIMEOUT',
  'HORIZON_ERROR',
  'TLS_ERROR',
  'FAILED',
  'TRUSTLINE_UNAUTHORIZED',
  'CLAWBACK_BLOCKED',
  'CIRCUIT_OPEN',
  'RATE_BUDGET_EXHAUSTED',
  'HOME_DOMAIN_MISMATCH',
  'HOME_DOMAIN_MISSING',
  'MILESTONE_GATE_SKIPPED',
  'MAINTAINER_SKIPPED',
  'SAC_ISSUER_NOT_VERIFIABLE',
  'HORIZON_WAIT_BUDGET_EXHAUSTED',
  'EXTRA_TRUSTLINE_MISSING',
] as const;

/** Every value `ValidationResult.reasonCode` (src/checks.ts) may hold. */
export type ReasonCode = (typeof REASON_CODES)[number];

const REASON_CODE_SET: ReadonlySet<string> = new Set(REASON_CODES);

/** Codes that only appear on batch rows (`batch_summary_json`), never on the run-level `reason_code`. */
export const BATCH_ONLY_REASON_CODES = [
  'INVALID_ADDRESS',
  'FATAL_AUTH',
  'FATAL_CONFIG',
  'FATAL_CANCELLED',
  'CLAWBACK_STRICT_MODE',
  'CANCELLED',
] as const;
export type BatchReasonCode = ReasonCode | (typeof BATCH_ONLY_REASON_CODES)[number];

/** Subset of the catalog emitted per asset in webhook payloads. */
export const ASSET_REASON_CODES = ['SUCCESS', 'TRUSTLINE_MISSING', 'CLAWBACK_BLOCKED'] as const satisfies readonly ReasonCode[];
export type AssetReasonCode = (typeof ASSET_REASON_CODES)[number];

/** Codes reported on `WebhookDeliveryResult.reason`. */
export const WEBHOOK_DELIVERY_REASON_CODES = [
  'WEBHOOK_PAYLOAD_TRUNCATED',
  'WEBHOOK_SIZE_LIMIT_EXCEEDED',
] as const;

/** Run-level code when a check did not set one explicitly. */
export function effectiveReasonCode(result: { reasonCode?: ReasonCode; valid: boolean }): ReasonCode {
  return result.reasonCode ?? (result.valid ? 'SUCCESS' : 'FAILED');
}

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
export const REASON_CODE_ALIASES: readonly ReasonCodeAlias[] = [];

const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

/** Deprecated names to emit next to `code` today. Empty outside the window. */
export function deprecatedReasonCodesFor(
  code: ReasonCode,
  now: Date = new Date(),
  aliases: readonly ReasonCodeAlias[] = REASON_CODE_ALIASES,
): string[] {
  const day = utcDay(now);
  return aliases
    .filter((a) => a.canonical === code && a.deprecatedOn <= day && day <= a.removeAfter)
    .map((a) => a.deprecated);
}

function isCalendarDay(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(date.getTime()) && utcDay(date) === value;
}

/** Problems with the alias registry, including expired windows. CI requires none. */
export function validateReasonCodeAliases(
  aliases: readonly ReasonCodeAlias[] = REASON_CODE_ALIASES,
  now: Date = new Date(),
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const a of aliases) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(a.deprecated)) errors.push(`${a.deprecated}: malformed deprecated code`);
    if (seen.has(a.deprecated)) errors.push(`${a.deprecated}: duplicate alias`);
    seen.add(a.deprecated);
    if (isReasonCode(a.deprecated)) errors.push(`${a.deprecated}: still in REASON_CODES`);
    if (!isReasonCode(a.canonical)) errors.push(`${a.deprecated}: unknown canonical code ${String(a.canonical)}`);
    if (!isCalendarDay(a.deprecatedOn) || !isCalendarDay(a.removeAfter) || a.removeAfter < a.deprecatedOn) {
      errors.push(`${a.deprecated}: invalid window ${a.deprecatedOn}..${a.removeAfter}`);
    } else if (utcDay(now) > a.removeAfter) {
      errors.push(`${a.deprecated}: window expired on ${a.removeAfter}; remove the alias`);
    }
  }
  return errors;
}

/** Type guard: narrows an arbitrary string to `ReasonCode` when it is cataloged. */
export function isReasonCode(value: string): value is ReasonCode {
  return REASON_CODE_SET.has(value);
}

/**
 * Exhaustiveness guard for `switch`/`if`-chains over `ReasonCode`.
 *
 * Call this in the `default`/final branch of a chain that is meant to
 * handle every cataloged code. If `REASON_CODES` gains a new entry and the
 * chain is not updated, the argument type at that call site stops being
 * `never` and `tsc` fails the build — see
 * `__tests__/reason-codes.test.ts` for the compiled proof.
 */
export function assertExhaustiveReasonCode(code: never): never {
  throw new Error(`Unhandled reason_code: ${String(code)}`);
}
