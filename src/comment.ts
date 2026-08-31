import * as core from "@actions/core";
import * as fs from "fs";
import * as path from "path";
import * as github from "@actions/github";
import {
  CheckConfig,
  STELLAR_BASE_RESERVE_XLM,
  STELLAR_MIN_ACCOUNT_BALANCE_XLM,
  buildValidationGate,
  ValidationResult,
  estimateTrustlineSetupCost,
} from "./checks";
import {
  buildAccountViewerLink,
  buildChangeTrustLink,
  buildLobstrLink,
  buildSep0007PayLink,
  buildSep0010ChallengeSnippet,
  inferStellarNetwork,
  buildFaqLinkForCheck,
} from "./links";
import { buildOnboardingChecklist, inlineCode } from "./markdown";
import { MetricsCollector } from "./metrics";
import {
  formatSnoozeMarker,
  parseSnoozeMarker,
  evaluateSnoozeState,
  evaluateCombinedSnoozeState,
  CommentReaction,
} from "./snooze";
import { buildDiagnosticsBlock, DiagnosticsConfig } from "./diagnostics";
import { Locale, getStrings } from "./i18n";
import { formatDeltaMarkdown, ValidationDelta } from "./delta";

/**
 * Semantic schema version embedded in every TrustBridge issue comment.
 * Bump when the comment body structure (sections, markers, remediation
 * shape, etc.) changes in a way that downstream consumers or future
 * versions of this action need to detect.
 */
export const COMMENT_SCHEMA_VERSION = "1.1.0";

export interface CommentConfig extends CheckConfig {
  stellarAddress: string;
  horizonUrl: string;
  failOnMissing?: boolean;
  waitUntilFunded?: boolean;
  waitUntilFundedTimeoutMs?: number;
  waitUntilFundedIntervalMs?: number;
  stickyComment?: boolean;
  /**
   * When true (default), append an onboarding checklist task list whose
   * checkboxes reflect live ValidationResult state (fund → trustline →
   * verify balance). Set false to omit the block.
   */
  onboardingChecklist?: boolean;
  /** Emit SEP-0007 wallet deep links (web+stellar:pay) in the comment. */
  sep0007DeepLinks?: boolean;
  /** Optional origin domain for SEP-0007 URIs (§3.4). */
  sep0007OriginDomain?: string;
  /**
   * When true, the comment reveals the full `horizon_url` host (still
   * address-redacted). When false/omitted, only the URL scheme is shown —
   * a private Horizon mirror's hostname can itself be sensitive
   * infrastructure information and should not be posted to a (potentially
   * public) issue by default.
   */
  debugMode?: boolean;
  /**
   * When provided, a hardened metrics JSON block is appended to the comment
   * as a fenced code block. Callers should pass a fresh `MetricsCollector`
   * snapshot so the comment reflects the run that generated it.
   */
  metricsSnapshot?: MetricsCollector;
  /**
   * Locale for comment strings (e.g., 'en', 'es', 'pt').
   * Falls back to English if unset or invalid.
   */
  locale?: Locale;
  /**
   * When provided and `debugMode` is true, appends an expert diagnostics
   * collapsible block with Horizon request details and normalized inputs.
   * Never includes secrets. (Issue #102)
   */
  diagnosticsConfig?: DiagnosticsConfig;
  /**
   * Optional base URL for FAQ/docs deep links. When set, failing check
   * bullets link to anchor-level FAQ entries in docs/FAQ.md.
   * Defaults to the repo's docs/FAQ.md. Invalid values fall back to the
   * default silently so comment posting is never blocked. (Issue #104)
   */
  docsBaseUrl?: string;
  /**
   * Delta vs previous validation run (Issue #148). When present, a delta
   * section is appended to the comment showing newly-passed/failed checks.
   */
  delta?: ValidationDelta | null;
  /**
   * SEP-0010 challenge proof (Issue #252). Optional — when either field is set,
   * a "Proof of wallet control" snippet is appended to the comment. Does not
   * block `ready` unless the caller explicitly gates on it. Prefer
   * `sep0010DashboardUrl` over raw `sep0010ChallengeXdr` to avoid leaking
   * nonces in public issues.
   */
  sep0010ChallengeXdr?: string;
  sep0010DashboardUrl?: string;
}

export const TRUSTBRIDGE_FOOTER =
  "_Posted by [trustbridge-action](https://github.com/Stellar-TrustBridge/trustbridge-action)_";

/**
 * Legacy hidden marker (pre-schema-version). Kept for backward
 * compatibility in `findStickyComment` so comments posted by older
 * releases of the action are still eligible for upsert.
 */
export const STICKY_COMMENT_MARKER_LEGACY =
  "<!-- trustbridge-action:sticky-comment -->";

/**
 * Hidden marker embedded in every TrustBridge comment body. Includes the
 * comment schema version so future releases can detect the format of a
 * prior comment and decide whether to update it in place or post a new
 * one.
 */
export const STICKY_COMMENT_MARKER = `<!-- trustbridge-action:sticky-comment:schema-v${COMMENT_SCHEMA_VERSION} -->`;

function statusIcon(passed: boolean): string {
  return passed ? "✅" : "❌";
}

export const MAX_COMMENT_LENGTH = 64000;
const TRUNCATION_NOTICE =
  "\n\n_... [Truncated due to GitHub length limits. See workflow logs for full details.]_";

