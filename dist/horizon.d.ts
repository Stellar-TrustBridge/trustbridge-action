import { SimpleCache } from './cache';
import { RateBudgetTracker, CircuitBreaker } from './resilience';
export interface HorizonBalanceNative {
    balance: string;
    asset_type: 'native';
    buying_liabilities: string;
    selling_liabilities: string;
}
export interface HorizonBalanceCredit {
    balance: string;
    asset_type: 'credit_alphanum4' | 'credit_alphanum12';
    asset_code: string;
    asset_issuer: string;
    buying_liabilities: string;
    selling_liabilities: string;
    limit?: string;
    /**
     * Present only when the issuer has AUTHORIZATION_REQUIRED set. Absent
     * means the issuer does not require per-account authorization.
     */
    is_authorized?: boolean;
    is_authorized_to_maintain_liabilities?: boolean;
    /**
     * Per-trustline clawback flag (Horizon protocol 17+). Reflects the
     * issuer's AUTH_CLAWBACK_ENABLED setting unless overridden on this
     * specific trustline.
     */
    is_clawback_enabled?: boolean;
}
export interface HorizonBalanceLiquidityPoolShares {
    balance: string;
    asset_type: 'liquidity_pool_shares';
    liquidity_pool_id: string;
    buying_liabilities: string;
    selling_liabilities: string;
    limit: string;
    is_authorized: boolean;
    is_authorized_to_maintain_liabilities: boolean;
}
export interface HorizonBalanceClaimable {
    asset_type: 'claimable_balance_id';
    balance: string;
    claimable_balance_id: string;
}
export type HorizonBalance = HorizonBalanceNative | HorizonBalanceCredit | HorizonBalanceLiquidityPoolShares | HorizonBalanceClaimable;
export interface HorizonAccount {
    id: string;
    account_id: string;
    sequence: string;
    subentry_count: number;
    balances: HorizonBalance[];
    /** Sponsorship fields (CAP-0033). Omitted by older Horizon snapshots — treat as 0 when absent. */
    num_sponsoring?: number;
    num_sponsored?: number;
    /** Horizon base URL that actually served this account snapshot (primary or failover). */
    _servedByUrl?: string;
    /**
     * SEP-0001: The domain that hosts the issuer's stellar.toml metadata file.
     * Populated by Horizon when the issuer account has set a home_domain on-chain.
     * May be absent on older Horizon snapshots or when the issuer has not configured it.
     * Never use this value directly in a network request without SSRF-safe validation.
     */
    home_domain?: string;
    /**
     * Bitmask of account flags set by the issuer (AUTH_REQUIRED, AUTH_REVOCABLE, etc.).
     * Omitted by older Horizon snapshots — treat as 0 when absent.
     */
    flags?: {
        auth_required?: boolean;
        auth_revocable?: boolean;
        auth_immutable?: boolean;
        auth_clawback_enabled?: boolean;
    };
}
export interface HorizonErrorResponse {
    type?: string;
    title?: string;
    status?: number;
    detail?: string;
}
export declare class HorizonError extends Error {
    readonly statusCode: number;
    readonly retryable: boolean;
    constructor(message: string, statusCode: number, retryable?: boolean);
}
export declare class HorizonRateLimitError extends HorizonError {
    readonly retryAfterMs?: number | undefined;
    constructor(message: string, retryAfterMs?: number | undefined);
}
export declare class HorizonTlsError extends HorizonError {
    readonly originalCode?: string | undefined;
    constructor(message: string, originalCode?: string | undefined);
}
/**
 * Thrown when the Horizon TLS certificate fingerprint does not match the
 * configured `horizon_pin_fingerprint` value (Issue #303).
 */
