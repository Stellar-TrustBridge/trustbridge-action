/**
 * Issue #900 — TrustBridge markers must not collide with other bots' HTML
 * comments when several bots share one issue thread.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  COMMENT_SCHEMA_VERSION,
  STICKY_COMMENT_MARKER,
  STICKY_COMMENT_MARKER_LEGACY,
  TRUSTBRIDGE_FOOTER,
  TRUSTBRIDGE_IDENTITY_LINES,
  findStickyComment,
  formatCommentBody,
  isTrustBridgeComment,
} from '../src/comment';
import { markdownLinesOutsideCode } from '../src/markdown';
import { ValidationResult } from '../src/checks';

jest.mock('@actions/github', () => ({
  context: {
    payload: {},
    repo: { owner: 'test-owner', repo: 'test-repo' },
    apiUrl: 'https://api.github.com',
  },
  getOctokit: jest.fn(),
}));

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  setOutput: jest.fn(),
  setFailed: jest.fn(),
  getInput: jest.fn(),
}));

/** Comments other bots commonly leave on Wave issues. */
const FOREIGN_BOT_BODIES = {
  wave: '<!-- wave:application-id:2aae6b2d-7430-4e00-abf1-fd66342cfe2a -->\n<!-- wave:app-text-start -->\n> I would like to work on this\n<!-- wave:app-text-end -->',
  coverage: '<!-- codecov-comment -->\n## Coverage report\nNo change.',
  similarPrefix: '<!-- trustbridge-action:sticky-comment-mirror -->\nMirror bot copy',
  otherVersion: '<!-- trustbridge-action:sticky-comment:schema-v999 -->\nfuture schema from a fork',
  nestedInOtherMarker: `<!-- other-bot:quote ${STICKY_COMMENT_MARKER} -->\nquoted`,
  inlineMention: `The marker is ${STICKY_COMMENT_MARKER} — see docs.`,
  inlineCodeMention: `Use \`${STICKY_COMMENT_MARKER}\` to find it.`,
  fencedQuote: `Previous TrustBridge comment:\n\n\`\`\`html\n${STICKY_COMMENT_MARKER}\n## TrustBridge\n---\n${TRUSTBRIDGE_FOOTER}\n\`\`\``,
  tildeFenceQuote: `~~~\n${STICKY_COMMENT_MARKER_LEGACY}\n~~~`,
  indentedCode: `Example:\n\n    ${STICKY_COMMENT_MARKER}`,
  blockquote: `> ${STICKY_COMMENT_MARKER}\n> ## TrustBridge — Stellar Account Check\n> ${TRUSTBRIDGE_FOOTER}`,
  footerInSentence: `Thanks! ${TRUSTBRIDGE_FOOTER} is great.`,
};

const validationResult: ValidationResult = {
  valid: true,
  accountFunded: true,
  trustlineExists: true,
  xlmBalance: '10.0000000',
  xlmReserveMet: true,
  assetBalance: '1.0000000',
  assetBalanceMet: true,
  checks: [{ passed: true, label: 'Account funded', detail: 'Account is active.' }],
} as ValidationResult;

function makeOctokit() {
  return {
    paginate: jest.fn(),
    graphql: jest.fn(),
    rest: { issues: { listComments: jest.fn() } },
  };
}

function graphqlPage(nodes: Array<Record<string, unknown>>) {
  return {
    repository: {
      issue: { comments: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } },
    },
  };
}

const asOctokit = (o: ReturnType<typeof makeOctokit>) =>
  o as unknown as Parameters<typeof findStickyComment>[0];

describe('isTrustBridgeComment marker collisions (#900)', () => {
  it('happy path: a real TrustBridge comment body is recognised', () => {
    const body = formatCommentBody(validationResult, {
      stellarAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      assetCode: 'USDC',
      assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      horizonUrl: 'https://horizon.stellar.org',
      minXlmReserve: 1.5,
    } as Parameters<typeof formatCommentBody>[1]);
    expect(isTrustBridgeComment(body)).toBe(true);
    expect(isTrustBridgeComment(body.replace(/\n/g, '\r\n'))).toBe(true);
  });

  it('recognises each identity line on its own and with surrounding whitespace', () => {
    for (const line of TRUSTBRIDGE_IDENTITY_LINES) {
      expect(isTrustBridgeComment(line)).toBe(true);
      expect(isTrustBridgeComment(`  ${line}  \nbody`)).toBe(true);
    }
  });

  it.each(Object.entries(FOREIGN_BOT_BODIES))('ignores foreign body: %s', (_name, body) => {
    expect(isTrustBridgeComment(body)).toBe(false);
  });

  it('a marker after a closed fence still counts', () => {
    expect(isTrustBridgeComment(`\`\`\`\ncode\n\`\`\`\n${STICKY_COMMENT_MARKER}`)).toBe(true);
  });

  it('an unterminated fence hides everything after it', () => {
    expect(isTrustBridgeComment(`\`\`\`\n${STICKY_COMMENT_MARKER}`)).toBe(false);
  });

  it('empty and non-string bodies are not TrustBridge comments', () => {
    expect(isTrustBridgeComment('')).toBe(false);
    expect(isTrustBridgeComment(null)).toBe(false);
    expect(isTrustBridgeComment(undefined)).toBe(false);
    expect(isTrustBridgeComment(42 as unknown as string)).toBe(false);
  });
});

