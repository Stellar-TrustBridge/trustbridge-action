import { HorizonBalanceCredit } from './horizon';

const ASSET_CODE_REGEX = /^[A-Z0-9]{1,12}$/;

export interface AssetConfigInput {
  assetCode: string;
  assetIssuer: string;
}

export function normalizeAssetCode(assetCode: string): string {
  return assetCode.trim().toUpperCase();
}

export function assertValidAssetCode(assetCode: string): void {
  const normalized = normalizeAssetCode(assetCode);
  if (!ASSET_CODE_REGEX.test(normalized)) {
    throw new Error(
      `asset_code must be 1-12 uppercase alphanumeric characters. Received: "${assetCode}"`,
    );
  }
}

export function normalizeAssetConfig(input: AssetConfigInput): AssetConfigInput {
  const assetCode = normalizeAssetCode(input.assetCode);
  assertValidAssetCode(assetCode);
  return {
    assetCode,
    assetIssuer: input.assetIssuer.trim(),
  };
}

export interface AssetClawbackStatus {
  clawbackEnabled: boolean;
}

/**
 * Determine whether a credit trustline balance has clawback enabled.
 * Horizon exposes `is_clawback_enabled` per-trustline (protocol 17+),
 * reflecting the issuer's AUTH_CLAWBACK_ENABLED setting unless overridden
 * on that specific trustline. Absent/undefined — including when no
 * trustline balance was found at all — is treated as not clawback-enabled
 * so vanilla assets (e.g. mainnet USDC, which does not enable clawback)
 * never trigger a false warning.
 */
export function getAssetClawbackStatus(
  balance: HorizonBalanceCredit | undefined,
): AssetClawbackStatus {
  return { clawbackEnabled: balance?.is_clawback_enabled === true };
}
