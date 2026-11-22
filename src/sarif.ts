/**
 * SARIF (Static Analysis Results Interchange Format) 2.1.0 support.
 *
 * Two entry points share this module:
 *
 *  - `buildSarifOutput` turns a full `ValidationResult` into the SARIF file
 *    written to `sarif_output_path` for GitHub Advanced Security code
 *    scanning. Rule ids TB001–TB010 are a stable public contract: GHAS users
 *    filter TrustBridge findings by them, so ids are only ever added, never
 *    renumbered.
 *  - `buildSarifDocument` / `uploadSarifReport` serialise a minimal
 *    `TrustBridgeCheckOutcome` for the best-effort upload path. A failure there
 *    emits a workflow warning rather than failing the run so that comment
 *    posting and action outputs are not blocked.
 *
 * Every document can be checked with `validateSarifSchema` /
 * `getSarifSchemaErrors` against the vendored OASIS SARIF 2.1.0 JSON Schema
 * (`schemas/sarif-schema-2.1.0.json`, Issue #679) before it is written or
 * uploaded.
 *
 * Every result carries a `partialFingerprints` entry keyed by
 * `trustbridge/v1` — a stable hash of the result's identity inputs (Issue
 * #893). It excludes message text and account data on purpose, so
 * code-scanning history does not churn when wording or balances move; a
 * `reason_code` change does move it. See {@link computeSarifFingerprint} and
 * `docs/SCHEMA.md`.
 *
 * SARIF reference: https://sarifweb.azurewebsites.net/
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type {
  CheckResultItem,
  HomeDomainCheckMode,
  HomeDomainOutcome,
  ValidationResult,
} from './checks';
import { loadSarifJsonSchema, validateAgainstJsonSchema } from './sarifSchema';

export const SARIF_SCHEMA =
  'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json';
export const SARIF_VERSION = '2.1.0';
export const TOOL_NAME = 'trustbridge-action';
export const TOOL_VERSION = '1.0.0';

export type SarifLevel = 'error' | 'warning' | 'note' | 'none';

export interface SarifMessage {
  text: string;
}

export interface SarifResult {
  ruleId: string;
  level: SarifLevel;
  message: SarifMessage;
  locations?: SarifLocation[];
  /** Stable identity for code scanning (Issue #893); see {@link SARIF_FINGERPRINT_KEY}. */
  partialFingerprints?: Record<string, string>;
}

export interface SarifLocation {
  physicalLocation: {
    artifactLocation: {
      uri: string;
    };
  };
}

// ---------------------------------------------------------------------------
// Stable result fingerprints (Issue #893)
// ---------------------------------------------------------------------------

/**
 * `partialFingerprints` key TrustBridge writes on every SARIF result.
 *
 * The `v1` suffix versions the fingerprint algorithm: bump it in the same
 * release as any change to {@link SarifFingerprintInputs}, so GitHub code
 * scanning treats the new values as a fresh result identity instead of
 * matching them against values computed from the old inputs.
 */
export const SARIF_FINGERPRINT_KEY = 'trustbridge/v1';

/**
 * Inputs that define the stable identity of one SARIF result (Issue #893).
 *
 * These are the *only* inputs. Anything that changes between runs without the
 * finding itself changing is deliberately excluded — the result message text
 * (which embeds addresses, balances and home-domain values), the Horizon URL,
 * the run timestamp and the tool version. Feeding those in made code scanning
 * open a new alert every time wording or account data moved, which is the
 * history noise this contract removes.
 *
 * - `ruleId`     — stable TB### rule id, declared in {@link buildSarifRules}.
 * - `checkLabel` — stable check label, also carried in `properties.checkLabel`.
 * - `assetCode`  — configured asset code; part of what is being checked.
 * - `reasonCode` — effective run reason code ({@link sarifRunReasonCode}).
 */
export interface SarifFingerprintInputs {
  ruleId: string;
  checkLabel: string;
  assetCode: string;
  reasonCode: string;
}

/**
 * Compute the stable fingerprint for one SARIF result.
 *
 * Deterministic SHA-256 over {@link SarifFingerprintInputs} joined with NUL
 * separators (so `a` + `bc` cannot collide with `ab` + `c`), truncated to 32
 * hex characters. The same inputs always yield the same value on every runner,
 * and a `reason_code` change yields a different one.
 */
export function computeSarifFingerprint(inputs: SarifFingerprintInputs): string {
  const canonical = [inputs.ruleId, inputs.checkLabel, inputs.assetCode, inputs.reasonCode].join(
    '\u0000',
  );
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32);
}

