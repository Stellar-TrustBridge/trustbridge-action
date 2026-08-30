import { HorizonAccount } from './horizon';
import { StellarNetwork } from './links';
import { UnauthorizedTrustlinePolicy } from './inputs';
/** Stellar public network base reserve per ledger entry (XLM). */
export declare const STELLAR_BASE_RESERVE_XLM = 0.5;
/** Minimum balance required to activate a new account (XLM). */
export declare const STELLAR_MIN_ACCOUNT_BALANCE_XLM = 1;
/**
 * SEP-0001 home domain check mode.
 *
 * - `"warn"`  (default) — a missing or mismatched home domain records a metrics tag and
 *   adds an informational check row but does NOT set `valid = false`.
 * - `"strict"` — a missing or mismatched home domain sets `valid = false` and blocks
 *   payout automation, matching the behaviour of other hard checks.
 */
export type HomeDomainCheckMode = 'warn' | 'strict';
/**
 * Claimable-balance policy (Issue #260).
 *
 * - `"ignore"` — funded means Horizon account exists; claimable balances do not affect funded.
 * - `"count"` — unfunded accounts with claimable balances surface an informational hint.
 */
export type ClaimableBalancePolicy = 'ignore' | 'count';
/**
 * Whether an account snapshot contains any `claimable_balance_id` entries.
 * Note: funded accounts rarely embed claimables in `balances`; this helper
 * is for completeness and for the optional `count` policy which may also
 * inspect a separate claimable_balances Horizon response.
 */
export declare function hasClaimableBalances(account: HorizonAccount): boolean;
export declare function countClaimableBalances(account: HorizonAccount): number;
export interface CheckConfig {
    assetCode: string;
    assetIssuer: string;
    minXlmReserve: number;
    minTrustlineLimit?: number;
    /** Optional minimum balance for the configured asset (Issue #112). */
    minAssetBalance?: string | number;
    horizonUrl?: string;
    /** How to treat a trustline that exists but is not yet authorized by the issuer. Default: "warn". */
    unauthorizedTrustlinePolicy?: UnauthorizedTrustlinePolicy;
    /** When true, a clawback-enabled trustline fails the check instead of only warning. Default: false. */
    clawbackStrictMode?: boolean;
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
     * Defaults to 60 s (≈ 5–6 Stellar ledger close cycles).
     */
    maxLedgerLagSeconds?: number;
    /**
     * When `true` a stale ledger response sets `valid = false` and (when
     * `fail_on_missing` is also true) fails the workflow step.
     * When `false` (default / "warn") the result is informational only —
     * a warning row is added to the checks table and metrics are emitted but
     * the overall `valid` flag is unaffected.
     */
    ledgerFreshnessFailOnStale?: boolean;
    /**
     * How to treat claimable balances when determining `funded` status.
     *
     * - `"ignore"` (default) — funded = Horizon account exists (200). Claimable
     *   balances are ignored; an address with only claimable balances still shows
     *   “not found / unfunded”. No extra Horizon request is made.
     * - `"count"` — when the account is 404, TrustBridge also checks
     *   `GET /claimable_balances?claimant=address` (1 extra request, capped at
     *   5s). If claimable balances exist, the comment notes them but `accountFunded`
     *   remains false and `valid` is not set true unless documented. This is
     *   informational only and never auto-claims.
     *
     * Default `"ignore"` matches today’s behavior and avoids extra request budget.
     * Empty claimables (0) are treated as no hint in either mode.
     */
    claimableBalancePolicy?: ClaimableBalancePolicy;
}
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
 * - 404 primary + 200 alt (public→testnet OR testnet→public) => hint, clear
 *   comment with both canonical URLs and horizon_url guidance.
 * - 404 primary + 404 alt => no hint (genuinely unfunded everywhere).
 * - alt returns non-200/404 (503, 429, etc.) or network error/timeout => no hint.
 * - Alt URL is SSRF-validated via `validateHorizonUrl`; blocked URLs => no hint.
 * - Canonical opposite URLs (https://horizon.stellar.org ↔ https://horizon-testnet.stellar.org)
 *   are allowlisted and safe to probe even when `allow_cross_network_fallback` is false.
 *   Arbitrary fallback URLs are NEVER probed here — that is gated in `horizon.ts` via
 *   `allowCrossNetworkFallback`. This keeps probing deterministic and bounded.
 *
 * @param configuredHorizonUrl  The `horizon_url` input value.
 * @param stellarAddress        The 56-char G-address that returned 404.
 * @param fetchFn               Optional injected fetch (for testing).
 */
export declare function detectNetworkMismatch(configuredHorizonUrl: string, stellarAddress: string, fetchFn?: (url: string, init?: RequestInit) => Promise<{
    status: number;
}>): Promise<NetworkMismatchHint | undefined>;
/**
 * Build the deterministic cross-network mismatch detail string used in the
 * `Account funded` check. Centralized so both directions (public↔testnet) use
 * the identical format and are tested deterministically.
 */
export declare function buildNetworkMismatchDetail(stellarAddress: string, hint: NetworkMismatchHint): string;
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
    trustlineLimit?: string;
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
     * fetched and the policy is observed. Informational only — does not affect
     * `accountFunded` when policy is `ignore` (default).
     */
    claimableBalanceCount?: number;
    hasClaimableBalances?: boolean;
}
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
        cached: boolean;
    };
}
/**
 * Evaluate the issuer's SEP-0001 home domain alignment against the
 * fetched Horizon account data.
 *
 * This is a **pure, synchronous** function — it only inspects the
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
export declare function evaluateHomeDomain(issuerAccount: HorizonAccount | null, config: CheckConfig): HomeDomainCheckResult;
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
export declare function enrichHomeDomainCheckWithToml(result: HomeDomainCheckResult, config: CheckConfig): Promise<HomeDomainCheckResult>;
/**
 * Thin wrapper around `FreshnessCheckResult` from `freshness.ts` that adds
 * the information needed by comment rendering and the checks table.
 *
 * - `status`          — 'ok' | 'stale' | 'unknown'
 * - `lagSeconds`      — measured lag, or null when unavailable
 * - `latestLedger`    — latest ledger sequence, or null
 * - `message`         — human-readable detail line (safe for Markdown comment)
 * - `blocksValid`     — true when `ledgerFreshnessFailOnStale=true` AND status='stale'
 */
