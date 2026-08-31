/**
 * Stellar Laboratory and wallet deep-link helpers.
 *
 * ## SEP-0007 wallet deep links
 *
 * SEP-0007 defines a URI scheme (`web+stellar:`) that allows web pages and
 * CI workflows to deep-link into compatible wallets (LOBSTR, Solar, Albedo,
 * etc.) with a pre-built transaction or operation payload.
 *
 * TrustBridge uses SEP-0007 `tx` URIs so that contributors can open a
 * one-click "add trustline" link directly from the issue comment, without
 * having to manually construct a Change Trust operation in Stellar Lab.
 *
 * Reference: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md
 *
 * ## FAQ anchor deep links (Issue #104)
 *
 * Each failing check maps to a specific anchor in `docs/FAQ.md` so
 * contributors land on the exact fix rather than a generic docs page.
 * Use `buildFaqLink` to generate a durable link from a check name,
 * or `getFaqAnchorForCheck` to resolve the anchor directly.
 *
 * The base URL defaults to this repository's `docs/FAQ.md` but can be
 * overridden with the `docs_base_url` action input for forks or mirrors.
 * Invalid overrides fall back to the default silently so comment posting
 * is never blocked by a bad URL input.
 */
/**
 * The default base URL for the TrustBridge FAQ document.
 * All anchor fragments are appended to this URL.
 */
export declare const DEFAULT_FAQ_BASE_URL = "https://github.com/Stellar-TrustBridge/trustbridge-action/blob/main/docs/FAQ.md";
/**
 * Stable FAQ anchor names. Each corresponds to a heading in `docs/FAQ.md`
 * with an explicit `{#anchor-name}` fragment.
 *
 * Keep this enum in sync with the headings in `docs/FAQ.md`. The CI test
 * `__tests__/faq-anchors.test.ts` verifies every anchor name resolves to
 * a heading in the doc.
 */
export declare const FAQ_ANCHORS: {
    readonly ACCOUNT_NOT_FUNDED: "account-not-funded";
    readonly TRUSTLINE_MISSING: "trustline-missing";
    readonly XLM_RESERVE_TOO_LOW: "xlm-reserve-too-low";
    readonly TESTING_ON_TESTNET: "testing-on-testnet";
    readonly HORIZON_ERROR: "horizon-error";
    readonly DEBUG_MODE: "debug-mode";
    readonly WEBHOOK_NOT_RECEIVED: "webhook-not-received";
};
export type FaqAnchor = (typeof FAQ_ANCHORS)[keyof typeof FAQ_ANCHORS];
/**
 * Resolve the FAQ anchor most relevant to a check label.
 *
 * Returns `undefined` when no mapping is found so callers can omit the
 * FAQ link gracefully.
 *
 * @param checkLabel  The human-readable check label from the `ValidationResult`.
 */
export declare function getFaqAnchorForCheck(checkLabel: string): FaqAnchor | undefined;
/**
 * Build a full FAQ deep link URL for a given anchor.
 *
 * @param anchor   A value from `FAQ_ANCHORS`.
 * @param baseUrl  Optional override for the FAQ base URL (e.g. a fork's
 *                 mirror). When the value is not a valid HTTPS URL, the
 *                 default base URL is used silently so comment posting is
 *                 never blocked by an invalid override.
 */
export declare function buildFaqLink(anchor: FaqAnchor, baseUrl?: string): string;
/**
 * Build a FAQ deep link for a check label, resolving the anchor automatically.
 *
 * Returns `undefined` when no FAQ anchor is mapped for the given label, so
 * callers can skip rendering the link.
 *
 * @param checkLabel  The human-readable check label from the ValidationResult.
 * @param baseUrl     Optional FAQ base URL override.
 */
export declare function buildFaqLinkForCheck(checkLabel: string, baseUrl?: string): string | undefined;
export type StellarNetwork = 'public' | 'testnet';
export declare function inferStellarNetwork(horizonUrl: string): StellarNetwork;
/**
 * Known Horizon presets and the network they belong to. Used by cross-network
 * detection to identify which network an address was most recently active on.
 */
export declare const KNOWN_HORIZON_NETWORKS: Record<string, StellarNetwork>;
/**
 * Returns the "opposite" Stellar network (for cross-network mismatch error
 * messages that suggest switching to the correct Horizon URL).
 */
export declare function oppositeNetwork(network: StellarNetwork): StellarNetwork;
/**
 * Returns the canonical Horizon base URL for a given network.
 * Useful when suggesting "switch to the correct Horizon" in error messages.
 */
export declare function canonicalHorizonUrl(network: StellarNetwork): string;
export declare function buildAccountViewerLink(stellarAddress: string, network: StellarNetwork): string;
export declare function buildChangeTrustLink(network: StellarNetwork): string;
export declare function buildLobstrLink(): string;
/**
 * Options for building a SEP-0007 `tx` deep link.
 */