/**
 * Normalise a run's reason code exactly the way `runs[0].properties.reasonCode`
 * does: an explicit code wins, otherwise `SUCCESS` for a passing run and
 * `FAILED` for a failing one.
 */
export function sarifRunReasonCode(result: Pick<ValidationResult, 'reasonCode' | 'valid'>): string {
  return result.reasonCode ?? (result.valid ? 'SUCCESS' : 'FAILED');
}

/** Build the `partialFingerprints` property bag for one result. */
export function sarifPartialFingerprints(inputs: SarifFingerprintInputs): Record<string, string> {
  return { [SARIF_FINGERPRINT_KEY]: computeSarifFingerprint(inputs) };
}

export interface SarifRun {
  tool: {
    driver: {
      name: string;
      version: string;
      informationUri: string;
      rules: SarifRule[];
    };
  };
  results: SarifResult[];
}

export interface SarifRule {
  id: string;
  name?: string;
  shortDescription: SarifMessage;
  fullDescription?: SarifMessage;
  helpUri?: string;
  properties?: {
    tags?: string[];
    precision?: string;
  };
  /** Rich help shown by Code Scanning; `markdown` is rendered when present. */
  help?: { text: string; markdown?: string };
}

/** Stable SARIF rule id for the SEP-0001 home domain check (Issue #708). */
export const HOME_DOMAIN_RULE_ID = 'TB004';

export const HOME_DOMAIN_HELP_URI =
  'https://github.com/Stellar-TrustBridge/trustbridge-action/blob/main/docs/SEP0001_HOME_DOMAIN.md';

/** Home domain check outcome carried into SARIF when the check is enabled. */
export interface SarifHomeDomainOutcome {
  outcome: HomeDomainOutcome;
  mode: HomeDomainCheckMode;
  actualHomeDomain?: string;
  expectedHomeDomain?: string;
}

export interface SarifDocument {
  $schema: string;
  version: string;
  runs: SarifRun[];
}

export interface TrustBridgeCheckOutcome {
  /** Horizon URL used for this run. */
  horizonUrl: string;
  /** Stellar address that was validated. */
  stellarAddress: string;
  /** Whether the account exists on-chain. */
  accountFunded: boolean;
  /** Whether the configured asset trustline is present. */
  trustlineExists: boolean;
  /** Whether the XLM reserve requirement is met. */
  xlmReserveMet: boolean;
  /** Asset code being checked (e.g. "USDC"). */
  assetCode: string;
  /**
   * SEP-0001 home domain outcome (Issue #708). Present only when
   * `home_domain_check_enabled` is true; adds rule TB004 to the report.
   */
  homeDomain?: SarifHomeDomainOutcome;
}

/**
 * Build a minimal SARIF 2.1.0 document from a TrustBridge check outcome.
 *
 * Three rules are emitted, one per validation gate:
 *  - TB001  account-funded
 *  - TB002  trustline-exists
 *  - TB003  xlm-reserve-met
 *
 * Each failing gate becomes a SARIF result at level "error"; passing gates
 * are emitted at level "none" so the run is always present in the report.
 *
 * When `outcome.homeDomain` is set, a fourth rule is emitted:
 *  - TB004  home-domain-aligned (error in strict mode, warning in warn mode)
 */