export function formatCommentBody(
  result: ValidationResult,
  config: CommentConfig,
): string {
  const stellarLabNetwork = inferStellarNetwork(config.horizonUrl);
  const gate = buildValidationGate(result);
  const strings = getStrings(config.locale ?? "en");
  const assetBalanceCheckEnabled = !!config.minAssetBalance;

  // Generate snooze marker with current check status (Issue #155)
  const snoozeMarker = formatSnoozeMarker(result.valid ? "pass" : "fail");

  const buildWithRemediation = (remediation: string | undefined): string => {
    const lines: string[] = [
      STICKY_COMMENT_MARKER,
      `<!-- trustbridge-action:schema-version:${COMMENT_SCHEMA_VERSION} -->`,
      snoozeMarker,
      "## TrustBridge — Stellar Account Check",
      "",
      `${strings.checkedAccount} ${inlineCode(config.stellarAddress)}`,
      `${strings.horizon} ${inlineCode(config.horizonUrl)}`,
      `${strings.asset} **${config.assetCode}** · Issuer: ${inlineCode(config.assetIssuer)}`,
      "",
      `### ${strings.resultsHeading}`,
      "",
    ];

    for (const check of result.checks) {
      // Append a FAQ deep link for failing checks so contributors land on the
      // exact fix (Issue #104). Passing checks do not include the link to keep
      // the happy path clean.
      let faqSuffix = "";
      if (!check.passed) {
        const faqUrl = buildFaqLinkForCheck(check.label, config.docsBaseUrl);
        if (faqUrl) {
          faqSuffix = ` [→ FAQ](${faqUrl})`;
        }
      }
      lines.push(
        `- ${statusIcon(check.passed)} **${check.label}** — ${check.detail}${faqSuffix}`,
      );
    }

    // Onboarding checklist (Issue #154) — default on unless explicitly disabled.
    if (config.onboardingChecklist !== false) {
      lines.push(
        "",
        buildOnboardingChecklist(result, {
          assetCode: config.assetCode,
          minXlmReserve: config.minXlmReserve,
        }),
      );
    }

    // Ledger freshness / lag alert (Issue #107) — surfaced as a distinct banner
    // so contributors clearly understand it is about Horizon data quality, not
    // their wallet state.
    if (result.ledgerFreshnessResult) {
      const fr = result.ledgerFreshnessResult;
      const icon =
        fr.status === "ok" ? "✅" : fr.status === "stale" ? "⚠️" : "ℹ️";
      const lagDisplay =
        fr.lagSeconds !== null ? `${fr.lagSeconds.toFixed(1)}s` : "_unknown_";
      const ledgerDisplay =
        fr.latestLedger !== null ? `#${fr.latestLedger}` : "_unknown_";
      lines.push(
        "",
        `> ${icon} **Ledger freshness** — ${fr.message}`,
        `> - Measured lag: \`${lagDisplay}\` · Latest ledger: \`${ledgerDisplay}\``,
        fr.blocksValid
          ? "> - ❌ This is treated as a **hard failure** (`ledger_freshness_fail_on_stale: true`)."
          : fr.status === "stale"
            ? "> - ⚠️ This is an **informational warning** (`ledger_freshness_fail_on_stale: false`). Results may not reflect the current network state."
            : "",
      );
    }

    const deltaSection = formatDeltaMarkdown(config.delta);
    if (deltaSection) {
      lines.push("", deltaSection);
    }

    lines.push(
      "",
      `### ${strings.validationGateHeading}`,
      "",
      gate.ready
        ? `- ${strings.readyToProceed}`
        : `- ${strings.blockedBy} ${gate.failedLabels.join(", ")}`,
      `- ${strings.passedChecks} ${gate.passedChecks}/${gate.totalChecks}`,
      `- ${strings.failedChecks} ${gate.failedChecks}`,
      "",
      `### ${strings.balancesHeading}`,
      "",
      `- **Native XLM balance:** ${result.xlmBalance === "unknown" ? "_unknown_" : `\`${result.xlmBalance} XLM\``}`,
      result.reserveRequirement
        ? `- **Minimum required (XLM reserve):** \`${result.reserveRequirement.required} XLM\` (protocol minimum \`${result.reserveRequirement.protocolMinimum} XLM\` from ${result.reserveRequirement.subentryCount} subentries/sponsorship, configured floor \`${result.reserveRequirement.configuredFloor} XLM\`)`
        : `- **Minimum required (XLM reserve):** \`${config.minXlmReserve} XLM\``,
      // Split display: trustline vs native (Issue #246) — deterministic, 7-decimal, handles missing/0 balance
      (() => {
        const asset = config.assetCode;
        const bal = result.assetBalance ?? "0";
        const trustline = result.trustlineExists;
        if (bal === "unknown") {
          return `- **${asset} trustline balance:** _unknown_ (trustline ${trustline ? "exists" : "missing"})`;
        }
        if (!trustline) {
          return `- **${asset} trustline balance:** \`0 ${asset}\` — no trustline configured`;
        }
        // Trustline exists — show 7-decimal balance (Horizon always 7dp) and optional limit
        const limitNote = result.trustlineLimit
          ? ` (limit \`${result.trustlineLimit} ${asset}\`)`
          : "";
        return `- **${asset} trustline balance:** \`${bal} ${asset}\`${limitNote}`;
      })(),
      "",
      `### ${strings.setupCostHeading}`,
      "",
      `- ${strings.minimumAccountBalance} **${STELLAR_MIN_ACCOUNT_BALANCE_XLM} XLM**`,
      `- ${strings.baseReservePerTrustline} **${STELLAR_BASE_RESERVE_XLM} XLM**`,
      `- ${strings.typicalMinimumToFund} **~${estimateTrustlineSetupCost()} XLM**`,
      "",
      `### ${strings.addTrustlineHeading}`,
      "",
      `- [${strings.viewAccountOnLab}](${buildAccountViewerLink(config.stellarAddress, stellarLabNetwork)})`,
      `- [${strings.openTransactionBuilder}](${buildChangeTrustLink(stellarLabNetwork)})`,
      `- [${strings.lobstrWallet}](${buildLobstrLink()}) — ${strings.lobstrDescription} **${config.assetCode}** from issuer \`${config.assetIssuer}\``,
    );

    // SEP-0007 wallet deep links (Issue #44)
    if (config.sep0007DeepLinks) {
      const payLink = buildSep0007PayLink({
        destination: config.stellarAddress,
        amount: String(STELLAR_MIN_ACCOUNT_BALANCE_XLM),
        msg: `Activate Stellar account for ${config.assetCode} trustline`,
        network: stellarLabNetwork,
        originDomain: config.sep0007OriginDomain || undefined,
      });
      lines.push(
        "",
        `### ${strings.sepWalletActionsHeading}`,
        "",
        `_${strings.sepWalletActionsDescription}_`,
        "",
        `- [${strings.sendXlmToActivate.replace("{amount}", String(STELLAR_MIN_ACCOUNT_BALANCE_XLM))}](${payLink})`,
      );
    }

    // SEP-0010 challenge snippet (Issue #252) — optional, does not block ready
    // Prefer dashboard proof link over raw XDR to avoid leaking nonces in public issues.
    const sep0010Snippet = buildSep0010ChallengeSnippet({
      challengeXdr: config.sep0010ChallengeXdr,
      dashboardUrl: config.sep0010DashboardUrl,
      network: stellarLabNetwork,
      stellarAddress: config.stellarAddress,
    });
    if (sep0010Snippet) {
      lines.push(
        "",
        "### Proof of wallet control (SEP-0010)",
        "",
        sep0010Snippet,
        "",
        "_This section is informational and does not affect `ready` unless your workflow explicitly gates on it. Prefer a dashboard Freighter proof link over a raw challenge XDR to avoid reusing nonces._",
      );
    }

    // Sponsorship info explainer (Issue #141)
    if (
      result.sponsorshipInfo &&
      (result.sponsorshipInfo.numSponsoring > 0 ||
        result.sponsorshipInfo.numSponsored > 0)
    ) {
      lines.push(
        "",
        "### Sponsorship status",
        "",
        result.sponsorshipInfo.numSponsored > 0
          ? `**This account is sponsored.** Another account is covering some or all of its reserve requirements.`
          : "**This account sponsors other accounts** and may have reduced available balance.",
        "",
        `- Accounts this account sponsors: **${result.sponsorshipInfo.numSponsoring}**`,
        `- Accounts sponsoring this account: **${result.sponsorshipInfo.numSponsored}**`,
        "",
        "**Reserve implications:** Sponsored accounts may have different reserve requirements than their balance suggests. The sponsoring account bears the reserve cost. [Learn more about sponsorship.](https://developers.stellar.org/learn/fundamentals/stellar-data-structures/ledger-entries#sponsorships)",
      );
    }

    if (remediation) {
      lines.push("", `### ${strings.remediationHeading}`, "", remediation);
    }

    lines.push(
      "",
      `### ${strings.configurationSummaryHeading}`,
      "",
      `| ${strings.inputColumn} | ${strings.valueColumn} |`,
      `| --- | --- |`,
      `| \`fail_on_missing\` | ${config.failOnMissing === undefined ? "_default (true)_" : config.failOnMissing ? strings.failOnMissingTrue : strings.failOnMissingFalse} |`,
      `| \`sticky_comment\` | ${config.stickyComment === undefined ? "_default (true)_" : config.stickyComment ? strings.stickyCommentTrue : strings.stickyCommentFalse} |`,
      `| \`wait_until_funded\` | ${config.waitUntilFunded ? strings.waitUntilFundedTrue : strings.waitUntilFundedFalse} |`,
      `| \`onboarding_checklist\` | \`${config.onboardingChecklist === false ? "false" : "true"}\` |`,
    );

    // Ledger freshness config row
    if (config.checkLedgerFreshness) {
      lines.push(
        `| \`check_ledger_freshness\` | \`true\` |`,
        `| \`max_ledger_lag_seconds\` | \`${config.maxLedgerLagSeconds ?? 60}s\` |`,
        `| \`ledger_freshness_fail_on_stale\` | \`${config.ledgerFreshnessFailOnStale ? "true (hard fail)" : "false (warn only)"}\` |`,
      );
    }

    if (assetBalanceCheckEnabled) {
      lines.push(
        `| \`min_asset_balance\` | \`${config.minAssetBalance} ${config.assetCode}\` |`,
      );
    }

    if (config.waitUntilFunded) {
      const timeout = config.waitUntilFundedTimeoutMs ?? 120000;
      const interval = config.waitUntilFundedIntervalMs ?? 5000;
      lines.push(
        `| \`wait_until_funded_timeout_ms\` | ${strings.waitUntilFundedTimeoutMs.replace("{ms}", String(timeout))} |`,
        `| \`wait_until_funded_interval_ms\` | ${strings.waitUntilFundedIntervalMs.replace("{ms}", String(interval))} |`,
      );
    }

    lines.push(
      "",
      `### ${strings.outputsHeading}`,
      "",
      `_${strings.outputsDescription}_`,
      "",
      `| ${strings.outputColumn} | ${strings.valueRunColumn} | ${strings.descriptionColumn} |`,
      `| --- | --- | --- |`,
      `| \`account_funded\` | \`${String(result.accountFunded)}\` | ${strings.accountFundedOutput} |`,
      `| \`trustline_exists\` | \`${String(result.trustlineExists)}\` | ${strings.trustlineExistsOutput.replace("{assetCode}", config.assetCode)} |`,
      `| \`xlm_balance\` | \`${result.xlmBalance}\` | ${strings.xlmBalanceOutput} |`,
      `| \`native_balance\` | \`${result.xlmBalance}\` | Native XLM balance (alias of \`xlm_balance\`, 7-decimal string) |`,
      `| \`asset_balance\` | \`${result.assetBalance ?? "0"}\` | ${config.assetCode} trustline balance (7-decimal string, \`0\` if no trustline, \`unknown\` on Horizon error) |`,
      `| \`comment_url\` | _set after posting_ | ${strings.commentUrlOutput} |`,
    );

    // Hardened metrics JSON export (Issue #33)
    if (config.metricsSnapshot) {
      const metricsJson = buildHardenedMetricsJson(config.metricsSnapshot);
      lines.push(
        "",
        `### ${strings.metricsHeading}`,
        "",
        `_${strings.metricsDescription}_`,
        "",
        "```json",
        metricsJson,
        "```",
      );
    }

    // Expert diagnostics block (Issue #102) — only appended in debug/expert mode
    if (config.debugMode && config.diagnosticsConfig) {
      const diagnosticsBlock = buildDiagnosticsBlock(config.diagnosticsConfig);
      if (diagnosticsBlock) {
        lines.push(diagnosticsBlock);
      }
    }

    lines.push("", "---", TRUSTBRIDGE_FOOTER);

    return lines.join("\n");
  };

  let fullBody = buildWithRemediation(result.remediation);

  if (fullBody.length > MAX_COMMENT_LENGTH && result.remediation) {
    const excess = fullBody.length - MAX_COMMENT_LENGTH;
    const availableForRemediation =
      result.remediation.length - excess - TRUNCATION_NOTICE.length;

    let truncatedRemediation: string;
    if (availableForRemediation > 0) {
      truncatedRemediation =
        result.remediation.slice(0, availableForRemediation) +
        TRUNCATION_NOTICE;
    } else {
      truncatedRemediation = TRUNCATION_NOTICE.trimStart();
    }

    fullBody = buildWithRemediation(truncatedRemediation);
  }

  return fullBody;
}

