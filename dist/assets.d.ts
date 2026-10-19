import { HorizonBalanceCredit } from './horizon';
export declare const MAINNET_USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
export declare const TESTNET_USDC_ISSUER = "GBBD47IF6LWK2P7MDEVSCWR7DPUWV3NY3DTQEVFL4TWVC5GIOTASHEX2";
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
export declare function normalizeAssetCode(assetCode: string): string;
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
export interface AssetClawbackStatus {
    clawbackEnabled: boolean;
}
/**
 * Read the per-trustline clawback flag from a Horizon credit balance entry.
 * Absent / undefined is treated as clawback disabled.
 */
export declare function getAssetClawbackStatus(balance: HorizonBalanceCredit | undefined): AssetClawbackStatus;