export function buildSarifDocument(outcome: TrustBridgeCheckOutcome): SarifDocument {
  const rules: SarifRule[] = [
    {
      id: 'TB001',
      name: 'AccountFunded',
      shortDescription: { text: 'Stellar account must be funded and activated on-chain.' },
      helpUri: 'https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/accounts',
    },
    {
      id: 'TB002',
      name: 'TrustlineExists',
      shortDescription: {
        text: `Account must hold a trustline for the configured asset (${outcome.assetCode}).`,
      },
      helpUri: 'https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/assets',
    },
    {
      id: 'TB003',
      name: 'XlmReserveMet',
      shortDescription: { text: 'Account native XLM balance must meet the minimum reserve.' },
      helpUri: 'https://developers.stellar.org/docs/learn/fundamentals/lumens',
    },
  ];

  // `label` is the rule's stable `name`; this document carries no per-check
  // labels, so it is the identity input for the fingerprint (Issue #893).
  const checks: Array<{ ruleId: string; label: string; passed: boolean; message: string }> = [
    {
      ruleId: 'TB001',
      label: 'AccountFunded',
      passed: outcome.accountFunded,
      message: outcome.accountFunded
        ? `Account ${outcome.stellarAddress} is funded and active.`
        : `Account ${outcome.stellarAddress} was not found on Horizon — it may not be funded yet.`,
    },
    {
      ruleId: 'TB002',
      label: 'TrustlineExists',
      passed: outcome.trustlineExists,
      message: outcome.trustlineExists
        ? `Trustline for ${outcome.assetCode} is present.`
        : `Trustline for ${outcome.assetCode} is missing.`,
    },
    {
      ruleId: 'TB003',
      label: 'XlmReserveMet',
      passed: outcome.xlmReserveMet,
      message: outcome.xlmReserveMet
        ? 'XLM balance meets the minimum reserve requirement.'
        : 'XLM balance is below the minimum reserve requirement.',
    },
  ];

  const results: SarifResult[] = checks.map(({ ruleId, label, passed, message }) => ({
    ruleId,
    level: passed ? 'none' : 'error',
    message: { text: message },
    partialFingerprints: sarifPartialFingerprints({
      ruleId,
      checkLabel: label,
      assetCode: outcome.assetCode,
      reasonCode: passed ? 'SUCCESS' : 'FAILED',
    }),
  }));

  if (outcome.homeDomain && outcome.homeDomain.outcome !== 'skipped') {
    rules.push(buildHomeDomainRule());
    results.push(buildHomeDomainResult(outcome.homeDomain, outcome.assetCode));
  }

  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: TOOL_NAME,
            version: TOOL_VERSION,
            informationUri: 'https://github.com/Stellar-TrustBridge/trustbridge-action',
            rules,
          },
        },
        results,
      },
    ],
  };
}

function buildHomeDomainRule(): SarifRule {
  return {
    id: HOME_DOMAIN_RULE_ID,
    name: 'HomeDomainAligned',
    shortDescription: {
      text: 'Asset issuer must publish the expected SEP-0001 home_domain on-chain.',
    },
    helpUri: HOME_DOMAIN_HELP_URI,
    help: {
      text:
        'The asset issuer account home_domain is checked against expected_home_domain. ' +
        'In strict mode a missing or mismatched domain fails validation; in warn mode it is reported only.',
      markdown:
        'The asset issuer account `home_domain` is checked against `expected_home_domain` ' +
        '([SEP-0001](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0001.md)).\n\n' +
        '- `home_domain_check_mode: strict`: a missing or mismatched domain fails validation ' +
        '(`HOME_DOMAIN_MISSING` / `HOME_DOMAIN_MISMATCH`).\n' +
        '- `home_domain_check_mode: warn`: the problem is reported as a warning only.\n\n' +
        `See [SEP0001_HOME_DOMAIN.md](${HOME_DOMAIN_HELP_URI}) for configuration.`,
    },
  };
}

/**
 * Map a home domain outcome to the reason code used for its fingerprint. These
 * are the `reason_code` values the full validation path records for the same
 * outcome, so a code rename moves this fingerprint too (Issue #893).
 */
const HOME_DOMAIN_OUTCOME_REASON_CODE: Record<HomeDomainOutcome, string> = {
  valid: 'SUCCESS',
  mismatch: 'HOME_DOMAIN_MISMATCH',
  missing: 'HOME_DOMAIN_MISSING',
  skipped: 'SUCCESS',
};

function buildHomeDomainResult(
  homeDomain: SarifHomeDomainOutcome,
  assetCode: string,
): SarifResult {
  const partialFingerprints = sarifPartialFingerprints({
    ruleId: HOME_DOMAIN_RULE_ID,
    checkLabel: 'HomeDomainAligned',
    assetCode,
    reasonCode: HOME_DOMAIN_OUTCOME_REASON_CODE[homeDomain.outcome],
  });

  if (homeDomain.outcome === 'valid') {
    return {
      ruleId: HOME_DOMAIN_RULE_ID,
      level: 'none',
      message: { text: `Issuer home_domain is ${homeDomain.actualHomeDomain ?? 'set'}.` },
      partialFingerprints,
    };
  }
  const level: SarifLevel = homeDomain.mode === 'strict' ? 'error' : 'warning';
  const text =
    homeDomain.outcome === 'mismatch'
      ? `Issuer home_domain is ${homeDomain.actualHomeDomain ?? ''} but ${homeDomain.expectedHomeDomain ?? ''} was expected.`
      : 'Issuer account has no home_domain set on-chain (or the issuer account was unavailable).';
  return { ruleId: HOME_DOMAIN_RULE_ID, level, message: { text }, partialFingerprints };
}

/**
 * Build a SARIF outcome from a `ValidationResult` (Issue #708), so callers
 * don't have to re-derive each gate. `homeDomainCheckMode` is only needed
 * when the home domain check ran.
 */