export declare class HorizonPinMismatchError extends HorizonError {
    readonly expectedFingerprint: string;
    readonly actualFingerprint: string;
    constructor(message: string, expectedFingerprint: string, actualFingerprint: string);
}
/**
 * Thrown when a Horizon request was short-circuited by the circuit breaker
 * (Issue #209) and surfaced for comment rendering (Issue #434).
 *
 * Distinct from a plain `HorizonError` because the failure says nothing about
 * the account: no request reached the network, so the account was never
 * checked. The sticky comment renders a dedicated "circuit breaker open"
 * banner for this case so a resilience safeguard is not mistaken for an
 * account-level failure.
 *
 * Extends `HorizonError` so existing `instanceof HorizonError` handling keeps
 * working unchanged.
 */
export declare class HorizonCircuitOpenError extends HorizonError {
    constructor(message: string);
}
/** Is this error a circuit-breaker fast-fail (Issue #434)? */
export declare function isCircuitOpenError(error: unknown): error is HorizonCircuitOpenError;
/**
 * Verify the TLS certificate fingerprint of a Horizon endpoint against an
 * expected SHA-256 fingerprint (Issue #303).
 *
 * @param horizonUrl - The Horizon URL to check (must be https:)
 * @param expectedFingerprint - SHA-256 fingerprint in colon-separated uppercase hex (e.g. 'AA:BB:...').
 *   Pass an empty string to skip the pin check and rely on standard WebPKI validation.
 * @throws {HorizonPinMismatchError} When the actual fingerprint does not match `expectedFingerprint`.
 * @throws {HorizonTlsError} When the TLS connection or certificate retrieval fails.
 */
export declare function checkCertificatePin(horizonUrl: string, expectedFingerprint: string): Promise<void>;
export type FetchLike = (url: string | import('node-fetch').Request, init?: import('node-fetch').RequestInit) => Promise<import('node-fetch').Response>;
export interface FetchAccountOptions {
    timeoutMs?: number;
    maxRetries?: number;
    horizonUrlFallback?: string;
    fallbackUrls?: string[];
    useCache?: boolean;
    cacheTtlMs?: number;
    cache?: SimpleCache;
    fetchFn?: FetchLike;
    /**
     * Optional AbortSignal from a parent controller (e.g. job cancellation).
     * When the signal fires, in-flight and pending requests are aborted
     * immediately; no misleading "account not funded" result is produced.
     */
    signal?: AbortSignal;
    /**
     * Base delay for exponential backoff (`retry_base_delay_ms`). The n-th
     * retry waits `retryBaseDelayMs * 2^n`, capped at `retryMaxDelayMs`.
     */
    retryBaseDelayMs?: number;
    /**
     * Hard cap on any single retry sleep (`retry_max_delay_ms`), applied to
     * both `Retry-After` values and exponential backoff. 0 disables sleeping
     * between retries while still honoring `maxRetries`.
     */
    retryMaxDelayMs?: number;
    /**
     * Cumulative sleep budget across all retries of one endpoint
     * (`retry_max_total_wait_ms`). When the next sleep would exceed it the
     * retry loop aborts with a `HorizonRateLimitError` (429) or the last
     * transport error instead of sleeping.
     */
    retryMaxTotalWaitMs?: number;
    /** Per-run Horizon request budget (`horizon_max_requests`). */
    horizonMaxRequests?: number;
    rateBudgetTracker?: RateBudgetTracker;
    /** Optional circuit breaker for Horizon fetches (Issue #209). */
    circuitBreaker?: CircuitBreaker;
    /**
     * Opt into a fallback URL on a different Stellar network than the primary
     * `horizon_url`. Off by default: a G-address is valid on every network, so
     * a cross-network fallback could silently report data from the wrong ledger.
     */
    allowCrossNetworkFallback?: boolean;
    /** Alias for `allowCrossNetworkFallback` kept for older call sites / tests. */
    allowCrossNetworkFailover?: boolean;
    /** Optional secondary Horizon URL used for same-network failover. */
    secondaryHorizonUrl?: string;
    /** Optional SHA-256 TLS certificate fingerprint pin (Issue #303). */
    pinFingerprint?: string;
}
export declare const DEFAULT_RETRY_MAX_DELAY_MS = 30000;
export declare const DEFAULT_RETRY_MAX_TOTAL_WAIT_MS = 120000;
export declare function normalizeHorizonUrl(baseUrl: string): string;
/**
 * Produce a representation of a configured Horizon URL that is safe to
 * post in a public-facing GitHub issue comment. A private Horizon mirror's
 * hostname can itself be sensitive internal infrastructure information, so
 * by default only the URL scheme is shown. Pass `revealHost: true` (wired
 * to the `debug_mode` input) to show the full host — still routed through
 * `redactHorizonUrl` so any embedded account address stays masked.
 */
