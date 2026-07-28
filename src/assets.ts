import { HorizonBalanceCredit } from './horizon';

const ASSET_CODE_REGEX = /^[A-Z0-9]{1,12}$/;

export interface AssetConfigInput {
  assetCode: string;
  assetIssuer: string;
}

/** Raw shape accepted in the `assets_json` action input. */
export interface AssetJsonEntry {
  code: string;
  issuer: string;
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

/**
 * Parse and validate the `assets_json` action input.
 * Accepts a JSON array of `{code, issuer}` objects.
 * Returns normalized `AssetConfigInput[]`.
 * Throws a descriptive error on any parse or validation failure.
 */
export function parseAssetsJson(raw: string): AssetConfigInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    throw new Error(`assets_json must be a valid JSON array. Parse error: ${raw.slice(0, 80)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('assets_json must be a JSON array of {code, issuer} objects.');
  }

  return parsed.map((entry: unknown, idx: number) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`assets_json[${idx}]: each entry must be an object with "code" and "issuer" fields.`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.code !== 'string' || !e.code.trim()) {
      throw new Error(`assets_json[${idx}]: "code" must be a non-empty string.`);
    }
    if (typeof e.issuer !== 'string' || !e.issuer.trim()) {
      throw new Error(`assets_json[${idx}]: "issuer" must be a non-empty string.`);
    }
    return normalizeAssetConfig({ assetCode: e.code as string, assetIssuer: e.issuer as string });
  });
}

/**
 * Remove duplicate assets (same code + issuer after normalization).
 * Preserves first-occurrence order.
 */
export function dedupeAssets(assets: AssetConfigInput[]): AssetConfigInput[] {
  const seen = new Set<string>();
  return assets.filter((a) => {
    const key = `${a.assetCode}:${a.assetIssuer}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
