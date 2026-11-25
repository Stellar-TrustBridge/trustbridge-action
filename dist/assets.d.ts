import { HorizonAccount, HorizonBalanceCredit } from './horizon';
export declare const MAINNET_USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
export declare const TESTNET_USDC_ISSUER = "GBBD47IF6LWK2P7MDEVSCWR7DPUWV3NY3DTQEVFL4TWVC5GIOTASHEX2";
/**
 * Stellar assets carry a 7-decimal exponent on the ledger, but the human
 * amount an operator writes (e.g. `1.5`, `10`, `0.0000001`) is a decimal
 * string. Comparisons between a trustline balance and a minimum requirement
 * must therefore be done on exact decimal values, never on floats.
 *
 * See `docs/DECIMAL_PRECISION.md` for the full rules. The helpers below are
 * the single source of truth used by `src/checks.ts`.
 */
export declare const DECIMAL_PRECISION = 7;
/** Maximum number of fractional digits a Stellar amount can represent. */
export declare const MAX_DECIMAL_PLACES = 7;
export interface CampaignPreset {
    id: string;
    network: 'public' | 'testnet';
    horizonUrl: string;
    assetCode: string;
    assetIssuer: string;
    minXlmReserve: string;
}
export declare const CAMPAIGN_PRESETS: Record<string, CampaignPreset>;
export declare function getCampaignPreset(presetOrNetworkName?: string): CampaignPreset | undefined;
export declare function validateNetworkAssetCompatibility(horizonUrl: string, assetCode: string, assetIssuer: string, presetName?: string): void;
export interface AssetConfigInput {
    assetCode: string;
    assetIssuer: string;
}
/** Raw shape accepted in the `assets_json` action input. */
export interface AssetJsonEntry {
    code: string;
    issuer: string;
}
/**
 * Canonicalize a Stellar asset code for comparison. Trims surrounding
 * whitespace and uppercases mixed-case codes; validation is handled by
 * `assertValidAssetCode()` so callers can normalize before deciding whether to
 * accept the value.
 */
export declare function normalizeAssetCode(assetCode: string): string;
/**
 * Compare two asset codes in their canonical form (Issue #968). This is the
 * single predicate callers should use when casing/whitespace may differ
 * between an action input and a Horizon balance.
 */
export declare function assetCodesEqual(a: string, b: string): boolean;
export declare function assertValidAssetCode(assetCode: string): void;
export declare function assertValidAssetIssuer(assetIssuer: string): void;
export declare function normalizeAssetConfig(input: AssetConfigInput): AssetConfigInput;
/**
 * Parse and validate the `assets_json` action input.
 * Accepts a JSON array of `{code, issuer}` objects.
 * Returns normalized `AssetConfigInput[]`.
 * Throws a descriptive error on any parse or validation failure.
 */
export declare function parseAssetsJson(raw: string): AssetConfigInput[];
/**
 * Remove duplicate assets (same code + issuer after normalization).
 * Preserves first-occurrence order.
 */
export declare function dedupeAssets(assets: AssetConfigInput[]): AssetConfigInput[];
/**
 * Issuer flavour of an asset (Issue #730).
 *
 * Classic Stellar assets are issued by a G-account; Stellar Asset Contracts
 * (SAC) are issued by a Soroban contract id (C-address). The two need
 * different validation: a Horizon account balance entry always names a
 * G-account issuer, so a C-address issuer can never be confirmed through the
 * classic trustline path and must be resolved contract-aware instead.
 */
export type AssetIssuerKind = 'classic' | 'soroban-contract';
/**
 * Classify an asset issuer as a classic G-account or a Soroban contract id.
 *
 * The value is **not** validated here — use `assertValidAssetIssuer` first.
 * Anything that is not a well-formed C-address is treated as classic so
 * existing G-address callers keep their exact behaviour.
 */
