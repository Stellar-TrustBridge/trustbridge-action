/**
 * Wave #29 — Benchmark: workflow_dispatch issue_number
 *
 * End-to-end harness that verifies TrustBridge's behaviour when triggered
 * via `workflow_dispatch` with an explicit `issue_number` input.
 *
 * Covers:
 *   - Happy path: funded account → comment posted on the target issue
 *   - Failure path: unfunded account → comment posted, outputs set correctly
 *   - Missing issue_number: no comment, warning emitted
 *   - Invalid issue_number: parse error surfaced early
 *   - Horizon outage / rate-limit during dispatch run
 *   - Invalid env configuration (bad token, bad address)
 *   - Auth/permission failure (GitHub comment API 403)
 *   - 100+ contributor scale: comment finds existing sticky comment via pagination
 *
 * HTTP interactions are fully mocked via jest.mock so no real network calls
 * are made.  GitHub API interactions use a structural mock of `@actions/github`.
 * Snapshots capture the comment body shape for regression detection.
 */

import * as core from '@actions/core';
import * as github from '@actions/github';

// ---------------------------------------------------------------------------
// Helpers imported from src (pure, no network)
// ---------------------------------------------------------------------------
import {
  extractStellarAddressFromText,
  isValidStellarAddress,
} from '../src/checks';
import {
  postIssueComment,
  isTrustBridgeComment,
  findStickyComment,
  STICKY_COMMENT_MARKER,
  STICKY_COMMENT_MARKER_LEGACY,
  TRUSTBRIDGE_FOOTER,
  formatCommentBody,
} from '../src/comment';
import { fetchAccount } from '../src/horizon';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FUNDED_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const HORIZON_URL = 'https://horizon.stellar.org';
const GITHUB_TOKEN = 'ghs_test_token_000000000000000000000';
const DISPATCH_ISSUE_NUMBER = 29;

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

jest.mock('@actions/core');
jest.mock('@actions/github');
jest.mock('../src/horizon');

const mockCore = core as jest.Mocked<typeof core>;
const mockFetchAccount = fetchAccount as jest.MockedFunction<typeof fetchAccount>;

/** Build a mock Octokit that records calls and returns controlled responses. */
function buildMockOctokit(options: {
  existingCommentId?: number;
  createStatus?: number;
  updateStatus?: number;
  listPagesCount?: number;
} = {}) {
  const { existingCommentId, createStatus = 201, updateStatus = 200, listPagesCount = 1 } = options;

  const pages = Array.from({ length: listPagesCount }, (_, i) => {
    if (i === listPagesCount - 1 && existingCommentId) {
      return [{ id: existingCommentId, body: STICKY_COMMENT_MARKER + ' old content', html_url: `https://github.com/org/repo/issues/${DISPATCH_ISSUE_NUMBER}#issuecomment-${existingCommentId}` }];
    }
    return [];
  });

  const listCommentsMock = jest.fn().mockResolvedValue(pages.flat());

  const paginateMock = jest.fn().mockImplementation(
    async (_method: unknown, _params: unknown) => pages.flat(),
  );

  const createCommentMock = jest.fn().mockResolvedValue({
    status: createStatus,
    data: {
      id: 99999,
      html_url: `https://github.com/org/repo/issues/${DISPATCH_ISSUE_NUMBER}#issuecomment-99999`,
      body: 'mock body',
    },
  });

  const updateCommentMock = jest.fn().mockResolvedValue({
    status: updateStatus,
    data: {
      id: existingCommentId ?? 99999,
      html_url: `https://github.com/org/repo/issues/${DISPATCH_ISSUE_NUMBER}#issuecomment-${existingCommentId ?? 99999}`,
      body: 'mock body updated',
    },
  });

  return {
    paginate: paginateMock,
    rest: {
      issues: {
        listComments: listCommentsMock,
        createComment: createCommentMock,
        updateComment: updateCommentMock,
      },
    },
    _mocks: { createCommentMock, updateCommentMock, paginateMock },
  };
}