export declare function displayHorizonUrl(url: string, revealHost: boolean): string;
export declare function isRetryableStatus(status: number): boolean;
export declare function parseRetryAfterMs(response: import('node-fetch').Response): number | null;
export declare function fetchAccount(horizonUrl: string, stellarAddress: string, options?: FetchAccountOptions): Promise<HorizonAccount>;
/**
 * Fetch the asset issuer account for the SEP-0001 home domain check (Issue
 * #708). Returns `null` when the issuer is not a classic G-address (Soroban
 * contract issuers have no `home_domain`) or when Horizon can't return it,
 * so the check reports "missing" instead of failing the whole run.
 */
export declare function fetchHomeDomainIssuerAccount(horizonUrl: string, assetIssuer: string, options?: FetchAccountOptions): Promise<HorizonAccount | null>;
export interface WaitForFundedAccountOptions {
    /** Total time budget to keep polling before giving up, in milliseconds. */
    timeoutMs?: number;
    /** Delay between polling attempts, in milliseconds. */
    pollIntervalMs?: number;
    /** Per-request timeout passed through to each `fetchAccount` call. */
    requestTimeoutMs?: number;
    /** Per-request retry count passed through to each `fetchAccount` call. */
    maxRetries?: number;
    /** Called after each unfunded (404) poll, before sleeping for the next attempt. */
    onPoll?: (attempt: number, elapsedMs: number) => void;
    /** Optional AbortSignal from a parent controller (e.g. job cancellation).
     *  When the signal fires, polling stops immediately without emitting a
     *  misleading "account not funded" result. */
    signal?: AbortSignal;
}
/**
 * Poll Horizon for an account until it becomes funded or the timeout budget
 * is exhausted. Only Horizon 404 ("not found") responses are treated as
 * "not yet funded" and trigger another poll — any other error (rate limit
 * exhaustion, Horizon outage, network failure) is rethrown immediately so
 * outages don't turn into a silent multi-minute hang.
 */
export declare function waitForFundedAccount(horizonUrl: string, stellarAddress: string, options?: WaitForFundedAccountOptions, fetchAccountFn?: typeof fetchAccount): Promise<HorizonAccount>;
/**
 * Narrows to a credit trustline balance (`credit_alphanum4` /
 * `credit_alphanum12`) only. Checks the asset_type allowlist explicitly
 * rather than `!== 'native'` — liquidity-pool-share balances
 * (`asset_type: "liquidity_pool_shares"`) carry no `asset_code`/
 * `asset_issuer` and must never be misclassified as a credit trustline,
 * since that would let a same-shaped LP entry slip through a naive
 * trustline match.
 */
export declare function isCreditBalance(balance: HorizonBalance): balance is HorizonBalanceCredit;
export declare function getNativeBalance(account: HorizonAccount): string;
export declare function hasTrustline(account: HorizonAccount, assetCode: string, assetIssuer: string): boolean;
/**
 * Locate the credit trustline balance entry for a specific asset so callers
 * can inspect per-trustline flags such as `is_authorized` and
 * `is_clawback_enabled`.
 */
export declare function findTrustlineBalance(account: HorizonAccount, assetCode: string, assetIssuer: string): HorizonBalanceCredit | undefined;
/**
 * A trustline is considered authorized unless the issuer has explicitly
 * marked it unauthorized (`is_authorized === false`). Horizon omits this
 * field entirely when the issuer's AUTHORIZATION_REQUIRED flag is not set,
 * so "field absent" must be treated as authorized, not as unknown.
 */
export declare function isTrustlineAuthorized(balance: HorizonBalanceCredit): boolean;
/**
 * Get the balance string for a specific credit asset trustline, or `'0'`
 * when the trustline is absent.
 */