export function sarifOutcomeFromResult(
  result: ValidationResult,
  context: {
    horizonUrl: string;
    stellarAddress: string;
    assetCode: string;
    homeDomainCheckMode?: HomeDomainCheckMode;
  },
): TrustBridgeCheckOutcome {
  const homeDomainCheck = result.homeDomainCheck;
  return {
    horizonUrl: context.horizonUrl,
    stellarAddress: context.stellarAddress,
    accountFunded: result.accountFunded,
    trustlineExists: result.trustlineExists,
    xlmReserveMet: result.xlmReserveMet,
    assetCode: context.assetCode,
    homeDomain: homeDomainCheck
      ? {
          outcome: homeDomainCheck.outcome,
          mode: context.homeDomainCheckMode ?? 'warn',
          actualHomeDomain: homeDomainCheck.actualHomeDomain,
          expectedHomeDomain: homeDomainCheck.expectedHomeDomain,
        }
      : undefined,
  };
}

/**
 * Serialise a SARIF document to a compact JSON string suitable for upload.
 */
export function serialiseSarif(doc: SarifDocument): string {
  return JSON.stringify(doc, null, 2);
}

/**
 * Upload function signature expected by `uploadSarif`.
 * Using a callback makes the upload side-effect injectable for tests.
 */
export type SarifUploadFn = (sarifJson: string, horizonUrl: string) => Promise<void>;

/**
 * Build and upload the SARIF report for a TrustBridge check outcome.
 *
 * `uploadFn` is called with the serialised SARIF JSON.  In production it
 * would call the GitHub Code Scanning upload API; in tests it is replaced
 * with a mock so we can assert on the document structure without network calls.
 *
 * @throws {Error} Re-throws if `uploadFn` rejects — callers should catch and
 *   emit a `core.warning` rather than propagating the failure.
 */
export async function uploadSarifReport(
  outcome: TrustBridgeCheckOutcome,
  uploadFn: SarifUploadFn,
): Promise<void> {
  const doc = buildSarifDocument(outcome);
  const json = serialiseSarif(doc);
  await uploadFn(json, outcome.horizonUrl);
}

// ---------------------------------------------------------------------------
// ValidationResult → SARIF (sarif_output_path / GHAS code scanning)
// ---------------------------------------------------------------------------

/** Rule ID for the generic "account has the required trustline" finding. */
export const TRUSTLINE_RULE_ID = 'TB002';
/** Rule ID for "trustline exists but the issuer has not authorized it". */
export const UNAUTHORIZED_TRUSTLINE_RULE_ID = 'TB006';
/** Rule ID for runs skipped by the milestone gate (Issue #678). */
export const MILESTONE_GATE_RULE_ID = 'TB007';
/** Rule ID for the clawback-enabled advisory outside strict mode (Issue #678). */
export const CLAWBACK_ADVISORY_RULE_ID = 'TB008';
/** Rule ID for runs stopped by the `horizon_max_requests` budget (Issue #678). */
export const RATE_BUDGET_RULE_ID = 'TB009';
/** Rule ID for runs short-circuited by the Horizon circuit breaker (Issue #678). */
export const CIRCUIT_OPEN_RULE_ID = 'TB010';
/**
 * Fallback rule for checks that map to no dedicated rule (e.g. SEP-0001 home
 * domain, claimable balances, or labels added after this mapping was written).
 * Declared in the driver so every emitted `ruleId` resolves.
 */
export const GENERIC_RULE_ID = 'TB000';

/**
 * Map a `reason_code` to the dedicated rule that explains *why* the run could
 * not evaluate the account (Issue #678). Returns `undefined` for every other
 * code, including unknown ones, so callers fall back to the per-check
 * label mapping.
 */
export function reasonCodeToRuleId(reasonCode: string | undefined): string | undefined {
  switch (reasonCode) {
    case 'MILESTONE_GATE_SKIPPED':
      return MILESTONE_GATE_RULE_ID;
    case 'RATE_BUDGET_EXHAUSTED':
      return RATE_BUDGET_RULE_ID;
    case 'CIRCUIT_OPEN':
      return CIRCUIT_OPEN_RULE_ID;
    default:
      return undefined;
  }
}

/**
 * Build SARIF rule definitions from TrustBridge checks.
 * Each check becomes a rule with a stable ID, description, and help URI.
 */