/**
 * Build a hardened metrics JSON string safe for embedding in a GitHub issue
 * comment.
 *
 * "Hardened" means:
 *   1. Only structural/aggregate fields are included (no raw balances, no
 *      account addresses, no Horizon URLs).
 *   2. The JSON is produced via `JSON.stringify` with a replacer so
 *      unintended fields cannot sneak in via future `MetricsCollector`
 *      additions.
 *   3. The output is size-capped at `MAX_METRICS_JSON_BYTES`; if exceeded,
 *      a truncation notice replaces the body so the comment never exceeds
 *      GitHub's comment size limit.
 *
 * @internal Exported for testing.
 */
export const MAX_METRICS_JSON_BYTES = 4096;

export function buildHardenedMetricsJson(metrics: MetricsCollector): string {
  const summary = metrics.getSummary();

  // Strip metric tags entirely — tags may contain contract addresses.
  const safeSummary = {
    totalMetrics: summary.totalMetrics,
    counters: summary.counters,
    metrics: summary.metrics.map((m) => ({
      name: m.name,
      value: m.value,
      unit: m.unit,
      timestamp: m.timestamp,
      // tags deliberately omitted
    })),
  };

  let json: string;
  try {
    json = JSON.stringify(safeSummary, null, 2);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({
      error: `metrics serialisation failed: ${message}`,
    });
  }

  if (Buffer.byteLength(json, "utf8") > MAX_METRICS_JSON_BYTES) {
    const truncated = {
      totalMetrics: safeSummary.totalMetrics,
      counters: safeSummary.counters,
      truncated: true,
      note: `Metrics body exceeded ${MAX_METRICS_JSON_BYTES} bytes and was omitted.`,
    };
    return JSON.stringify(truncated, null, 2);
  }

  return json;
}

