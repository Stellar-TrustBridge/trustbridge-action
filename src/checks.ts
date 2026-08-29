import {
  HorizonAccount,
  findTrustlineBalance,
  getAssetBalance,
  getNativeBalance,
  hasTrustline,
  getTrustlineLimit,
  isCreditBalance,
  isTrustlineAuthorized,
  parseHorizonBalance,
} from './horizon';
import { getAssetClawbackStatus } from './assets';
import { escapeMarkdownInline, inlineCode } from './markdown';
import {
  buildChangeTrustLink,
  buildLobstrLink,
  canonicalHorizonUrl,
  inferStellarNetwork,
  oppositeNetwork,
  StellarNetwork,
} from './links';
import { globalMetrics } from './metrics';
import { getStrings } from './i18n';
import { UnauthorizedTrustlinePolicy } from './inputs';
import { fetchTomlWithCache } from './toml';

/** Stellar public network base reserve per ledger entry (XLM). */
export const STELLAR_BASE_RESERVE_XLM = 0.5;

/** Minimum balance required to activate a new account (XLM). */
export const STELLAR_MIN_ACCOUNT_BALANCE_XLM = 1;

/**
 * SEP-0001 home domain check mode.
 *
 * - `"warn"`  (default) â€” a missing or mismatched home domain records a metrics tag and
 *   adds an informational check row but does NOT set `valid = false`.
 * - `"strict"` â€” a missing or mismatched home domain sets `valid = false` and blocks
 *   payout automation, matching the behaviour of other hard checks.
 */
export type HomeDomainCheckMode = 'warn' | 'strict';

/**
 * Claimable-balance policy (Issue #260).
 *
 * - `"ignore"` â€” funded means Horizon account exists; claimable balances do not affect funded.
 * - `"count"` â€” unfunded accounts with claimable balances surface an informational hint.
 */
export type ClaimableBalancePolicy = 'ignore' | 'count';

/**
 * Whether an account snapshot contains any `claimable_balance_id` entries.
 * Note: funded accounts rarely embed claimables in `balances`; this helper
 * is for completeness and for the optional `count` policy which may also
 * inspect a separate claimable_balances Horizon response.
 */
export function hasClaimableBalances(account: HorizonAccount): boolean {
  return account.balances.some((b) => b.asset_type === 'claimable_balance_id');
}

export function countClaimableBalances(account: HorizonAccount): number {
  return account.balances.filter((b) => b.asset_type === 'claimable_balance_id').length;
}

export interface CheckConfig {
  assetCode: string;
  assetIssuer: string;
  minXlmReserve: number;
  minTrustlineLimit?: number; // Optional minimum trustline limit (Issue #140)
  /** Optional minimum balance for the configured asset (Issue #112). */
  minAssetBalance?: string | number;
  horizonUrl?: string;
  /** How to treat a trustline that exists but is not yet authorized by the issuer. Default: "warn". */
  unauthorizedTrustlinePolicy?: UnauthorizedTrustlinePolicy;
  /** When true, a clawback-enabled trustline fails the check instead of only warning. Default: false. */
  clawbackStrictMode?: boolean;

  // ---------------------------------------------------------------------------
  // SEP-0001 home domain check (optional, off by default)
  // ---------------------------------------------------------------------------

  /**
   * When true, TrustBridge fetches the issuer account from Horizon and
   * inspects the `home_domain` field.  Off by default so existing USDC
   * workflows are unaffected.
   */
  homeDomainCheckEnabled?: boolean;

  /**
   * The domain string that the issuer's on-chain `home_domain` must match
   * exactly (case-insensitive).  When omitted the check only verifies that
   * *some* home domain is set (non-empty).
   *
   * Example: `"centre.io"` for mainnet USDC.
   */
  expectedHomeDomain?: string;

  /**
   * Controls whether a home-domain failure blocks the overall `valid` flag.
   * Defaults to `"warn"` so the check is informational unless explicitly
   * tightened.
   */
  homeDomainCheckMode?: HomeDomainCheckMode;

  /**
   * When true, TrustBridge fetches stellar.toml from the issuer's home_domain
   * (https://{home_domain}/.well-known/stellar.toml) with SSRF protection and
   * TTL caching. Only used when homeDomainCheckEnabled is true. Default: false.
   */
  stellarTomlFetchEnabled?: boolean;

  /**
   * Time-to-live for stellar.toml fetch cache in milliseconds.
   * Default: 3600000 (1 hour). Only used when stellarTomlFetchEnabled is true.
   */
  stellarTomlCacheTtlMs?: number;

  /**
   * Optional integrity hash for stellar.toml content validation.
   * Format: "algorithm:hexvalue" (e.g. "sha256:abc123...").
   * When set, the fetched TOML content is hashed and compared; a mismatch fails
   * the check and blocks valid. Only used when stellarTomlFetchEnabled is true.
   */
  stellarTomlHashPin?: string;

  // ---------------------------------------------------------------------------
  // Ledger lag / freshness guard (Issue #107 â€” optional, off by default)
  // ---------------------------------------------------------------------------

  /**
   * When true, TrustBridge fetches the Horizon root endpoint before the
   * account check and compares `history_latest_ledger_closed_at` against
   * the current wall-clock time.  Off by default so existing workflows are
   * unaffected.
   */
  checkLedgerFreshness?: boolean;

  /**
   * Maximum allowed lag in seconds between the latest ledger close time and
   * the current wall clock before the freshness guard fires.
   * Defaults to 60 s (â‰ˆ 5â€“6 Stellar ledger close cycles).
   */
  maxLedgerLagSeconds?: number;

  /**
   * When `true` a stale ledger response sets `valid = false` and (when
   * `fail_on_missing` is also true) fails the workflow step.
   * When `false` (default / "warn") the result is informational only â€”
   * a warning row is added to the checks table and metrics are emitted but
   * the overall `valid` flag is unaffected.
   */
  ledgerFreshnessFailOnStale?: boolean;

  // ---------------------------------------------------------------------------
  // Claimable-balance-aware funded definition (Issue #260)
  // ---------------------------------------------------------------------------
  /**
   * How to treat claimable balances when determining `funded` status.
   *
   * - `"ignore"` (default) â€” funded = Horizon account exists (200). Claimable
   *   balances are ignored; an address with only claimable balances still shows
   *   â€œnot found / unfundedâ€. No extra Horizon request is made.
   * - `"count"` â€” when the account is 404, TrustBridge also checks
   *   `GET /claimable_balances?claimant=address` (1 extra request, capped at
   *   5s). If claimable balances exist, the comment notes them but `accountFunded`
   *   remains false and `valid` is not set true unless documented. This is
   *   informational only and never auto-claims.
   *
   * Default `"ignore"` matches todayâ€™s behavior and avoids extra request budget.
   * Empty claimables (0) are treated as no hint in either mode.
   */
  claimableBalancePolicy?: ClaimableBalancePolicy;
}

// ---------------------------------------------------------------------------
// #144 â€” Cross-network detection
// ---------------------------------------------------------------------------

/**
 * Hint passed in from the caller when a 404 is received to indicate that the
 * same address was found active on a **different** network (e.g. the address
 * exists on testnet but the workflow is pointed at mainnet Horizon, or vice
 * versa).
 *
 * When present, unfunded/not-found error messages are augmented with a clear
 * cross-network remediation so contributors understand they need to either
 * fund on the correct network or switch `horizon_url`.
 */
export interface NetworkMismatchHint {
  /** Network the configured Horizon URL resolves to. */
  configuredNetwork: StellarNetwork;
  /** Network on which the address *was* found active. */
  activeOnNetwork: StellarNetwork;
}