export interface LedgerFreshnessCheckResult {
    status: 'ok' | 'stale' | 'unknown';
    lagSeconds: number | null;
    latestLedger: number | null;
    message: string;
    blocksValid: boolean;
}
export declare function normalizeStellarAddress(address: string): string;
/**
 * Validates a Stellar "G..." address against the full StrKey policy: 56
 * characters from the StrKey base32 alphabet, the ed25519 public key
 * version byte, and a matching CRC-16/XMODEM checksum. A regex match alone
 * only confirms shape — many regex-valid strings are not real StrKeys
 * because their checksum bytes don't match the payload.
 */
export declare function isValidStellarAddress(address: string): boolean;
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
 * Safe to call with arbitrary untrusted input — performs no network requests
 * and never throws.
 *
 * @param text - Issue body, comment text, or any free-form string.
 * @returns `address` (first found) and `allAddresses` (all found, deduped).
 */
export declare function extractStellarAddressFromText(text: string | undefined | null): AddressExtractionResult;
export declare function validateStellarAddress(address: string): void;
export declare function parseMinXlmReserve(value: string): string;
export declare function parseMinAssetBalance(value: string): string | undefined;
export declare function parseTrustlineLimit(value: string): number;
export declare function estimateTrustlineSetupCost(): number;
export declare function formatXlmDeficit(required: number, actual: number): string;
export declare function formatAssetDeficit(required: number, actual: number): string;
export declare function runAccountChecks(account: HorizonAccount, config: CheckConfig): Promise<ValidationResult>;
export declare function unfundedAccountResult(stellarAddress: string, config: CheckConfig, mismatchHint?: NetworkMismatchHint, claimableCount?: number): ValidationResult;
export declare function getFailedCheckLabels(result: ValidationResult): string[];
export declare function horizonFailureResult(message: string, config: CheckConfig): ValidationResult;
/**
 * Builds a result for a TLS/certificate verification failure connecting to
 * the configured Horizon endpoint (see `HorizonTlsError`). Kept distinct
 * from `horizonFailureResult` so the comment clearly attributes the
 * failure to the endpoint's transport/certificate configuration rather
 * than to the account or trustline being checked — this matters most for
 * private/enterprise Horizon mirrors, where a bad or expired certificate
 * is easy to misdiagnose as "the account isn't set up right."
 */