export function buildSarifRules(): SarifRule[] {
  return [
    {
      id: 'TB001',
      name: 'AccountFunded',
      shortDescription: {
        text: 'Stellar account is funded and active on the network',
      },
      fullDescription: {
        text: 'Account must exist and be activated on the Stellar network before it can hold trustlines and balances.',
      },
      helpUri: 'https://developers.stellar.org/docs/fundamentals-and-concepts/stellar-data-structures/accounts',
      properties: {
        tags: ['trustbridge', 'stellar', 'wallet-readiness'],
        precision: 'high',
      },
    },
    {
      id: 'TB002',
      name: 'TrustlineExists',
      shortDescription: {
        text: 'Account has a trustline for the required asset',
      },
      fullDescription: {
        text: 'The account must explicitly trust the asset issuer before it can receive the asset.',
      },
      helpUri: 'https://developers.stellar.org/docs/fundamentals-and-concepts/stellar-data-structures/account-data#trustlines',
      properties: {
        tags: ['trustbridge', 'stellar', 'wallet-readiness'],
        precision: 'high',
      },
    },
    {
      id: 'TB003',
      name: 'XlmReserveMet',
      shortDescription: {
        text: 'Account meets minimum XLM reserve requirement',
      },
      fullDescription: {
        text: 'The account must maintain a minimum XLM balance to keep the account open and pay transaction fees.',
      },
      helpUri: 'https://developers.stellar.org/docs/learn/fundamentals/fees-and-metering#reserve',
      properties: {
        tags: ['trustbridge', 'stellar', 'wallet-readiness'],
        precision: 'high',
      },
    },
    {
      id: 'TB004',
      name: 'HorizonAvailability',
      shortDescription: {
        text: 'Horizon API is accessible and responding',
      },
      fullDescription: {
        text: 'TrustBridge must be able to reach the configured Horizon API endpoint to verify account state.',
      },
      helpUri: 'https://developers.stellar.org/docs/data/apis/horizon',
      properties: {
        tags: ['trustbridge', 'stellar', 'infrastructure'],
        precision: 'high',
      },
    },
    {
      id: 'TB005',
      name: 'ClawbackSafety',
      shortDescription: {
        text: 'Asset trustline does not have clawback enabled',
      },
      fullDescription: {
        text: 'The issuer can reclaim clawback-enabled assets at any time. Emitted when clawback_strict_mode blocks a clawback-enabled trustline.',
      },
      helpUri: 'https://developers.stellar.org/docs/tokens/control-asset-access#clawback-enabled-0x8',
      properties: {
        tags: ['trustbridge', 'stellar', 'wallet-readiness', 'clawback'],
        precision: 'high',
      },
    },
    {
      id: UNAUTHORIZED_TRUSTLINE_RULE_ID,
      name: 'UnauthorizedTrustline',
      shortDescription: {
        text: 'Asset trustline is authorized by the issuer',
      },
      fullDescription: {
        text: 'The issuer requires AUTHORIZATION_REQUIRED and has not authorized this trustline, so transfers of the asset fail. Emitted when unauthorized_trustline_policy: fail blocks a trustline that exists but is not authorized.',
      },
      helpUri: 'https://developers.stellar.org/docs/tokens/control-asset-access#authorization-required-0x1',
      properties: {
        tags: ['trustbridge', 'stellar', 'wallet-readiness', 'authorization'],
        precision: 'high',
      },
    },
    {
      id: MILESTONE_GATE_RULE_ID,
      name: 'MilestoneGate',
      shortDescription: {
        text: 'Validation was skipped by the milestone gate',
      },
      fullDescription: {
        text: 'The issue or pull request milestone is not in milestone_allowlist, so the wallet checks did not run. Emitted for reason_code MILESTONE_GATE_SKIPPED; the account state is unknown, not failing.',
      },
      helpUri: 'https://github.com/Stellar-TrustBridge/trustbridge-action/blob/main/docs/USAGE.md#milestone-gating',
      properties: {
        tags: ['trustbridge', 'stellar', 'policy', 'milestone'],
        precision: 'high',
      },
    },
    {
      id: CLAWBACK_ADVISORY_RULE_ID,
      name: 'ClawbackEnabledAdvisory',
      shortDescription: {
        text: 'Asset trustline has clawback enabled (advisory)',
      },
      fullDescription: {
        text: 'The configured trustline has clawback enabled but clawback_strict_mode is off, so the run is not blocked. Emitted at warning level so security reviewers can see assets the issuer can reclaim; enable clawback_strict_mode to turn this into a TB005 error.',
      },
      helpUri: 'https://developers.stellar.org/docs/tokens/control-asset-access#clawback-enabled-0x8',
      properties: {
        tags: ['trustbridge', 'stellar', 'wallet-readiness', 'clawback'],
        precision: 'high',
      },
    },
    {
      id: RATE_BUDGET_RULE_ID,
      name: 'RateBudgetExhausted',
      shortDescription: {
        text: 'Horizon request budget was not exhausted',
      },
      fullDescription: {
        text: 'The run stopped because the horizon_max_requests budget was used up before the account could be fetched. Emitted for reason_code RATE_BUDGET_EXHAUSTED; raise horizon_max_requests or enable caching.',
      },
      helpUri: 'https://github.com/Stellar-TrustBridge/trustbridge-action/blob/main/docs/USAGE.md#failure-reason-code-catalog-reason_code',
      properties: {
        tags: ['trustbridge', 'stellar', 'infrastructure', 'rate-limit'],
        precision: 'high',
      },
    },
    {
      id: CIRCUIT_OPEN_RULE_ID,
      name: 'CircuitOpen',
      shortDescription: {
        text: 'Horizon circuit breaker was closed',
      },
      fullDescription: {
        text: 'The Horizon circuit breaker was open after repeated failures, so no request was sent and the account was not evaluated. Emitted for reason_code CIRCUIT_OPEN; re-run after the recovery window.',
      },
      helpUri: 'https://github.com/Stellar-TrustBridge/trustbridge-action/blob/main/docs/COMMENT_GUIDE.md#circuit-breaker-banner-issue-434',
      properties: {
        tags: ['trustbridge', 'stellar', 'infrastructure', 'resilience'],
        precision: 'high',
      },
    },
    {
      id: GENERIC_RULE_ID,
      name: 'TrustBridgeCheck',
      shortDescription: {
        text: 'Additional TrustBridge validation check',
      },
      fullDescription: {
        text: 'Fallback rule for TrustBridge checks without a dedicated rule id (for example SEP-0001 home domain or claimable balances). The check label is carried in result.properties.checkLabel.',
      },
      helpUri: 'https://github.com/Stellar-TrustBridge/trustbridge-action/blob/main/docs/USAGE.md#sarif-rule-reference',
      properties: {
        tags: ['trustbridge', 'stellar'],
        precision: 'medium',
      },
    },
  ];
}