/**
 * GitHub's documented maximum body size for issue comments is 65,536
 * characters. We keep a small safety margin so the truncation notice and
 * surrounding HTML markers always fit within the limit.
 */
export const COMMENT_SIZE_LIMIT_BYTES = 65536;

/**
 * Number of bytes reserved for the truncation notice appended to the
 * shortened comment. Sized to comfortably hold the notice text plus the
 * footer.
 */
export const COMMENT_TRUNCATION_NOTICE_BYTES = 512;

/**
 * Build a truncated comment body that fits within `COMMENT_SIZE_LIMIT_BYTES`.
 *
 * The full body is cut at a safe byte offset, a truncation notice is
 * appended, and the TrustBridge footer is preserved so the sticky-comment
 * marker remains present.  The cut always happens on a line boundary so the
 * resulting markdown is clean.
 *
 * @param fullBody  The full comment body produced by `formatCommentBody`.
 * @param reportPath  Workspace-relative path where the full report was written.
 * @returns A comment body that fits within the GitHub size limit.
 *
 * @internal Exported for testing.
 */
export function buildTruncatedCommentBody(
  fullBody: string,
  reportPath: string,
): string {
  const budget = COMMENT_SIZE_LIMIT_BYTES - COMMENT_TRUNCATION_NOTICE_BYTES;

  // Walk backwards from the budget boundary to find a clean line break.
  const bodyBytes = Buffer.from(fullBody, "utf8");
  let cutByte = budget;
  while (cutByte > 0 && bodyBytes[cutByte] !== 0x0a /* '\n' */) {
    cutByte--;
  }

  const truncated = bodyBytes.subarray(0, cutByte).toString("utf8");

  const notice = [
    "",
    "---",
    "> **⚠️ Report truncated** — this comment exceeded GitHub's size limit.",
    `> The full validation report has been written to \`${reportPath}\` in the workflow workspace.`,
    "> Upload it as a workflow artifact using `actions/upload-artifact` to make it available for download.",
    "> See [USAGE.md](https://github.com/Stellar-TrustBridge/trustbridge-action/blob/main/docs/USAGE.md#handling-oversized-reports) for the recommended workflow pattern.",
    "",
    "---",
    TRUSTBRIDGE_FOOTER,
  ].join("\n");

  return truncated + notice;
}

/**
 * Write the full comment body to a workspace file so it can be uploaded as
 * a GitHub Actions artifact by a subsequent `actions/upload-artifact` step.
 *
 * Directories are created recursively if they don't exist.  Any write
 * failure is surfaced as a warning (not an error) so the action can still
 * post the truncated comment.
 *
 * @param fullBody  Full comment body to persist.
 * @param outputPath  Absolute or workspace-relative path for the output file.
 * @returns The resolved absolute path on success, `undefined` on failure.
 *
 * @internal Exported for testing.
 */