/**
 * Detect whether a Stellar address that returned 404 on the primary Horizon
 * URL is actually active on the opposite network.
 *
 * Returns a `NetworkMismatchHint` when a mismatch is confirmed, or
 * `undefined` when there is no evidence of a mismatch (either no cross-check
 * was performed or the address is genuinely unfunded everywhere).
 *
 * Deterministic heuristics (Issue #266):
 * - 404 primary + 200 alt (publicâ†’testnet OR testnetâ†’public) => hint, clear
 *   comment with both canonical URLs and horizon_url guidance.
 * - 404 primary + 404 alt => no hint (genuinely unfunded everywhere).
 * - alt returns non-200/404 (503, 429, etc.) or network error/timeout => no hint.
 * - Alt URL is SSRF-validated via `validateHorizonUrl`; blocked URLs => no hint.
 * - Canonical opposite URLs (https://horizon.stellar.org â†” https://horizon-testnet.stellar.org)
 *   are allowlisted and safe to probe even when `allow_cross_network_fallback` is false.
 *   Arbitrary fallback URLs are NEVER probed here â€” that is gated in `horizon.ts` via
 *   `allowCrossNetworkFallback`. This keeps probing deterministic and bounded.
 *
 * @param configuredHorizonUrl  The `horizon_url` input value.
 * @param stellarAddress        The 56-char G-address that returned 404.
 * @param fetchFn               Optional injected fetch (for testing).
 */
export async function detectNetworkMismatch(
  configuredHorizonUrl: string,
  stellarAddress: string,
  fetchFn?: (url: string, init?: RequestInit) => Promise<{ status: number }>,
): Promise<NetworkMismatchHint | undefined> {
  const configuredNetwork = inferStellarNetwork(configuredHorizonUrl);
  const altNetwork = oppositeNetwork(configuredNetwork);
  const altHorizonUrl = canonicalHorizonUrl(altNetwork);
  // SSRF guard: canonical URLs are known-good, but validate anyway so a
  // future change that returns a private/loopback URL cannot be probed.
  const ssrfCheck = validateHorizonUrl(altHorizonUrl, 'alt_horizon_url', { allowHttp: true });
  if (!ssrfCheck.valid) {
    return undefined;
  }
  const checkUrl = `${altHorizonUrl}/accounts/${stellarAddress}`;

  try {
    const fetcher = fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    const response = await fetcher(checkUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });

    // Deterministic: only 200 is a positive mismatch signal. 404 => genuinely unfunded.
    // Any other status (503, 429, 500, etc.) is treated as "no evidence" to avoid
    // false positives when the opposite Horizon is temporarily unavailable.
    if (response.status === 200) {
      return { configuredNetwork, activeOnNetwork: altNetwork };
    }
    return undefined;
  } catch {
    // Network error or timeout â€” can't determine, so no hint
    return undefined;
  }
}

/**
 * Build the deterministic cross-network mismatch detail string used in the
 * `Account funded` check. Centralized so both directions (publicâ†”testnet) use
 * the identical format and are tested deterministically.
 */
export function buildNetworkMismatchDetail(
  stellarAddress: string,
  hint: NetworkMismatchHint,
): string {
  const safeAddress = inlineCode(stellarAddress);
  const configuredUrl = canonicalHorizonUrl(hint.configuredNetwork);
  const altUrl = canonicalHorizonUrl(hint.activeOnNetwork);
  const strings = getStrings('en');
  return (
    `Account ${safeAddress} was **not found** on the **${hint.configuredNetwork}** network` +
    ` (${configuredUrl}) but **is active on ${hint.activeOnNetwork}** (${altUrl}).` +
    ` ${strings.networkMismatchDetected} ${strings.networkMismatchConfiguredNetwork}` +
    ` **${hint.configuredNetwork}** (${configuredUrl}). ${strings.networkMismatchActiveNetwork}` +
    ` **${hint.activeOnNetwork}** (${altUrl}). ${strings.networkMismatchFix}` +
    ` ${strings.networkMismatchUpdateUrl}`
  );
}

export interface CheckResultItem {
  passed: boolean;
  label: string;
  detail: string;
}

export interface SponsorshipInfo {
  /** Number of accounts this account is sponsoring (num_sponsoring from Horizon). */
  numSponsoring: number;
  /** Number of accounts sponsoring this account (num_sponsored from Horizon). */
  numSponsored: number;
}

export interface ValidationResult {
  valid: boolean;
  accountFunded: boolean;
  trustlineExists: boolean;
  /** Authorization state of the matched trustline, or undefined if not applicable (no trustline, or issuer field absent). */
  trustlineAuthorized?: boolean;
  /** Whether the matched trustline has clawback enabled, or undefined if not applicable. */
  clawbackEnabled?: boolean;
  xlmBalance: string;
  xlmReserveMet: boolean;
  /** Current balance of the configured asset (or `'0'` / `'unknown'` on error paths). */
  assetBalance?: string;
  /** True when `minAssetBalance` is unset/zero, or the asset balance meets the floor. */
  assetBalanceMet?: boolean;
  trustlineLimit?: string; // Actual trustline limit for the asset (Issue #140)
  checks: CheckResultItem[];
  remediation?: string;
  /** Machine-readable failure reason for gating / metrics. */
  reasonCode?: string;
  /** Precomputed failed check labels (stable snake_case codes). */
  failedCheckLabels?: string[];
  /** CAP-0033 sponsorship counts from the Horizon account snapshot. */
  sponsorshipInfo?: SponsorshipInfo;
  /** Populated when the reserve was computed from a real account (not the unfunded/error paths). */
  reserveRequirement?: ReserveRequirement;
  /**
   * SEP-0001 home domain check result. Only populated when
   * `config.homeDomainCheckEnabled` is true.
   */
  homeDomainCheck?: HomeDomainCheckResult;
  /**
   * Ledger freshness / lag check result. Only populated when
   * `config.checkLedgerFreshness` is true.
   */
  ledgerFreshnessResult?: LedgerFreshnessCheckResult;
  /**
   * Claimable balance info (Issue #260). Only populated when the account was
   * fetched and the policy is observed. Informational only â€” does not affect
   * `accountFunded` when policy is `ignore` (default).
   */
  claimableBalanceCount?: number;
  hasClaimableBalances?: boolean;
}

// ---------------------------------------------------------------------------
// SEP-0001 home domain check types and helper
// ---------------------------------------------------------------------------

/**
 * Outcome of a single SEP-0001 home domain alignment check against an
 * issuer account returned by Horizon.
 *
 * Metric tags emitted:
 *  - `home_domain_valid`   when `outcome === "valid"`
 *  - `home_domain_missing` when `outcome === "missing"`
 *  - `home_domain_mismatch` when `outcome === "mismatch"`
 *  - `home_domain_skipped` when the check is disabled
 */
export type HomeDomainOutcome = 'valid' | 'missing' | 'mismatch' | 'skipped';

export interface HomeDomainCheckResult {
  /** Classified outcome. */
  outcome: HomeDomainOutcome;
  /**
   * The actual `home_domain` value on the issuer account, or `undefined`
   * when Horizon did not expose it.
   */
  actualHomeDomain?: string;
  /**
   * The domain that was required (from `config.expectedHomeDomain`).
   * Undefined means "any non-empty value is acceptable".
   */
  expectedHomeDomain?: string;
  /**
   * Human-readable summary safe to embed in a Markdown comment.
   * All dynamic values are escaped before being set here.
   */
  detail: string;
  /**
   * When the check mode is `"strict"` and the outcome is not `"valid"`,
   * this flag is true to indicate the failure should block `valid`.
   */
  blocksValid: boolean;

  /**
   * Optional SEP-0001 stellar.toml fetch result. Only populated when
   * stellarTomlFetchEnabled is true and a fetch was attempted.
   */
  tomlFetch?: {
    ok: boolean;
    error?: string;
    hash?: string;
    cached: boolean; // true if served from cache
  };
}

