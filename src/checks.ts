import { HorizonAccount, getNativeBalance, hasTrustline, isCreditBalance, parseHorizonBalance } from './horizon';
import { escapeMarkdownInline, inlineCode } from './markdown';
import { buildChangeTrustLink, buildLobstrLink, inferStellarNetwork } from './links';
import { UnauthorizedTrustlinePolicy } from './inputs';

/** Stellar public network base reserve per ledger entry (XLM). */
export const STELLAR_BASE_RESERVE_XLM = 0.5;

/** Minimum balance required to activate a new account (XLM). */
export const STELLAR_MIN_ACCOUNT_BALANCE_XLM = 1;

export interface CheckConfig {
  assetCode: string;
  assetIssuer: string;
  minXlmReserve: number;
  horizonUrl?: string;
  /** How to treat a trustline that exists but is not yet authorized by the issuer. Default: "warn". */
  unauthorizedTrustlinePolicy?: UnauthorizedTrustlinePolicy;
  /** When true, a clawback-enabled trustline fails the check instead of only warning. Default: false. */
  clawbackStrictMode?: boolean;
}

export interface CheckResultItem {
  passed: boolean;
  label: string;
  detail: string;
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
  checks: CheckResultItem[];
  remediation?: string;
  /** Non-blocking warnings surfaced in the comment (e.g. unauthorized/clawback-enabled trustline under "warn" policy). */
  warnings?: string[];
}

const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

export function normalizeStellarAddress(address: string): string {
  return address.trim();
}

export function isValidStellarAddress(address: string): boolean {
  return STELLAR_ADDRESS_REGEX.test(normalizeStellarAddress(address));
}

export function validateStellarAddress(address: string): void {
  if (!address || !address.trim()) {
    throw new Error('stellar_address_input is required.');
  }
  if (!isValidStellarAddress(address)) {
    throw new Error(
      `Invalid Stellar address "${address}". Expected a 56-character public key starting with "G".`,
    );
  }
}

export function parseMinXlmReserve(value: string): number {
  const normalized = value.trim();
  const parsed = Number(normalized);
  if (!normalized || !Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`min_xlm_reserve must be a non-negative number. Received: "${value}"`);
  }
  return parsed;
}

export function estimateTrustlineSetupCost(): number {
  return STELLAR_MIN_ACCOUNT_BALANCE_XLM + STELLAR_BASE_RESERVE_XLM;
}

export function formatXlmDeficit(required: number, actual: number): string {
  return Math.max(0, required - actual).toFixed(7);
}