describe('findStickyComment with multiple bots on one issue (#900)', () => {
  const foreignNodes = Object.values(FOREIGN_BOT_BODIES).map((body, i) => ({
    id: `IC_F${i}`,
    databaseId: 900 + i,
    body,
    author: { login: `other-bot-${i}[bot]`, __typename: 'Bot' },
    viewerCanUpdate: true,
  }));

  it('GraphQL: picks the TrustBridge comment even when foreign markers come after it', async () => {
    const octokit = makeOctokit();
    octokit.graphql.mockResolvedValueOnce(
      graphqlPage([
        {
          id: 'IC_TB',
          databaseId: 42,
          body: `${STICKY_COMMENT_MARKER}\nTrustBridge result`,
          author: { login: 'github-actions[bot]', __typename: 'Bot' },
          viewerCanUpdate: true,
        },
        ...foreignNodes,
      ]),
    );
    await expect(findStickyComment(asOctokit(octokit), 'o', 'r', 1)).resolves.toBe(42);
  });

  it('GraphQL: returns undefined when only foreign bots have commented', async () => {
    const octokit = makeOctokit();
    octokit.graphql.mockResolvedValueOnce(graphqlPage(foreignNodes));
    await expect(findStickyComment(asOctokit(octokit), 'o', 'r', 1)).resolves.toBeUndefined();
    expect(octokit.paginate).not.toHaveBeenCalled();
  });

  it('GraphQL: skips a real marker the viewer cannot update (another bot copied it)', async () => {
    const octokit = makeOctokit();
    octokit.graphql.mockResolvedValueOnce(
      graphqlPage([
        { id: 'IC_TB', databaseId: 42, body: `${STICKY_COMMENT_MARKER}\nours`, viewerCanUpdate: true },
        {
          id: 'IC_COPY',
          databaseId: 77,
          body: `${STICKY_COMMENT_MARKER}\ncopy`,
          author: { login: 'copycat[bot]', __typename: 'Bot' },
          viewerCanUpdate: false,
        },
      ]),
    );
    await expect(findStickyComment(asOctokit(octokit), 'o', 'r', 1)).resolves.toBe(42);
  });

  it('REST fallback: ignores foreign markers and keeps the TrustBridge comment', async () => {
    const octokit = makeOctokit();
    octokit.graphql.mockRejectedValue(new Error('GraphQL unavailable'));
    octokit.paginate.mockResolvedValue([
      { id: 7, body: `${STICKY_COMMENT_MARKER_LEGACY}\nold TrustBridge`, user: { login: 'github-actions[bot]', type: 'Bot' } },
      ...Object.values(FOREIGN_BOT_BODIES).map((body, i) => ({
        id: 100 + i,
        body,
        user: { login: `other-bot-${i}[bot]`, type: 'Bot' },
      })),
    ]);
    await expect(findStickyComment(asOctokit(octokit), 'o', 'r', 1)).resolves.toBe(7);
  });

  it('REST fallback: returns undefined when only foreign bots have commented', async () => {
    const octokit = makeOctokit();
    octokit.graphql.mockRejectedValue(new Error('GraphQL unavailable'));
    octokit.paginate.mockResolvedValue(
      Object.values(FOREIGN_BOT_BODIES).map((body, i) => ({ id: 100 + i, body, user: { type: 'Bot' } })),
    );
    await expect(findStickyComment(asOctokit(octokit), 'o', 'r', 1)).resolves.toBeUndefined();
  });
});

describe('markdownLinesOutsideCode (#900)', () => {
  it('drops fenced, indented and quoted lines', () => {
    expect(
      markdownLinesOutsideCode('a\n```\nb\n```\n    c\n> d\n~~~~\ne\n~~~\nf\n~~~~\ng'),
    ).toEqual(['a', 'g']);
  });

  it('returns [] for non-string input', () => {
    expect(markdownLinesOutsideCode(undefined)).toEqual([]);
    expect(markdownLinesOutsideCode({})).toEqual([]);
  });
});

describe('marker format stability (#900)', () => {
  it('marker strings are frozen', () => {
    expect(STICKY_COMMENT_MARKER_LEGACY).toBe('<!-- trustbridge-action:sticky-comment -->');
    expect(STICKY_COMMENT_MARKER).toBe(
      `<!-- trustbridge-action:sticky-comment:schema-v${COMMENT_SCHEMA_VERSION} -->`,
    );
    expect(TRUSTBRIDGE_IDENTITY_LINES).toEqual([
      STICKY_COMMENT_MARKER,
      STICKY_COMMENT_MARKER_LEGACY,
      TRUSTBRIDGE_FOOTER,
    ]);
  });

  it('docs/COMMENT_GUIDE.md documents every identity line', () => {
    const guide = fs.readFileSync(
      path.join(__dirname, '..', 'docs', 'COMMENT_GUIDE.md'),
      'utf8',
    );
    expect(guide).toContain('## Marker format stability');
    expect(guide).toContain(STICKY_COMMENT_MARKER_LEGACY);
    expect(guide).toContain('<!-- trustbridge-action:sticky-comment:schema-v<N> -->');
    expect(guide).toContain(TRUSTBRIDGE_FOOTER);
  });
});