/**
 * Map a TrustBridge check result to a SARIF result level.
 */
export function checkToSarifLevel(check: CheckResultItem): SarifLevel {
  return check.passed ? 'note' : 'error';
}

/**
 * Map a TrustBridge check label to a SARIF rule ID.
 *
 * Unknown labels fall back to {@link GENERIC_RULE_ID}, which is declared in
 * {@link buildSarifRules}, so the result always references a defined rule.
 */
export function checkLabelToRuleId(label: string): string {
  if (label.includes('Account funded')) return 'TB001';
  // Checked before 'trustline' so clawback labels never fall into TB002.
  if (label.includes('clawback')) return 'TB005';
  if (label.includes('trustline')) return 'TB002';
  if (label.includes('XLM reserve')) return 'TB003';
  if (label.includes('Horizon')) return 'TB004';
  return GENERIC_RULE_ID;
}

/**
 * Resolve the SARIF severity for an unauthorized trustline according to the
 * effective `unauthorized_trustline_policy` (Issue #729).
 *
 * - `fail` — blocking policy failure: reported as an `error` under the
 *   dedicated {@link UNAUTHORIZED_TRUSTLINE_RULE_ID} rule.
 * - `warn` (default) — informational only: the trustline check passes, so the
 *   finding stays at `note` severity under the generic trustline rule.
 * - `ignore` — the policy asks for no finding at all, so `undefined` means
 *   "omit the authorization result".
 */
export function unauthorizedTrustlineSarifSeverity(
  result: Pick<ValidationResult, 'trustlineAuthorized' | 'unauthorizedTrustlinePolicy'>,
): { level: SarifLevel; ruleId: string } | undefined {
  if (result.trustlineAuthorized !== false) return undefined;
  const policy = result.unauthorizedTrustlinePolicy ?? 'warn';
  if (policy === 'ignore') return undefined;
  if (policy === 'fail') {
    return { level: 'error', ruleId: UNAUTHORIZED_TRUSTLINE_RULE_ID };
  }
  return { level: 'note', ruleId: TRUSTLINE_RULE_ID };
}

/**
 * Build a single SARIF result from a TrustBridge check.
 */
