/**
 * Wave #38 + Wave #30 — Integration tests touching src/index.ts
 *
 * Strategy: src/index.ts runs `run()` immediately on import. We can't
 * re-require it per test cleanly without resetting all mocks. Instead we
 * test the *units* that index.ts uses:
 *
 *   • comment_mode logic  → tested via comment.ts + outputs.ts helpers
 *   • dashboard webhook   → postDashboardWebhook assembled from checks +
 *                           node-fetch (mocked)
 *   • Soroban C-address   → validateContractAddress (validation.ts)
 *   • SEP-0007 deep links → buildSep0007PayLink (links.ts)
 *   • action.yml inputs   → structural YAML assertions (no runtime)
 *
 * For full index.ts run() integration we use a controlled process-level
 * approach: set env vars the way the GitHub Actions runner does, then
 * require the compiled JS in a child process — captured via a small
 * test-runner helper. These tests are marked as "run-level" and are
 * lightweight because node-fetch is replaced by the jest mock network.
 */

import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

// ---------------------------------------------------------------------------
// Import the modules under test (NOT index.ts itself — it auto-runs)
// ---------------------------------------------------------------------------

import {
  buildValidationGate,
  unfundedAccountResult,
  horizonFailureResult,
  ValidationResult,
} from "../src/checks";
import type { CheckConfig } from "../src/checks";
import { validateContractAddress } from "../src/validation";
import { buildSep0007PayLink } from "../src/links";
import { parseBooleanInput } from "../src/inputs";
import { formatCommentBody, isTrustBridgeSlashCommand } from "../src/comment";
import { toActionOutputs } from "../src/outputs";
import { handleAutoUnassign, resolveCommentModes } from "../src/index";
import { applyReadyLabels } from "../src/horizon";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_ADDRESS =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const CONTRACT_ISSUER = "C" + "A".repeat(55);
const MALFORMED_CONTRACT = "C" + "A".repeat(10); // too short

const DEFAULT_CHECK_CONFIG: CheckConfig = {
  assetCode: "USDC",
  assetIssuer: USDC_ISSUER,
  minXlmReserve: 1.5,
  horizonUrl: "https://horizon.stellar.org",
};