export declare function getAssetBalance(account: HorizonAccount, assetCode: string, assetIssuer: string): string;
/**
 * Get the trustline limit for a specific asset, if it exists.
 * Returns the limit as a string (as provided by Horizon) or '0' if not found.
 */
export declare function getTrustlineLimit(account: HorizonAccount, assetCode: string, assetIssuer: string): string;
export declare function parseHorizonBalance(balance: string): number;
/**
 * Format a stroop amount (1 XLM = 10^7 stroops) as a fixed 7-decimal XLM string.
 */
export declare function formatStroops(stroops: bigint): string;
export interface HorizonFetchOptions {
    maxRetries?: number;
    retryBaseDelayMs?: number;
}
/**
 * Fetch the number of claimable balances for a claimant address.
 *
 * Used only when `claimableBalancePolicy === 'count'` and the account is 404.
 * Returns 0 on any error (404, network, timeout) so callers can treat the
 * absence as "no evidence" without failing the run. The request is bounded to
 * 5s and validated for SSRF so private Horizon mirrors are never probed
 * with an attacker-controlled claimant.
 *
 * Horizon endpoint: `GET /claimable_balances?claimant=<G-address>&limit=5`
 * The limit is intentionally small — we only need to know if >0 exist and
 * at most a count up to 5 for the informational comment.
 */
export declare function fetchClaimableBalanceCount(horizonUrl: string, stellarAddress: string, fetchFn?: FetchLike, timeoutMs?: number): Promise<number>;
/**
 * Labels automatically applied to a GitHub issue based on the Stellar
 * wallet state discovered during an account check.
 *
 * - `wallet: funded`           — account exists and XLM balance ≥ reserve.
 * - `wallet: unfunded`         — Horizon returned 404 (account not yet created).
 * - `wallet: trustline-missing`— account funded but missing the required trustline.
 * - `wallet: reserve-low`      — account funded + trustline present but XLM reserve not met.
 * - `wallet: horizon-error`    — Horizon returned a non-404 error; state unknown.
 */
export type WalletLabel = 'wallet: funded' | 'wallet: unfunded' | 'wallet: trustline-missing' | 'wallet: reserve-low' | 'wallet: horizon-error';
/**
 * All wallet label strings — useful for bulk removal before re-applying
 * the current state so stale labels never linger on an issue.
 */
export declare const ALL_WALLET_LABELS: WalletLabel[];
export interface WalletLabelInput {
    /** Whether Horizon returned an active account (HTTP 200). */
    accountFunded: boolean;
    /** Whether the required asset trustline exists on the account. */
    trustlineExists: boolean;
    /** Whether the native XLM balance meets the configured minimum. */
    xlmReserveMet: boolean;
    /** Whether a Horizon error (non-404) occurred during the check. */
    horizonError?: boolean;
}
/**
 * Derive the single wallet label that best describes the current account
 * state. Priority order:
 *
 * 1. `wallet: horizon-error`    — any Horizon error takes precedence.
 * 2. `wallet: unfunded`         — account not found (404).
 * 3. `wallet: trustline-missing`— funded but trustline absent.
 * 4. `wallet: reserve-low`      — funded + trustline but XLM below reserve.
 * 5. `wallet: funded`           — all checks passed.
 */
export declare function deriveWalletLabel(input: WalletLabelInput): WalletLabel;
/**
 * Options for `applyWalletLabels`.
 */