export declare function tlsFailureResult(message: string, config: CheckConfig): ValidationResult;
/**
 * Builds a result for a rate-budget exhaustion failure (horizon_max_requests
 * exceeded). This is intentionally distinct from both:
 * - `horizonFailureResult` (Horizon API error or outage) — reason_code: HORIZON_ERROR
 * - `unfundedAccountResult` (Horizon 404) — reason_code: ACCOUNT_NOT_FUNDED
 *
 * A RATE_BUDGET_EXHAUSTED result always means the run was stopped by the
 * local request cap, *not* by any signal from Horizon about the account.
 * The account state is therefore genuinely unknown — fail closed.
 */
export declare function rateBudgetExhaustedResult(message: string, config: CheckConfig): ValidationResult;
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
 * `(2 base reserves + subentries + num_sponsoring − num_sponsored) * base_reserve`.
 * Sponsored subentries don't count against the sponsoree's own reserve, and
 * subentries the account sponsors *for others* do — see CAP-0033. Clamped
 * to zero so a stale/inconsistent sponsorship snapshot can never go negative.
 */
export declare function computeProtocolMinReserve(account: SponsorAwareAccountFields): number;
/**
 * Builds the effective reserve requirement for an account: the Stellar
 * protocol minimum (sponsor-aware) with `configuredFloor` (`min_xlm_reserve`)
 * applied as a floor override, so maintainers can still require more than
 * the bare protocol minimum.
 */
export declare function buildReserveRequirement(configuredFloor: number, actual: number, account?: SponsorAwareAccountFields): ReserveRequirement;
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
export declare function runMultiAssetChecks(account: HorizonAccount, assets: Array<{
    assetCode: string;
    assetIssuer: string;
}>): {
    results: AssetTrustlineResult[];
    allTrustlinesExist: boolean;
};
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
export declare function buildValidationGate(result: ValidationResult): ValidationGate;
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
export declare function checkTrustlineExists(account: HorizonAccount, assetCode: string, assetIssuer: string): boolean;
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
export declare function checkReserveMet(account: HorizonAccount, minReserve: number): boolean;
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
export declare function validateStrKeyFormat(address: string): boolean;
/**
 * Multi-asset trustline check configuration.
 */
export interface MultiAssetConfig {
    assetCode: string;
    assetIssuer: string;
    required: boolean;
}
/**
 * Reusable workflow: verify multiple asset trustlines in a single check.
 * Returns an array of results — one per asset — with pass/fail status.
 *
 * Usage in workflows:
 * ```yaml
 * - name: Verify multi-asset trustlines
 *   run: |
 *     check-multi-asset USDC,EURC ${USDC_ISSUER},${EURC_ISSUER}
 * ```
 */
export declare function checkMultiAssetTrustlines(account: HorizonAccount, assets: MultiAssetConfig[]): Array<{
    asset: string;
    issuer: string;
    exists: boolean;
    required: boolean;
}>;
/**
 * Reusable workflow: calculate recommended XLM reserve for an account.
 * Formula: base account reserve (1 XLM) + (trustline count × 0.5 XLM per entry).
 *
 * Usage in workflows:
 * ```yaml
 * - name: Calculate reserve requirement
 *   run: |
 *     RESERVE=$(calculate-reserve ${TRUSTLINE_COUNT})
 *     echo "Recommended reserve: ${RESERVE} XLM"
 * ```
 */
export declare function calculateRecommendedReserve(trustlineCount: number): number;
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
export declare function checkAccountSponsored(account: HorizonAccount): boolean;
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
    trustlines: Array<{
        asset: string;
        issuer: string;
        exists: boolean;
    }>;
    sponsored: boolean;
    timestamp: string;
}
export declare function generateValidationReport(account: HorizonAccount, config: CheckConfig, additionalAssets?: MultiAssetConfig[]): ValidationReport;
export interface AssetBalanceRequirement {
    required: bigint;
    actual: bigint;
    missing: string;
    met: boolean;
}
export declare function buildAssetBalanceRequirement(required: bigint, actual: bigint): AssetBalanceRequirement;
