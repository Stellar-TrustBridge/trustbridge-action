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