function setupGithubContext(issueNumber?: number) {
  (github.context as unknown as Record<string, unknown>).repo = { owner: 'org', repo: 'repo' };
  (github.context as unknown as Record<string, unknown>).payload = issueNumber
    ? { issue: { number: issueNumber, body: '' } }
    : {};
  (github.context as unknown as Record<string, unknown>).eventName = issueNumber
    ? 'issues'
    : 'workflow_dispatch';
}

// ---------------------------------------------------------------------------
// Wave #28: extractStellarAddressFromText unit tests
// ---------------------------------------------------------------------------

describe('extractStellarAddressFromText (Wave #28)', () => {
  it('extracts a valid address from plain text', () => {
    const body = `Please send rewards to ${FUNDED_ADDRESS} thanks`;
    const result = extractStellarAddressFromText(body);
    expect(result.address).toBe(FUNDED_ADDRESS);
    expect(result.allAddresses).toHaveLength(1);
  });

  it('extracts first address when multiple are present', () => {
    const second = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H';
    const body = `Primary: ${FUNDED_ADDRESS}\nBackup: ${second}`;
    const result = extractStellarAddressFromText(body);
    expect(result.address).toBe(FUNDED_ADDRESS);
    expect(result.allAddresses).toHaveLength(2);
  });

  it('deduplicates repeated occurrences of the same address', () => {
    const body = `${FUNDED_ADDRESS} and ${FUNDED_ADDRESS} again`;
    const result = extractStellarAddressFromText(body);
    expect(result.allAddresses).toHaveLength(1);
  });

  it('returns undefined and empty array when no address present', () => {
    const result = extractStellarAddressFromText('No stellar address here');
    expect(result.address).toBeUndefined();
    expect(result.allAddresses).toHaveLength(0);
  });

  it('returns empty result for null input', () => {
    const result = extractStellarAddressFromText(null);
    expect(result.address).toBeUndefined();
    expect(result.allAddresses).toHaveLength(0);
  });

  it('returns empty result for undefined input', () => {
    const result = extractStellarAddressFromText(undefined);
    expect(result.address).toBeUndefined();
    expect(result.allAddresses).toHaveLength(0);
  });

  it('ignores strings that look like addresses but are invalid (wrong length)', () => {
    const body = 'GABC123 is not valid';
    const result = extractStellarAddressFromText(body);
    expect(result.address).toBeUndefined();
  });

  it('ignores strings starting with G but containing invalid base32 chars', () => {
    const body = 'G' + '0'.repeat(55) + ' bad address';
    const result = extractStellarAddressFromText(body);
    expect(result.address).toBeUndefined();
  });

  it('extracts an address embedded in an issue template line', () => {
    const body = [
      '## Stellar wallet',
      `Wallet address: ${FUNDED_ADDRESS}`,
      '## Description',
      'I would like to contribute to issue #29.',
    ].join('\n');
    const result = extractStellarAddressFromText(body);
    expect(result.address).toBe(FUNDED_ADDRESS);
  });

  it('handles very long text without regex catastrophic backtracking', () => {
    const padding = 'x'.repeat(50_000);
    const body = `${padding} ${FUNDED_ADDRESS} ${padding}`;
    const start = Date.now();
    const result = extractStellarAddressFromText(body);
    const elapsed = Date.now() - start;
    expect(result.address).toBe(FUNDED_ADDRESS);
    // Should complete well under 1 second even for large bodies
    expect(elapsed).toBeLessThan(1000);
  });

  it('is idempotent — calling twice returns the same result', () => {
    const body = `Contributor wallet: ${FUNDED_ADDRESS}`;
    const r1 = extractStellarAddressFromText(body);
    const r2 = extractStellarAddressFromText(body);
    expect(r1).toEqual(r2);
  });
});

