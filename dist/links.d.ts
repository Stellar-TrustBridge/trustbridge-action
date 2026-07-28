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
 */
export type StellarNetwork = 'public' | 'testnet';
export declare function inferStellarNetwork(horizonUrl: string): StellarNetwork;
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