export interface ApplyWalletLabelsOptions {
    /**
     * Remove all other wallet labels before applying the new one.
     * Default: `true`. Set to `false` to only add (never remove) labels.
     */
    removeStale?: boolean;
}
/**
 * Apply the appropriate wallet label to a GitHub issue via Octokit,
 * optionally removing stale wallet labels first.
 *
 * Conflict resolution: when multiple wallet state labels are present
 * (e.g. from a previous interrupted run), all stale labels are removed
 * before the new one is applied. The target label is derived
 * deterministically by `deriveWalletLabel` using a fixed priority order
 * (horizon-error > unfunded > trustline-missing > reserve-low > funded),
 * so concurrent runs always converge to the same label.
 *
 * Pagination: `listLabelsOnIssue` is paginated in 100-item pages so
 * issues with more than 100 labels are handled correctly.
 *
 * Errors are non-fatal: label failures are caught and returned as a
 * descriptive string so the main check result is never blocked by a
 * labelling permission issue.
 *
 * @param octokit       Authenticated Octokit instance.
 * @param owner         Repository owner.
 * @param repo          Repository name.
 * @param issueNumber   Issue to label.
 * @param input         Wallet state derived from the Horizon check.
 * @param options       Labelling behaviour options.
 * @returns             The label that was applied, or an error string.
 */
export declare function applyWalletLabels(octokit: {
    rest: {
        issues: {
            addLabels: (params: {
                owner: string;
                repo: string;
                issue_number: number;
                labels: string[];
            }) => Promise<unknown>;
            removeLabel: (params: {
                owner: string;
                repo: string;
                issue_number: number;
                name: string;
            }) => Promise<unknown>;
            listLabelsOnIssue: (params: {
                owner: string;
                repo: string;
                issue_number: number;
                per_page: number;
                page: number;
            }) => Promise<{
                data: Array<{
                    name: string;
                }>;
            }>;
        };
    };
}, owner: string, repo: string, issueNumber: number, input: WalletLabelInput, options?: ApplyWalletLabelsOptions): Promise<{
    applied: WalletLabel;
    removed: string[];
    error?: string;
}>;
export interface ReadyLabelInput {
    ready: boolean;
    passLabel?: string;
    failLabel?: string;
}
export declare function applyReadyLabels(octokit: {
    rest: {
        issues: {
            addLabels: (params: {
                owner: string;
                repo: string;
                issue_number: number;
                labels: string[];
            }) => Promise<unknown>;
            removeLabel: (params: {
                owner: string;
                repo: string;
                issue_number: number;
                name: string;
            }) => Promise<unknown>;
            listLabelsOnIssue: (params: {
                owner: string;
                repo: string;
                issue_number: number;
                per_page: number;
            }) => Promise<{
                data: Array<{
                    name: string;
                }>;
            }>;
        };
    };
}, owner: string, repo: string, issueNumber: number, input: ReadyLabelInput): Promise<{
    applied?: string;
    removed: string[];
    error?: string;
}>;
/**
 * Fetch the Stellar network passphrase from a Horizon root endpoint.
 */
export declare function fetchNetworkPassphrase(horizonUrl: string, options?: FetchAccountOptions): Promise<string>;
export interface FriendbotOptions {
    /** Friendbot URL. Must be HTTPS and on the allowlist. */
    friendbotUrl: string;
    /** Request timeout in milliseconds. */
    timeoutMs?: number;
    /** Override fetch function (for testing). */
    fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
}
/**
 * Check if a friendbot URL is on the allowlist and safe to use.
 * Prevents SSRF attacks by only allowing known testnet friendbot endpoints.
 */
export declare function isFriendbotAllowed(friendbotUrl: string): boolean;
/**
 * Detect whether a Horizon URL points to testnet or mainnet.
 * Used to enforce friendbot safety rules (never call friendbot on mainnet).
 */
export declare function isTestnetHorizon(horizonUrl: string): boolean;
export interface FriendbotResult {
    success: boolean;
    message: string;
    transactionHash?: string;
}
/**
 * Call Stellar Friendbot to fund a testnet account.
 *
 * Safety rules:
 * - Only works with allowlisted friendbot URLs (SSRF protection)
 * - Only callable when Horizon URL indicates testnet
 * - Fails fast with clear error on mainnet or unknown networks
 *
 * @param stellarAddress The G-address to fund
 * @param options Friendbot configuration
 * @param horizonUrl The Horizon URL (used for network safety check)
 * @returns FriendbotResult with success status and transaction details
 */
export declare function callFriendbot(stellarAddress: string, options: FriendbotOptions, horizonUrl: string): Promise<FriendbotResult>;