export function checkToSarifResult(
  check: CheckResultItem,
  assetCode: string,
  horizonUrl: string,
  stellarAddress: string,
  severityOverride?: { level: SarifLevel; ruleId: string },
  reasonCode: string = '',
): Record<string, unknown> {
  const ruleId = severityOverride?.ruleId ?? checkLabelToRuleId(check.label);
  const level = severityOverride?.level ?? checkToSarifLevel(check);

  return {
    ruleId,
    level,
    message: {
      text: check.detail,
    },
    locations: [
      {
        physicalLocation: {
          artifactLocation: {
            uri: horizonUrl,
            description: {
              text: `Stellar Horizon endpoint for account ${stellarAddress}`,
            },
          },
        },
      },
    ],
    partialFingerprints: sarifPartialFingerprints({
      ruleId,
      checkLabel: check.label,
      assetCode,
      reasonCode,
    }),
    properties: {
      assetCode,
      checkLabel: check.label,
      passed: check.passed,
    },
  };
}

/**
 * Pick the rule/level override for one check (Issues #678, #729).
 *
 * - The primary `<ASSET> trustline` check follows the unauthorized-trustline
 *   policy (TB006 / TB002).
 * - When the run was stopped by the rate budget (TB009) or the circuit
 *   breaker (TB010), the `Horizon availability` check reports under that
 *   dedicated rule instead of the generic TB004, because Horizon itself was
 *   never the problem.
 */
function severityOverrideFor(
  check: CheckResultItem,
  result: ValidationResult,
  unauthorizedSeverity: { level: SarifLevel; ruleId: string } | undefined,
): { level: SarifLevel; ruleId: string } | undefined {
  if (unauthorizedSeverity && / trustline$/.test(check.label)) {
    return unauthorizedSeverity;
  }
  if (check.label === 'Horizon availability' && !check.passed) {
    const ruleId = result.circuitOpen
      ? CIRCUIT_OPEN_RULE_ID
      : reasonCodeToRuleId(result.reasonCode);
    if (ruleId === RATE_BUDGET_RULE_ID || ruleId === CIRCUIT_OPEN_RULE_ID) {
      return { level: 'error', ruleId };
    }
  }
  return undefined;
}

/**
 * Build a complete SARIF 2.1.0 output from a TrustBridge ValidationResult.
 * Returns a valid SARIF object ready for serialization to JSON and upload
 * to GitHub Advanced Security via the upload-sarif action.
 *
 * Besides one result per check, two run-level findings are added (Issue #678):
 *  - TB007 (`warning`) when the milestone gate skipped validation.
 *  - TB008 (`warning`) when the trustline has clawback enabled but
 *    `clawback_strict_mode` did not block it (strict-mode blocks stay TB005).
 *
 * Every result also carries `partialFingerprints['trustbridge/v1']`, hash of
 * the rule id, check label, asset code and the run's `reason_code`
 * (Issue #893). Message text, the account address, balances, the Horizon URL
 * and the run timestamp are excluded, so a purely cosmetic wording change
 * keeps the same code-scanning alert while a `reason_code` change opens a new
 * one.
 */
