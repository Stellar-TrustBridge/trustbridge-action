import { assertValidAssetCode, assertValidAssetIssuer, normalizeAssetCode } from './assets';

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

// ---------------------------------------------------------------------------
// FAQ anchor deep links (Issue #104)
// ---------------------------------------------------------------------------

/**
 * The default base URL for the TrustBridge FAQ document.
 * All anchor fragments are appended to this URL.
 */
export const DEFAULT_FAQ_BASE_URL =
  'https://github.com/Stellar-TrustBridge/trustbridge-action/blob/main/docs/FAQ.md';

/**
 * Stable FAQ anchor names. Each corresponds to a heading in `docs/FAQ.md`
 * with an explicit `{#anchor-name}` fragment.
 *
 * Keep this enum in sync with the headings in `docs/FAQ.md`. The CI test
 * `__tests__/faq-anchors.test.ts` verifies every anchor name resolves to
 * a heading in the doc.
 */
export const FAQ_ANCHORS = {
  ACCOUNT_NOT_FUNDED: 'account-not-funded',
  TRUSTLINE_MISSING: 'trustline-missing',
  XLM_RESERVE_TOO_LOW: 'xlm-reserve-too-low',
  TESTING_ON_TESTNET: 'testing-on-testnet',
  HORIZON_ERROR: 'horizon-error',
  DEBUG_MODE: 'debug-mode',
  WEBHOOK_NOT_RECEIVED: 'webhook-not-received',
  CLAIMABLE_BALANCE: 'claimable-balance',
  UNAUTHORIZED_TRUSTLINE: 'unauthorized-trustline',
} as const;

export type FaqAnchor = (typeof FAQ_ANCHORS)[keyof typeof FAQ_ANCHORS];

/**
 * Map from check label keywords to FAQ anchor names.
 * Matching is case-insensitive on the label.
 */
const CHECK_TO_ANCHOR_MAP: Array<{ keyword: string; anchor: FaqAnchor }> = [
  { keyword: 'funded', anchor: FAQ_ANCHORS.ACCOUNT_NOT_FUNDED },
  // 'unauthorized' must come before 'trustline' so the more specific match wins
  { keyword: 'unauthorized', anchor: FAQ_ANCHORS.UNAUTHORIZED_TRUSTLINE },
  { keyword: 'trustline', anchor: FAQ_ANCHORS.TRUSTLINE_MISSING },
  { keyword: 'reserve', anchor: FAQ_ANCHORS.XLM_RESERVE_TOO_LOW },
  { keyword: 'xlm', anchor: FAQ_ANCHORS.XLM_RESERVE_TOO_LOW },
  { keyword: 'horizon', anchor: FAQ_ANCHORS.HORIZON_ERROR },
  { keyword: 'claimable', anchor: FAQ_ANCHORS.CLAIMABLE_BALANCE },
];

/**
 * Resolve the FAQ anchor most relevant to a check label.
 *
 * Returns `undefined` when no mapping is found so callers can omit the
 * FAQ link gracefully.
 *
 * @param checkLabel  The human-readable check label from the `ValidationResult`.
 */