export function writeFullReport(
  fullBody: string,
  outputPath: string,
): string | undefined {
  try {
    const resolved = path.isAbsolute(outputPath)
      ? outputPath
      : path.resolve(
          process.env["GITHUB_WORKSPACE"] ?? process.cwd(),
          outputPath,
        );

    const dir = path.dirname(resolved);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(resolved, fullBody, "utf8");

    core.info(`Full validation report written to ${resolved}`);
    return resolved;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.warning(`Failed to write full validation report: ${message}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// #322 — Comment threading / reply mode
// ---------------------------------------------------------------------------

/**
 * Explicit comment threading strategy.
 *
 * - `'sticky'` — update the existing TrustBridge comment in place (default).
 * - `'new'`    — always post a fresh top-level comment (full audit trail).
 * - `'reply'`  — post a reply to the *first* TrustBridge comment in the
 *                thread, building a chronological chain without overwriting
 *                the original summary comment.
 */
export type CommentMode = 'sticky' | 'new' | 'reply';

/**
 * Valid `CommentMode` values — used for input validation.
 */
export const VALID_COMMENT_MODES: CommentMode[] = ['sticky', 'new', 'reply'];

/**
 * Resolve the effective `CommentMode` from action inputs.
 *
 * Priority: `commentMode` input > derive from `sticky` boolean > default `'sticky'`.
 * Invalid values fall back to `'sticky'` with a warning so the action
 * never hard-fails due to a misconfigured `comment_mode`.
 */
export function resolveCommentMode(
  commentMode: string | undefined,
  sticky: boolean | undefined,
): CommentMode {
  if (commentMode) {
    const normalised = commentMode.trim().toLowerCase() as CommentMode;
    if (VALID_COMMENT_MODES.includes(normalised)) {
      return normalised;
    }
    // Invalid value — warn and fall through to default.
    core.warning(
      `Invalid comment_mode value "${commentMode}". Expected one of: ${VALID_COMMENT_MODES.join(', ')}. Falling back to "sticky".`,
    );
  }
  // Derive from legacy sticky boolean.
  if (sticky === false) return 'new';
  return 'sticky';
}

export interface UpsertCommentOptions {
  /**
   * When true (default), find and update TrustBridge's previous comment on
   * the issue instead of posting a new one every run. Falls back to
   * creating a new comment when no prior comment is found, or when the
   * lookup itself fails (e.g. transient GitHub API error).
   *
   * @deprecated Prefer `commentMode` for explicit control.
   */
  sticky?: boolean;
  /**
   * Comment threading strategy (#322).
   *
   * - `'sticky'` (default): update the previous TrustBridge comment in place.
   *   Equivalent to `sticky: true`.
   * - `'new'`: always post a fresh comment for a full audit trail.
   *   Equivalent to `sticky: false`.
   * - `'reply'`: post a reply to the first TrustBridge comment in the thread
   *   (using `in_reply_to` if the API supports it, else a top-level comment
   *   that references the parent). Useful when orgs want a chronological
   *   thread without overwriting the original.
   *
   * When set, `commentMode` takes precedence over `sticky`.
   */
  commentMode?: CommentMode;
  /**
   * When true, post the comment normally even if snoozed.
   * Useful for maintainers forcing an immediate re-alert.
   */
  forceComment?: boolean;
  /**
   * Snooze window in milliseconds for suppressing duplicate failure comments.
   * When result failed and last check failed within this window, skip the
   * comment post (unless forceComment is true). Always update outputs.
   */
  snoozeWindowMs?: number;
  /**
   * Explicit issue/PR number override (e.g. from workflow_dispatch input).
   * When omitted, falls back to `resolveIssueOrPullRequestNumber(github.context.payload)`.
   */
  issueNumber?: number;
}

type Octokit = ReturnType<typeof github.getOctokit>;

/**
 * Resolve the issue or pull-request number a comment should be posted to.
 *
 * `pull_request` (and `pull_request_target`) events carry the number under
 * `payload.pull_request.number`, not `payload.issue.number` — `payload.issue`
 * is only populated for `issues`/`issue_comment` events. GitHub treats every
 * PR as an issue under the hood, so the REST issues API (`createComment`,
 * `updateComment`, `listComments`) works identically for both once the
 * correct number is resolved (Issue #220).
 *
 * Only the numeric identifier is read from the payload here — never the PR
 * title/body — so this cannot leak untrusted fork-PR content into anything
 * built from the result (e.g. Horizon request URLs).
 *
 * Checks `issue` first so that `issue_comment` events on a PR (which set
 * *both* `payload.issue` and `payload.issue.pull_request`) keep resolving
 * the same way they always have.
 *
 * @internal Exported for testing.
 */
export function resolveIssueOrPullRequestNumber(
  payload: unknown,
): number | undefined {
  if (payload && typeof payload === "object") {
    const typedPayload = payload as {
      issue?: { number?: unknown };
      pull_request?: { number?: unknown };
    };
    const issueNumber = typedPayload.issue?.number;
    if (typeof issueNumber === "number") {
      return issueNumber;
    }
    const prNumber = typedPayload.pull_request?.number;
    if (typeof prNumber === "number") {
      return prNumber;
    }
  }
  return undefined;
}

/**
 * Returns true when a comment body matches any of the TrustBridge
 * identifiers: the current versioned sticky marker, the legacy marker
 * (pre-schema-version), or the TrustBridge footer. Matching on any of
 * these provides defense-in-depth across upgrades and accidental
 * marker drift.
 */
export function isTrustBridgeComment(body: string | undefined | null): boolean {
  if (!body) return false;
  return (
    body.includes(STICKY_COMMENT_MARKER) ||
    body.includes(STICKY_COMMENT_MARKER_LEGACY) ||
    body.includes(TRUSTBRIDGE_FOOTER)
  );
}

/**
 * Detect a revalidation slash command on an issue comment.
 *
 * Only exact `/trustbridge` prefixes are treated as commands so that unrelated
 * comments and other slash commands are ignored. The match is intentionally
 * narrow and only triggers when the command begins the comment body (allowing
 * leading whitespace, then the exact token followed by whitespace or end-of-text).
 */
export function isTrustBridgeSlashCommand(
  body: string | undefined | null,
): boolean {
  const text = (body ?? "").trimStart();
  return /^\/trustbridge(?:\s|$)/.test(text);
}

/**
 * Returns true when the issue comment came from a bot account and therefore
 * should never trigger a revalidation loop or a follow-up command.
 */
export function isBotCommentAuthor(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const typed = payload as {
    comment?: { user?: { type?: string; login?: string } };
  };
  const user = typed.comment?.user;
  if (!user) return false;
  return (
    user.type === "Bot" || Boolean(user.login && /\[bot\]$/i.test(user.login))
  );
}

/**
 * Maximum number of comment pages (100 comments per page) to search for sticky
 * comments on high-traffic issues or discussions before capping.
 * Capping at 10 pages (1,000 comments) prevents rate limit exhaustion and
 * infinite pagination on busy threads. (Issue #226)
 */
export const MAX_STICKY_COMMENT_SEARCH_PAGES = 10;

export interface FindStickyCommentOptions {
  /** Maximum number of comment pages (100 comments per page) to search before stopping. Defaults to 10. */
  maxPages?: number;
}

interface IssueCommentGraphqlNode {
  id: string;
  databaseId?: number;
  body: string;
}

interface IssueCommentsGraphqlPage {
  repository?: {
    issue?: {
      comments?: {
        nodes: IssueCommentGraphqlNode[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    };
  } | null;
}

/**
 * Find TrustBridge's previous sticky comment on the issue, if any.
 *
 * Uses GraphQL pagination (100 comments per page, up to MAX_STICKY_COMMENT_SEARCH_PAGES = 10 pages)
 * to locate the marker efficiently even on busy Wave issues with hundreds of comments.
 * Falls back to REST pagination if GraphQL is unavailable or fails.
 *
 * Matches on the current versioned marker, the legacy marker, and the
 * action footer so comments posted by older releases are still eligible
 * for upsert.
 */
export async function findStickyComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  options: FindStickyCommentOptions = {},
): Promise<number | undefined> {
  const maxPages = options.maxPages ?? MAX_STICKY_COMMENT_SEARCH_PAGES;

  // Primary: GraphQL pagination (efficiently retrieves only databaseId + body)
  if (typeof octokit.graphql === "function") {
    try {
      const query = `
        query FindTrustBridgeIssueComment($owner: String!, $repo: String!, $issueNumber: Int!, $cursor: String) {
          repository(owner: $owner, name: $repo) {
            issue(number: $issueNumber) {
              comments(first: 100, after: $cursor) {
                nodes {
                  id
                  databaseId
                  body
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        }
      `;

      let cursor: string | null = null;
      let lastMatchId: number | undefined;
      let pageCount = 0;
      let graphqlHandled = false;

      while (pageCount < maxPages) {
        pageCount++;
        const data = (await octokit.graphql(query, {
          owner,
          repo,
          issueNumber,
          cursor,
        })) as IssueCommentsGraphqlPage;

        const comments = data?.repository?.issue?.comments;
        if (!comments || !Array.isArray(comments.nodes)) {
          break;
        }

        graphqlHandled = true;

        for (const comment of comments.nodes) {
          if (isTrustBridgeComment(comment.body)) {
            // databaseId is the numeric REST issue comment id
            lastMatchId = comment.databaseId;
          }
        }

        if (!comments.pageInfo.hasNextPage || !comments.pageInfo.endCursor) {
          break;
        }
        cursor = comments.pageInfo.endCursor;
      }

      if (lastMatchId !== undefined) {
        return lastMatchId;
      }
      if (graphqlHandled) {
        return undefined;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      core.debug(
        `GraphQL sticky comment search failed, falling back to REST: ${message}`,
      );
    }
  }

  // Fallback: REST pagination with page cap
  if (
    typeof octokit.paginate === "function" &&
    octokit.rest?.issues?.listComments
  ) {
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    });
    const matches = comments.filter((comment) =>
      isTrustBridgeComment(comment.body),
    );
    return matches.length > 0 ? matches[matches.length - 1]!.id : undefined;
  }

  return undefined;
}

export async function postIssueComment(
  token: string,
  body: string,
  options: UpsertCommentOptions = {},
): Promise<string | undefined> {
  // Resolve effective comment mode (#322): commentMode input takes precedence
  // over legacy sticky boolean.
  const effectiveMode = resolveCommentMode(
    options.commentMode,
    options.sticky,
  );
  // Map back to sticky boolean for the existing snooze/lookup machinery.
  const sticky = effectiveMode === 'sticky';
  const forceComment = options.forceComment ?? false;
  const snoozeWindowMs = options.snoozeWindowMs ?? 0;
  const context = github.context;
  // Prefer an explicitly-supplied issue number (e.g. from workflow_dispatch
  // input) over the event context payload so manual benchmark runs can
  // target a specific issue. Otherwise resolve from either an `issues` event
  // (`payload.issue.number`) or a `pull_request`/`pull_request_target` event
  // (`payload.pull_request.number`) — see resolveIssueOrPullRequestNumber (Issue #220).
  const issueNumber =
    options.issueNumber ?? resolveIssueOrPullRequestNumber(context.payload);

  if (!issueNumber) {
    core.warning(
      "No issue or pull request context found — skipping comment. Pass `issue_number` as a workflow_dispatch input or run this action on an `issues`, `pull_request`, or `pull_request_target` event.",
    );
    return undefined;
  }

  // `github.getOctokit` defaults to `https://api.github.com` unless a
  // `baseUrl` is supplied — on GitHub Enterprise Server the runner sets
  // `GITHUB_API_URL` to the enterprise API base (e.g.
  // `https://ghes.example.com/api/v3`), which `context.apiUrl` reads.
  // Passing it explicitly here is what makes comment posting work on GHES
  // instead of silently calling the wrong (public) API host.
  const octokit = github.getOctokit(token, { baseUrl: context.apiUrl });
  const { owner, repo } = context.repo;

  let existingCommentId: number | undefined;
  let existingCommentBody: string | undefined;
  let existingCommentReactions: CommentReaction[] = [];

  if (sticky) {
    try {
      existingCommentId = await findStickyComment(
        octokit,
        owner,
        repo,
        issueNumber,
      );

      // Fetch comment body and reactions to check snooze status (Issue #155, Issue #227)
      if (existingCommentId && snoozeWindowMs > 0 && !forceComment) {
        try {
          const commentResponse = await octokit.rest.issues.getComment({
            owner,
            repo,
            comment_id: existingCommentId,
          });
          existingCommentBody = commentResponse.data.body;
        } catch (error) {
          core.debug(
            `Could not fetch existing comment body for snooze check: ${error}`,
          );
        }

        try {
          if (octokit.rest?.reactions?.listForIssueComment) {
            const reactionsResponse =
              await octokit.rest.reactions.listForIssueComment({
                owner,
                repo,
                comment_id: existingCommentId,
                per_page: 100,
              });
            if (Array.isArray(reactionsResponse?.data)) {
              existingCommentReactions =
                reactionsResponse.data as unknown as CommentReaction[];
            }
          }
        } catch (error) {
          core.debug(
            `Could not fetch comment reactions for snooze check: ${error}`,
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      core.warning(
        `Could not look up existing TrustBridge comment, falling back to a new comment: ${message}`,
      );
    }
  }

  // Check snooze state (Issue #155, Issue #227)
  if (existingCommentId && snoozeWindowMs > 0 && !forceComment) {
    const lastMarker = parseSnoozeMarker(existingCommentBody);

    // Determine if current check is passing by looking at body content
    // The snooze marker we just added to body indicates 'pass' or 'fail'
    const currentPassed = body.includes(
      "<!-- trustbridge-action:snooze:status=pass",
    );

    const snoozeState = evaluateCombinedSnoozeState(
      currentPassed,
      lastMarker,
      existingCommentReactions,
      snoozeWindowMs,
    );

    if (snoozeState.isSnoozed) {
      core.info(
        `Snooze window active (${Math.round((snoozeState.elapsedMs ?? 0) / 1000)}s elapsed). Suppressing comment update. Outputs remain updated.`,
      );
      return existingCommentId
        ? `https://github.com/${owner}/${repo}/issues/${issueNumber}#issuecomment-${existingCommentId}`
        : undefined;
    }
  }

  if (existingCommentId) {
    try {
      const response = await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existingCommentId,
        body,
      });
      core.info(
        `Updated existing TrustBridge comment on issue #${issueNumber}.`,
      );
      return response.data.html_url;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      core.warning(
        `Could not update existing TrustBridge comment (id=${existingCommentId}), falling back to a new comment: ${message}`,
      );
    }
  }

  // reply mode (#322): find the first TrustBridge comment and post a new
  // top-level comment that references it. GitHub's issue comment API does not
  // have a native `in_reply_to` for issue comments (only PR review comments
  // support that), so we prepend a contextual reference line so readers can
  // follow the chain. When no prior comment exists, falls through to a plain
  // new comment.
  if (effectiveMode === 'reply') {
    let parentId: number | undefined;
    try {
      parentId = await findStickyComment(octokit, owner, repo, issueNumber);
    } catch (error) {
      core.debug(`reply mode: could not find parent comment: ${error}`);
    }
    const replyBody = parentId
      ? `> _Reply to [TrustBridge check #${parentId}](https://github.com/${owner}/${repo}/issues/${issueNumber}#issuecomment-${parentId})_\n\n${body}`
      : body;

    const replyResponse = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: replyBody,
    });
    core.info(
      `Posted TrustBridge reply comment on issue #${issueNumber}${parentId ? ` (reply to #${parentId})` : ''}.`,
    );
    return replyResponse.data.html_url;
  }

  const response = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });

  core.info(`Posted TrustBridge comment on issue #${issueNumber}`);
  return response.data.html_url;
}

// ---------------------------------------------------------------------------
// GitHub Discussions comment path (Issue #221)
//
// Discussion events carry a GraphQL node id (e.g. "DIC_...") instead of an
// issue number. The REST issues API 404s on a discussion node id — or, worse,
// comments on the wrong issue when the id happens to be numeric. TrustBridge
// therefore posts discussion comments exclusively through the GraphQL
// `addDiscussionComment` / `updateDiscussionComment` mutations and never falls
// back to the REST issues API for discussion events.
// ---------------------------------------------------------------------------

/**
 * Extract the GitHub Discussion node id from an event payload, if present.
 *
 * Discussion webhook events (`discussion`, `discussion_comment`) embed the
 * discussion under `payload.discussion.node_id`. Returns `undefined` for
 * non-discussion events so callers can route between the issue (REST) and
 * discussion (GraphQL) comment paths.
 *
 * @internal Exported for testing.
 */
export function resolveDiscussionNodeId(payload: unknown): string | undefined {
  if (payload && typeof payload === "object") {
    const discussion = (payload as { discussion?: { node_id?: unknown } })
      .discussion;
    const nodeId = discussion?.node_id;
    if (typeof nodeId === "string" && nodeId.trim()) {
      return nodeId.trim();
    }
  }
  return undefined;
}

export interface UpsertDiscussionCommentOptions extends UpsertCommentOptions {
  /**
   * Explicit discussion node id (e.g. "DIC_kw..."). When omitted, the id is
   * resolved from `github.context.payload.discussion.node_id`.
   */
  discussionId?: string;
}

interface DiscussionCommentNode {
  id: string;
  body: string;
  reactions?: {
    nodes?: CommentReaction[];
  };
}

interface DiscussionCommentsPage {
  node: {
    comments: {
      nodes: DiscussionCommentNode[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  } | null;
}

interface DiscussionCommentMutationResult {
  updateDiscussionComment?: { comment: { url: string } };
  addDiscussionComment?: { comment: { url: string } };
}

/**
 * Find TrustBridge's previous sticky comment on a discussion, if any.
 *
 * Paginates through every discussion comment (100 per page) so the marker is
 * found even on high-traffic threads — same semantics as `findStickyComment`
 * for issues. Matches on the current versioned marker, the legacy marker, and
 * the action footer so comments posted by older releases are still eligible
 * for upsert.
 */
export async function findStickyDiscussionComment(
  octokit: Octokit,
  discussionId: string,
  options: FindStickyCommentOptions = {},
): Promise<DiscussionCommentNode | undefined> {
  const maxPages = options.maxPages ?? MAX_STICKY_COMMENT_SEARCH_PAGES;
  const query = `
    query FindTrustBridgeDiscussionComment($discussionId: ID!, $cursor: String) {
      node(id: $discussionId) {
        ... on Discussion {
          comments(first: 100, after: $cursor) {
            nodes {
              id
              body
              reactions(first: 100) {
                nodes {
                  content
                  createdAt
                  user {
                    login
                  }
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }
  `;

  let cursor: string | null = null;
  let lastMatch: DiscussionCommentNode | undefined;
  let pageCount = 0;

  while (pageCount < maxPages) {
    pageCount++;
    const data = (await octokit.graphql(query, {
      discussionId,
      cursor,
    })) as DiscussionCommentsPage;

    const comments = data?.node?.comments;
    if (!comments) {
      // Discussion was deleted or the token cannot read it — stop paginating.
      break;
    }

    for (const comment of comments.nodes) {
      if (isTrustBridgeComment(comment.body)) {
        // Use the last matching comment so that if multiple TrustBridge
        // comments exist (e.g. sticky was toggled off then on), we upsert
        // the most recent one.
        lastMatch = comment;
      }
    }

    if (!comments.pageInfo.hasNextPage || !comments.pageInfo.endCursor) {
      break;
    }
    cursor = comments.pageInfo.endCursor;
  }

  return lastMatch;
}

/**
 * Post (or sticky-upsert) a TrustBridge comment on a GitHub Discussion via
 * the GraphQL API.
 *
 * Discussion events have a node id, not an issue number, so this path never
 * touches the REST issues API. When `sticky` is enabled the previous
 * TrustBridge comment on the discussion is updated in place via
 * `updateDiscussionComment`; otherwise a new comment is created via
 * `addDiscussionComment`.
 *
 * Requires `discussions: write` permission on the workflow token (documented
 * in docs/USAGE.md). A missing permission surfaces as a GraphQL mutation
 * error, which the caller is expected to catch and downgrade to a warning —
 * comment posting must never fail the run.
 *
 * @returns The URL of the created/updated discussion comment, or `undefined`
 *          when there is no discussion context in the event payload.
 */
export async function postDiscussionComment(
  token: string,
  body: string,
  options: UpsertDiscussionCommentOptions = {},
): Promise<string | undefined> {
  const sticky = options.sticky ?? true;
  const forceComment = options.forceComment ?? false;
  const snoozeWindowMs = options.snoozeWindowMs ?? 0;
  const context = github.context;
  const discussionId =
    options.discussionId ?? resolveDiscussionNodeId(context.payload);

  if (!discussionId) {
    core.warning(
      "No discussion context found — skipping comment. Run this action on a `discussion` event (the payload must include discussion.node_id).",
    );
    return undefined;
  }

  const octokit = github.getOctokit(token, { baseUrl: context.apiUrl });

  let existingComment: DiscussionCommentNode | undefined;
  if (sticky) {
    try {
      existingComment = await findStickyDiscussionComment(
        octokit,
        discussionId,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      core.warning(
        `Could not look up existing TrustBridge discussion comment, falling back to a new comment: ${message}`,
      );
    }
  }

  // Check snooze state (Issue #155, Issue #227) — mirrors the issue-comment path.
  if (existingComment && snoozeWindowMs > 0 && !forceComment) {
    const lastMarker = parseSnoozeMarker(existingComment.body);
    const currentPassed = body.includes(
      "<!-- trustbridge-action:snooze:status=pass",
    );
    const snoozeState = evaluateCombinedSnoozeState(
      currentPassed,
      lastMarker,
      existingComment.reactions?.nodes,
      snoozeWindowMs,
    );

    if (snoozeState.isSnoozed) {
      core.info(
        `Snooze window active (${Math.round((snoozeState.elapsedMs ?? 0) / 1000)}s elapsed). Suppressing discussion comment update. Outputs remain updated.`,
      );
      return undefined;
    }
  }

  if (existingComment) {
    try {
      const data = (await octokit.graphql(
        `mutation UpdateTrustBridgeDiscussionComment($commentId: ID!, $body: String!) {
          updateDiscussionComment(input: { commentId: $commentId, body: $body }) {
            comment { id url }
          }
        }`,
        { commentId: existingComment.id, body },
      )) as DiscussionCommentMutationResult;
      const url = data.updateDiscussionComment?.comment.url;
      core.info(
        `Updated existing TrustBridge comment on discussion ${discussionId}.`,
      );
      return url;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      core.warning(
        `Could not update existing TrustBridge discussion comment (id=${existingComment.id}), falling back to a new comment: ${message}`,
      );
    }
  }

  const data = (await octokit.graphql(
    `mutation AddTrustBridgeDiscussionComment($discussionId: ID!, $body: String!) {
      addDiscussionComment(input: { discussionId: $discussionId, body: $body }) {
        comment { id url }
      }
    }`,
    { discussionId, body },
  )) as DiscussionCommentMutationResult;

  core.info(`Posted TrustBridge comment on discussion ${discussionId}.`);
  return data.addDiscussionComment?.comment.url;
}