export function runAccountChecks(
  account: HorizonAccount,
  config: CheckConfig,
): ValidationResult {
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

  // "Stricter readiness meaning" (issue #72): under the "fail" policy, an
  // unauthorized trustline does not count as a satisfied trustline
  // requirement, so trustlineExists — and any output derived from it —
  // reflects that.
  const trustlineExists = trustlineExistsRaw && !authorizationBlocks;

  const reserveRequirement = buildReserveRequirement(config.minXlmReserve, xlmNumeric);
  const xlmReserveMet = reserveRequirement.met;
  const hasAnyTrustlines = account.balances.some((b) => isCreditBalance(b));

  const safeAssetCode = escapeMarkdownInline(config.assetCode);

  let trustlineDetail: string;
  if (trustlineExistsRaw && isUnauthorized) {
    trustlineDetail = authorizationBlocks
      ? `Trustline for **${safeAssetCode}** exists but is **not authorized** by the issuer (${inlineCode(config.assetIssuer)}) — blocked by \`unauthorized_trustline_policy: fail\`.`
      : `Trustline for **${safeAssetCode}** (${inlineCode(config.assetIssuer)}) is configured, but **not yet authorized** by the issuer — transfers will fail until authorized.`;
  } else if (trustlineExistsRaw) {
    trustlineDetail = `Trustline for **${safeAssetCode}** (${inlineCode(config.assetIssuer)}) is configured.`;
  } else if (hasAnyTrustlines) {
    trustlineDetail = `Account has trustlines, but not for **${safeAssetCode}** issued by ${inlineCode(config.assetIssuer)}.`;
  } else {
    trustlineDetail = 'Account has **zero trustlines** — add a trustline before receiving this asset.';
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
        ? `Balance **${inlineCode(xlmBalance)} XLM** meets the minimum of **${config.minXlmReserve} XLM**.`
        : `Balance **${inlineCode(xlmBalance)} XLM** is below the required **${config.minXlmReserve} XLM**.`,
    },
  ];

  if (trustlineExistsRaw && clawbackEnabled && clawbackStrictMode) {
    checks.push({
      passed: false,
      label: `${safeAssetCode} clawback safety`,
      detail: `**${safeAssetCode}** has **clawback enabled** for this trustline (${inlineCode(config.assetIssuer)}) — blocked by \`clawback_strict_mode: true\`.`,
    });
  }

  const warnings: string[] = [];
  if (isUnauthorized && unauthorizedPolicy === 'warn') {
    warnings.push(
      `**${safeAssetCode} trustline is not authorized** by the issuer (${inlineCode(config.assetIssuer)}). The issuer has AUTHORIZATION_REQUIRED enabled and has not authorized this account yet — payments in this asset will fail until authorized. Contact the issuer to request authorization.`,
    );
  }
  if (trustlineExistsRaw && clawbackEnabled && !clawbackStrictMode) {
    warnings.push(
      `**${safeAssetCode} has clawback enabled** for this trustline (${inlineCode(config.assetIssuer)}) — the issuer can revoke (claw back) funds from this account at any time. Review custody/security implications before gating payouts on this asset.`,
    );
  }

  const valid = checks.every((c) => c.passed);
  let remediation: string | undefined;

  if (!valid) {
    const network = inferStellarNetwork(config.horizonUrl ?? '');
    const steps: string[] = [];
    if (authorizationBlocks) {
      steps.push(
        `Ask the asset issuer (${inlineCode(config.assetIssuer)}) to authorize this trustline for ${inlineCode(account.account_id)}. The issuer has AUTHORIZATION_REQUIRED enabled, so a Change Trust operation alone is not enough — the issuer must submit a SetTrustLineFlags (or legacy AllowTrust) operation.`,
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
    if (clawbackBlocks) {
      steps.push(
        `This asset has clawback enabled, which is blocked by \`clawback_strict_mode: true\`. Choose a different asset, or set \`clawback_strict_mode: false\` to proceed with a warning instead.`,
      );
    }
    remediation = steps.join('\n\n');
  }

  return {
    valid,
    accountFunded: true,
    trustlineExists,
    trustlineAuthorized,
    clawbackEnabled: trustlineExistsRaw ? clawbackEnabled : undefined,
    xlmBalance,
    xlmReserveMet,
    checks,
    remediation,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export function unfundedAccountResult(
  stellarAddress: string,
  config: CheckConfig,
): ValidationResult {
  const safeAssetCode = escapeMarkdownInline(config.assetCode);
  const safeAddress = inlineCode(stellarAddress);
  const network = inferStellarNetwork(config.horizonUrl ?? '');

  const checks: CheckResultItem[] = [
    {
      passed: false,
      label: 'Account funded',
      detail: `Account ${safeAddress} was **not found** on Horizon — it may not be funded or activated yet.`,
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

  return {
    valid: false,
    accountFunded: false,
    trustlineExists: false,
    xlmBalance: '0',
    xlmReserveMet: false,
    checks,
    remediation: [
      `Activate ${safeAddress} by sending at least **${STELLAR_MIN_ACCOUNT_BALANCE_XLM} XLM** (Stellar minimum account balance).`,
      `Then add a **${safeAssetCode}** trustline via [Stellar Laboratory](${buildChangeTrustLink(network)}) or [LOBSTR](${buildLobstrLink()}).`,
      `Estimated setup cost: ~**${estimateTrustlineSetupCost()} XLM** (1 XLM base + 0.5 XLM per trustline reserve).`,
    ].join('\n\n'),
  };
}

export function getFailedCheckLabels(result: ValidationResult): string[] {
  return result.checks.filter((check) => !check.passed).map((check) => check.label);
}

/**
 * Reduces an error message to something safe to post in a public GitHub
 * comment: only the first line (never a multi-line stack trace) and capped
 * to a sane length. The underlying Error's full `.stack` is never passed
 * into this pipeline in the first place — callers only ever pass
 * `error.message` — but this is a defense-in-depth guard against a
 * message that itself happens to be multi-line or unexpectedly long.
 */
function sanitizeErrorMessageForComment(message: string): string {
  const firstLine = message.split(/\r?\n/)[0] ?? '';
  const MAX_LENGTH = 500;
  return firstLine.length > MAX_LENGTH ? `${firstLine.slice(0, MAX_LENGTH)}…` : firstLine;
}

export function horizonFailureResult(message: string, config: CheckConfig): ValidationResult {
  // `message` may originate from the configured Horizon endpoint's HTTP
  // response body (e.g. the `detail`/`title` fields of an error payload),
  // which is not trusted content — sanitize and escape it before it lands
  // in the Markdown comment so it can't dump a stack trace, inject
  // formatting/links, or break out of the comment structure.
  const safeMessage = escapeMarkdownInline(sanitizeErrorMessageForComment(message));
  const safeAssetCode = escapeMarkdownInline(config.assetCode);

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

  return {
    valid: false,
    accountFunded: false,
    trustlineExists: false,
    xlmBalance: 'unknown',
    xlmReserveMet: false,
    checks,
    remediation:
      'Horizon could not be reached. Retry later or verify your `horizon_url` input and network connectivity.',
  };
}

/**
 * Builds a result for a TLS/certificate verification failure connecting to
 * the configured Horizon endpoint (see `HorizonTlsError`). Kept distinct
 * from `horizonFailureResult` so the comment clearly attributes the
 * failure to the endpoint's transport/certificate configuration rather
 * than to the account or trustline being checked — this matters most for
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
      detail: 'Check could not be completed — the Horizon TLS handshake failed before this account could be queried.',
    },
    {
      passed: false,
      label: 'XLM reserve',
      detail: 'Check could not be completed — the Horizon TLS handshake failed before this account could be queried.',
    },
  ];

  return {
    valid: false,
    accountFunded: false,
    trustlineExists: false,
    xlmBalance: 'unknown',
    xlmReserveMet: false,
    checks,
    remediation:
      'This is a TLS/certificate problem with the configured `horizon_url`, not an issue with the Stellar account. ' +
      'If you are using a private Horizon mirror, verify its certificate is valid, not expired, and signed by a CA trusted by the runner. ' +
      'See docs/USAGE.md for private-mirror setup guidance.',
  };
}

export interface ReserveRequirement {
  required: number;
  actual: number;
  missing: string;
  met: boolean;
}

export function buildReserveRequirement(required: number, actual: number): ReserveRequirement {
  return {
    required,
    actual,
    missing: formatXlmDeficit(required, actual),
    met: actual >= required,
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
