import { HorizonAccount, HorizonBalanceCredit, findTrustlineBalance } from './horizon';

const ASSET_CODE_REGEX = /^[A-Z0-9]{1,12}$/;
const STELLAR_ISSUER_G_REGEX = /^G[A-Z2-7]{55}$/;
const STELLAR_ISSUER_C_REGEX = /^C[A-Z2-7]{55}$/;

export const MAINNET_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
export const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK2P7MDEVSCWR7DPUWV3NY3DTQEVFL4TWVC5GIOTASHEX2';

/**
 * Stellar assets carry a 7-decimal exponent on the ledger, but the human
 * amount an operator writes (e.g. `1.5`, `10`, `0.0000001`) is a decimal
 * string. Comparisons between a trustline balance and a minimum requirement
 * must therefore be done on exact decimal values, never on floats.
 *
 * See `docs/DECIMAL_PRECISION.md` for the full rules. The helpers below are
 * the single source of truth used by `src/checks.ts`.
 */
export const DECIMAL_PRECISION = 7;

/** Maximum number of fractional digits a Stellar amount can represent. */
export const MAX_DECIMAL_PLACES = DECIMAL_PRECISION;

const DECIMAL_AMOUNT_REGEX = /^-?\d+(\.\d+)?$/;

export interface CampaignPreset {
  id: string;
  network: 'public' | 'testnet';
  horizonUrl: string;
  assetCode: string;
  assetIssuer: string;
  minXlmReserve: string;
}

export const CAMPAIGN_PRESETS: Record<string, CampaignPreset> = {
  testnet: {
    id: 'testnet',
    network: 'testnet',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    assetCode: 'USDC',
    assetIssuer: TESTNET_USDC_ISSUER,
    minXlmReserve: '1.5',
  },
  'testnet-usdc': {
    id: 'testnet-usdc',
    network: 'testnet',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    assetCode: 'USDC',
    assetIssuer: TESTNET_USDC_ISSUER,
    minXlmReserve: '1.5',
  },
  public: {
    id: 'public',
    network: 'public',
    horizonUrl: 'https://horizon.stellar.org',
    assetCode: 'USDC',
    assetIssuer: MAINNET_USDC_ISSUER,
    minXlmReserve: '1.5',
  },
  mainnet: {
    id: 'mainnet',
    network: 'public',
    horizonUrl: 'https://horizon.stellar.org',
    assetCode: 'USDC',
    assetIssuer: MAINNET_USDC_ISSUER,
    minXlmReserve: '1.5',
  },
};

export function getCampaignPreset(presetOrNetworkName?: string): CampaignPreset | undefined {
  if (!presetOrNetworkName) return undefined;
  const key = presetOrNetworkName.trim().toLowerCase();
  return CAMPAIGN_PRESETS[key];
}

export function validateNetworkAssetCompatibility(
  horizonUrl: string,
  assetCode: string,
  assetIssuer: string,
  presetName?: string,
): void {
  const isTestnetHorizon = horizonUrl.toLowerCase().includes('testnet');
  const normalizedIssuer = assetIssuer.trim();
  const normalizedCode = assetCode.trim().toUpperCase();

  if (isTestnetHorizon && normalizedIssuer === MAINNET_USDC_ISSUER) {
    throw new Error(
      `Incompatible network configuration: Mainnet ${normalizedCode} issuer (${MAINNET_USDC_ISSUER}) cannot be used on Stellar Testnet (${horizonUrl}). Use testnet issuer ${TESTNET_USDC_ISSUER} or switch to public Horizon.`,
    );
  }

  if (!isTestnetHorizon && normalizedIssuer === TESTNET_USDC_ISSUER) {
    throw new Error(
      `Incompatible network configuration: Testnet ${normalizedCode} issuer (${TESTNET_USDC_ISSUER}) cannot be used on Stellar Mainnet (${horizonUrl}). Use mainnet issuer ${MAINNET_USDC_ISSUER} or switch to testnet Horizon.`,
    );
  }

  if (presetName) {
    const preset = getCampaignPreset(presetName);
    if (preset) {
      if (preset.network === 'testnet' && !isTestnetHorizon) {
        throw new Error(
          `Preset conflict: Preset "${presetName}" specifies testnet, but horizon_url is set to non-testnet URL "${horizonUrl}".`,
        );
      }
      if (preset.network === 'public' && isTestnetHorizon) {
        throw new Error(
          `Preset conflict: Preset "${presetName}" specifies public mainnet, but horizon_url is set to testnet URL "${horizonUrl}".`,
        );
      }
    }
  }
}

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

export function assertValidAssetIssuer(assetIssuer: string): void {
  const trimmed = assetIssuer.trim();
  if (trimmed.startsWith('G') && STELLAR_ISSUER_G_REGEX.test(trimmed)) {
    return;
  }
  if (trimmed.startsWith('C') && STELLAR_ISSUER_C_REGEX.test(trimmed)) {
    return;
  }
  throw new Error(
    `asset_issuer must be a valid 56-character Stellar public key starting with "G" or a contract ID starting with "C". Received: "${assetIssuer}"`
  );
}