/**
 * Evaluate the issuer's SEP-0001 home domain alignment against the
 * fetched Horizon account data.
 *
 * This is a **pure, synchronous** function â€” it only inspects the
 * `home_domain` field already present on the `HorizonAccount` object.
 * Full SEP-0001 HTTP stellar.toml fetching and signature verification
 * are explicitly out of scope (see docs/SEP0001_HOME_DOMAIN.md). If that
 * fetch is added later, it must use a redirect-limited, HTTPS-only, SSRF-safe
 * wrapper that re-validates every redirect hop before following it.
 *
 * @param issuerAccount  The Horizon account for the asset issuer (not the
 *                       recipient wallet). May be `null` when Horizon did
 *                       not return the issuer account.
 * @param config         The current `CheckConfig` (reads
 *                       `expectedHomeDomain` and `homeDomainCheckMode`).
 * @returns              A `HomeDomainCheckResult` describing the outcome.
 */
export function evaluateHomeDomain(
  issuerAccount: HorizonAccount | null,
  config: CheckConfig,
): HomeDomainCheckResult {
  const mode: HomeDomainCheckMode = config.homeDomainCheckMode ?? 'warn';
  const expected = config.expectedHomeDomain?.trim().toLowerCase();

  // No issuer account available â€” treat the same as missing.
  if (!issuerAccount) {
    return {
      outcome: 'missing',
      expectedHomeDomain: config.expectedHomeDomain,
      detail: 'Issuer account data was not available from Horizon â€” home domain could not be verified.',
      blocksValid: mode === 'strict',
    };
  }

  const rawDomain = issuerAccount.home_domain?.trim() ?? '';

  if (!rawDomain) {
    const detail = expected
      ? `Issuer account has no \`home_domain\` set on-chain (expected \`${escapeMarkdownInline(config.expectedHomeDomain!)}\`).`
      : 'Issuer account has no `home_domain` set on-chain.';
    return {
      outcome: 'missing',
      actualHomeDomain: undefined,
      expectedHomeDomain: config.expectedHomeDomain,
      detail,
      blocksValid: mode === 'strict',
    };
  }

  if (expected && rawDomain.toLowerCase() !== expected) {
    return {
      outcome: 'mismatch',
      actualHomeDomain: rawDomain,
      expectedHomeDomain: config.expectedHomeDomain,
      detail: `Issuer \`home_domain\` is \`${escapeMarkdownInline(rawDomain)}\` but \`${escapeMarkdownInline(config.expectedHomeDomain!)}\` was expected.`,
      blocksValid: mode === 'strict',
    };
  }

  return {
    outcome: 'valid',
    actualHomeDomain: rawDomain,
    expectedHomeDomain: config.expectedHomeDomain,
    detail: `Issuer \`home_domain\` is \`${escapeMarkdownInline(rawDomain)}\` âœ“`,
    blocksValid: false,
  };
}

/**
 * Asynchronously fetch and validate stellar.toml for a home_domain.
 *
 * This function:
 *  - Only runs if stellarTomlFetchEnabled is true in config
 *  - Skips fetch if on-chain home domain check failed
 *  - Fetches with SSRF protection and TTL caching
 *  - Validates hash (if pin provided)
 *  - Appends tomlFetch result to the existing HomeDomainCheckResult
 *  - Fails the check if fetch/hash validation fails in strict mode
 *
 * @param result The existing HomeDomainCheckResult from evaluateHomeDomain
 * @param config The CheckConfig with TOML options
 * @returns Potentially updated result with tomlFetch populated
 */
