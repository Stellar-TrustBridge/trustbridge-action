/**
 * SARIF (Static Analysis Results Interchange Format) 2.1.0 output generation.
 *
 * Emits TrustBridge validation results as SARIF for integration with GitHub
 * Advanced Security (GHAS) code scanning so wallet-check failures appear
 * alongside other security findings.
 *
 * SARIF reference: https://sarifweb.azurewebsites.net/
 */

import { ValidationResult, CheckResultItem } from './checks';

/**
 * SARIF 2.1.0 rule definition for a TrustBridge check.
 */
export interface SarifRule {
  id: string;
  shortDescription: {
    text: string;
  };
  fullDescription?: {
    text: string;
  };
  helpUri?: string;
  properties?: {
    tags?: string[];
    precision?: string;
  };
}

/**
 * SARIF result level mapping from TrustBridge check outcome.
 */
export type SarifLevel = 'note' | 'warning' | 'error';

/** Rule ID for the generic "account has the required trustline" finding. */
export const TRUSTLINE_RULE_ID = 'TB002';
/** Rule ID for "trustline exists but the issuer has not authorized it". */
export const UNAUTHORIZED_TRUSTLINE_RULE_ID = 'TB006';

/**
 * Build SARIF rule definitions from TrustBridge checks.
 * Each check becomes a rule with a stable ID, description, and help URI.
 */
export function buildSarifRules(): SarifRule[] {
  return [
    {
      id: 'TB001',
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
      id: 'TB006',
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
 */
export function checkLabelToRuleId(label: string): string {
  if (label.includes('Account funded')) return 'TB001';
  // Checked before 'trustline' so clawback labels never fall into TB002.
  if (label.includes('clawback')) return 'TB005';
  if (label.includes('trustline')) return 'TB002';
  if (label.includes('XLM reserve')) return 'TB003';
  if (label.includes('Horizon availability')) return 'TB004';
  return 'TB000'; // Unknown
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
    properties: {
      assetCode,
      checkLabel: check.label,
      passed: check.passed,
    },
  };
}

/**
 * Build a complete SARIF 2.1.0 output from a TrustBridge ValidationResult.
 * Returns a valid SARIF object ready for serialization to JSON and upload
 * to GitHub Advanced Security via the upload-sarif action.
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
  const results = result.checks.map((check) =>
    checkToSarifResult(
      check,
      assetCode,
      horizonUrl,
      stellarAddress,
      unauthorizedSeverity && check.label.toLowerCase().includes('trustline')
        ? unauthorizedSeverity
        : undefined,
    ),
  );
  const sarif = {
    version: '2.1.0',
    $schema:
      'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
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
 * Validate that a SARIF output matches the 2.1.0 schema essentials.
 * Returns true if the structure is valid, false otherwise.
 */
export function validateSarifSchema(sarif: unknown): boolean {
  if (!sarif || typeof sarif !== 'object') return false;
  const s = sarif as Record<string, unknown>;
  if (s.version !== '2.1.0') return false;
  if (!Array.isArray(s.runs) || s.runs.length === 0) return false;

  const run = s.runs[0] as Record<string, unknown>;
  if (!run.tool || !run.tool || typeof run.tool !== 'object') return false;
  const tool = run.tool as Record<string, unknown>;
  if (!tool.driver) return false;
  if (!Array.isArray(run.results)) return false;

  return true;
}