export declare function classifyAssetIssuer(assetIssuer: string): AssetIssuerKind;
/** True when `assetIssuer` is a well-formed Soroban contract id (C-address). */
export declare function isSorobanContractIssuer(assetIssuer: string): boolean;
/**
 * Validate an asset code supplied for a Soroban SAC issuer.
 *
 * SAC contracts enforce the same 1–12 uppercase alphanumeric rule as classic
 * assets, so this is `assertValidAssetCode` with a contract-specific error
 * message that tells the operator the mismatch is on the *issuer* side.
 */
export declare function assertValidSacAssetCode(assetIssuer: string, assetCode: string): void;
/**
 * Parse a decimal amount string into a scaled integer of stroops
 * (1 unit = 10^DECIMAL_PRECISION).
 *
 * Rules (see `docs/DECIMAL_PRECISION.md`):
 * - Accepts an optional leading `-`, digits, and an optional fractional part.
 * - Rejects empty/whitespace-only input, non-numeric input, and more than
 *   `MAX_DECIMAL_PLACES` fractional digits (which cannot be represented on
 *   the Stellar ledger).
 * - Never uses floating point, so `0.1 + 0.2` style drift cannot occur.
 */
export declare function parseDecimalAmount(amount: string): bigint;
/**
 * Compare two decimal amount strings exactly.
 * Returns -1 when `a < b`, 0 when equal, 1 when `a > b`.
 * Throws on malformed input via `parseDecimalAmount`.
 */
export declare function compareDecimalAmounts(a: string, b: string): -1 | 0 | 1;
/**
 * True when `balance` meets or exceeds `minimum` using exact decimal
 * comparison. Used by `src/checks.ts` for trustline balance checks so that
 * assets with different exponents (USDC, XLM, custom tokens) are compared
 * consistently.
 */
export declare function meetsMinimumBalance(balance: string, minimum: string): boolean;
/**
 * Per-asset `reason_code` values. They reuse the public catalog codes in
 * `schemas/reason-codes.json` so webhook receivers can switch on the same
 * strings as the top-level `reason_code` output.
 */
export type AssetReasonCode = 'SUCCESS' | 'TRUSTLINE_MISSING' | 'CLAWBACK_BLOCKED';
/** Evaluated trustline/clawback state for one asset (primary or `assets_json`). */
export interface AssetReasonEvaluation {
    assetCode: string;
    assetIssuer: string;
    /** True for the primary `asset_code` / `asset_issuer` pair. */
    primary: boolean;
    trustlineExists: boolean;
    clawbackEnabled: boolean;
    reasonCode: AssetReasonCode;
}
/**
 * Derive the reason code for a single asset.
 *
 * Precedence: a missing trustline outranks clawback (a clawback flag can only
 * exist on a trustline that is present). A clawback-enabled trustline only
 * yields `CLAWBACK_BLOCKED` under `clawback_strict_mode: true`; in warn mode
 * it stays `SUCCESS` and the receiver reads `clawback_enabled` instead.
 */
export declare function deriveAssetReasonCode(trustlineExists: boolean, clawbackEnabled: boolean, clawbackStrictMode: boolean): AssetReasonCode;
/**
 * Evaluate every configured asset against a Horizon account. The primary
 * asset is always first; `assets_json` entries follow in input order with
 * duplicates of the primary `code:issuer` pair skipped.
 */
export declare function evaluateAssetReasonCodes(account: HorizonAccount, primary: AssetConfigInput, extraAssets: AssetConfigInput[], clawbackStrictMode: boolean): AssetReasonEvaluation[];
/** Per-trustline clawback status read from a Horizon credit balance entry. */
export interface AssetClawbackStatus {
    clawbackEnabled: boolean;
}
/**
 * Read the per-trustline clawback flag from a Horizon credit balance entry.
 * Absent / undefined is treated as clawback disabled.
 */
export declare function getAssetClawbackStatus(balance: HorizonBalanceCredit | undefined): AssetClawbackStatus;
/**
 * Reason codes the authorization/clawback layer can produce. Every value is
 * part of the public catalog in `schemas/reason-codes.json`.
 */
export type IssuerAuthFlagReasonCode = 'SUCCESS' | 'TRUSTLINE_MISSING' | 'TRUSTLINE_UNAUTHORIZED' | 'CLAWBACK_BLOCKED';
/**
 * Non-blocking signals surfaced alongside the verdict. They never change the
 * reason code on their own; they explain why the comment carries a warning.
 */
