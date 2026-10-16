/**
 * SARIF (Static Analysis Results Interchange Format) upload support.
 *
 * When `sarif_enabled` is true, TrustBridge serialises the Stellar account
 * validation result as a minimal SARIF 2.1.0 document and uploads it to
 * GitHub Code Scanning via the REST API.  This lets security dashboards and
 * release automation consume TrustBridge outcomes alongside other static
 * analysis reports.
 *
 * The upload is best-effort: a failure in this module emits a workflow warning
 * rather than failing the run so that comment posting and action outputs are
 * not blocked.
 */

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
}

export interface SarifLocation {
  physicalLocation: {
    artifactLocation: {
      uri: string;
    };
  };
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
  name: string;
  shortDescription: SarifMessage;
  helpUri?: string;
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

  const checks: Array<{ ruleId: string; passed: boolean; message: string }> = [
    {
      ruleId: 'TB001',
      passed: outcome.accountFunded,
      message: outcome.accountFunded
        ? `Account ${outcome.stellarAddress} is funded and active.`
        : `Account ${outcome.stellarAddress} was not found on Horizon — it may not be funded yet.`,
    },
    {
      ruleId: 'TB002',
      passed: outcome.trustlineExists,
      message: outcome.trustlineExists
        ? `Trustline for ${outcome.assetCode} is present.`
        : `Trustline for ${outcome.assetCode} is missing.`,
    },
    {
      ruleId: 'TB003',
      passed: outcome.xlmReserveMet,
      message: outcome.xlmReserveMet
        ? 'XLM balance meets the minimum reserve requirement.'
        : 'XLM balance is below the minimum reserve requirement.',
    },
  ];

  const results: SarifResult[] = checks.map(({ ruleId, passed, message }) => ({
    ruleId,
    level: passed ? 'none' : 'error',
    message: { text: message },
  }));

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