export function getFaqAnchorForCheck(checkLabel: string): FaqAnchor | undefined {
  const lower = checkLabel.toLowerCase();
  for (const { keyword, anchor } of CHECK_TO_ANCHOR_MAP) {
    if (lower.includes(keyword)) {
      return anchor;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Link safety (Issue #853) — shared guard for every URL this module renders
// as a clickable Markdown link.
// ---------------------------------------------------------------------------

/**
 * Hosts rejected for any externally-rendered link regardless of scheme:
 * private/loopback/link-local address ranges and cloud metadata endpoints.
 * Mirrors the SSRF blocklist already enforced for live Horizon requests —
 * a link a human clicks should not be able to target internal
 * infrastructure any more than a request this Action makes itself.
 */
const BLOCKED_LINK_HOSTS: RegExp[] = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\.0\.0\.0$/,
  /^localhost$/i,
  /^\[?::1\]?$/,
];

const BLOCKED_LINK_EXACT_HOSTS = new Set(['metadata.google.internal']);

/**
 * Validate that `url` is safe to render as a clickable link in a GitHub
 * comment (Issue #853): deep links into Horizon explorers, docs mirrors,
 * dashboards, and wallet callbacks all funnel through this check before
 * being embedded in Markdown.
 *
 * Rejects:
 * - anything that does not parse as an absolute URL
 * - any scheme other than `https:` — `javascript:`, `data:`, `vbscript:`,
 *   plain `http:`, and bare/relative strings are all rejected outright, so
 *   a crafted value can never execute script or escape to a local file
 * - embedded credentials (`https://user:pass@host/...`)
 * - private, loopback, link-local, or cloud-metadata hosts (open-redirect-
 *   to-internal-service guard, same list as the Horizon SSRF policy)
 *
 * This check only validates the URL as a whole; it does not percent-encode
 * anything. Callers that interpolate dynamic path or query segments must
 * still build them with `URLSearchParams` (as every builder in this file
 * does), because an unescaped `)` in a raw string would terminate a
 * Markdown `[text](url)` link early and let the rest of the string inject
 * arbitrary Markdown.
 */
export function isSafeExternalLink(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_LINK_EXACT_HOSTS.has(host)) return false;
  for (const pattern of BLOCKED_LINK_HOSTS) {
    if (pattern.test(host)) return false;
  }
  // Issue #853: every caller in this codebase embeds the URL this check
  // approves directly as raw `[text](url)` Markdown (buildFaqLink, the
  // SEP-0010 dashboard proof link, buildAssetChecklist's `deepLink`). An
  // unescaped `)` ends that link early and lets the remainder of the
  // string inject arbitrary Markdown; raw whitespace, backticks, angle
  // brackets, and quotes are rejected too since a well-formed URL never
  // needs them unencoded — a legitimate URL that needs one of these
  // characters should percent-encode it (`)` -> `%29`, etc).
  if (/[()\s`<>"']/.test(url)) return false;
  return true;
}

/**
 * Build a full FAQ deep link URL for a given anchor.
 *
 * @param anchor   A value from `FAQ_ANCHORS`.
 * @param baseUrl  Optional override for the FAQ base URL (e.g. a fork's
 *                 mirror). When the value fails {@link isSafeExternalLink}
 *                 (wrong scheme, credentials, private/metadata host, or
 *                 simply not a valid URL), the default base URL is used
 *                 silently so comment posting is never blocked by an
 *                 invalid or malicious override.
 */
export function buildFaqLink(anchor: FaqAnchor, baseUrl?: string): string {
  let base = DEFAULT_FAQ_BASE_URL;
  if (baseUrl && isSafeExternalLink(baseUrl)) {
    base = baseUrl.replace(/\/$/, '');
  }
  return `${base}#${anchor}`;
}

/**
 * Build a FAQ deep link for a check label, resolving the anchor automatically.
 *
 * Returns `undefined` when no FAQ anchor is mapped for the given label, so
 * callers can skip rendering the link.
 *
 * @param checkLabel  The human-readable check label from the ValidationResult.
 * @param baseUrl     Optional FAQ base URL override.
 */
export function buildFaqLinkForCheck(
  checkLabel: string,
  baseUrl?: string,
): string | undefined {
  const anchor = getFaqAnchorForCheck(checkLabel);
  if (!anchor) return undefined;
  return buildFaqLink(anchor, baseUrl);
}

export type StellarNetwork = 'public' | 'testnet';

export function inferStellarNetwork(horizonUrl: string): StellarNetwork {
  const lower = horizonUrl.toLowerCase();
  // 'testnet' substring covers Horizon URLs; the standalone word 'test'
  // covers network passphrases ('Test SDF Network ; ...') without matching
  // words like 'latest' or 'protest'.
  if (lower.includes('testnet') || /\btest\b/.test(lower)) return 'testnet';
  return 'public';
}

/**
 * Official Stellar network presets (Issue #707). `StellarNetwork` stays
 * `public | testnet` for link builders; this wider union adds futurenet so
 * passphrase inference and failover network binding can tell it apart.
 */
export type StellarNetworkPreset = StellarNetwork | 'futurenet';

export interface StellarNetworkPresetDefaults {
  /** Official SDF Horizon base URL. */
  horizonUrl: string;
  /** Network passphrase reported by that Horizon's root endpoint. */
  networkPassphrase: string;
  /** Official Friendbot URL, or null when the network has no Friendbot. */
  friendbotUrl: string | null;
}

/**
 * Default Horizon host, passphrase and Friendbot per network. Documented in
 * docs/USAGE.md#network-presets — keep both in sync.
 */
export const STELLAR_NETWORK_PRESETS: Record<StellarNetworkPreset, StellarNetworkPresetDefaults> = {
  public: {
    horizonUrl: 'https://horizon.stellar.org',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
    friendbotUrl: null,
  },
  testnet: {
    horizonUrl: 'https://horizon-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
    friendbotUrl: 'https://friendbot.stellar.org',
  },
  futurenet: {
    horizonUrl: 'https://horizon-futurenet.stellar.org',
    networkPassphrase: 'Test SDF Future Network ; October 2022',
    friendbotUrl: 'https://friendbot-futurenet.stellar.org',
  },
};

/**
 * Like {@link inferStellarNetwork}, but recognises futurenet hosts instead of
 * folding them into `public`.
 */
export function inferStellarNetworkPreset(horizonUrl: string): StellarNetworkPreset {
  if (horizonUrl.toLowerCase().includes('futurenet')) return 'futurenet';
  return inferStellarNetwork(horizonUrl);
}

/**
 * Known Horizon presets and the network they belong to. Used by cross-network
 * detection to identify which network an address was most recently active on.
 */
export const KNOWN_HORIZON_NETWORKS: Record<string, StellarNetwork> = {
  'https://horizon.stellar.org': 'public',
  'https://horizon-testnet.stellar.org': 'testnet',
};

/**
 * Returns the "opposite" Stellar network (for cross-network mismatch error
 * messages that suggest switching to the correct Horizon URL).
 */
export function oppositeNetwork(network: StellarNetwork): StellarNetwork {
  return network === 'public' ? 'testnet' : 'public';
}

/**
 * Returns the canonical Horizon base URL for a given network.
 * Useful when suggesting "switch to the correct Horizon" in error messages.
 */
export function canonicalHorizonUrl(network: StellarNetwork): string {
  return network === 'public'
    ? 'https://horizon.stellar.org'
    : 'https://horizon-testnet.stellar.org';
}

export function buildAccountViewerLink(
  stellarAddress: string,
  network: StellarNetwork,
  dashboardUrl?: string,
): string {
  if (dashboardUrl && !isValidDashboardUrl(dashboardUrl)) {
    throw new Error('Invalid dashboard URL');
  }
  const params = new URLSearchParams({ network, account: stellarAddress });
  return `https://laboratory.stellar.org/#account-viewer?${params.toString()}`;
}

export function buildChangeTrustLink(network: StellarNetwork, dashboardUrl?: string): string {
  if (dashboardUrl && !isValidDashboardUrl(dashboardUrl)) {
    throw new Error('Invalid dashboard URL');
  }
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
  // Issue #853: `callback` is where a compatible wallet POSTs the signed
  // XDR. An unvalidated value here is a direct exfiltration vector for a
  // signed transaction, so a callback that fails isSafeExternalLink (wrong
  // scheme, credentials, or a private/metadata host) is dropped rather than
  // included — same silent fail-closed-by-omission pattern as buildFaqLink.
  if (options.callback && isSafeExternalLink(options.callback)) {
    params.set('callback', options.callback);
  }
  if (options.originDomain) {
    params.set('origin_domain', options.originDomain);
  }

  return `web+stellar:tx?${params.toString()}`;
}

function validateSep0007PayLinkOptions(options: Sep0007PayOptions): void {
  const assetCode = options.assetCode?.trim();
  const assetIssuer = options.assetIssuer?.trim();

  if (assetCode || assetIssuer) {
    if (!assetCode) {
      throw new Error('asset_code is required when asset_issuer is provided.');
    }
    if (!assetIssuer) {
      throw new Error('asset_issuer is required when assetCode is provided.');
    }
    assertValidAssetCode(assetCode);
    assertValidAssetIssuer(assetIssuer);
  }

  if (options.networkPassphrase !== undefined && !options.networkPassphrase.trim()) {
    throw new Error('network passphrase must be a non-empty string when provided.');
  }
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
  validateSep0007PayLinkOptions(options);

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
    params.set('asset_code', normalizeAssetCode(options.assetCode));
    if (options.assetIssuer) {
      params.set('asset_issuer', options.assetIssuer.trim());
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

// ---------------------------------------------------------------------------
// SEP-0010 challenge snippet helpers (Issue #252)
// ---------------------------------------------------------------------------

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
 *
 * Additionally, `dashboard.stellar.org` is explicitly rejected: it is not a
 * recognized Stellar dashboard endpoint, and SEP-0010 proofs must reference
 * either the Stellar Laboratory builders or an explicitly trusted dashboard
 * host — never a plausible-looking but unrecognized one.
 */
export function isValidDashboardUrl(url: string): boolean {
  if (!isSafeExternalLink(url)) return false;
  try {
    const parsed = new URL(url);
    // `dashboard.stellar.org` is not a recognized Stellar dashboard
    // endpoint — see the docstring above for why it is explicitly rejected
    // rather than just "not allowlisted".
    if (parsed.hostname.toLowerCase() === 'dashboard.stellar.org') return false;
    return true;
  } catch {
    return false;
  }
}

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
export function buildSep0010ChallengeSnippet(options: Sep0010ChallengeOptions): string | undefined {
  const network = options.network ?? 'public';
  const hasDashboard = !!options.dashboardUrl && options.dashboardUrl.trim().length > 0;
  const hasChallenge = !!options.challengeXdr && options.challengeXdr.trim().length > 0;

  if (!hasDashboard && !hasChallenge) {
    return undefined;
  }

  if (hasDashboard && isValidDashboardUrl(options.dashboardUrl!)) {
    const addrNote = options.stellarAddress ? ` for \`${options.stellarAddress}\`` : '';
    return (
      `**SEP-0010 wallet proof${addrNote}:** verify ownership via Freighter on the dashboard: ` +
      `[Open dashboard proof](${options.dashboardUrl}) — network **${network}**. ` +
      `_Challenge verification happens off-action; this link is informational and does not block \`ready\`._`
    );
  }

  if (hasChallenge) {
    const xdr = options.challengeXdr!.trim();
    // Truncate XDR for display to avoid leaking full nonce and to keep comment size small
    const display = xdr.length > 32 ? `${xdr.slice(0, 24)}…${xdr.slice(-8)}` : xdr;
    const networkNote = network === 'testnet' ? ' (testnet)' : '';
    return (
      `**SEP-0010 challenge${networkNote}:** prove wallet control by signing this challenge with Freighter and posting the signed XDR to your dashboard. ` +
      `Challenge (truncated, do not reuse nonce): \`${display}\` ` +
      `— [How to sign](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md). ` +
      `_This snippet is informational and does not block \`ready\` unless documented._`
    );
  }

  // Dashboard URL invalid => fall back to no snippet to avoid posting a broken link
  return undefined;
}