export function normalizeAssetConfig(input: AssetConfigInput): AssetConfigInput {
  const assetCode = normalizeAssetCode(input.assetCode);
  assertValidAssetCode(assetCode);
  const assetIssuer = input.assetIssuer.trim();
  assertValidAssetIssuer(assetIssuer);
  return {
    assetCode,
    assetIssuer,
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

/** StrKey format of a Soroban contract id (C-address): C + 55 base32 chars. */
const SOROBAN_CONTRACT_ID_REGEX = /^C[A-Z2-7]{55}$/;

/**
 * Classify an asset issuer as a classic G-account or a Soroban contract id.
 *
 * The value is **not** validated here — use `assertValidAssetIssuer` first.
 * Anything that is not a well-formed C-address is treated as classic so
 * existing G-address callers keep their exact behaviour.
 */
export function classifyAssetIssuer(assetIssuer: string): AssetIssuerKind {
  return isSorobanContractIssuer(assetIssuer) ? 'soroban-contract' : 'classic';
}

/** True when `assetIssuer` is a well-formed Soroban contract id (C-address). */
export function isSorobanContractIssuer(assetIssuer: string): boolean {
  return SOROBAN_CONTRACT_ID_REGEX.test((assetIssuer ?? '').trim());
}

/**
 * Validate an asset code supplied for a Soroban SAC issuer.
 *
 * SAC contracts enforce the same 1–12 uppercase alphanumeric rule as classic
 * assets, so this is `assertValidAssetCode` with a contract-specific error
 * message that tells the operator the mismatch is on the *issuer* side.
 */
export function assertValidSacAssetCode(assetIssuer: string, assetCode: string): void {
  try {
    assertValidAssetCode(assetCode);
  } catch {
    throw new Error(
      `asset_code "${assetCode}" is invalid for Soroban SAC contract issuer ${assetIssuer}: asset codes must be 1-12 uppercase alphanumeric characters.`,
    );
  }
}

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
export function parseDecimalAmount(amount: string): bigint {
  const trimmed = (amount ?? '').trim();
  if (!trimmed) {
    throw new Error('amount must be a non-empty decimal string.');
  }
  if (!DECIMAL_AMOUNT_REGEX.test(trimmed)) {
    throw new Error(`amount must be a decimal number. Received: "${amount}"`);
  }

  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholePart, fracPart = ''] = unsigned.split('.');

  if (fracPart.length > MAX_DECIMAL_PLACES) {
    throw new Error(
      `amount "${amount}" has ${fracPart.length} fractional digits; Stellar assets support at most ${MAX_DECIMAL_PLACES}.`,
    );
  }

  const paddedFrac = fracPart.padEnd(MAX_DECIMAL_PLACES, '0');
  const scaled = BigInt(wholePart) * 10n ** BigInt(MAX_DECIMAL_PLACES) + BigInt(paddedFrac || '0');
  return negative ? -scaled : scaled;
}

/**
 * Compare two decimal amount strings exactly.
 * Returns -1 when `a < b`, 0 when equal, 1 when `a > b`.
 * Throws on malformed input via `parseDecimalAmount`.
 */
export function compareDecimalAmounts(a: string, b: string): -1 | 0 | 1 {
  const left = parseDecimalAmount(a);
  const right = parseDecimalAmount(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * True when `balance` meets or exceeds `minimum` using exact decimal
 * comparison. Used by `src/checks.ts` for trustline balance checks so that
 * assets with different exponents (USDC, XLM, custom tokens) are compared
 * consistently.
 */
export function meetsMinimumBalance(balance: string, minimum: string): boolean {
  return compareDecimalAmounts(balance, minimum) >= 0;
}

// ---------------------------------------------------------------------------
// Issue #676 — per-asset clawback reason codes for webhook consumers.
// ---------------------------------------------------------------------------

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
export function deriveAssetReasonCode(
  trustlineExists: boolean,
  clawbackEnabled: boolean,
  clawbackStrictMode: boolean,
): AssetReasonCode {
  if (!trustlineExists) return 'TRUSTLINE_MISSING';
  if (clawbackEnabled && clawbackStrictMode) return 'CLAWBACK_BLOCKED';
  return 'SUCCESS';
}

/**
 * Evaluate every configured asset against a Horizon account. The primary
 * asset is always first; `assets_json` entries follow in input order with
 * duplicates of the primary `code:issuer` pair skipped.
 */
export function evaluateAssetReasonCodes(
  account: HorizonAccount,
  primary: AssetConfigInput,
  extraAssets: AssetConfigInput[],
  clawbackStrictMode: boolean,
): AssetReasonEvaluation[] {
  const evaluate = (asset: AssetConfigInput, isPrimary: boolean): AssetReasonEvaluation => {
    const balance = findTrustlineBalance(account, asset.assetCode, asset.assetIssuer);
    const trustlineExists = balance !== undefined;
    const clawbackEnabled = trustlineExists && getAssetClawbackStatus(balance).clawbackEnabled;
    return {
      assetCode: asset.assetCode,
      assetIssuer: asset.assetIssuer,
      primary: isPrimary,
      trustlineExists,
      clawbackEnabled,
      reasonCode: deriveAssetReasonCode(trustlineExists, clawbackEnabled, clawbackStrictMode),
    };
  };

  const primaryKey = `${primary.assetCode}:${primary.assetIssuer}`;
  return [
    evaluate(primary, true),
    ...extraAssets
      .filter((asset) => `${asset.assetCode}:${asset.assetIssuer}` !== primaryKey)
      .map((asset) => evaluate(asset, false)),
  ];
}

/** Per-trustline clawback status read from a Horizon credit balance entry. */
export interface AssetClawbackStatus {
  clawbackEnabled: boolean;
}

/**
 * Read the per-trustline clawback flag from a Horizon credit balance entry.
 * Absent / undefined is treated as clawback disabled.
 */
export function getAssetClawbackStatus(
  balance: HorizonBalanceCredit | undefined,
): AssetClawbackStatus {
  return { clawbackEnabled: balance?.is_clawback_enabled === true };
}
