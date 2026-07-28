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

export function inferStellarNetwork(horizonUrl: string): StellarNetwork {
  return horizonUrl.toLowerCase().includes('testnet') ? 'testnet' : 'public';
}

export function buildAccountViewerLink(stellarAddress: string, network: StellarNetwork): string {
  const params = new URLSearchParams({ network, account: stellarAddress });
  return `https://laboratory.stellar.org/#account-viewer?${params.toString()}`;
}

export function buildChangeTrustLink(network: StellarNetwork): string {
  const params = new URLSearchParams({ network });
  return `https://laboratory.stellar.org/#txbuilder?${params.toString()}`;
}

export function buildLobstrLink(): string {
  return 'https://lobstr.co/';
}

// ---------------------------------------------------------------------------
// SEP-0007 deep-link helpers
// ---------------------------------------------------------------------------

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
export function buildSep0007TxLink(options: Sep0007TxOptions): string {
  const network = options.network ?? 'public';
  const passphrase =
    options.networkPassphrase ??
    (network === 'testnet'
      ? 'Test SDF Network ; September 2015'
      : 'Public Global Stellar Network ; September 2015');

  const params = new URLSearchParams({ xdr: options.xdr });

  params.set('network_passphrase', passphrase);

  if (options.msg) {
    params.set('msg', options.msg);
  }
  if (options.callback) {
    params.set('callback', options.callback);
  }
  if (options.originDomain) {
    params.set('origin_domain', options.originDomain);
  }

  return `web+stellar:tx?${params.toString()}`;
}

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
export function buildSep0007PayLink(options: Sep0007PayOptions): string {
  const network = options.network ?? 'public';
  const passphrase =
    options.networkPassphrase ??
    (network === 'testnet'
      ? 'Test SDF Network ; September 2015'
      : 'Public Global Stellar Network ; September 2015');

  const params = new URLSearchParams({ destination: options.destination });

  params.set('network_passphrase', passphrase);

  if (options.amount) {
    params.set('amount', options.amount);
  }
  if (options.assetCode) {
    params.set('asset_code', options.assetCode);
    if (options.assetIssuer) {
      params.set('asset_issuer', options.assetIssuer);
    }
  }
  if (options.memo) {
    params.set('memo', options.memo);
    params.set('memo_type', options.memoType ?? 'text');
  }
  if (options.msg) {
    params.set('msg', options.msg);
  }
  if (options.originDomain) {
    params.set('origin_domain', options.originDomain);
  }

  return `web+stellar:pay?${params.toString()}`;
}