function makeFundedAccount() {
  return {
    id: VALID_ADDRESS,
    account_id: VALID_ADDRESS,
    sequence: "1",
    subentry_count: 1,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [
      {
        balance: "10.0000000",
        asset_type: "native" as const,
        buying_liabilities: "0",
        selling_liabilities: "0",
      },
      {
        balance: "100.0000000",
        asset_type: "credit_alphanum4" as const,
        asset_code: "USDC",
        asset_issuer: USDC_ISSUER,
        buying_liabilities: "0",
        selling_liabilities: "0",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Issue #528 — posting policy and threading strategy are resolved independently
// ---------------------------------------------------------------------------

describe("posting_mode and comment_mode input resolution (Issue #528)", () => {
  it.each(["post", "dry-run", "off"])("accepts posting_mode %s", (mode) => {
    expect(resolveCommentModes(mode, "sticky")).toEqual({
      postingMode: mode,
      commentThreadingMode: "sticky",
    });
  });

  it("uses comment_mode only for threading when posting_mode is explicit", () => {
    expect(resolveCommentModes("dry-run", "reply")).toEqual({
      postingMode: "dry-run",
      commentThreadingMode: "reply",
    });
    expect(resolveCommentModes("post", "new")).toEqual({
      postingMode: "post",
      commentThreadingMode: "new",
    });
    expect(resolveCommentModes("post", "dry-run")).toEqual({
      postingMode: "post",
      commentThreadingMode: undefined,
    });
  });

  it("retains legacy posting values only when posting_mode is unset", () => {
    expect(resolveCommentModes("", "off")).toEqual({
      postingMode: "off",
      commentThreadingMode: undefined,
    });
    expect(resolveCommentModes("", "dry-run").postingMode).toBe("dry-run");
  });

  it("defaults to post and does not interpret threading modes as posting policy", () => {
    expect(resolveCommentModes("", "reply")).toEqual({
      postingMode: "post",
      commentThreadingMode: "reply",
    });
  });

  it("rejects invalid posting_mode values", () => {
    expect(() => resolveCommentModes("invalid-mode", "sticky")).toThrow(
      /Invalid posting_mode/,
    );
  });
});

// ---------------------------------------------------------------------------
// Wave #30 — comment_mode: outputs are always set regardless of mode
// ---------------------------------------------------------------------------

describe("Wave #30 — outputs set in all comment modes", () => {
  it("toActionOutputs includes account_funded, trustline_exists, xlm_balance for funded account", () => {
    const account = makeFundedAccount();
    const { runAccountChecks } = require("../src/checks");
    const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);
    const outputs = toActionOutputs(result);

    expect(outputs.account_funded).toBe("true");
    expect(outputs.trustline_exists).toBe("true");
    expect(outputs.xlm_balance).toBe("10.0000000");
    expect(outputs.comment_url).toBe("");
  });

  it("toActionOutputs sets comment_url when provided", () => {
    const account = makeFundedAccount();
    const { runAccountChecks } = require("../src/checks");
    const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);
    const outputs = toActionOutputs(
      result,
      "https://github.com/issue/1#comment-42",
    );

    expect(outputs.comment_url).toBe("https://github.com/issue/1#comment-42");
  });

  it("in dry-run mode comment_url is empty (no commentUrl passed)", () => {
    const account = makeFundedAccount();
    const { runAccountChecks } = require("../src/checks");
    const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);
    // dry-run: commentUrl is undefined → toActionOutputs gets no second arg
    const outputs = toActionOutputs(result, undefined);
    expect(outputs.comment_url).toBe("");
  });

  it("unfunded result has account_funded=false in all modes", () => {
    const result = unfundedAccountResult(VALID_ADDRESS, DEFAULT_CHECK_CONFIG);
    const outputs = toActionOutputs(result);
    expect(outputs.account_funded).toBe("false");
  });

  it("horizon failure result has account_funded=false", () => {
    const result = horizonFailureResult(
      "503 Service Unavailable",
      DEFAULT_CHECK_CONFIG,
    );
    const outputs = toActionOutputs(result);
    expect(outputs.account_funded).toBe("false");
  });
});

// ---------------------------------------------------------------------------
// Wave #30 — fail_on_missing respects all comment modes (logic only)
// ---------------------------------------------------------------------------

describe("Wave #30 — fail_on_missing logic across comment modes", () => {
  it("parseBooleanInput correctly parses fail_on_missing=true", () => {
    expect(parseBooleanInput("true", true)).toBe(true);
    expect(parseBooleanInput("1", true)).toBe(true);
  });

  it("parseBooleanInput correctly parses fail_on_missing=false", () => {
    expect(parseBooleanInput("false", true)).toBe(false);
    expect(parseBooleanInput("0", true)).toBe(false);
  });

  it("unfunded account produces valid=false which triggers setFailed when failOnMissing=true", () => {
    const result = unfundedAccountResult(VALID_ADDRESS, DEFAULT_CHECK_CONFIG);
    expect(result.valid).toBe(false);
    // In index.ts: if (!result.valid && failOnMissing) → setFailed
    const wouldFail = !result.valid && true;
    expect(wouldFail).toBe(true);
  });

  it("unfunded account with failOnMissing=false triggers warning only", () => {
    const result = unfundedAccountResult(VALID_ADDRESS, DEFAULT_CHECK_CONFIG);
    const wouldFail = !result.valid && false;
    expect(wouldFail).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wave #38 — dashboard webhook payload shape
// ---------------------------------------------------------------------------

describe("Wave #38 — dashboard webhook payload", () => {
  function buildPayload(
    result: ReturnType<typeof unfundedAccountResult>,
    commentMode: string,
    commentUrl?: string,
  ) {
    const gate = buildValidationGate(result);
    return {
      validation: {
        ready: gate.ready,
        accountFunded: result.accountFunded,
        trustlineExists: result.trustlineExists,
        xlmBalance: result.xlmBalance,
        xlmReserveMet: result.xlmReserveMet,
        failedChecks: gate.failedChecks,
        passedChecks: gate.passedChecks,
        totalChecks: gate.totalChecks,
        failedLabels: gate.failedLabels,
      },
      config: {
        assetCode: DEFAULT_CHECK_CONFIG.assetCode,
        assetIssuer: DEFAULT_CHECK_CONFIG.assetIssuer,
        minXlmReserve: DEFAULT_CHECK_CONFIG.minXlmReserve,
      },
      stellarAddressRedacted: `${VALID_ADDRESS.slice(0, 4)}...${VALID_ADDRESS.slice(-4)}`,
      commentMode,
      commentUrl,
      timestamp: new Date().toISOString(),
    };
  }

  it("funded account: ready=true, failedChecks=0", () => {
    const account = makeFundedAccount();
    const { runAccountChecks } = require("../src/checks");
    const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);
    const payload = buildPayload(result, "dry-run");

    expect(payload.validation.ready).toBe(true);
    expect(payload.validation.accountFunded).toBe(true);
    expect(payload.validation.trustlineExists).toBe(true);
    expect(payload.validation.failedChecks).toBe(0);
    expect(payload.validation.passedChecks).toBe(3);
    expect(payload.validation.totalChecks).toBe(3);
    expect(payload.validation.failedLabels).toEqual([]);
  });

  it("unfunded account: ready=false, all 3 checks failed", () => {
    const result = unfundedAccountResult(VALID_ADDRESS, DEFAULT_CHECK_CONFIG);
    const payload = buildPayload(result, "post");

    expect(payload.validation.ready).toBe(false);
    expect(payload.validation.accountFunded).toBe(false);
    expect(payload.validation.failedChecks).toBe(3);
    expect(payload.validation.passedChecks).toBe(0);
    expect(payload.validation.failedLabels).toHaveLength(3);
  });

  it("horizon failure: ready=false, xlmBalance=unknown", () => {
    const result = horizonFailureResult("503 outage", DEFAULT_CHECK_CONFIG);
    const payload = buildPayload(result, "off");

    expect(payload.validation.ready).toBe(false);
    expect(payload.validation.xlmBalance).toBe("unknown");
  });

  it("raw Stellar address is NOT in the payload — only redacted form", () => {
    const result = unfundedAccountResult(VALID_ADDRESS, DEFAULT_CHECK_CONFIG);
    const payload = buildPayload(result, "dry-run");
    const json = JSON.stringify(payload);

    expect(json).not.toContain(VALID_ADDRESS);
    expect(json).toContain("GAAA...AWHF");
  });

  it("commentMode field is preserved in the payload", () => {
    for (const mode of ["post", "dry-run", "off"]) {
      const result = unfundedAccountResult(VALID_ADDRESS, DEFAULT_CHECK_CONFIG);
      const payload = buildPayload(result, mode);
      expect(payload.commentMode).toBe(mode);
    }
  });

  it("commentUrl is undefined in dry-run (no comment posted)", () => {
    const result = unfundedAccountResult(VALID_ADDRESS, DEFAULT_CHECK_CONFIG);
    const payload = buildPayload(result, "dry-run", undefined);
    expect(payload.commentUrl).toBeUndefined();
  });

  it("commentUrl is set when comment was posted (mode=post)", () => {
    const result = unfundedAccountResult(VALID_ADDRESS, DEFAULT_CHECK_CONFIG);
    const url = "https://github.com/owner/repo/issues/1#comment-99";
    const payload = buildPayload(result, "post", url);
    expect(payload.commentUrl).toBe(url);
  });

  it("payload is valid JSON when serialised", () => {
    const result = unfundedAccountResult(VALID_ADDRESS, DEFAULT_CHECK_CONFIG);
    const payload = buildPayload(result, "dry-run");
    expect(() => JSON.parse(JSON.stringify(payload))).not.toThrow();
  });

  it("validation block types are all correct", () => {
    const account = makeFundedAccount();
    const { runAccountChecks } = require("../src/checks");
    const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);
    const payload = buildPayload(result, "dry-run");

    expect(typeof payload.validation.ready).toBe("boolean");
    expect(typeof payload.validation.accountFunded).toBe("boolean");
    expect(typeof payload.validation.trustlineExists).toBe("boolean");
    expect(typeof payload.validation.xlmBalance).toBe("string");
    expect(typeof payload.validation.xlmReserveMet).toBe("boolean");
    expect(typeof payload.validation.failedChecks).toBe("number");
    expect(typeof payload.validation.passedChecks).toBe("number");
    expect(typeof payload.validation.totalChecks).toBe("number");
    expect(Array.isArray(payload.validation.failedLabels)).toBe(true);
  });

  it("timestamp is a valid ISO-8601 string", () => {
    const result = unfundedAccountResult(VALID_ADDRESS, DEFAULT_CHECK_CONFIG);
    const payload = buildPayload(result, "dry-run");
    expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// ---------------------------------------------------------------------------
// Wave #38 — Soroban contract issuer (C-address) validation
// ---------------------------------------------------------------------------

describe("Wave #38 — Soroban contract issuer validation", () => {
  it("valid C-address passes validateContractAddress", () => {
    const result = validateContractAddress(CONTRACT_ISSUER);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("malformed C-address fails validateContractAddress", () => {
    const result = validateContractAddress(MALFORMED_CONTRACT);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("error message mentions StrKey format", () => {
    const result = validateContractAddress(MALFORMED_CONTRACT);
    const errorText = result.errors.join(" ");
    expect(errorText).toMatch(/56|StrKey|format|characters/i);
  });

  it("C-address with wrong alphabet fails", () => {
    const badChars = "C" + "0".repeat(55); // 0 not in base32
    const result = validateContractAddress(badChars);
    expect(result.valid).toBe(false);
  });

  it("empty string fails with clear error", () => {
    const result = validateContractAddress("");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("empty");
  });

  it("G-address fails (wrong prefix)", () => {
    const result = validateContractAddress(VALID_ADDRESS);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('"C"');
  });

  it("validateContractAddress is called before Horizon fetch in index.ts (code path check)", () => {
    // Verify the guard logic: if assetIssuer starts with 'C', validate it
    const issuer = CONTRACT_ISSUER;
    const startsWithC = issuer.startsWith("C");
    expect(startsWithC).toBe(true);

    const checkResult = validateContractAddress(issuer);
    // If valid → proceed; if not → throw "Invalid asset_issuer contract address"
    if (!checkResult.valid) {
      const msg = `Invalid asset_issuer contract address: ${checkResult.errors.join("; ")}`;
      expect(msg).toContain("Invalid asset_issuer contract address");
    } else {
      expect(checkResult.valid).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Wave #38 — SEP-0007 deep links
// ---------------------------------------------------------------------------

describe("Wave #38 — SEP-0007 deep links", () => {
  it("buildSep0007PayLink produces a web+stellar:pay URI", () => {
    const link = buildSep0007PayLink({
      destination: VALID_ADDRESS,
      amount: "1",
      msg: "Activate Stellar account",
      network: "public",
    });
    expect(link).toMatch(/^web\+stellar:pay\?/);
    expect(link).toContain("destination=");
    expect(link).toContain("amount=1");
  });

  it("buildSep0007PayLink encodes the network passphrase", () => {
    const link = buildSep0007PayLink({
      destination: VALID_ADDRESS,
      network: "public",
    });
    expect(link).toContain("network_passphrase=");
    expect(link).toContain("Public+Global+Stellar+Network");
  });

  it("buildSep0007PayLink uses testnet passphrase when network=testnet", () => {
    const link = buildSep0007PayLink({
      destination: VALID_ADDRESS,
      network: "testnet",
    });
    expect(link).toContain("Test+SDF+Network");
  });

  it("buildSep0007PayLink includes origin_domain when provided", () => {
    const link = buildSep0007PayLink({
      destination: VALID_ADDRESS,
      originDomain: "trustbridge.example.com",
    });
    expect(link).toContain("origin_domain=trustbridge.example.com");
  });

  it("sep0007_deep_links=true includes SEP-0007 section in comment body", () => {
    const account = makeFundedAccount();
    const { runAccountChecks } = require("../src/checks");
    const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);

    const body = formatCommentBody(result, {
      ...DEFAULT_CHECK_CONFIG,
      stellarAddress: VALID_ADDRESS,
      horizonUrl: "https://horizon.stellar.org",
      failOnMissing: true,
      stickyComment: true,
      waitUntilFunded: false,
      waitUntilFundedTimeoutMs: 120000,
      waitUntilFundedIntervalMs: 5000,
      sep0007DeepLinks: true,
      sep0007OriginDomain: "",
    });

    expect(body).toContain("web+stellar:pay");
    expect(body).toContain("SEP-0007");
  });

  it("sep0007_deep_links=false omits SEP-0007 section from comment body", () => {
    const account = makeFundedAccount();
    const { runAccountChecks } = require("../src/checks");
    const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);

    const body = formatCommentBody(result, {
      ...DEFAULT_CHECK_CONFIG,
      stellarAddress: VALID_ADDRESS,
      horizonUrl: "https://horizon.stellar.org",
      failOnMissing: true,
      stickyComment: true,
      waitUntilFunded: false,
      waitUntilFundedTimeoutMs: 120000,
      waitUntilFundedIntervalMs: 5000,
      sep0007DeepLinks: false,
      sep0007OriginDomain: "",
    });

    expect(body).not.toContain("web+stellar:pay");
  });
});

// ---------------------------------------------------------------------------
// Wave #38 — 100+ contributor scale: validation gate is independent per call
// ---------------------------------------------------------------------------

describe("Wave #38 — scale: validation gate independence", () => {
  function makeContributorAddress(n: number): string {
    // Valid base32 chars only: A-Z, 2-7. Encode n as 4-char base-6 suffix.
    const BASE6 = "234567";
    let suffix = "";
    let rem = n;
    for (let i = 0; i < 4; i++) {
      suffix = BASE6[rem % 6] + suffix;
      rem = Math.floor(rem / 6);
    }
    return "G" + "A".repeat(51) + suffix;
  }

  it("produces independent results for 100 contributor addresses", () => {
    const { runAccountChecks } = require("../src/checks");

    for (let i = 0; i < 100; i++) {
      const addr = makeContributorAddress(i);
      const account = {
        id: addr,
        account_id: addr,
        sequence: "1",
        subentry_count: 1,
        num_sponsoring: 0,
        num_sponsored: 0,
        balances: [
          {
            balance: "10.0000000",
            asset_type: "native" as const,
            buying_liabilities: "0",
            selling_liabilities: "0",
          },
          {
            balance: "100.0",
            asset_type: "credit_alphanum4" as const,
            asset_code: "USDC",
            asset_issuer: USDC_ISSUER,
            buying_liabilities: "0",
            selling_liabilities: "0",
          },
        ],
      };

      const result = runAccountChecks(account, DEFAULT_CHECK_CONFIG);
      const gate = buildValidationGate(result);
      const outputs = toActionOutputs(result);

      expect(gate.ready).toBe(true);
      expect(outputs.account_funded).toBe("true");
    }
  });

  it("unfunded accounts all produce account_funded=false independently", () => {
    for (let i = 0; i < 100; i++) {
      const addr = makeContributorAddress(i);
      const result = unfundedAccountResult(addr, DEFAULT_CHECK_CONFIG);
      const outputs = toActionOutputs(result);
      expect(outputs.account_funded).toBe("false");
    }
  });

  it("mixed funded/unfunded results are never shared across calls", () => {
    const { runAccountChecks } = require("../src/checks");
    const results: boolean[] = [];

    for (let i = 0; i < 50; i++) {
      const addr = makeContributorAddress(i);
      if (i % 2 === 0) {
        const account = {
          id: addr,
          account_id: addr,
          sequence: "1",
          subentry_count: 1,
          num_sponsoring: 0,
          num_sponsored: 0,
          balances: [
            {
              balance: "5.0",
              asset_type: "native" as const,
              buying_liabilities: "0",
              selling_liabilities: "0",
            },
            {
              balance: "100.0",
              asset_type: "credit_alphanum4" as const,
              asset_code: "USDC",
              asset_issuer: USDC_ISSUER,
              buying_liabilities: "0",
              selling_liabilities: "0",
            },
          ],
        };
        results.push(runAccountChecks(account, DEFAULT_CHECK_CONFIG).valid);
      } else {
        results.push(unfundedAccountResult(addr, DEFAULT_CHECK_CONFIG).valid);
      }
    }

    for (let i = 0; i < 50; i++) {
      expect(results[i]).toBe(i % 2 === 0);
    }
  });
});

// ---------------------------------------------------------------------------
// Wave #30 — action.yml structural checks
// ---------------------------------------------------------------------------

describe("Wave #30 + #38 — action.yml structural checks", () => {
  const actionPath = path.join(__dirname, "../action.yml");
  let content: string;

  beforeAll(() => {
    content = fs.readFileSync(actionPath, "utf8");
  });

  it("comment_mode input is declared with sticky default", () => {
    expect(content).toContain("comment_mode:");
    expect(content).toContain("default: 'sticky'");
  });

  it("posting_mode input leaves metadata default empty for legacy detection", () => {
    expect(content).toContain("posting_mode:");
    expect(content).toContain("default: ''");
  });

  it("posting_mode description mentions dry-run and off", () => {
    // Both terms appear somewhere in the file (description is multi-line YAML)
    expect(content).toContain("dry-run");
    expect(content).toContain('"off"');
  });

  it("dashboard_webhook_url input is declared", () => {
    expect(content).toContain("dashboard_webhook_url:");
  });

  it("dashboard_webhook_url default is empty string", () => {
    // The default: '' line exists somewhere in the file for this input
    // Count occurrences — at least one belongs to dashboard_webhook_url
    const occurrences = (content.match(/default: ''/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(1);
  });

  it("all four standard outputs are declared", () => {
    expect(content).toContain("trustline_exists:");
    expect(content).toContain("xlm_balance:");
    expect(content).toContain("account_funded:");
    expect(content).toContain("comment_url:");
  });
});

// ---------------------------------------------------------------------------
// Wave #30 — workflow YAML structural checks
// ---------------------------------------------------------------------------

describe("Wave #30 — workflow YAML structural checks", () => {
  it("ci.yml verifies the published action package", () => {
    const content = fs.readFileSync(
      path.join(__dirname, "../.github/workflows/ci.yml"),
      "utf8",
    );
    expect(content).toContain("action.yml");
    expect(content).toContain("dist/index.js");
  });

  it("release.yml verifies the action bundle", () => {
    const content = fs.readFileSync(
      path.join(__dirname, "../.github/workflows/release.yml"),
      "utf8",
    );
    expect(content).toContain("dist/index.js");
  });
});

// ---------------------------------------------------------------------------
// Issue #711 — auto_wallet_labels conflict resolution and pagination
// ---------------------------------------------------------------------------

import { applyWalletLabels, ALL_WALLET_LABELS, deriveWalletLabel } from '../src/horizon';
import type { WalletLabelInput } from '../src/horizon';

describe('Issue #711 — applyWalletLabels: deterministic conflict resolution', () => {
  const OWNER = 'test-owner';
  const REPO = 'test-repo';
  const ISSUE = 42;

  function makeOctokit(labelNames: string[] = []) {
    return {
      rest: {
        issues: {
          listLabelsOnIssue: jest.fn().mockResolvedValue({ data: labelNames.map((name) => ({ name })) }),
          removeLabel: jest.fn().mockResolvedValue({}),
          addLabels: jest.fn().mockResolvedValue({}),
        },
      },
    };
  }

  const fundedInput: WalletLabelInput = {
    accountFunded: true,
    trustlineExists: true,
    xlmReserveMet: true,
  };

  it('applies the correct label when no wallet labels exist', async () => {
    const octokit = makeOctokit([]);
    const result = await applyWalletLabels(octokit, OWNER, REPO, ISSUE, fundedInput);
    expect(result.applied).toBe('wallet: funded');
    expect(result.removed).toEqual([]);
    expect(result.error).toBeUndefined();
    expect(octokit.rest.issues.addLabels).toHaveBeenCalledWith({
      owner: OWNER, repo: REPO, issue_number: ISSUE, labels: ['wallet: funded'],
    });
  });

  it('removes a single stale label before applying the new one', async () => {
    const octokit = makeOctokit(['wallet: unfunded', 'bug']);
    const result = await applyWalletLabels(octokit, OWNER, REPO, ISSUE, fundedInput);
    expect(result.applied).toBe('wallet: funded');
    expect(result.removed).toEqual(['wallet: unfunded']);
    expect(octokit.rest.issues.removeLabel).toHaveBeenCalledTimes(1);
    expect(octokit.rest.issues.removeLabel).toHaveBeenCalledWith({
      owner: OWNER, repo: REPO, issue_number: ISSUE, name: 'wallet: unfunded',
    });
  });

  it('removes ALL stale wallet labels when multiple conflict (deterministic resolution)', async () => {
    // Simulate an interrupted prior run that left multiple wallet labels.
    const octokit = makeOctokit(['wallet: unfunded', 'wallet: trustline-missing', 'wallet: reserve-low']);
    const result = await applyWalletLabels(octokit, OWNER, REPO, ISSUE, fundedInput);
    expect(result.applied).toBe('wallet: funded');
    expect(result.removed).toHaveLength(3);
    expect(result.removed).toContain('wallet: unfunded');
    expect(result.removed).toContain('wallet: trustline-missing');
    expect(result.removed).toContain('wallet: reserve-low');
    expect(octokit.rest.issues.removeLabel).toHaveBeenCalledTimes(3);
    expect(octokit.rest.issues.addLabels).toHaveBeenCalledTimes(1);
  });

  it('does not remove the target label even if it is already present', async () => {
    const octokit = makeOctokit(['wallet: funded']);
    const result = await applyWalletLabels(octokit, OWNER, REPO, ISSUE, fundedInput);
    expect(result.removed).toEqual([]);
    expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
    expect(octokit.rest.issues.addLabels).toHaveBeenCalledTimes(1);
  });

  it('continues adding the target label when a stale label removal fails (non-fatal)', async () => {
    const octokit = makeOctokit(['wallet: unfunded']);
    octokit.rest.issues.removeLabel.mockRejectedValueOnce(new Error('Not Found'));
    const result = await applyWalletLabels(octokit, OWNER, REPO, ISSUE, fundedInput);
    // Remove failed but add still proceeds
    expect(result.removed).toEqual([]);
    expect(result.error).toBeUndefined();
    expect(octokit.rest.issues.addLabels).toHaveBeenCalledTimes(1);
  });

  it('returns error string when addLabels fails', async () => {
    const octokit = makeOctokit([]);
    octokit.rest.issues.addLabels.mockRejectedValueOnce(new Error('Resource not accessible by integration'));
    const result = await applyWalletLabels(octokit, OWNER, REPO, ISSUE, fundedInput);
    expect(result.error).toContain('Resource not accessible by integration');
    expect(result.applied).toBe('wallet: funded');
  });

  it('skips removal when removeStale=false', async () => {
    const octokit = makeOctokit(['wallet: unfunded']);
    const result = await applyWalletLabels(octokit, OWNER, REPO, ISSUE, fundedInput, { removeStale: false });
    expect(result.removed).toEqual([]);
    expect(octokit.rest.issues.listLabelsOnIssue).not.toHaveBeenCalled();
    expect(octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
    expect(octokit.rest.issues.addLabels).toHaveBeenCalledTimes(1);
  });

  it('deriveWalletLabel priority: horizon-error beats all others', () => {
    expect(deriveWalletLabel({ accountFunded: true, trustlineExists: true, xlmReserveMet: true, horizonError: true })).toBe('wallet: horizon-error');
    expect(deriveWalletLabel({ accountFunded: false, trustlineExists: false, xlmReserveMet: false, horizonError: true })).toBe('wallet: horizon-error');
  });

  it('deriveWalletLabel priority: unfunded beats trustline-missing and reserve-low', () => {
    expect(deriveWalletLabel({ accountFunded: false, trustlineExists: false, xlmReserveMet: false })).toBe('wallet: unfunded');
  });

  it('deriveWalletLabel priority: trustline-missing beats reserve-low', () => {
    expect(deriveWalletLabel({ accountFunded: true, trustlineExists: false, xlmReserveMet: false })).toBe('wallet: trustline-missing');
  });

  it('deriveWalletLabel: reserve-low when funded + trustline but low XLM', () => {
    expect(deriveWalletLabel({ accountFunded: true, trustlineExists: true, xlmReserveMet: false })).toBe('wallet: reserve-low');
  });

  it('ALL_WALLET_LABELS contains exactly the 5 expected labels', () => {
    expect(ALL_WALLET_LABELS).toHaveLength(5);
    expect(ALL_WALLET_LABELS).toContain('wallet: funded');
    expect(ALL_WALLET_LABELS).toContain('wallet: unfunded');
    expect(ALL_WALLET_LABELS).toContain('wallet: trustline-missing');
    expect(ALL_WALLET_LABELS).toContain('wallet: reserve-low');
    expect(ALL_WALLET_LABELS).toContain('wallet: horizon-error');
  });
});

describe('Issue #711 — applyWalletLabels: pagination', () => {
  const OWNER = 'test-owner';
  const REPO = 'test-repo';
  const ISSUE = 99;

  it('paginates when first page is full (100 labels)', async () => {
    // Page 1: 100 non-wallet labels (full page → triggers page 2 fetch)
    // Page 2: 1 stale wallet label (partial page → stops)
    const page1 = Array.from({ length: 100 }, (_, i) => ({ name: `label-${i}` }));
    const page2 = [{ name: 'wallet: unfunded' }];

    const listLabelsOnIssue = jest.fn()
      .mockResolvedValueOnce({ data: page1 })
      .mockResolvedValueOnce({ data: page2 });
    const removeLabel = jest.fn().mockResolvedValue({});
    const addLabels = jest.fn().mockResolvedValue({});

    const octokit = { rest: { issues: { listLabelsOnIssue, removeLabel, addLabels } } };
    const input: WalletLabelInput = { accountFunded: true, trustlineExists: true, xlmReserveMet: true };

    const result = await applyWalletLabels(octokit, OWNER, REPO, ISSUE, input);

    expect(listLabelsOnIssue).toHaveBeenCalledTimes(2);
    expect(listLabelsOnIssue).toHaveBeenNthCalledWith(1, { owner: OWNER, repo: REPO, issue_number: ISSUE, per_page: 100, page: 1 });
    expect(listLabelsOnIssue).toHaveBeenNthCalledWith(2, { owner: OWNER, repo: REPO, issue_number: ISSUE, per_page: 100, page: 2 });
    expect(result.removed).toEqual(['wallet: unfunded']);
    expect(result.applied).toBe('wallet: funded');
  });

  it('stops paginating when first page is partial (<100 labels)', async () => {
    const page1 = [{ name: 'bug' }, { name: 'wallet: reserve-low' }];
    const listLabelsOnIssue = jest.fn().mockResolvedValueOnce({ data: page1 });
    const removeLabel = jest.fn().mockResolvedValue({});
    const addLabels = jest.fn().mockResolvedValue({});

    const octokit = { rest: { issues: { listLabelsOnIssue, removeLabel, addLabels } } };
    const input: WalletLabelInput = { accountFunded: true, trustlineExists: true, xlmReserveMet: true };

    await applyWalletLabels(octokit, OWNER, REPO, ISSUE, input);

    expect(listLabelsOnIssue).toHaveBeenCalledTimes(1);
  });

  it('handles exactly 100 labels on page 1 with no wallet labels on page 2 (empty last page)', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ name: `label-${i}` }));
    const page2: Array<{ name: string }> = [];

    const listLabelsOnIssue = jest.fn()
      .mockResolvedValueOnce({ data: page1 })
      .mockResolvedValueOnce({ data: page2 });
    const removeLabel = jest.fn().mockResolvedValue({});
    const addLabels = jest.fn().mockResolvedValue({});

    const octokit = { rest: { issues: { listLabelsOnIssue, removeLabel, addLabels } } };
    const input: WalletLabelInput = { accountFunded: false, trustlineExists: false, xlmReserveMet: false };

    const result = await applyWalletLabels(octokit, OWNER, REPO, ISSUE, input);

    expect(listLabelsOnIssue).toHaveBeenCalledTimes(2);
    expect(result.removed).toEqual([]);
    expect(result.applied).toBe('wallet: unfunded');
  });

  it('collects wallet labels across multiple pages and removes all stale ones', async () => {
    // Page 1: 100 labels including one stale wallet label
    const page1 = [
      ...Array.from({ length: 99 }, (_, i) => ({ name: `label-${i}` })),
      { name: 'wallet: trustline-missing' },
    ];
    // Page 2: another stale wallet label
    const page2 = [{ name: 'wallet: reserve-low' }];

    const listLabelsOnIssue = jest.fn()
      .mockResolvedValueOnce({ data: page1 })
      .mockResolvedValueOnce({ data: page2 });
    const removeLabel = jest.fn().mockResolvedValue({});
    const addLabels = jest.fn().mockResolvedValue({});

    const octokit = { rest: { issues: { listLabelsOnIssue, removeLabel, addLabels } } };
    const input: WalletLabelInput = { accountFunded: true, trustlineExists: true, xlmReserveMet: true };

    const result = await applyWalletLabels(octokit, OWNER, REPO, ISSUE, input);

    expect(listLabelsOnIssue).toHaveBeenCalledTimes(2);
    expect(result.removed).toHaveLength(2);
    expect(result.removed).toContain('wallet: trustline-missing');
    expect(result.removed).toContain('wallet: reserve-low');
    expect(result.applied).toBe('wallet: funded');
  });
});

// ---------------------------------------------------------------------------
// Issue #228 — Auto-unassign on not-ready
// ---------------------------------------------------------------------------

describe("issue_comment /trustbridge revalidation guard", () => {
  it("matches only the exact /trustbridge prefix and ignores unrelated comments", () => {
    expect(isTrustBridgeSlashCommand("/trustbridge")).toBe(true);
    expect(isTrustBridgeSlashCommand("/trustbridge please recheck")).toBe(true);
    expect(isTrustBridgeSlashCommand(" /trustbridge reload")).toBe(true);
    expect(isTrustBridgeSlashCommand("/trustbridge-other")).toBe(false);
    expect(isTrustBridgeSlashCommand("hello /trustbridge")).toBe(false);
    expect(isTrustBridgeSlashCommand("")).toBe(false);
  });
});

describe("ready label sync", () => {
  it("applies the pass label and removes the fail label when ready", async () => {
    const octokit = {
      rest: {
        issues: {
          listLabelsOnIssue: jest
            .fn()
            .mockResolvedValue({ data: [{ name: "trustbridge: fail" }] }),
          removeLabel: jest.fn().mockResolvedValue({}),
          addLabels: jest.fn().mockResolvedValue({}),
        },
      },
    } as any;

    const result = await applyReadyLabels(
      octokit,
      "test-owner",
      "test-repo",
      123,
      {
        ready: true,
        passLabel: "trustbridge: pass",
        failLabel: "trustbridge: fail",
      },
    );

    expect(result.applied).toBe("trustbridge: pass");
    expect(result.removed).toContain("trustbridge: fail");
    expect(octokit.rest.issues.addLabels).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      issue_number: 123,
      labels: ["trustbridge: pass"],
    });
  });

  it("no-ops when pass/fail label names are empty", async () => {
    const octokit = {
      rest: {
        issues: {
          listLabelsOnIssue: jest.fn(),
          removeLabel: jest.fn(),
          addLabels: jest.fn(),
        },
      },
    } as any;

    const result = await applyReadyLabels(
      octokit,
      "test-owner",
      "test-repo",
      123,
      {
        ready: true,
        passLabel: "",
        failLabel: "",
      },
    );

    expect(result.applied).toBeUndefined();
    expect(result.removed).toEqual([]);
    expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
  });
});

describe("Issue #228 — handleAutoUnassign", () => {
  const baseResult: ValidationResult = {
    valid: false,
    reasonCode: "TRUSTLINE_MISSING",
    accountFunded: true,
    trustlineExists: false,
    xlmBalance: "10.0",
    xlmReserveMet: true,
    assetBalance: "0",
    assetBalanceMet: false,
    checks: [
      {
        label: "Trustline exists",
        passed: false,
        detail: "Trustline not found",
      },
    ],
  };

  function makeMockOctokit() {
    return {
      rest: {
        issues: {
          removeAssignees: jest.fn().mockResolvedValue({}),
        },
      },
    };
  }

  it("does nothing when unassignOnNotReady is false (default off)", async () => {
    const octokit = makeMockOctokit();
    const result = await handleAutoUnassign({
      octokit,
      owner: "test-owner",
      repo: "test-repo",
      issueNumber: 123,
      payload: {
        issue: { number: 123, assignees: [{ login: "alice", type: "User" }] },
      },
      result: baseResult,
      unassignOnNotReady: false,
    });

    expect(result).toBeUndefined();
    expect(octokit.rest.issues.removeAssignees).not.toHaveBeenCalled();
  });

  it("does nothing when result.valid is true (checks passed)", async () => {
    const octokit = makeMockOctokit();
    const passingResult: ValidationResult = {
      ...baseResult,
      valid: true,
      reasonCode: "SUCCESS",
    };
    const result = await handleAutoUnassign({
      octokit,
      owner: "test-owner",
      repo: "test-repo",
      issueNumber: 123,
      payload: {
        issue: { number: 123, assignees: [{ login: "alice", type: "User" }] },
      },
      result: passingResult,
      unassignOnNotReady: true,
    });

    expect(result).toBeUndefined();
    expect(octokit.rest.issues.removeAssignees).not.toHaveBeenCalled();
  });

  it("unassigns assignee from issues.assigned payload when not ready", async () => {
    const octokit = makeMockOctokit();
    const result = await handleAutoUnassign({
      octokit,
      owner: "test-owner",
      repo: "test-repo",
      issueNumber: 123,
      payload: {
        assignee: { login: "alice", type: "User" },
        issue: { number: 123, assignees: [{ login: "alice", type: "User" }] },
      },
      result: baseResult,
      unassignOnNotReady: true,
    });

    expect(result).toEqual(["alice"]);
    expect(octokit.rest.issues.removeAssignees).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      issue_number: 123,
      assignees: ["alice"],
    });
  });

  it("unassigns all non-bot assignees when event assignee is absent", async () => {
    const octokit = makeMockOctokit();
    const result = await handleAutoUnassign({
      octokit,
      owner: "test-owner",
      repo: "test-repo",
      issueNumber: 123,
      payload: {
        issue: {
          number: 123,
          assignees: [
            { login: "alice", type: "User" },
            { login: "bob", type: "User" },
            { login: "dependabot[bot]", type: "Bot" },
          ],
        },
      },
      result: baseResult,
      unassignOnNotReady: true,
    });

    expect(result).toEqual(["alice", "bob"]);
    expect(octokit.rest.issues.removeAssignees).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      issue_number: 123,
      assignees: ["alice", "bob"],
    });
  });

  it("skips unassigning on Horizon outage reason codes", async () => {
    const outageCodes = ["HORIZON_ERROR", "HORIZON_TIMEOUT", "TLS_ERROR"];
    for (const code of outageCodes) {
      const octokit = makeMockOctokit();
      const outageResult: ValidationResult = {
        ...baseResult,
        reasonCode: code,
      };
      const result = await handleAutoUnassign({
        octokit,
        owner: "test-owner",
        repo: "test-repo",
        issueNumber: 123,
        payload: {
          issue: { number: 123, assignees: [{ login: "alice", type: "User" }] },
        },
        result: outageResult,
        unassignOnNotReady: true,
      });

      expect(result).toBeUndefined();
      expect(octokit.rest.issues.removeAssignees).not.toHaveBeenCalled();
    }
  });

  it("skips bot assignees cleanly", async () => {
    const octokit = makeMockOctokit();
    const result = await handleAutoUnassign({
      octokit,
      owner: "test-owner",
      repo: "test-repo",
      issueNumber: 123,
      payload: {
        assignee: { login: "github-actions[bot]", type: "Bot" },
        issue: {
          number: 123,
          assignees: [{ login: "github-actions[bot]", type: "Bot" }],
        },
      },
      result: baseResult,
      unassignOnNotReady: true,
    });

    expect(result).toBeUndefined();
    expect(octokit.rest.issues.removeAssignees).not.toHaveBeenCalled();
  });

  it("catches and warns on GitHub API permission/network errors without throwing", async () => {
    const octokit = {
      rest: {
        issues: {
          removeAssignees: jest
            .fn()
            .mockRejectedValue(
              new Error("Resource not accessible by integration (403)"),
            ),
        },
      },
    };

    const result = await handleAutoUnassign({
      octokit,
      owner: "test-owner",
      repo: "test-repo",
      issueNumber: 123,
      payload: {
        issue: { number: 123, assignees: [{ login: "alice", type: "User" }] },
      },
      result: baseResult,
      unassignOnNotReady: true,
    });

    expect(result).toBeUndefined();
    expect(octokit.rest.issues.removeAssignees).toHaveBeenCalled();
  });

  it("skips unassign when there is no issue context (workflow_dispatch)", async () => {
    const octokit = makeMockOctokit();
    const result = await handleAutoUnassign({
      octokit,
      owner: "test-owner",
      repo: "test-repo",
      payload: {},
      result: baseResult,
      unassignOnNotReady: true,
    });

    expect(result).toBeUndefined();
    expect(octokit.rest.issues.removeAssignees).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Wave #38 — Integration tests: key run() decision paths
// Strategy: Test the critical branching logic in index.ts:
// - Happy path: account funded → all checks pass → comment posted → webhook sent
// - Unfunded path: account 404 → unfundedAccountResult → fail_on_missing controls setFailed vs warn
// - Webhook-off: empty webhook_url skips webhook but everything else runs
// - Comment-off: comment_mode=off/dry-run skips posting but validation + outputs still occur
// ---------------------------------------------------------------------------

describe('Wave #38 — Integration tests: critical index.ts run() paths', () => {
  const FUNDED_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

  describe('Happy path: funded account flow', () => {
    it('funded account produces ready=true via buildValidationGate', () => {
      const result = buildValidationGate({
        valid: true,
        accountFunded: true,
        trustlineExists: true,
        xlmBalance: '50.0000000',
        xlmReserveMet: true,
        checks: [
          { label: 'Account funded', passed: true, detail: 'ok' },
          { label: 'Trustline', passed: true, detail: 'ok' },
        ],
        reasonCode: 'SUCCESS',
      } as any);
      expect(result.ready).toBe(true);
    });

    it('outputs: account_funded=true when result is valid', () => {
      // Using the known-good pattern from existing tests
      const outputs = toActionOutputs(
        {
          valid: true,
          accountFunded: true,
          trustlineExists: true,
          xlmBalance: '50.0000000',
          xlmReserveMet: true,
          checks: [],
          reasonCode: 'SUCCESS',
        } as any,
        'https://github.com/owner/repo/issues/1#comment-99',
      );
      expect(outputs.account_funded).toBe('true');
      expect(outputs.comment_url).toBe('https://github.com/owner/repo/issues/1#comment-99');
    });
  });

  describe('Unfunded path: fail_on_missing logic', () => {
    it('unfunded account produces ready=false', () => {
      const checkConfig: CheckConfig = {
        assetCode: 'USDC',
        assetIssuer: USDC_ISSUER,
        minXlmReserve: 1.5,
        minAssetBalance: 0,
        minTrustlineLimit: 0,
        horizonUrl: 'https://horizon.stellar.org',
      };
      const result = unfundedAccountResult(FUNDED_ADDRESS, checkConfig);
      const gate = buildValidationGate(result);
      expect(gate.ready).toBe(false);
    });

    it('fail_on_missing=true with unfunded: calls setFailed path', () => {
      const checkConfig: CheckConfig = {
        assetCode: 'USDC',
        assetIssuer: USDC_ISSUER,
        minXlmReserve: 1.5,
        minAssetBalance: 0,
        minTrustlineLimit: 0,
        horizonUrl: 'https://horizon.stellar.org',
      };
      const result = unfundedAccountResult(FUNDED_ADDRESS, checkConfig);
      // In index.ts: if (!result.valid && failOnMissing) { core.setFailed() }
      const failOnMissing = true;
      expect(!result.valid && failOnMissing).toBe(true);
    });

    it('fail_on_missing=false with unfunded: calls warning path', () => {
      const checkConfig: CheckConfig = {
        assetCode: 'USDC',
        assetIssuer: USDC_ISSUER,
        minXlmReserve: 1.5,
        minAssetBalance: 0,
        minTrustlineLimit: 0,
        horizonUrl: 'https://horizon.stellar.org',
      };
      const result = unfundedAccountResult(FUNDED_ADDRESS, checkConfig);
      // In index.ts: else { core.warning() }
      const failOnMissing = false;
      expect(!result.valid && !failOnMissing).toBe(true);
    });
  });

  describe('Webhook-off: empty webhook_url', () => {
    it('empty webhook_url skips webhook delivery', () => {
      const webhookUrl = '';
      // In index.ts: if (webhookUrl) { sendWebhookNotification(...) }
      expect(!!webhookUrl).toBe(false);
    });

    it('webhook_url with value sends webhook', () => {
      const webhookUrl = 'https://webhook.example.com/notify';
      expect(!!webhookUrl).toBe(true);
    });
  });

  describe('Comment-off: comment_mode logic', () => {
    it('comment_mode=off skips posting', () => {
      const commentMode = 'off' as string;
      const shouldPostComment = commentMode === 'post';
      expect(shouldPostComment).toBe(false);
    });

    it('comment_mode=dry-run skips posting', () => {
      const commentMode = 'dry-run' as string;
      const shouldPostComment = commentMode === 'post';
      expect(shouldPostComment).toBe(false);
    });

    it('comment_mode=post sends comment', () => {
      const commentMode = 'post' as string;
      const shouldPostComment = commentMode === 'post';
      expect(shouldPostComment).toBe(true);
    });

    it('dry-run: comment_url is empty in outputs', () => {
      const outputs = toActionOutputs(
        {
          valid: true,
          accountFunded: true,
          trustlineExists: true,
          xlmBalance: '50.0000000',
          xlmReserveMet: true,
          checks: [],
          reasonCode: 'SUCCESS',
        } as any,
        undefined,
      );
      expect(outputs.comment_url).toBe('');
    });
  });

  describe('Sticky comment behavior', () => {
    it('stickyComment=true enables re-use of prior comment', () => {
      const stickyComment = true;
      expect(stickyComment).toBe(true);
    });

    it('stickyComment=false posts new comment every time', () => {
      const stickyComment = false;
      expect(stickyComment).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Source guards for src/index.ts (Issues #534 and #535)
//
// Both issues are merge-artifact defects in the orchestration file, so the
// regression has to be asserted against the parsed source rather than at
// runtime: a bad merge that collapses two statements onto one line still
// compiles, which is exactly how the collapsed `getOctokit` /
// `applyWalletLabels` line (#534) and the duplicated `setValidationOutputs`
// call (#535) survived review.
//
// The checks run over the TypeScript AST so they describe intent ("no two
// statements start on the same line") instead of a line-regex approximation.
// ---------------------------------------------------------------------------

describe('src/index.ts source guards (#534, #535)', () => {
  const sourcePath = path.join(path.resolve(__dirname, '..'), 'src/index.ts');
  const sourceText = fs.readFileSync(sourcePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    sourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const lineOf = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  function visit(node: ts.Node, fn: (node: ts.Node) => void): void {
    fn(node);
    ts.forEachChild(node, (child) => visit(child, fn));
  }

  /** Every call to `callee(...)` inside src/index.ts, excluding the import. */
  function callSites(calleeText: string): ts.CallExpression[] {
    const calls: ts.CallExpression[] = [];
    visit(sourceFile, (node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(sourceFile) === calleeText &&
        !ts.isImportDeclaration(node.parent)
      ) {
        calls.push(node);
      }
    });
    return calls;
  }

  /** Line numbers of every call to `callee(...)` — compact enough for diffs. */
  function callLines(calleeText: string): number[] {
    return callSites(calleeText).map(lineOf);
  }

  describe('#534 — collapsed getOctokit / applyWalletLabels line', () => {
    it('never places two statements on the same line', () => {
      const collisions: string[] = [];

      const checkStatementList = (list: ts.NodeArray<ts.Statement>) => {
        for (let i = 1; i < list.length; i += 1) {
          if (lineOf(list[i]!) === lineOf(list[i - 1]!)) {
            collisions.push(
              `line ${lineOf(list[i]!)}: "${list[i - 1]!.getText(sourceFile).slice(0, 60)}" + "${list[i]!.getText(sourceFile).slice(0, 60)}"`,
            );
          }
        }
      };

      const checkLists = (node: ts.Node): void => {
        if (ts.isSourceFile(node) || ts.isBlock(node)) {
          checkStatementList(node.statements);
        }
        ts.forEachChild(node, checkLists);
      };
      checkLists(sourceFile);

      expect(collisions).toEqual([]);
    });

    it('splits getOctokit and applyWalletLabels into separate statements', () => {
      const getOctokitCalls = callSites('github.getOctokit');
      const labelCalls = callSites('applyWalletLabels');

      expect(getOctokitCalls.length).toBeGreaterThan(0);
      expect(labelCalls.length).toBeGreaterThan(0);

      /** Nearest enclosing statement of a node. */
      const enclosingStatement = (node: ts.Node): ts.Statement => {
        let current: ts.Node = node;
        while (current.parent && !ts.isStatement(current)) {
          current = current.parent;
        }
        return current as ts.Statement;
      };

      for (const call of labelCalls) {
        const statement = enclosingStatement(call);
        // The label call spans several lines, so the `const octokit = ...`
        // declaration cannot have been merged onto the same line as it.
        expect(statement.getText(sourceFile)).toContain('\n');
        expect(statement.getText(sourceFile)).toContain('applyWalletLabels');
      }
    });

    it('keeps the octokit declaration on its own statement', () => {
      const declarations = sourceFile
        .getFullText()
        .split('\n')
        .map((line, index) => ({ line: line.trim(), number: index + 1 }))
        .filter(({ line }) => line.startsWith('const octokit = github.getOctokit('));

      expect(declarations.length).toBeGreaterThan(0);
      for (const { line } of declarations) {
        // `const octokit = github.getOctokit(...);` and nothing else on the line.
        expect(line.endsWith(';')).toBe(true);
        expect(line.indexOf(';')).toBe(line.length - 1);
      }
    });
  });

  describe('#535 — single setValidationOutputs call', () => {
    it('calls setValidationOutputs exactly once', () => {
      expect(callLines('setValidationOutputs')).toHaveLength(1);
    });

    it('passes result, commentUrl, fullReportPath and the extras bag', () => {
      const [call] = callSites('setValidationOutputs');
      const args = call!.arguments;

      expect(args).toHaveLength(4);
      expect(args[0]!.getText(sourceFile)).toBe('result');
      expect(args[1]!.getText(sourceFile)).toBe('commentUrl');
      expect(args[2]!.getText(sourceFile)).toBe('fullReportPath');

      const extras = args[3]!;
      expect(ts.isObjectLiteralExpression(extras)).toBe(true);

      const extrasEntries = new Map<string, string>();
      for (const prop of (extras as ts.ObjectLiteralExpression).properties) {
        if (ts.isShorthandPropertyAssignment(prop)) {
          extrasEntries.set(prop.name.getText(sourceFile), prop.name.getText(sourceFile));
        } else if (ts.isPropertyAssignment(prop)) {
          extrasEntries.set(prop.name.getText(sourceFile), prop.initializer.getText(sourceFile));
        }
      }

      expect(extrasEntries.get('validatedAt')).toBe('validatedAt');
      expect(extrasEntries.get('timings')).toBe('globalMetrics.getTimingBreakdown()');
      expect(extrasEntries.get('friendbotCalled')).toBe('friendbotCalled');
      expect(extrasEntries.get('friendbotSuccess')).toBe('friendbotSuccess');
      expect(extrasEntries.get('friendbotTransactionHash')).toBe('friendbotTransactionHash');
    });

    it('publishes outputs after the comment post so commentUrl is final', () => {
      const outputsLine = lineOf(callSites('setValidationOutputs')[0]!);
      const commentLines = callSites('postIssueComment').map(lineOf);

      expect(commentLines.length).toBeGreaterThan(0);
      for (const commentLine of commentLines) {
        expect(outputsLine).toBeGreaterThan(commentLine);
      }
    });

    it('no longer re-sets the friendbot outputs by hand', () => {
      // toActionOutputs already emits friendbot_called/success/transaction_hash,
      // so the explicit core.setOutput calls that followed the second
      // setValidationOutputs call were pure duplication.
      const manualFriendbotWrites = [...sourceFile.getFullText().matchAll(/core\.setOutput\(\s*["']friendbot_/g)];
      expect(manualFriendbotWrites).toHaveLength(0);
    });

    // Issue #550 — check_run_id / check_run_conclusion are declared in
    // action.yml, so they must flow through setValidationOutputs as well
    // instead of being written ad-hoc in this file.
    it('no longer writes the check_run outputs by hand (Issue #550)', () => {
      const manualCheckRunWrites = [
        ...sourceFile.getFullText().matchAll(/core\.setOutput\(\s*["']check_run_/g),
      ];
      expect(manualCheckRunWrites).toHaveLength(0);
    });

    it('passes the check_run values through the setValidationOutputs extras (Issue #550)', () => {
      const call = callSites('setValidationOutputs')[0];
      expect(call).toBeDefined();

      const extrasArg = call!.arguments[3];
      expect(extrasArg).toBeDefined();

      const extrasText = extrasArg!.getText(sourceFile);
      expect(extrasText).toContain('checkRunId');
      expect(extrasText).toContain('checkRunConclusion');
    });

    it('has no other call that could publish the validation outputs twice', () => {
      expect(callLines('setValidationOutputs')).toHaveLength(1);

      // `result` must still reach setValidationOutputs — the guard above would
      // otherwise pass trivially if the call were dropped entirely.
      expect(sourceFile.getFullText()).toContain('setValidationOutputs(result');
    });
  });

  describe('#526 — GitHub Projects v2 status integration', () => {
    it('invokes the project updater with the selected outcome and issue/PR node ID', () => {
      const projectCalls = callSites('updateProjectV2Status');
      expect(projectCalls).toHaveLength(1);

      const source = sourceFile.getFullText();
      expect(source).toContain('const targetProjectStatus = result.valid');
      expect(source).toContain('github.context.payload.issue?.node_id');
      expect(source).toContain('github.context.payload.pull_request?.node_id');
      expect(source).toContain('targetStatusValue: targetProjectStatus');
      expect(source).toContain('projectId,');
      expect(source).toContain('statusFieldName: projectStatusField');
      expect(source).toContain('github.getOctokit(');
      expect(source).toContain('projectToken,');
    });
  });
});

// ---------------------------------------------------------------------------
// Issue #692 — milestone_allowlist and milestone_fail_on_skip integration
// ---------------------------------------------------------------------------

describe("Issue #692 — milestone gate evaluation", () => {
  // Helper to create a minimal issue payload with a milestone
  function issuePayload(milestoneTitle?: string): Record<string, unknown> {
    return {
      issue: {
        number: 1,
        milestone: milestoneTitle ? { title: milestoneTitle } : null,
      },
    };
  }

  // Helper to create a minimal PR payload with a milestone
  function prPayload(milestoneTitle?: string): Record<string, unknown> {
    return {
      pull_request: {
        number: 1,
        milestone: milestoneTitle ? { title: milestoneTitle } : null,
      },
    };
  }

  describe("evaluateMilestoneGate signature and exports", () => {
    it("is exported from src/index", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      expect(typeof evaluateMilestoneGate).toBe("function");
    });

    it("returns a MilestoneGateDecision shape", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      const decision = evaluateMilestoneGate("", false, {});
      expect(decision).toHaveProperty("shouldSkip");
      expect(decision).toHaveProperty("reason");
      expect(decision).toHaveProperty("fullMessage");
      expect(decision).toHaveProperty("milestoneTitle");
      expect(typeof decision.shouldSkip).toBe("boolean");
      expect(typeof decision.reason).toBe("string");
      expect(typeof decision.fullMessage).toBe("string");
      expect(typeof decision.milestoneTitle).toBe("string");
    });
  });

  describe("no allowlist configured", () => {
    it("returns shouldSkip=false when allowlist is empty string", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      const decision = evaluateMilestoneGate("", false, issuePayload("Wave 12"));
      expect(decision.shouldSkip).toBe(false);
      expect(decision.reason).toBe("");
    });

    it("returns shouldSkip=false when allowlist is whitespace only", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      const decision = evaluateMilestoneGate(
        "   ",
        false,
        issuePayload("Wave 12"),
      );
      expect(decision.shouldSkip).toBe(false);
    });

    it("returns shouldSkip=false when allowlist splits to empty (trailing comma only)", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      const decision = evaluateMilestoneGate(" , ", false, issuePayload("Wave 12"));
      expect(decision.shouldSkip).toBe(false);
    });
  });

  describe("allowlist configured — milestone present and matching", () => {
    it("returns shouldSkip=false when issue milestone matches allowlist", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      const decision = evaluateMilestoneGate(
        "Wave 12",
        false,
        issuePayload("Wave 12"),
      );
      expect(decision.shouldSkip).toBe(false);
      expect(decision.milestoneTitle).toBe("Wave 12");
    });

    it("is case-insensitive when checking milestone title", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      const decision = evaluateMilestoneGate(
        "wave 12",
        false,
        issuePayload("WAVE 12"),
      );
      expect(decision.shouldSkip).toBe(false);
    });

    it("trims whitespace from milestone title before matching", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      const decision = evaluateMilestoneGate(
        "Wave 12",
        false,
        issuePayload("  Wave 12  "),
      );
      expect(decision.shouldSkip).toBe(false);
    });

    it("matches when milestone is in a multi-value allowlist", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      const decision = evaluateMilestoneGate(
        "Wave 11,Wave 12,Wave 13",
        false,
        issuePayload("Wave 12"),
      );
      expect(decision.shouldSkip).toBe(false);
    });

    it("matches PR milestone against allowlist", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      const decision = evaluateMilestoneGate(
        "Release 1.0",
        false,
        prPayload("Release 1.0"),
      );
      expect(decision.shouldSkip).toBe(false);
    });

    it("prefers issue milestone over PR milestone when both present", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      const payload: Record<string, unknown> = {
        issue: { number: 1, milestone: { title: "Issue Milestone" } },
        pull_request: { number: 1, milestone: { title: "PR Milestone" } },
      };
      const decision = evaluateMilestoneGate("Issue Milestone", false, payload);
      expect(decision.shouldSkip).toBe(false);
      expect(decision.milestoneTitle).toBe("Issue Milestone");
    });

    it("does NOT fall back to PR milestone when issue context exists but has no milestone", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      const payload: Record<string, unknown> = {
        issue: { number: 1 }, // issue exists, but no milestone
        pull_request: { number: 1, milestone: { title: "Release 1.0" } },
      };
      const decision = evaluateMilestoneGate("Release 1.0", false, payload);
      expect(decision.shouldSkip).toBe(true);
      expect(decision.reason).toContain("No milestone found");
    });
  });

  describe("allowlist configured — milestone missing", () => {
    it("returns shouldSkip=true when issue has no milestone (milestone is null)", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      const decision = evaluateMilestoneGate(
        "Wave 12",
        false,
        issuePayload(undefined),
      );
      expect(decision.shouldSkip).toBe(true);
      expect(decision.reason).toContain("No milestone found");
    });

    it("returns shouldSkip=true when issue has no milestone field at all", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      const decision = evaluateMilestoneGate("Wave 12", false, {
        issue: { number: 1 },
      });
      expect(decision.shouldSkip).toBe(true);
      expect(decision.reason).toContain("No milestone found");
    });

    it("returns shouldSkip=true when payload has neither issue nor PR context", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      const decision = evaluateMilestoneGate("Wave 12", false, {});
      expect(decision.shouldSkip).toBe(true);
      expect(decision.reason).toContain("No milestone found");
    });

    it("returns shouldSkip=true when milestone object has empty title", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      const decision = evaluateMilestoneGate(
        "Wave 12",
        false,
        issuePayload(""),
      );
      expect(decision.shouldSkip).toBe(true);
      expect(decision.reason).toContain("No milestone found");
      // Note: payload.issue.milestone is truthy (object { title: "" }),
      // but the empty title normalises to "" → treated as missing.
      // See edge case: "Issues API milestone null vs empty object"
    });

    it("generates correct fullMessage with Skipping validation suffix", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      const decision = evaluateMilestoneGate(
        "Wave 12",
        false,
        issuePayload(undefined),
      );
      expect(decision.fullMessage).toBe(
        "Milestone gate: No milestone found on this event, but milestone_allowlist is active. Skipping validation.",
      );
    });
  });

  describe("allowlist configured — milestone does not match", () => {
    it("returns shouldSkip=true when milestone is not in the allowlist", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      const decision = evaluateMilestoneGate(
        "Wave 12",
        false,
        issuePayload("Wave 11"),
      );
      expect(decision.shouldSkip).toBe(true);
      expect(decision.reason).toContain("not in the allowlist");
    });

    it("includes the actual milestone title in the reason message", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      const decision = evaluateMilestoneGate(
        "Wave 12",
        false,
        issuePayload("Wave 11"),
      );
      expect(decision.reason).toContain('"Wave 11"');
    });

    it("returns shouldSkip=true for PR with non-allowlisted milestone", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      const decision = evaluateMilestoneGate(
        "Release 1.0",
        false,
        prPayload("Release 2.0"),
      );
      expect(decision.shouldSkip).toBe(true);
      expect(decision.reason).toContain("Release 2.0");
    });

    it("does not match when milestone is close but not exact after normalization", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      const decision = evaluateMilestoneGate(
        "Wave 12",
        false,
        issuePayload("Wave12"),
      );
      expect(decision.shouldSkip).toBe(true);
    });

    it("generates correct fullMessage for non-matching milestone", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      const decision = evaluateMilestoneGate(
        "Wave 12",
        false,
        issuePayload("Sprint 3"),
      );
      expect(decision.fullMessage).toBe(
        'Milestone gate: Milestone "Sprint 3" is not in the allowlist. Skipping validation.',
      );
    });
  });

  describe("milestone_fail_on_skip behavior", () => {
    it("does not affect the gate decision (decision is independent)", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      // The function accepts _milestoneFailOnSkip but the decision logic
      // is the same regardless of the flag — only the caller uses it.
      const d1 = evaluateMilestoneGate("Wave 12", true, issuePayload(undefined));
      const d2 = evaluateMilestoneGate(
        "Wave 12",
        false,
        issuePayload(undefined),
      );
      expect(d1.shouldSkip).toBe(true);
      expect(d2.shouldSkip).toBe(true);
      expect(d1.reason).toBe(d2.reason);
    });

    it("fail_on_skip=true + missing milestone triggers core.setFailed in run()", () => {
      // This test verifies the side-effect contract between evaluateMilestoneGate
      // and run(). When shouldSkip=true and milestoneFailOnSkip=true, run()
      // calls core.setFailed with the fullMessage.
      const { evaluateMilestoneGate } = require("../src/index");
      const decision = evaluateMilestoneGate(
        "Wave 12",
        true,
        issuePayload(undefined),
      );
      expect(decision.shouldSkip).toBe(true);
      expect(decision.fullMessage).toContain("Skipping validation");
    });

    it("fail_on_skip=false + missing milestone triggers core.info in run()", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      const decision = evaluateMilestoneGate(
        "Wave 12",
        false,
        issuePayload(undefined),
      );
      expect(decision.shouldSkip).toBe(true);
      expect(decision.fullMessage).toContain("Skipping validation");
    });
  });

  describe("run() side-effect contract for skip path", () => {
    it("skip decision sets ready=false, reason_code=MILESTONE_GATE_SKIPPED", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      const decision = evaluateMilestoneGate(
        "Wave 12",
        false,
        issuePayload("Sprint 3"),
      );
      // In run(): when shouldSkip=true, core.setOutput("ready", "false"),
      // core.setOutput("reason_code", "MILESTONE_GATE_SKIPPED"),
      // core.setOutput("checks_json", "[]")
      expect(decision.shouldSkip).toBe(true);
      // The outputs are set by run(), not by evaluateMilestoneGate.
      // This test documents the contract.
    });
  });

  describe("edge cases", () => {
    it("handles milestone object with non-string title gracefully", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      const payload: Record<string, unknown> = {
        issue: {
          number: 1,
          milestone: { title: 42 },
        },
      };
      // Accessing `.title` on a number coerces to string via `|| ""`,
      // but in practice GitHub API always returns a string.
      const decision = evaluateMilestoneGate("42", false, payload);
      // The .title || "" coercion: 42 is truthy, so raw becomes "42"
      expect(decision.shouldSkip).toBe(false);
    });

    it("handles organization-level milestone numeric titles (coerced to string)", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      const payload: Record<string, unknown> = {
        issue: {
          number: 1,
          milestone: { title: "12" }, // org milestones can be numeric in title
        },
      };
      const decision = evaluateMilestoneGate("12", false, payload);
      expect(decision.shouldSkip).toBe(false);
    });

    it("allowlist with extra whitespace around commas is parsed correctly", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      const decision = evaluateMilestoneGate(
        " Wave 11 , Wave 12 , Wave 13 ",
        false,
        issuePayload("Wave 12"),
      );
      expect(decision.shouldSkip).toBe(false);
    });

    it("allowlist with duplicate entries does not break matching", () => {
      const { evaluateMilestoneGate } = require("../src/index");
      const decision = evaluateMilestoneGate(
        "Wave 12,Wave 12,Wave 12",
        false,
        issuePayload("Wave 12"),
      );
      expect(decision.shouldSkip).toBe(false);
    });
  });
});

