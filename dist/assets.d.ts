export interface AssetConfigInput {
    assetCode: string;
    assetIssuer: string;
}
export declare function normalizeAssetCode(assetCode: string): string;
export declare function assertValidAssetCode(assetCode: string): void;
export declare function normalizeAssetConfig(input: AssetConfigInput): AssetConfigInput;