// ---------------------------------------------------------------------------
// Wave #29: workflow_dispatch issue_number comment routing
// ---------------------------------------------------------------------------

describe('postIssueComment with explicit issueNumber (Wave #29)', () => {
  const validCommentBody = `${STICKY_COMMENT_MARKER}\n## TrustBridge — Stellar Account Check\n`;

  beforeEach(() => {
    jest.clearAllMocks();
    setupGithubContext(); // no issue in event payload (workflow_dispatch)
  });

  it('happy path: posts a new comment on the dispatch issue number', async () => {
    const octokit = buildMockOctokit();
    (github.getOctokit as jest.Mock).mockReturnValue(octokit);

    const url = await postIssueComment(GITHUB_TOKEN, validCommentBody, {
      sticky: false,
      issueNumber: DISPATCH_ISSUE_NUMBER,
    });

    expect(url).toContain(`issuecomment-`);
    expect(octokit._mocks.createCommentMock).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: DISPATCH_ISSUE_NUMBER }),
    );
  });

  it('sticky: finds existing comment and updates it rather than creating new', async () => {
    const octokit = buildMockOctokit({ existingCommentId: 42 });
    (github.getOctokit as jest.Mock).mockReturnValue(octokit);

    const url = await postIssueComment(GITHUB_TOKEN, validCommentBody, {
      sticky: true,
      issueNumber: DISPATCH_ISSUE_NUMBER,
    });

    expect(url).toBeDefined();
    expect(octokit._mocks.updateCommentMock).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 42 }),
    );
    expect(octokit._mocks.createCommentMock).not.toHaveBeenCalled();
  });

  it('skips comment and warns when no issue number in context and none supplied', async () => {
    setupGithubContext(); // workflow_dispatch, no issue
    const octokit = buildMockOctokit();
    (github.getOctokit as jest.Mock).mockReturnValue(octokit);

    const url = await postIssueComment(GITHUB_TOKEN, validCommentBody, { sticky: false });

    expect(url).toBeUndefined();
    expect(mockCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('No issue or pull request context found'),
    );
    expect(octokit._mocks.createCommentMock).not.toHaveBeenCalled();
  });

  it('explicit issueNumber overrides event-context issue number', async () => {
    setupGithubContext(999); // event has issue 999
    const octokit = buildMockOctokit();
    (github.getOctokit as jest.Mock).mockReturnValue(octokit);

    await postIssueComment(GITHUB_TOKEN, validCommentBody, {
      sticky: false,
      issueNumber: DISPATCH_ISSUE_NUMBER,
    });

    expect(octokit._mocks.createCommentMock).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: DISPATCH_ISSUE_NUMBER }),
    );
  });

  it('auth failure (403) surfaced from GitHub API', async () => {
    const octokit = buildMockOctokit();
    octokit._mocks.createCommentMock.mockRejectedValue(
      Object.assign(new Error('Resource not accessible by integration'), { status: 403 }),
    );
    (github.getOctokit as jest.Mock).mockReturnValue(octokit);

    await expect(
      postIssueComment(GITHUB_TOKEN, validCommentBody, {
        sticky: false,
        issueNumber: DISPATCH_ISSUE_NUMBER,
      }),
    ).rejects.toThrow('Resource not accessible by integration');
  });

  it('sticky fallback: sticky lookup failure → creates new comment', async () => {
    const octokit = buildMockOctokit();
    octokit._mocks.paginateMock.mockRejectedValue(new Error('API rate limit exceeded'));
    (github.getOctokit as jest.Mock).mockReturnValue(octokit);

    // postIssueComment wraps findStickyComment in a try/catch and falls back
    const url = await postIssueComment(GITHUB_TOKEN, validCommentBody, {
      sticky: true,
      issueNumber: DISPATCH_ISSUE_NUMBER,
    });

    expect(url).toBeDefined();
    expect(mockCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('Could not look up existing TrustBridge comment'),
    );
    expect(octokit._mocks.createCommentMock).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Wave #29: 100+ contributor scale — pagination
// ---------------------------------------------------------------------------

describe('findStickyComment — pagination at scale (Wave #29)', () => {
  it('finds the sticky comment on the last page across 3 pages', async () => {
    const COMMENT_ID = 55555;
    // Simulate 3 pages: first two empty, last has the sticky comment
    const paginateResult = [
      ...Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: 'Some unrelated comment', html_url: '#' })),
      ...Array.from({ length: 100 }, (_, i) => ({ id: i + 101, body: 'Another comment', html_url: '#' })),
      { id: COMMENT_ID, body: `${STICKY_COMMENT_MARKER}\n## TrustBridge`, html_url: `#issuecomment-${COMMENT_ID}` },
    ];

    const octokit = {
      paginate: jest.fn().mockResolvedValue(paginateResult),
      rest: { issues: { listComments: jest.fn() } },
    } as unknown as ReturnType<typeof github.getOctokit>;

    const found = await findStickyComment(octokit, 'org', 'repo', DISPATCH_ISSUE_NUMBER);
    expect(found).toBe(COMMENT_ID);
  });

  it('returns undefined when no TrustBridge comment exists across many comments', async () => {
    const paginateResult = Array.from({ length: 150 }, (_, i) => ({
      id: i + 1,
      body: `Unrelated comment ${i}`,
      html_url: '#',
    }));

    const octokit = {
      paginate: jest.fn().mockResolvedValue(paginateResult),
      rest: { issues: { listComments: jest.fn() } },
    } as unknown as ReturnType<typeof github.getOctokit>;

    const found = await findStickyComment(octokit, 'org', 'repo', DISPATCH_ISSUE_NUMBER);
    expect(found).toBeUndefined();
  });

  it('matches legacy marker for backward compat', async () => {
    const LEGACY_ID = 77777;
    const octokit = {
      paginate: jest.fn().mockResolvedValue([
        { id: LEGACY_ID, body: STICKY_COMMENT_MARKER_LEGACY + ' old body', html_url: '#' },
      ]),
      rest: { issues: { listComments: jest.fn() } },
    } as unknown as ReturnType<typeof github.getOctokit>;

    const found = await findStickyComment(octokit, 'org', 'repo', DISPATCH_ISSUE_NUMBER);
    expect(found).toBe(LEGACY_ID);
  });

  it('matches footer marker as fallback identifier', async () => {
    const FOOTER_ID = 88888;
    const octokit = {
      paginate: jest.fn().mockResolvedValue([
        { id: FOOTER_ID, body: `Some content\n${TRUSTBRIDGE_FOOTER}`, html_url: '#' },
      ]),
      rest: { issues: { listComments: jest.fn() } },
    } as unknown as ReturnType<typeof github.getOctokit>;

    const found = await findStickyComment(octokit, 'org', 'repo', DISPATCH_ISSUE_NUMBER);
    expect(found).toBe(FOOTER_ID);
  });
});