export type IssuerAuthFlagNote = 'unauthorized_warn' | 'clawback_warn' | 'auth_required' | 'auth_revocable' | 'auth_immutable';
/** Policy for `unauthorized_trustline_policy` (mirrors `src/inputs.ts`). */
export type IssuerAuthUnauthorizedPolicy = 'fail' | 'warn' | 'ignore';
/** Flag state observed for one asset on one account. */
export interface IssuerAuthFlagState {
    /** A matching trustline is present in the account's `balances`. */
    trustlineExists: boolean;
    /**
     * Horizon `is_authorized`. `undefined` (older Horizon, or no trustline)
     * is treated as authorized, matching `isTrustlineAuthorized`.
     */
    trustlineAuthorized?: boolean;
    /** Trustline-level `is_clawback_enabled`. */
    clawbackEnabled?: boolean;
    /** Issuer `auth_required` flag (informational). */
    authRequired?: boolean;
    /** Issuer `auth_revocable` flag (informational). */
    authRevocable?: boolean;
    /** Issuer `auth_immutable` flag (informational). */
    authImmutable?: boolean;
    /** `unauthorized_trustline_policy` input. Default: `warn`. */
    unauthorizedTrustlinePolicy?: IssuerAuthUnauthorizedPolicy;
    /** `clawback_strict_mode` input. Default: `false`. */
    clawbackStrictMode?: boolean;
}
/** Result of applying the decision table to an {@link IssuerAuthFlagState}. */
export interface IssuerAuthFlagVerdict {
    reasonCode: IssuerAuthFlagReasonCode;
    /** `unauthorized_trustline_policy: fail` blocked an unauthorized trustline. */
    authorizationBlocks: boolean;
    /** `clawback_strict_mode: true` blocked a clawback-enabled trustline. */
    clawbackBlocks: boolean;
    /** Informational notes, in stable order. */
    notes: IssuerAuthFlagNote[];
}
/**
 * Ordered precedence of the blocking rules. The first rule that matches
 * decides the reason code; later rules are not consulted.
 *
 * 1. `TRUSTLINE_MISSING` — no trustline, so no trustline flag can apply.
 * 2. `TRUSTLINE_UNAUTHORIZED` — `is_authorized: false` under policy `fail`.
 *    The actionable fix is issuer approval (SetTrustLineFlags), so it
 *    outranks clawback even when both flags are set.
 * 3. `CLAWBACK_BLOCKED` — `is_clawback_enabled: true` under strict mode.
 * 4. `SUCCESS`.
 *
 * `auth_required`, `auth_revocable` and `auth_immutable` are issuer
 * capabilities. They never change the reason code; only the trustline's
 * present `is_authorized` / `is_clawback_enabled` state does.
 */
export declare const ISSUER_AUTH_FLAG_PRECEDENCE: readonly IssuerAuthFlagReasonCode[];
/**
 * Apply the issuer authorization flag decision table.
 *
 * Inputs are compared with `=== true` / `=== false`, so a malformed or
 * missing Horizon field falls back to the permissive default (authorized,
 * clawback disabled, flag unset) instead of throwing. An unknown policy
 * string is treated as the default `warn`.
 */
export declare function resolveIssuerAuthFlagVerdict(state: IssuerAuthFlagState): IssuerAuthFlagVerdict;
/** One row of the published decision table (see `docs/USAGE.md`). */
export interface IssuerAuthFlagDecisionRow {
    id: string;
    state: IssuerAuthFlagState;
    reasonCode: IssuerAuthFlagReasonCode;
}
/**
 * The published decision table. `docs/USAGE.md` renders the same rows and
 * `__tests__/issuer-auth-flag-precedence.test.ts` asserts that each row
 * matches {@link resolveIssuerAuthFlagVerdict} and the full `runAccountChecks`
 * pipeline.
 */
export declare const ISSUER_AUTH_FLAG_DECISION_TABLE: readonly IssuerAuthFlagDecisionRow[];