export async function enrichHomeDomainCheckWithToml(
  result: HomeDomainCheckResult,
  config: CheckConfig,
): Promise<HomeDomainCheckResult> {
  // Only fetch TOML if enabled
  if (!config.stellarTomlFetchEnabled) {
    return result;
  }

  // Only fetch if we have a valid on-chain domain
  if (result.outcome !== 'valid' || !result.actualHomeDomain) {
    return result;
  }

  const domain = result.actualHomeDomain;
  const cacheTtlMs = config.stellarTomlCacheTtlMs ?? 3600000;
  const hashPin = config.stellarTomlHashPin ?? '';

  try {
    const fetchResult = await fetchTomlWithCache(domain, {
      cacheTtlMs,
      hashPin: hashPin || undefined,
    });

    if (!fetchResult.ok) {
      const detail = `Stellar.toml fetch failed: ${fetchResult.error}`;

      // In strict mode, TOML fetch failure blocks valid
      const shouldBlock = config.homeDomainCheckMode === 'strict';

      return {
        ...result,
        tomlFetch: {
          ok: false,
          error: fetchResult.error,
          cached: false,
        },
        // Only block if in strict mode
        blocksValid: result.blocksValid || shouldBlock,
        detail: `${result.detail}\n${detail}`,
      };
    }

    // TOML fetch succeeded
    globalMetrics.incrementCounter('home_domain_toml_success');

    return {
      ...result,
      tomlFetch: {
        ok: true,
        hash: fetchResult.hash,
        cached: !fetchResult.fetched,
      },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const detail = `Stellar.toml fetch error: ${msg}`;

    // In strict mode, unexpected errors block valid
    const shouldBlock = config.homeDomainCheckMode === 'strict';

    globalMetrics.incrementCounter('home_domain_toml_error');

    return {
      ...result,
      tomlFetch: {
        ok: false,
        error: detail,
        cached: false,
      },
      blocksValid: result.blocksValid || shouldBlock,
      detail: `${result.detail}\n${detail}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Ledger freshness check result type (Issue #107)
// ---------------------------------------------------------------------------

/**
 * Thin wrapper around `FreshnessCheckResult` from `freshness.ts` that adds
 * the information needed by comment rendering and the checks table.
 *
 * - `status`          â€” 'ok' | 'stale' | 'unknown'
 * - `lagSeconds`      â€” measured lag, or null when unavailable
 * - `latestLedger`    â€” latest ledger sequence, or null
 * - `message`         â€” human-readable detail line (safe for Markdown comment)
 * - `blocksValid`     â€” true when `ledgerFreshnessFailOnStale=true` AND status='stale'
 */
export interface LedgerFreshnessCheckResult {
  status: 'ok' | 'stale' | 'unknown';
  lagSeconds: number | null;
  latestLedger: number | null;
  message: string;
  blocksValid: boolean;
}

const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

/** Matches bare G-addresses embedded in free-form text (issue bodies, comments). */
const STELLAR_ADDRESS_IN_TEXT_REGEX = /\bG[A-Z2-7]{55}\b/g;

/** RFC4648 base32 alphabet used by Stellar's StrKey encoding (no padding). */
const STRKEY_BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** StrKey version byte for an ed25519 public key ("G..." address): 6 << 3. */
const STRKEY_VERSION_BYTE_ED25519_PUBLIC_KEY = 0x30;

/**
 * Decodes an RFC4648 base32 string (no padding) into raw bytes, as used by
 * Stellar's StrKey encoding. Returns `null` if the input contains
 * characters outside the StrKey alphabet.
 */
function base32Decode(input: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of input) {
    const index = STRKEY_BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      return null;
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }

  return Uint8Array.from(bytes);
}

/**
 * CRC-16/XMODEM (poly 0x1021, init 0x0000, no reflect, no xorout) â€” the
 * checksum algorithm StrKey appends (little-endian) after the version byte
 * and payload.
 */
function crc16xmodem(bytes: Uint8Array): number {
  let crc = 0x0000;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export function normalizeStellarAddress(address: string): string {
  return address.trim();
}

/**
 * Validates a Stellar "G..." address against the full StrKey policy: 56
 * characters from the StrKey base32 alphabet, the ed25519 public key
 * version byte, and a matching CRC-16/XMODEM checksum. A regex match alone
 * only confirms shape â€” many regex-valid strings are not real StrKeys
 * because their checksum bytes don't match the payload.
 */
export function isValidStellarAddress(address: string): boolean {
  const trimmed = normalizeStellarAddress(address);
  if (!STELLAR_ADDRESS_REGEX.test(trimmed)) {
    return false;
  }

  const decoded = base32Decode(trimmed);
  // 1 version byte + 32-byte ed25519 payload + 2-byte checksum.
  if (!decoded || decoded.length !== 35) {
    return false;
  }

  if (decoded[0] !== STRKEY_VERSION_BYTE_ED25519_PUBLIC_KEY) {
    return false;
  }

  const versionAndPayload = decoded.subarray(0, 33);
  const expectedChecksum = crc16xmodem(versionAndPayload);
  const actualChecksum = decoded[33] | (decoded[34] << 8);

  return expectedChecksum === actualChecksum;
}

export interface AddressExtractionResult {
  /** The first valid Stellar G-address found, or undefined if none. */
  address: string | undefined;
  /** All valid G-addresses found in the text (deduplicated, order preserved). */
  allAddresses: string[];
}

/**
 * Extract Stellar G-addresses from free-form text such as an issue body.
 *
 * Scans the text for all 56-character sequences starting with G followed by
 * base32 characters, validates each one, and returns the first valid hit
 * together with a deduplicated list of every valid address found.
 *
 * Safe to call with arbitrary untrusted input â€” performs no network requests
 * and never throws.
 *
 * @param text - Issue body, comment text, or any free-form string.
 * @returns `address` (first found) and `allAddresses` (all found, deduped).
 */
export function extractStellarAddressFromText(text: string | undefined | null): AddressExtractionResult {
  if (!text) {
    return { address: undefined, allAddresses: [] };
  }

  STELLAR_ADDRESS_IN_TEXT_REGEX.lastIndex = 0;
  const seen = new Set<string>();
  const allAddresses: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = STELLAR_ADDRESS_IN_TEXT_REGEX.exec(text)) !== null) {
    const candidate = match[0];
    if (isValidStellarAddress(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      allAddresses.push(candidate);
    }
  }

  return {
    address: allAddresses[0],
    allAddresses,
  };
}

export function validateStellarAddress(address: string): void {
  if (!address || !address.trim()) {
    throw new Error('stellar_address_input is required.');
  }
  if (!isValidStellarAddress(address)) {
    throw new Error(
      `Invalid Stellar address "${address}". Expected a 56-character ed25519 public key ` +
        'starting with "G" with a valid StrKey checksum.',
    );
  }
}

export function parseMinXlmReserve(value: string): string {
  const normalized = value.trim();
  const parsed = Number(normalized);
  if (!normalized || !Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`min_xlm_reserve must be a non-negative number. Received: "${value}"`);
  }
  return normalized;
}

export function parseMinAssetBalance(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`min_asset_balance must be a non-negative number. Received: "${value}"`);
  }
  return normalized;
}

export function parseTrustlineLimit(value: string): number {
  const normalized = value.trim();
  const parsed = Number(normalized);
  if (!normalized || !Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`min_trustline_limit must be a non-negative number. Received: "${value}"`);
  }
  return parsed;
}

export function estimateTrustlineSetupCost(): number {
  return STELLAR_MIN_ACCOUNT_BALANCE_XLM + STELLAR_BASE_RESERVE_XLM;
}

export function formatXlmDeficit(required: number, actual: number): string {
  return Math.max(0, required - actual).toFixed(7);
}

export function formatAssetDeficit(required: number, actual: number): string {
  return Math.max(0, required - actual).toFixed(7);
}

/**
 * Renders the sponsor-aware reserve math behind a `ReserveRequirement` as a
 * short human-readable clause, e.g.
 * "protocol minimum **1.5 XLM** = (2 + 1 subentry) Ã— 0.5 XLM, floor **1.5 XLM**".
 */
function explainReserveRequirement(reserve: ReserveRequirement): string {
  const sponsorClause =
    reserve.numSponsoring !== 0 || reserve.numSponsored !== 0
      ? ` + ${reserve.numSponsoring} sponsoring âˆ’ ${reserve.numSponsored} sponsored`
      : '';
  const subentryWord = reserve.subentryCount === 1 ? 'subentry' : 'subentries';
  const formula = `(2 + ${reserve.subentryCount} ${subentryWord}${sponsorClause}) Ã— ${STELLAR_BASE_RESERVE_XLM} XLM`;
  return `protocol minimum **${reserve.protocolMinimum} XLM** = ${formula}, floor **${reserve.configuredFloor} XLM**`;
}

export async function runAccountChecks(
  account: HorizonAccount,
  config: CheckConfig,
): Promise<ValidationResult> {
  const xlmBalance = getNativeBalance(account);
  const xlmNumeric = parseHorizonBalance(xlmBalance);
  const trustlineBalance = findTrustlineBalance(account, config.assetCode, config.assetIssuer);
  const trustlineExistsRaw = trustlineBalance !== undefined;
  const trustlineAuthorized = trustlineBalance ? isTrustlineAuthorized(trustlineBalance) : undefined;
  const { clawbackEnabled } = getAssetClawbackStatus(trustlineBalance);

  const unauthorizedPolicy = config.unauthorizedTrustlinePolicy ?? 'warn';
  const isUnauthorized = trustlineExistsRaw && trustlineAuthorized === false;
  const authorizationBlocks = isUnauthorized && unauthorizedPolicy === 'fail';

  const clawbackStrictMode = config.clawbackStrictMode ?? false;
  const clawbackBlocks = trustlineExistsRaw && clawbackEnabled && clawbackStrictMode;

  // Under the "fail" policy, an unauthorized trustline does not count as a
  // satisfied trustline requirement.
  const trustlineExists = trustlineExistsRaw && !authorizationBlocks;

  const reserveRequirement = buildReserveRequirement(config.minXlmReserve, xlmNumeric, account);
  const xlmReserveMet = reserveRequirement.met;
  const hasAnyTrustlines = account.balances.some((b) => isCreditBalance(b));

  const assetBalanceRaw = getAssetBalance(account, config.assetCode, config.assetIssuer);
  const assetBalanceNumeric = parseHorizonBalance(assetBalanceRaw);
  const minAssetBalanceRequired = Number(config.minAssetBalance ?? 0);
  const assetBalanceCheckEnabled = minAssetBalanceRequired > 0;
  const assetBalanceMet =
    !assetBalanceCheckEnabled || assetBalanceNumeric >= minAssetBalanceRequired;

  const safeAssetCode = escapeMarkdownInline(config.assetCode);
  const reserveExplanation = explainReserveRequirement(reserveRequirement);

  // Get trustline limit for the asset (Issue #140)
  const trustlineLimit = getTrustlineLimit(account, config.assetCode, config.assetIssuer);
  const trustlineLimitNumeric = parseHorizonBalance(trustlineLimit);
  const trustlineLimitMet = !config.minTrustlineLimit || trustlineLimitNumeric >= config.minTrustlineLimit;

  let trustlineDetail: string;
  if (trustlineExistsRaw && isUnauthorized) {
    trustlineDetail = authorizationBlocks
      ? `Trustline for **${safeAssetCode}** exists but is **not authorized** by the issuer (${inlineCode(config.assetIssuer)}) â€” blocked by \`unauthorized_trustline_policy: fail\`.`
      : `Trustline for **${safeAssetCode}** (${inlineCode(config.assetIssuer)}) is configured, but **not yet authorized** by the issuer â€” transfers will fail until authorized.`;
  } else if (trustlineExistsRaw) {
    trustlineDetail = `Trustline for **${safeAssetCode}** (${inlineCode(config.assetIssuer)}) is configured.`;
  } else if (hasAnyTrustlines) {
    trustlineDetail = `Account has trustlines, but not for **${safeAssetCode}** issued by ${inlineCode(config.assetIssuer)}.`;
  } else {
    trustlineDetail = 'Account has **zero trustlines** â€” add a trustline before receiving this asset.';
  }

  const checks: CheckResultItem[] = [
    {
      passed: true,
      label: 'Account funded',
      detail: `Account ${inlineCode(account.account_id)} is active on the Stellar network.`,
    },
    {
      passed: trustlineExists,
      label: `${safeAssetCode} trustline`,
      detail: trustlineDetail,
    },
    {
      passed: xlmReserveMet,
      label: 'XLM reserve',
      detail: xlmReserveMet
        ? `Balance **${inlineCode(xlmBalance)} XLM** meets the required **${reserveRequirement.required} XLM** â€” ${reserveExplanation}.`
        : `Balance **${inlineCode(xlmBalance)} XLM** is below the required **${reserveRequirement.required} XLM** â€” ${reserveExplanation}.`,
    },
  ];

  // Add trustline limit check if configured (Issue #140)
  if (config.minTrustlineLimit !== undefined) {
    checks.push({
      passed: trustlineExists && trustlineLimitMet,
      label: 'Trustline limit',
      detail: trustlineExists
        ? trustlineLimitMet
          ? `Trustline limit is **${inlineCode(trustlineLimit)} ${safeAssetCode}** (minimum required: **${config.minTrustlineLimit} ${safeAssetCode}**).`
          : `Trustline limit is **${inlineCode(trustlineLimit)} ${safeAssetCode}** but **${config.minTrustlineLimit} ${safeAssetCode}** is required.`
        : `Cannot verify trustline limit (${safeAssetCode} trustline does not exist).`,
    });
  }

  if (assetBalanceCheckEnabled) {
    const assetBalanceCheckDetail = trustlineExists
      ? assetBalanceMet
        ? `Balance **${inlineCode(assetBalanceRaw)} ${safeAssetCode}** meets the minimum of **${minAssetBalanceRequired} ${safeAssetCode}**.`
        : `Balance **${inlineCode(assetBalanceRaw)} ${safeAssetCode}** is below the required **${minAssetBalanceRequired} ${safeAssetCode}**. Deficit: **${formatAssetDeficit(minAssetBalanceRequired, assetBalanceNumeric)} ${safeAssetCode}**.`
      : `Cannot verify ${safeAssetCode} balance â€” trustline is not configured yet.`;
    checks.push({
      passed: assetBalanceMet || !trustlineExists,
      label: `${safeAssetCode} minimum balance`,
      detail: assetBalanceCheckDetail,
    });
  }

  if (trustlineExistsRaw && clawbackEnabled && clawbackStrictMode) {
    checks.push({
      passed: false,
      label: `${safeAssetCode} clawback safety`,
      detail: `**${safeAssetCode}** has **clawback enabled** for this trustline (${inlineCode(config.assetIssuer)}) â€” blocked by \`clawback_strict_mode: true\`.`,
    });
  }

  // ---------------------------------------------------------------------------
  // SEP-0001 home domain check (optional, off by default)
  // ---------------------------------------------------------------------------
  let homeDomainCheck: HomeDomainCheckResult | undefined;
  if (config.homeDomainCheckEnabled) {
    // The issuer account is not the same as the wallet account being checked.
    // We use the `home_domain` field already present on the recipient account's
    // balance entry if the issuer is Horizon-visible, but in the common case
    // TrustBridge only holds the *wallet* account. We therefore pass `null` to
    // evaluateHomeDomain unless the caller has pre-fetched the issuer account
    // separately. For the monolith runAccountChecks path we use whatever
    // home_domain the wallet account carries (useful when the wallet IS the
    // issuer, e.g. in regulated-asset test setups). The plugin-based path
    // (homeDomainPlugin) follows the same convention. Full issuer-account
    // lookup is deferred to a future enhancement.
    homeDomainCheck = evaluateHomeDomain(account, config);

    // Optionally enrich with stellar.toml fetch and validation
    if (config.stellarTomlFetchEnabled) {
      homeDomainCheck = await enrichHomeDomainCheckWithToml(homeDomainCheck, config);
    }

    // Emit metrics tag for dashboards and payout automation.
    globalMetrics.incrementCounter(`home_domain_${homeDomainCheck.outcome}`);
    globalMetrics.recordMetric('home_domain_check', 1, 'count', {
      outcome: homeDomainCheck.outcome,
      mode: config.homeDomainCheckMode ?? 'warn',
    });

    const homeDomainPassed = !homeDomainCheck.blocksValid || homeDomainCheck.outcome === 'valid';
    checks.push({
      passed: homeDomainPassed,
      label: 'SEP-0001 home domain',
      detail: homeDomainCheck.detail,
    });
  }

  const valid = checks.every((c) => c.passed);
  let remediation: string | undefined;

  if (!valid) {
    const network = inferStellarNetwork(config.horizonUrl ?? '');
    const steps: string[] = [];
    if (authorizationBlocks) {
      steps.push(
        `Ask the asset issuer (${inlineCode(config.assetIssuer)}) to authorize this trustline for ${inlineCode(account.account_id)}. The issuer has AUTHORIZATION_REQUIRED enabled, so a Change Trust operation alone is not enough â€” the issuer must submit a SetTrustLineFlags (or legacy AllowTrust) operation.`,
      );
    } else if (!trustlineExists) {
      steps.push(
        `Add a **${safeAssetCode}** trustline using [Stellar Laboratory](${buildChangeTrustLink(network)}) (Change Trust operation) or a wallet such as [LOBSTR](${buildLobstrLink()}).`,
      );
    }
    if (!xlmReserveMet) {
      steps.push(
        `Send at least **${reserveRequirement.missing} XLM** to ${inlineCode(account.account_id)} to meet the reserve requirement.`,
      );
    }
    if (trustlineExists && !trustlineLimitMet && config.minTrustlineLimit) {
      steps.push(
        `Increase the ${safeAssetCode} trustline limit to at least **${config.minTrustlineLimit} ${safeAssetCode}** using [Stellar Laboratory](${buildChangeTrustLink(network)}) (Manage Trust operation) or a wallet. Current limit is **${inlineCode(trustlineLimit)} ${safeAssetCode}**.`,
      );
    }
    if (assetBalanceCheckEnabled && !assetBalanceMet && trustlineExists) {
      steps.push(
        `Acquire at least **${formatAssetDeficit(minAssetBalanceRequired, assetBalanceNumeric)} ${safeAssetCode}** to meet the minimum asset balance requirement of **${minAssetBalanceRequired} ${safeAssetCode}**.`,
      );
    }
    if (clawbackBlocks) {
      steps.push(
        `This asset has clawback enabled, which is blocked by \`clawback_strict_mode: true\`. Choose a different asset, or set \`clawback_strict_mode: false\` to proceed with a warning instead.`,
      );
    }
    remediation = steps.join('\n\n');
  }

  // Extract sponsorship info from account (Issue #141)
  const sponsorshipInfo: SponsorshipInfo = {
    numSponsoring: account.num_sponsoring ?? 0,
    numSponsored: account.num_sponsored ?? 0,
  };

  // Claimable-balance-aware funded definition (Issue #260)
  // Default 'ignore' means claimables do not affect funded/valid.
  // When policy is 'count', we surface an informational note if claimables exist.
  const claimableBalancePolicy = config.claimableBalancePolicy ?? 'ignore';
  const claimableBalanceCount = countClaimableBalances(account);
  const hasClaimables = claimableBalanceCount > 0;
  if (claimableBalancePolicy === 'count' && hasClaimables) {
    checks.push({
      passed: true,
      label: 'Claimable balances',
      detail: `Account has **${claimableBalanceCount} claimable balance(s)** â€” these are not counted toward \`account_funded\` but can be claimed via Horizon claimable_balances endpoint.`,
    });
    globalMetrics.incrementCounter('claimable_balances_found');
    globalMetrics.recordMetric('claimable_balances_count', claimableBalanceCount, 'count', {
      policy: 'count',
    });
  }

  return {
    valid,
    accountFunded: true,
    trustlineExists,
    trustlineAuthorized,
    clawbackEnabled: trustlineExistsRaw ? clawbackEnabled : undefined,
    xlmBalance,
    xlmReserveMet,
    assetBalance: assetBalanceRaw,
    assetBalanceMet,
    trustlineLimit,
    checks,
    remediation,
    claimableBalanceCount,
    hasClaimableBalances: hasClaimables,
    reasonCode: (() => {
      if (valid) return 'SUCCESS';
      if (!trustlineExists) return 'TRUSTLINE_MISSING';
      if (!xlmReserveMet) return 'RESERVE_TOO_LOW';
      if (config.minTrustlineLimit && !trustlineLimitMet) return 'TRUSTLINE_LIMIT_TOO_LOW';
      return 'FAILED';
    })(),
    failedCheckLabels: toFailedCheckCodes(checks),
    reserveRequirement,
    homeDomainCheck,
    sponsorshipInfo,
  };
}

export function unfundedAccountResult(
  stellarAddress: string,
  config: CheckConfig,
  mismatchHint?: NetworkMismatchHint,
  claimableCount?: number,
): ValidationResult {
  const safeAssetCode = escapeMarkdownInline(config.assetCode);
  const safeAddress = inlineCode(stellarAddress);
  const network = inferStellarNetwork(config.horizonUrl ?? '');
  const assetBalanceCheckEnabled = Number(config.minAssetBalance ?? 0) > 0;

  // Build the "not found" detail, extended with mismatch context when available
  // Uses centralized deterministic builder so publicâ†”testnet produce identical format.
  let notFoundDetail = `Account ${safeAddress} was **not found** on Horizon â€” it may not be funded or activated yet.`;
  if (mismatchHint) {
    notFoundDetail = buildNetworkMismatchDetail(stellarAddress, mismatchHint);
  }
  // Claimable-balance-aware funded definition (Issue #260): when policy is 'count' and
  // claimableCount >0, surface an informational note. This does NOT set accountFunded true;
  // the account is still unfunded, but the contributor is told claimables exist.
  const claimablePolicy = config.claimableBalancePolicy ?? 'ignore';
  const hasClaimables = typeof claimableCount === 'number' && claimableCount > 0;
  if (claimablePolicy === 'count' && hasClaimables) {
    notFoundDetail += ` It has **${claimableCount} claimable balance(s)** on Horizon â€” these must be claimed after funding.`;
  } else if (claimablePolicy === 'ignore' && hasClaimables) {
    // When ignoring, we do not mention claimables in the funded check to keep today's behavior.
    // Metrics still tracked for observability if caller fetched count.
  }

  const checks: CheckResultItem[] = [
    {
      passed: false,
      label: 'Account funded',
      detail: notFoundDetail,
    },
    {
      passed: false,
      label: `${safeAssetCode} trustline`,
      detail: 'Cannot verify trustline until the account exists.',
    },
    {
      passed: false,
      label: 'XLM reserve',
      detail: `Cannot verify XLM balance. Fund the account with at least **${config.minXlmReserve} XLM**.`,
    },
  ];

  if (assetBalanceCheckEnabled) {
    checks.push({
      passed: false,
      label: `${safeAssetCode} minimum balance`,
      detail: `Cannot verify ${safeAssetCode} balance â€” Fund the account and establish a trustline first.`,
    });
  }

  // Claimable balances informational check (Issue #260) â€” only when policy is count
  const claimablePolicyForCheck = config.claimableBalancePolicy ?? 'ignore';
  if (claimablePolicyForCheck === 'count' && typeof claimableCount === 'number' && claimableCount > 0) {
    checks.push({
      passed: true,
      label: 'Claimable balances',
      detail: `Account has **${claimableCount} claimable balance(s)** pending claim. Fund the account first, then claim via Horizon or wallet.`,
    });
  }

  // Base remediation steps
  const remediationSteps = [
    `Activate ${safeAddress} by sending at least **${STELLAR_MIN_ACCOUNT_BALANCE_XLM} XLM** (Stellar minimum account balance).`,
    `Then add a **${safeAssetCode}** trustline via [Stellar Laboratory](${buildChangeTrustLink(network)}) or [LOBSTR](${buildLobstrLink()}).`,
    `Estimated setup cost: ~**${estimateTrustlineSetupCost()} XLM** (1 XLM base + 0.5 XLM per trustline reserve).`,
  ];

  // Claimable remediation when policy is count
  if ((config.claimableBalancePolicy ?? 'ignore') === 'count' && typeof claimableCount === 'number' && claimableCount > 0) {
    remediationSteps.push(
      `This address has **${claimableCount} claimable balance(s)** awaiting claim. After funding, claim them via [Horizon claimable_balances endpoint](${config.horizonUrl ?? 'https://horizon.stellar.org'}/claimable_balances?claimant=${stellarAddress}) or a wallet that supports claimable balances.`,
    );
  }

  // Prepend network-mismatch guidance when detected so it's the first thing a
  // contributor reads.
  if (mismatchHint) {
    const strings = getStrings('en');
    const correctUrl = canonicalHorizonUrl(mismatchHint.configuredNetwork);
    const altUrl = canonicalHorizonUrl(mismatchHint.activeOnNetwork);
    remediationSteps.unshift(
      `${strings.networkMismatchDetected} ${strings.networkMismatchConfiguredNetwork}` +
        ` **${mismatchHint.configuredNetwork}** (${correctUrl}) and ${strings.networkMismatchActiveNetwork}` +
        ` **${mismatchHint.activeOnNetwork}** (${altUrl}).`,
      `${strings.networkMismatchFix} ${strings.networkMismatchUpdateUrl}`,
    );
  }

  // SEP-0001 home domain: account is unfunded so issuer data is unavailable.
  let homeDomainCheck: HomeDomainCheckResult | undefined;
  if (config.homeDomainCheckEnabled) {
    homeDomainCheck = evaluateHomeDomain(null, config);
    globalMetrics.incrementCounter(`home_domain_${homeDomainCheck.outcome}`);
    globalMetrics.recordMetric('home_domain_check', 1, 'count', {
      outcome: homeDomainCheck.outcome,
      mode: config.homeDomainCheckMode ?? 'warn',
    });
    checks.push({
      // Unfunded path: home domain cannot be verified, treat as non-blocking regardless of mode
      passed: true,
      label: 'SEP-0001 home domain',
      detail: 'Cannot verify issuer home domain â€” account is not yet funded.',
    });
  }

  return {
    valid: false,
    reasonCode: 'ACCOUNT_NOT_FUNDED',
    accountFunded: false,
    trustlineExists: false,
    xlmBalance: '0',
    xlmReserveMet: false,
    assetBalance: '0',
    assetBalanceMet: false,
    checks,
    remediation: remediationSteps.join('\n\n'),
    failedCheckLabels: toFailedCheckCodes(checks),
    sponsorshipInfo: { numSponsoring: 0, numSponsored: 0 },
    homeDomainCheck,
    claimableBalanceCount: typeof claimableCount === 'number' ? claimableCount : 0,
    hasClaimableBalances: typeof claimableCount === 'number' && claimableCount > 0,
  };
}

export function getFailedCheckLabels(result: ValidationResult): string[] {
  return result.checks.filter((check) => !check.passed).map((check) => check.label);
}

/**
 * Map human-readable check labels to stable snake_case codes used by
 * gating / metrics / fail_on_missing benchmarks.
 */
function toFailedCheckCodes(checks: CheckResultItem[]): string[] {
  const codes: string[] = [];
  for (const check of checks) {
    if (check.passed) continue;
    const label = check.label.toLowerCase();
    if (label.includes('horizon')) {
      codes.push('horizon_available');
    } else if (label.includes('account funded')) {
      codes.push('account_funded');
    } else if (label.includes('trustline') && !label.includes('limit') && !label.includes('clawback')) {
      codes.push('trustline');
    } else if (label.includes('xlm reserve')) {
      codes.push('xlm_reserve');
    } else if (label.includes('minimum balance')) {
      codes.push('asset_balance');
    } else if (label.includes('trustline limit')) {
      codes.push('trustline_limit');
    } else if (label.includes('home domain')) {
      codes.push('home_domain');
    } else {
      codes.push(label.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
    }
  }
  return codes;
}

/**
 * Reduces an error message to something safe to post in a public GitHub
 * comment: only the first line (never a multi-line stack trace) and capped
 * to a sane length. The underlying Error's full `.stack` is never passed
 * into this pipeline in the first place â€” callers only ever pass
 * `error.message` â€” but this is a defense-in-depth guard against a
 * message that itself happens to be multi-line or unexpectedly long.
 */
function sanitizeErrorMessageForComment(message: string): string {
  const firstLine = message.split(/\r?\n/)[0] ?? '';
  const MAX_LENGTH = 500;
  return firstLine.length > MAX_LENGTH ? `${firstLine.slice(0, MAX_LENGTH)}â€¦` : firstLine;
}

export function horizonFailureResult(message: string, config: CheckConfig): ValidationResult {
  // `message` may originate from the configured Horizon endpoint's HTTP
  // response body (e.g. the `detail`/`title` fields of an error payload),
  // which is not trusted content â€” sanitize and escape it before it lands
  // in the Markdown comment so it can't dump a stack trace, inject
  // formatting/links, or break out of the comment structure.
  const safeMessage = escapeMarkdownInline(sanitizeErrorMessageForComment(message));
  const safeAssetCode = escapeMarkdownInline(config.assetCode);
  const assetBalanceCheckEnabled = Number(config.minAssetBalance ?? 0) > 0;

  const checks: CheckResultItem[] = [
    {
      passed: false,
      label: 'Horizon availability',
      detail: safeMessage,
    },
    {
      passed: false,
      label: `${safeAssetCode} trustline`,
      detail: 'Check could not be completed.',
    },
    {
      passed: false,
      label: 'XLM reserve',
      detail: 'Check could not be completed.',
    },
  ];

  if (assetBalanceCheckEnabled) {
    checks.push({
      passed: false,
      label: `${safeAssetCode} minimum balance`,
      detail: 'Check could not be completed.',
    });
  }

  if (config.homeDomainCheckEnabled) {
    globalMetrics.incrementCounter('home_domain_skipped');
    globalMetrics.recordMetric('home_domain_check', 1, 'count', {
      outcome: 'skipped',
      mode: config.homeDomainCheckMode ?? 'warn',
    });
    checks.push({
      passed: true,
      label: 'SEP-0001 home domain',
      detail: 'Cannot verify issuer home domain â€” Horizon was unreachable.',
    });
  }

  return {
    valid: false,
    reasonCode: message.toLowerCase().includes('timed out') || message.toLowerCase().includes('timeout')
      ? 'HORIZON_TIMEOUT'
      : 'HORIZON_ERROR',
    accountFunded: false,
    trustlineExists: false,
    xlmBalance: 'unknown',
    xlmReserveMet: false,
    assetBalance: 'unknown',
    assetBalanceMet: false,
    checks,
    remediation:
      'Horizon could not be reached. Retry later or verify your `horizon_url` input and network connectivity.',
    failedCheckLabels: toFailedCheckCodes(checks),
    sponsorshipInfo: { numSponsoring: 0, numSponsored: 0 },
    homeDomainCheck: config.homeDomainCheckEnabled
      ? { outcome: 'skipped', detail: 'Cannot verify â€” Horizon unreachable.', blocksValid: false }
      : undefined,
  };
}

/**
 * Builds a result for a TLS/certificate verification failure connecting to
 * the configured Horizon endpoint (see `HorizonTlsError`). Kept distinct
 * from `horizonFailureResult` so the comment clearly attributes the
 * failure to the endpoint's transport/certificate configuration rather
 * than to the account or trustline being checked â€” this matters most for
 * private/enterprise Horizon mirrors, where a bad or expired certificate
 * is easy to misdiagnose as "the account isn't set up right."
 */
export function tlsFailureResult(message: string, config: CheckConfig): ValidationResult {
  const safeMessage = escapeMarkdownInline(sanitizeErrorMessageForComment(message));
  const safeAssetCode = escapeMarkdownInline(config.assetCode);

  const checks: CheckResultItem[] = [
    {
      passed: false,
      label: 'Horizon TLS / certificate verification',
      detail: safeMessage,
    },
    {
      passed: false,
      label: `${safeAssetCode} trustline`,
      detail: 'Check could not be completed â€” the Horizon TLS handshake failed before this account could be queried.',
    },
    {
      passed: false,
      label: 'XLM reserve',
      detail: 'Check could not be completed â€” the Horizon TLS handshake failed before this account could be queried.',
    },
  ];

  return {
    valid: false,
    reasonCode: 'TLS_ERROR',
    accountFunded: false,
    trustlineExists: false,
    xlmBalance: 'unknown',
    xlmReserveMet: false,
    assetBalance: 'unknown',
    assetBalanceMet: false,
    checks,
    remediation:
      'TLS/certificate verification failed for the configured Horizon endpoint. ' +
      'Check the endpoint certificate chain (especially for private mirrors) and retry.',
    failedCheckLabels: toFailedCheckCodes(checks),
    sponsorshipInfo: { numSponsoring: 0, numSponsored: 0 },
  };
}

/** Subset of `HorizonAccount` needed to compute the protocol-accurate minimum balance. */
export interface SponsorAwareAccountFields {
  subentry_count: number;
  num_sponsoring?: number;
  num_sponsored?: number;
}

export interface ReserveRequirement {
  /** Final required balance: the greater of the protocol minimum and the configured floor. */
  required: number;
  actual: number;
  missing: string;
  met: boolean;
  /** Stellar protocol minimum computed from subentries and net sponsorship (CAP-0033). */
  protocolMinimum: number;
  /** The `min_xlm_reserve` input value, applied as a floor over the protocol minimum. */
  configuredFloor: number;
  subentryCount: number;
  numSponsoring: number;
  numSponsored: number;
}

/**
 * Computes the real Stellar protocol minimum balance for an account:
 * `(2 base reserves + subentries + num_sponsoring âˆ’ num_sponsored) * base_reserve`.
 * Sponsored subentries don't count against the sponsoree's own reserve, and
 * subentries the account sponsors *for others* do â€” see CAP-0033. Clamped
 * to zero so a stale/inconsistent sponsorship snapshot can never go negative.
 */
export function computeProtocolMinReserve(account: SponsorAwareAccountFields): number {
  const numSponsoring = account.num_sponsoring ?? 0;
  const numSponsored = account.num_sponsored ?? 0;
  const reserveEntries = 2 + account.subentry_count + numSponsoring - numSponsored;
  return Math.max(0, reserveEntries) * STELLAR_BASE_RESERVE_XLM;
}

/**
 * Builds the effective reserve requirement for an account: the Stellar
 * protocol minimum (sponsor-aware) with `configuredFloor` (`min_xlm_reserve`)
 * applied as a floor override, so maintainers can still require more than
 * the bare protocol minimum.
 */
export function buildReserveRequirement(
  configuredFloor: number,
  actual: number,
  account?: SponsorAwareAccountFields,
): ReserveRequirement {
  const protocolMinimum = account ? computeProtocolMinReserve(account) : 0;
  const required = Math.max(protocolMinimum, configuredFloor);
  return {
    required,
    actual,
    missing: formatXlmDeficit(required, actual),
    met: actual >= required,
    protocolMinimum,
    configuredFloor,
    subentryCount: account?.subentry_count ?? 0,
    numSponsoring: account?.num_sponsoring ?? 0,
    numSponsored: account?.num_sponsored ?? 0,
  };
}

/** Per-asset trustline check result for multi-asset validation. */
export interface AssetTrustlineResult {
  assetCode: string;
  assetIssuer: string;
  trustlineExists: boolean;
}

/**
 * Run trustline checks for multiple assets against an already-fetched account.
 * Returns per-asset results and an aggregate `allTrustlinesExist` flag.
 */
export function runMultiAssetChecks(
  account: HorizonAccount,
  assets: Array<{ assetCode: string; assetIssuer: string }>,
): { results: AssetTrustlineResult[]; allTrustlinesExist: boolean } {
  const results: AssetTrustlineResult[] = assets.map((a) => ({
    assetCode: a.assetCode,
    assetIssuer: a.assetIssuer,
    trustlineExists: hasTrustline(account, a.assetCode, a.assetIssuer),
  }));
  return {
    results,
    allTrustlinesExist: results.every((r) => r.trustlineExists),
  };
}

export interface ValidationGate {
  ready: boolean;
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  failedLabels: string[];
}

/**
 * Build a machine-readable gate summary from the validation result.
 * This stays intentionally small so it can be consumed by comment output,
 * dashboards, or future release automation without re-parsing Markdown.
 */
export function buildValidationGate(result: ValidationResult): ValidationGate {
  const failedLabels = getFailedCheckLabels(result);
  const failedChecks = failedLabels.length;
  const totalChecks = result.checks.length;
  return {
    ready: failedChecks === 0,
    totalChecks,
    passedChecks: totalChecks - failedChecks,
    failedChecks,
    failedLabels,
  };
}

// ---------------------------------------------------------------------------
// Wave #32: Reusable workflow examples for trustline, reserve, StrKey,
// multi-asset validation checks (Issue #32)
// ---------------------------------------------------------------------------

/**
 * Reusable workflow: verify trustline existence for a specific asset.
 * Returns true if the account has an active trustline for the given asset code
 * and issuer, false otherwise.
 * 
 * Usage in workflows:
 * ```yaml
 * - name: Verify USDC trustline
 *   run: |
 *     if check-trustline USDC ${ISSUER}; then
 *       echo "Trustline configured"
 *     fi
 * ```
 */
export function checkTrustlineExists(
  account: HorizonAccount,
  assetCode: string,
  assetIssuer: string,
): boolean {
  return hasTrustline(account, assetCode, assetIssuer);
}

/**
 * Reusable workflow: verify XLM reserve meets minimum threshold.
 * Returns true if native balance >= minReserve, false otherwise.
 * 
 * Usage in workflows:
 * ```yaml
 * - name: Verify XLM reserve
 *   run: |
 *     if check-reserve ${ADDRESS} 1.5; then
 *       echo "Reserve met"
 *     fi
 * ```
 */
export function checkReserveMet(
  account: HorizonAccount,
  minReserve: number,
): boolean {
  const xlmBalance = getNativeBalance(account);
  const parsed = parseHorizonBalance(xlmBalance);
  return parsed >= minReserve;
}

/**
 * Reusable workflow: validate StrKey format for Stellar addresses.
 * Supports both G-addresses (accounts) and C-addresses (contracts).
 * Returns true if the address matches StrKey shape, false otherwise.
 * 
 * Usage in workflows:
 * ```yaml
 * - name: Validate address format
 *   run: |
 *     if validate-strkey ${ADDRESS}; then
 *       echo "Valid StrKey"
 *     fi
 * ```
 */
export function validateStrKeyFormat(address: string): boolean {
  const trimmed = address.trim();
  if (trimmed.length !== 56) return false;
  
  const prefix = trimmed.charAt(0);
  if (prefix !== 'G' && prefix !== 'C') return false;
  
  // StrKey uses base32 alphabet: A-Z, 2-7
  const strKeyRegex = /^[GC][A-Z2-7]{55}$/;
  return strKeyRegex.test(trimmed);
}

/**
 * Multi-asset trustline check configuration.
 */
export interface MultiAssetConfig {
  assetCode: string;
  assetIssuer: string;
  required: boolean; // if false, check is optional (warning only)
}

/**
 * Reusable workflow: verify multiple asset trustlines in a single check.
 * Returns an array of results â€” one per asset â€” with pass/fail status.
 * 
 * Usage in workflows:
 * ```yaml
 * - name: Verify multi-asset trustlines
 *   run: |
 *     check-multi-asset USDC,EURC ${USDC_ISSUER},${EURC_ISSUER}
 * ```
 */
export function checkMultiAssetTrustlines(
  account: HorizonAccount,
  assets: MultiAssetConfig[],
): Array<{ asset: string; issuer: string; exists: boolean; required: boolean }> {
  return assets.map((cfg) => ({
    asset: cfg.assetCode,
    issuer: cfg.assetIssuer,
    exists: hasTrustline(account, cfg.assetCode, cfg.assetIssuer),
    required: cfg.required,
  }));
}

/**
 * Reusable workflow: calculate recommended XLM reserve for an account.
 * Formula: base account reserve (1 XLM) + (trustline count Ã— 0.5 XLM per entry).
 * 
 * Usage in workflows:
 * ```yaml
 * - name: Calculate reserve requirement
 *   run: |
 *     RESERVE=$(calculate-reserve ${TRUSTLINE_COUNT})
 *     echo "Recommended reserve: ${RESERVE} XLM"
 * ```
 */
export function calculateRecommendedReserve(trustlineCount: number): number {
  return STELLAR_MIN_ACCOUNT_BALANCE_XLM + trustlineCount * STELLAR_BASE_RESERVE_XLM;
}

/**
 * Reusable workflow: check if account sponsor is configured.
 * Returns true if the account has a sponsor (num_sponsored > 0), false otherwise.
 * 
 * Useful for DAO/treasury workflows where accounts may be sponsored to reduce
 * reserve requirements for contributors.
 * 
 * Usage in workflows:
 * ```yaml
 * - name: Verify sponsorship
 *   run: |
 *     if check-sponsored ${ADDRESS}; then
 *       echo "Account is sponsored"
 *     fi
 * ```
 */
export function checkAccountSponsored(account: HorizonAccount): boolean {
  return (account.num_sponsored ?? 0) > 0;
}

/**
 * Reusable workflow example: comprehensive validation report combining all checks.
 * Produces a structured report for use in workflow decision steps or dashboard output.
 * 
 * Usage in workflows:
 * ```yaml
 * - name: Generate validation report
 *   run: |
 *     REPORT=$(generate-validation-report ${ADDRESS})
 *     echo "$REPORT" > report.json
 * ```
 */
export interface ValidationReport {
  address: string;
  strKeyValid: boolean;
  accountFunded: boolean;
  xlmBalance: string;
  reserveStatus: {
    current: number;
    required: number;
    met: boolean;
    deficit: string;
  };
  trustlines: Array<{ asset: string; issuer: string; exists: boolean }>;
  sponsored: boolean;
  timestamp: string;
}

export function generateValidationReport(
  account: HorizonAccount,
  config: CheckConfig,
  additionalAssets: MultiAssetConfig[] = [],
): ValidationReport {
  const xlmBalance = getNativeBalance(account);
  const xlmParsed = parseHorizonBalance(xlmBalance);
  const trustlineCount = account.balances.filter((b) => b.asset_type !== 'native').length;
  const recommendedReserve = calculateRecommendedReserve(trustlineCount);
  
  const primaryTrustline = {
    asset: config.assetCode,
    issuer: config.assetIssuer,
    exists: hasTrustline(account, config.assetCode, config.assetIssuer),
  };
  
  const additionalTrustlineResults = checkMultiAssetTrustlines(account, additionalAssets).map(
    (r) => ({ asset: r.asset, issuer: r.issuer, exists: r.exists }),
  );
  
  return {
    address: account.account_id,
    strKeyValid: validateStrKeyFormat(account.account_id),
    accountFunded: true,
    xlmBalance,
    reserveStatus: {
      current: xlmParsed,
      required: Math.max(config.minXlmReserve, recommendedReserve),
      met: xlmParsed >= Math.max(config.minXlmReserve, recommendedReserve),
      deficit: formatXlmDeficit(Math.max(config.minXlmReserve, recommendedReserve), xlmParsed),
    },
    trustlines: [primaryTrustline, ...additionalTrustlineResults],
    sponsored: checkAccountSponsored(account),
    timestamp: new Date().toISOString(),
  };
}


export interface AssetBalanceRequirement {
  required: bigint;
  actual: bigint;
  missing: string;
  met: boolean;
}

export function buildAssetBalanceRequirement(
  required: bigint,
  actual: bigint,
): AssetBalanceRequirement {
  const met = actual >= required;
  return {
    required,
    actual,
    missing: formatAssetDeficit(Number(required) / 1e7, Number(actual) / 1e7),
    met,
  };
}
