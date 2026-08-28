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
    horizonMaxRequests?: number;
    retryBaseDelayMs?: number;
    retryMaxDelayMs?: number;
    retryMaxTotalWaitMs?: number;
    rateBudgetTracker?: RateBudgetTracker;
    /**
     * Optional circuit breaker for Horizon fetches (Issue #209).
     * When the circuit is open, requests are fast-failed without reaching
     * the network. Cache hits bypass the circuit breaker.
     */
    circuitBreaker?: CircuitBreaker;
    /**
     * By default, a fallback URL that resolves to a *different* Stellar
     * network than the primary `horizon_url` (public vs testnet, inferred
     * from the URL) is never used — a G-address is valid on every network,
     * so a cross-network fallback can silently return funded/trustline/
     * reserve data for the wrong ledger instead of failing loudly. Set this
     * to `true` to opt into cross-network fallback anyway (e.g. deliberate
     * multi-network setups).
     */
    allowCrossNetworkFallback?: boolean;
    /**
     * Alias for `allowCrossNetworkFallback` kept for older call sites / tests.
     * Prefer `allowCrossNetworkFallback`.
     */
    allowCrossNetworkFailover?: boolean;
    /** Optional secondary Horizon URL used for same-network failover. */
    secondaryHorizonUrl?: string;
}
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
/**
 * Fetch the Stellar network passphrase from a Horizon root endpoint.
 */
export declare function fetchNetworkPassphrase(horizonUrl: string, options?: FetchAccountOptions): Promise<string>;