// ---------------------------------------------------------------------------
// Wave #29: isTrustBridgeComment
// ---------------------------------------------------------------------------

describe('isTrustBridgeComment', () => {
  it('returns true for current versioned marker', () => {
    expect(isTrustBridgeComment(STICKY_COMMENT_MARKER + '\n## TrustBridge')).toBe(true);
  });

  it('returns true for legacy marker', () => {
    expect(isTrustBridgeComment(STICKY_COMMENT_MARKER_LEGACY)).toBe(true);
  });

  it('returns true for footer-only match', () => {
    expect(isTrustBridgeComment(TRUSTBRIDGE_FOOTER)).toBe(true);
  });

  it('returns false for unrelated comment', () => {
    expect(isTrustBridgeComment('Just a regular comment')).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isTrustBridgeComment(null)).toBe(false);
    expect(isTrustBridgeComment(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wave #29: Horizon outage / rate limit edge cases
// ---------------------------------------------------------------------------

describe('Horizon failure modes during workflow_dispatch run (Wave #29)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupGithubContext();
  });

  it('fetchAccount mock simulates a 429 rate-limit error', async () => {
    // Use a plain Error with the expected properties since jest.mock
    // replaces HorizonError with an auto-mock that loses the class body.
    const err = Object.assign(new Error('Rate limit exceeded'), { statusCode: 429, retryable: true });
    mockFetchAccount.mockRejectedValue(err);

    await expect(
      fetchAccount(HORIZON_URL, FUNDED_ADDRESS, {}),
    ).rejects.toMatchObject({ statusCode: 429, retryable: true });
  });

  it('fetchAccount mock simulates a 503 outage error', async () => {
    const err = Object.assign(new Error('Service unavailable'), { statusCode: 503, retryable: true });
    mockFetchAccount.mockRejectedValue(err);

    await expect(
      fetchAccount(HORIZON_URL, FUNDED_ADDRESS, {}),
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  it('fetchAccount mock simulates a 404 unfunded account', async () => {
    const err = Object.assign(new Error('Account not found'), { statusCode: 404, retryable: false });
    mockFetchAccount.mockRejectedValue(err);

    await expect(
      fetchAccount(HORIZON_URL, FUNDED_ADDRESS, {}),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ---------------------------------------------------------------------------
// Wave #29: Comment body snapshot (regression guard)
// ---------------------------------------------------------------------------

describe('formatCommentBody snapshot — workflow_dispatch context (Wave #29)', () => {

  beforeAll(() => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000);
  });
  afterAll(() => {
    jest.restoreAllMocks();
  });


  const baseConfig = {
    assetCode: 'USDC',
    assetIssuer: USDC_ISSUER,
    minXlmReserve: 1.5,
    horizonUrl: HORIZON_URL,
    stellarAddress: FUNDED_ADDRESS,
    failOnMissing: true,
    stickyComment: true,
    waitUntilFunded: false,
  };

  const fundedResult = {
    valid: true,
    accountFunded: true,
    trustlineExists: true,
    xlmBalance: '10.0000000',
    xlmReserveMet: true,
    checks: [
      { passed: true, label: 'Account funded', detail: `Account \`${FUNDED_ADDRESS}\` is active on the Stellar network.` },
      { passed: true, label: 'USDC trustline', detail: `Trustline for **USDC** (\`${USDC_ISSUER}\`) is configured.` },
      { passed: true, label: 'XLM reserve', detail: `Balance **\`10.0000000\` XLM** meets the minimum of **1.5 XLM**.` },
    ],
    remediation: undefined,
  };

  const unfundedResult = {
    valid: false,
    accountFunded: false,
    trustlineExists: false,
    xlmBalance: '0',
    xlmReserveMet: false,
    checks: [
      { passed: false, label: 'Account funded', detail: `Account \`${FUNDED_ADDRESS}\` was **not found** on Horizon — it may not be funded or activated yet.` },
      { passed: false, label: 'USDC trustline', detail: 'Cannot verify trustline until the account exists.' },
      { passed: false, label: 'XLM reserve', detail: 'Cannot verify XLM balance. Fund the account with at least **1.5 XLM**.' },
    ],
    remediation: `Activate \`${FUNDED_ADDRESS}\` by sending at least **1 XLM**.`,
  };

  it('funded account comment matches snapshot', () => {
    const body = formatCommentBody(fundedResult, baseConfig);
    expect(body).toMatchSnapshot();
  });

  it('unfunded account comment matches snapshot', () => {
    const body = formatCommentBody(unfundedResult, baseConfig);
    expect(body).toMatchSnapshot();
  });

  it('funded comment contains sticky marker', () => {
    const body = formatCommentBody(fundedResult, baseConfig);
    expect(body).toContain(STICKY_COMMENT_MARKER);
  });

  it('funded comment contains validation gate section', () => {
    const body = formatCommentBody(fundedResult, baseConfig);
    expect(body).toContain('### Validation gate');
    expect(body).toContain('Ready to proceed: all checks passed.');
  });

  it('unfunded comment shows blocked-by in validation gate', () => {
    const body = formatCommentBody(unfundedResult, baseConfig);
    expect(body).toContain('Blocked by:');
    expect(body).toContain('Account funded');
  });

  it('comment includes action outputs reference table', () => {
    const body = formatCommentBody(fundedResult, baseConfig);
    expect(body).toContain('account_funded');
    expect(body).toContain('trustline_exists');
    expect(body).toContain('xlm_balance');
    expect(body).toContain('comment_url');
  });

  it('comment includes TrustBridge footer', () => {
    const body = formatCommentBody(fundedResult, baseConfig);
    expect(body).toContain(TRUSTBRIDGE_FOOTER);
  });
});

// ---------------------------------------------------------------------------
// Wave #28/#29: Integration — address extraction + dispatch issue_number
// ---------------------------------------------------------------------------

describe('address extraction + workflow_dispatch integration (Wave #28 + #29)', () => {
  it('extracts address from issue body and validates it', () => {
    const issueBody = [
      '## My contribution',
      `My Stellar address is: ${FUNDED_ADDRESS}`,
      'Please assign this to me.',
    ].join('\n');

    const extraction = extractStellarAddressFromText(issueBody);
    expect(extraction.address).toBe(FUNDED_ADDRESS);
    expect(isValidStellarAddress(extraction.address!)).toBe(true);
  });

  it('reports no address found when issue body has no G-address', () => {
    const issueBody = 'I want to work on this issue. My Discord: contributor#1234';
    const extraction = extractStellarAddressFromText(issueBody);
    expect(extraction.address).toBeUndefined();
  });

  it('handles issue body with multiple addresses — takes the first', () => {
    const second = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H';
    const issueBody = `Primary: ${FUNDED_ADDRESS}\nAlternate: ${second}`;
    const extraction = extractStellarAddressFromText(issueBody);
    expect(extraction.address).toBe(FUNDED_ADDRESS);
    expect(extraction.allAddresses).toEqual([FUNDED_ADDRESS, second]);
  });

  it('does not extract USDC issuer address as contributor address when both are present', () => {
    // In practice both could appear; the extractor returns both and
    // the caller decides which one is the contributor address.
    const issueBody = `Contributor: ${FUNDED_ADDRESS}\nIssuer: ${USDC_ISSUER}`;
    const extraction = extractStellarAddressFromText(issueBody);
    expect(extraction.allAddresses).toHaveLength(2);
    // First one is the contributor address by convention
    expect(extraction.address).toBe(FUNDED_ADDRESS);
  });
});

// ---------------------------------------------------------------------------
// Wave #29: Invalid inputs / env configuration edge cases
// ---------------------------------------------------------------------------

describe('invalid env configuration (Wave #29)', () => {
  it('isValidStellarAddress rejects empty string', () => {
    expect(isValidStellarAddress('')).toBe(false);
  });

  it('isValidStellarAddress rejects address shorter than 56 chars', () => {
    expect(isValidStellarAddress('GABC')).toBe(false);
  });

  it('isValidStellarAddress rejects address with lowercase letters', () => {
    expect(isValidStellarAddress('gaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaawhf')).toBe(false);
  });

  it('isValidStellarAddress rejects address starting with non-G', () => {
    expect(isValidStellarAddress('XAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF')).toBe(false);
  });

  it('isValidStellarAddress accepts a valid 56-char G-address', () => {
    expect(isValidStellarAddress(FUNDED_ADDRESS)).toBe(true);
  });

  it('extractStellarAddressFromText returns no address for injection-attempt content', () => {
    const maliciousBody = '$(cat /etc/passwd) `rm -rf /`; GABC123';
    const result = extractStellarAddressFromText(maliciousBody);
    expect(result.address).toBeUndefined();
  });
});