export interface Sep0007TxOptions {
    /**
     * Base64-encoded, signed or unsigned XDR `TransactionEnvelope`.
     * When the transaction is unsigned, compatible wallets will sign it before
     * submitting. Pass an unsigned envelope here so TrustBridge never holds a
     * signing key.
     */
    xdr: string;
    /** Optional callback URL the wallet should POST the signed XDR to. */
    callback?: string;
    /** Optional human-readable description shown in the wallet UI. */
    msg?: string;
    /** `public` or `testnet`. Defaults to `public`. */
    network?: StellarNetwork;
    /**
     * Optional network passphrase override. When omitted, the standard
     * passphrase for `network` is used. Set this for custom/private networks.
     */
    networkPassphrase?: string;
    /** Optional origin domain for wallet validation (SEP-0007 §3.4). */
    originDomain?: string;
}
/**
 * Build a SEP-0007 `tx` deep link.
 *
 * The returned URI (`web+stellar:tx?...`) can be used as an `href` in
 * Markdown or HTML so contributors can open it in a SEP-0007-compatible
 * wallet (LOBSTR, Solar, Albedo, etc.) with the transaction pre-loaded.
 *
 * @example
 * ```ts
 * const uri = buildSep0007TxLink({
 *   xdr: 'AAAAAQ...',          // base64 XDR
 *   msg: 'Add USDC trustline',
 *   network: 'public',
 * });
 * // => "web+stellar:tx?xdr=AAAAAQ...&msg=Add+USDC+trustline&network_passphrase=Public+Global+..."
 * ```
 */
export declare function buildSep0007TxLink(options: Sep0007TxOptions): string;
/**
 * Options for building a SEP-0007 `pay` deep link.
 */
export interface Sep0007PayOptions {
    /** Destination Stellar G-address. */
    destination: string;
    /** Optional payment amount (string to avoid floating-point issues). */
    amount?: string;
    /** Optional asset code (omit for native XLM). */
    assetCode?: string;
    /** Optional asset issuer (required when `assetCode` is non-native). */
    assetIssuer?: string;
    /** Optional human-readable memo. */
    memo?: string;
    /** Memo type: `text` | `id` | `hash` | `return`. Defaults to `text`. */
    memoType?: 'text' | 'id' | 'hash' | 'return';
    /** Optional human-readable description shown in the wallet UI. */
    msg?: string;
    /** `public` or `testnet`. Defaults to `public`. */
    network?: StellarNetwork;
    /** Optional network passphrase override. */
    networkPassphrase?: string;
    /** Optional origin domain for wallet validation (SEP-0007 §3.4). */
    originDomain?: string;
}
/**
 * Build a SEP-0007 `pay` deep link.
 *
 * Suitable for linking a contributor to a pre-filled payment screen (e.g.
 * "send 1 XLM to activate your account") inside the TrustBridge issue
 * comment.
 *
 * @example
 * ```ts
 * const uri = buildSep0007PayLink({
 *   destination: 'GABC...XYZ',
 *   amount: '1',
 *   msg: 'Activate Stellar account',
 * });
 * // => "web+stellar:pay?destination=GABC...&amount=1&msg=Activate+..."
 * ```
 */
export declare function buildSep0007PayLink(options: Sep0007PayOptions): string;
/**
 * Options for building a SEP-0010 challenge verification snippet.
 *
 * SEP-0010 defines a challenge transaction that a wallet signs to prove
 * control of a Stellar account. TrustBridge does not verify the signature
 * inside the action — that is out of scope — but it can surface an
 * optional challenge snippet or dashboard Freighter proof link in the
 * remediation comment so reviewers know the contributor proved wallet control.
 *
 * Prefer `dashboardUrl` (link to a dashboard where Freighter signage is
 * verified) over raw `challengeXdr` to avoid leaking nonces in public issues.
 * When a raw challenge XDR is supplied it is truncated in logs and should
 * not be reused.
 */
export interface Sep0010ChallengeOptions {
    /** Base64 XDR of the SEP-0010 challenge transaction (optional). */
    challengeXdr?: string;
    /** Dashboard URL where Freighter proof can be verified (optional, preferred). */
    dashboardUrl?: string;
    /** Stellar network for context (affects messaging). Defaults to public. */
    network?: StellarNetwork;
    /** Stellar G-address being verified (for link text). */
    stellarAddress?: string;
}
/**
 * Validate a dashboard URL for SEP-0010 proof links. Must be https, no SSRF
 * private targets, no credentials.
 */
export declare function isValidDashboardUrl(url: string): boolean;
/**
 * Build a markdown snippet for SEP-0010 proof of wallet control.
 *
 * Returns `undefined` when neither `challengeXdr` nor `dashboardUrl` is
 * provided. When both are provided, the dashboard link is preferred and the
 * XDR is not rendered (to avoid nonce leakage). The snippet is safe for
 * public issue comments — XDR is truncated to first 24 chars … last 8.
 *
 * Does NOT affect `valid`/`ready` unless the caller explicitly gates on it;
 * this is informational remediation only.
 */
export declare function buildSep0010ChallengeSnippet(options: Sep0010ChallengeOptions): string | undefined;