export function buildSarifOutput(
  result: ValidationResult,
  assetCode: string,
  horizonUrl: string,
  stellarAddress: string,
  version: string = '1.0.0',
): Record<string, unknown> {
  const rules = buildSarifRules();
  // Issue #729 — the authorization finding only appears when the policy asks
  // for it: `fail` promotes the trustline result to an `error` under TB006,
  // `warn` keeps it at `note` severity, `ignore` omits it entirely.
  const unauthorizedSeverity = unauthorizedTrustlineSarifSeverity(result);
  // Issue #893 — every result carries the run's reason code in its stable
  // fingerprint, so a reason_code change (including a rename) moves the
  // finding identity while message wording does not.
  const runReasonCode = sarifRunReasonCode(result);
  const results = result.checks.map((check) =>
    checkToSarifResult(
      check,
      assetCode,
      horizonUrl,
      stellarAddress,
      severityOverrideFor(check, result, unauthorizedSeverity),
      runReasonCode,
    ),
  );

  const location = [
    {
      physicalLocation: {
        artifactLocation: {
          uri: horizonUrl,
          description: {
            text: `Stellar Horizon endpoint for account ${stellarAddress}`,
          },
        },
      },
    },
  ];

  if (reasonCodeToRuleId(result.reasonCode) === MILESTONE_GATE_RULE_ID) {
    results.push({
      ruleId: MILESTONE_GATE_RULE_ID,
      level: 'warning',
      message: {
        text: 'Validation was skipped by the milestone gate — the issue milestone is not in milestone_allowlist.',
      },
      locations: location,
      partialFingerprints: sarifPartialFingerprints({
        ruleId: MILESTONE_GATE_RULE_ID,
        checkLabel: 'Milestone gate',
        assetCode,
        reasonCode: runReasonCode,
      }),
      properties: {
        assetCode,
        checkLabel: 'Milestone gate',
        passed: false,
        reasonCode: result.reasonCode,
      },
    });
  }

  const strictClawbackBlocked = result.checks.some(
    (check) => check.label.includes('clawback') && !check.passed,
  );
  if (result.clawbackEnabled === true && !strictClawbackBlocked) {
    results.push({
      ruleId: CLAWBACK_ADVISORY_RULE_ID,
      level: 'warning',
      message: {
        text: `Trustline for ${assetCode} has clawback enabled — the issuer can reclaim the asset at any time. Set clawback_strict_mode: true to block it.`,
      },
      locations: location,
      partialFingerprints: sarifPartialFingerprints({
        ruleId: CLAWBACK_ADVISORY_RULE_ID,
        checkLabel: `${assetCode} clawback advisory`,
        assetCode,
        reasonCode: runReasonCode,
      }),
      properties: {
        assetCode,
        checkLabel: `${assetCode} clawback advisory`,
        passed: true,
      },
    });
  }

  const sarif = {
    version: SARIF_VERSION,
    $schema: SARIF_SCHEMA,
    runs: [
      {
        tool: {
          driver: {
            name: 'TrustBridge Action',
            version,
            informationUri: 'https://github.com/Stellar-TrustBridge/trustbridge-action',
            semanticVersion: version,
            rules,
          },
        },
        results,
        properties: {
          trustbridgeVersion: version,
          runTimestamp: new Date().toISOString(),
          reasonCode: runReasonCode,
          validationGate: {
            ready: result.valid,
            totalChecks: result.checks.length,
            passedChecks: result.checks.filter((c) => c.passed).length,
            failedChecks: result.checks.filter((c) => !c.passed).length,
          },
        },
      },
    ],
  };

  return sarif;
}

/**
 * Serialize SARIF output to a JSON string.
 * Safe for writing to a file or environment variable.
 */
export function serializeSarif(sarif: Record<string, unknown>): string {
  return JSON.stringify(sarif, null, 2);
}

/**
 * Validate a SARIF document against the vendored OASIS SARIF 2.1.0 JSON
 * Schema (`schemas/sarif-schema-2.1.0.json`, Issue #679).
 *
 * @returns Human-readable schema violations (JSON-path style, e.g.
 *   `$.runs[0].tool: missing required property "driver"`); empty when valid.
 */
export function getSarifSchemaErrors(sarif: unknown): string[] {
  return validateAgainstJsonSchema(sarif, loadSarifJsonSchema());
}

/**
 * Validate that a SARIF output conforms to the SARIF 2.1.0 JSON Schema.
 * Returns true if the document is valid, false otherwise. Use
 * {@link getSarifSchemaErrors} to obtain the individual violations.
 */
export function validateSarifSchema(sarif: unknown): boolean {
  return getSarifSchemaErrors(sarif).length === 0;
}

/** Thrown by {@link writeSarifFile} when the document fails schema validation. */
export class SarifValidationError extends Error {
  constructor(public readonly violations: string[]) {
    super(
      `SARIF output failed SARIF 2.1.0 schema validation (${violations.length} violation(s)): ${violations.join('; ')}`,
    );
    this.name = 'SarifValidationError';
  }
}

/**
 * Validate and write a SARIF document under the workspace (`sarif_output_path`).
 *
 * The document is validated first; an invalid document is never written, so
 * `github/codeql-action/upload-sarif` cannot pick up a malformed file left
 * behind by this run.
 *
 * @returns The absolute path that was written.
 * @throws {SarifValidationError} When the document violates the schema.
 * @throws {Error} When `outputPath` resolves outside the workspace.
 */
export function writeSarifFile(
  sarif: Record<string, unknown>,
  outputPath: string,
  workspaceRoot: string = process.env.GITHUB_WORKSPACE || process.cwd(),
): string {
  // Validate exactly what will be written: the JSON round-trip drops
  // `undefined` fields the same way the file on disk will.
  const json = serializeSarif(sarif);
  const violations = getSarifSchemaErrors(JSON.parse(json));
  if (violations.length > 0) {
    throw new SarifValidationError(violations);
  }

  const root = path.resolve(workspaceRoot);
  const absolutePath = path.resolve(root, outputPath);
  const relative = path.relative(root, absolutePath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`sarif_output_path must resolve to a file inside the workspace: ${outputPath}`);
  }

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, json, 'utf8');
  return absolutePath;
}
