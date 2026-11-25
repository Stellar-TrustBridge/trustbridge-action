import * as fs from 'fs';
import * as path from 'path';
import {
  parseCodeowners,
  normalizeOwnerHandle,
  loadCodeowners,
  isMaintainerActor,
  parseCodeownersRules,
  findCoveringRule,
  checkCodeownersCoverage,
  checkCodeownersCoverageWithDetail,
  formatMatchedPatternNote,
  CodeownersRule,
} from '../src/codeowners';

describe('parseCodeowners', () => {
  it('parses direct usernames and teams with leading @', () => {
    const content = `
# Global owners
* @alice @org/maintainers @bob
# Docs
/docs/ @charlie
`;
    const owners = parseCodeowners(content);
    expect(owners.has('alice')).toBe(true);
    expect(owners.has('org/maintainers')).toBe(true);
    expect(owners.has('bob')).toBe(true);
    expect(owners.has('charlie')).toBe(true);
    expect(owners.size).toBe(4);
  });

  it('handles empty and comment-only content without throwing', () => {
    expect(parseCodeowners('').size).toBe(0);
    expect(parseCodeowners('# Only comments\n# Another comment').size).toBe(0);
  });

  it('normalizes handles to lowercase', () => {
    const content = '* @Alice @ORG/TEAM';
    const owners = parseCodeowners(content);
    expect(owners.has('alice')).toBe(true);
    expect(owners.has('org/team')).toBe(true);
  });

  it('handles inline comments on rule lines', () => {
    const content = '* @alice @bob # trailing inline comment';
    const owners = parseCodeowners(content);
    expect(owners.has('alice')).toBe(true);
    expect(owners.has('bob')).toBe(true);
    expect(owners.has('trailing')).toBe(false);
    expect(owners.has('inline')).toBe(false);
  });
});

describe('normalizeOwnerHandle', () => {
  it('strips leading @ and lowercases', () => {
    expect(normalizeOwnerHandle('@User1')).toBe('user1');
    expect(normalizeOwnerHandle('user2')).toBe('user2');
    expect(normalizeOwnerHandle('@org/TeamA')).toBe('org/teama');
  });
});

describe('isMaintainerActor', () => {
  const codeowners = new Set(['alice', 'org/core-team', 'bob']);

  it('returns true when actor is in CODEOWNERS directly', () => {
    expect(isMaintainerActor('alice', codeowners)).toBe(true);
    expect(isMaintainerActor('ALICE', codeowners)).toBe(true);
    expect(isMaintainerActor('@alice', codeowners)).toBe(true);
  });

  it('returns true when actor matches team sub-name', () => {
    expect(isMaintainerActor('core-team', codeowners)).toBe(true);
  });

  it('returns true when actor is in maintainersAllowlist', () => {
    expect(isMaintainerActor('charlie', codeowners, ['@charlie', 'david'])).toBe(true);
    expect(isMaintainerActor('david', codeowners, ['@charlie', 'david'])).toBe(true);
  });

  it('returns false when actor is not a maintainer', () => {
    expect(isMaintainerActor('random-contributor', codeowners)).toBe(false);
    expect(isMaintainerActor('', codeowners)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseCodeownersRules
// ---------------------------------------------------------------------------

describe('parseCodeownersRules', () => {
  it('returns one rule per non-empty, non-comment line', () => {
    const content = `
# Global
*  @alice
/src/  @bob @org/team
`;
    const rules = parseCodeownersRules(content);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({ pattern: '*', owners: ['alice'] });
    expect(rules[1]).toEqual({ pattern: '/src/', owners: ['bob', 'org/team'] });
  });

  it('skips rules with no owners', () => {
    const content = `
*
/docs/   @docs-team
`;
    const rules = parseCodeownersRules(content);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.pattern).toBe('/docs/');
  });

  it('respects inline comments — tokens after # are not treated as owners', () => {
    const content = '* @alice @bob # this is not @an-owner';
    const rules = parseCodeownersRules(content);
    expect(rules[0]!.owners).toEqual(['alice', 'bob']);
    expect(rules[0]!.owners).not.toContain('this');
    expect(rules[0]!.owners).not.toContain('an-owner');
  });

  it('returns an empty array for blank or comment-only content', () => {
    expect(parseCodeownersRules('')).toEqual([]);
    expect(parseCodeownersRules('# just a comment')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findCoveringRule — last-match-wins precedence
// ---------------------------------------------------------------------------

describe('findCoveringRule — last-match-wins precedence', () => {
  it('returns null when no rules are provided', () => {
    expect(findCoveringRule('src/foo.ts', [])).toBeNull();
  });

  it('returns null when no rule matches the path', () => {
    const rules: CodeownersRule[] = [{ pattern: 'docs/**', owners: ['docs-team'] }];
    expect(findCoveringRule('src/foo.ts', rules)).toBeNull();
  });

  it('returns the only matching rule when just one matches', () => {
    const rules: CodeownersRule[] = [
      { pattern: '*', owners: ['global-owner'] },
      { pattern: 'docs/**', owners: ['docs-team'] },
    ];
    const result = findCoveringRule('src/foo.ts', rules);
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe('*');
    expect(result!.owners).toEqual(['global-owner']);
  });

  /**
   * Core precedence test: when multiple patterns match, the LAST one wins.
   * Fixture: conflict-glob-vs-specific.CODEOWNERS
   *   *            → @global-owner
   *   src/**       → @backend-team
   *   src/payments → @payments-team   ← should win for src/payments/invoice.ts
   */
  it('last-match-wins: specific path after broad glob wins', () => {
    const rules: CodeownersRule[] = [
      { pattern: '*', owners: ['global-owner'] },
      { pattern: 'src/**', owners: ['backend-team'] },
      { pattern: 'src/payments', owners: ['payments-team'] },
    ];
    const result = findCoveringRule('src/payments/invoice.ts', rules);
    expect(result!.pattern).toBe('src/payments');
    expect(result!.owners).toEqual(['payments-team']);
  });

  it('last-match-wins: intermediate rule wins when specific rule does not match', () => {
    const rules: CodeownersRule[] = [
      { pattern: '*', owners: ['global-owner'] },
      { pattern: 'src/**', owners: ['backend-team'] },
      { pattern: 'src/payments', owners: ['payments-team'] },
    ];
    // src/horizon.ts matches * and src/** but NOT src/payments
    const result = findCoveringRule('src/horizon.ts', rules);
    expect(result!.pattern).toBe('src/**');
    expect(result!.owners).toEqual(['backend-team']);
  });

  it('last-match-wins: catch-all * wins for root-level files when no later rule matches', () => {
    const rules: CodeownersRule[] = [
      { pattern: '*', owners: ['global-owner'] },
      { pattern: 'src/**', owners: ['backend-team'] },
    ];
    const result = findCoveringRule('README.md', rules);
    expect(result!.pattern).toBe('*');
    expect(result!.owners).toEqual(['global-owner']);
  });

  it('last-match-wins: duplicate pattern — second occurrence overrides first', () => {
    // Fixture: conflict-duplicate-pattern.CODEOWNERS
    const rules: CodeownersRule[] = [
      { pattern: 'src/**', owners: ['legacy-team'] },
      { pattern: 'src/**', owners: ['current-team'] },
    ];
    const result = findCoveringRule('src/index.ts', rules);
    expect(result!.owners).toEqual(['current-team']);
  });

  it('last-match-wins: team override for sub-path (fixture: conflict-team-override)', () => {
    // docs/**  → @docs-team
    // docs/api/** → @alice @bob  ← wins for docs/api/*
    const rules: CodeownersRule[] = [
      { pattern: 'docs/**', owners: ['docs-team'] },
      { pattern: 'docs/api/**', owners: ['alice', 'bob'] },
    ];
    const apiResult = findCoveringRule('docs/api/reference.md', rules);
    expect(apiResult!.pattern).toBe('docs/api/**');
    expect(apiResult!.owners).toEqual(['alice', 'bob']);

    const docsResult = findCoveringRule('docs/USAGE.md', rules);
    expect(docsResult!.pattern).toBe('docs/**');
    expect(docsResult!.owners).toEqual(['docs-team']);
  });

  it('last-match-wins: type-glob overridden for generated subtree (fixture: conflict-negation-gap)', () => {
    // **/*.ts         → @typescript-guild
    // src/generated/** → @tooling-team  ← wins for src/generated/*
    const rules: CodeownersRule[] = [
      { pattern: '**/*.ts', owners: ['typescript-guild'] },
      { pattern: 'src/generated/**', owners: ['tooling-team'] },
    ];
    const generatedResult = findCoveringRule('src/generated/schema.ts', rules);
    expect(generatedResult!.pattern).toBe('src/generated/**');
    expect(generatedResult!.owners).toEqual(['tooling-team']);

    const srcResult = findCoveringRule('src/codeowners.ts', rules);
    expect(srcResult!.pattern).toBe('**/*.ts');
    expect(srcResult!.owners).toEqual(['typescript-guild']);
  });

  it('strips a leading slash from the pattern before matching', () => {
    const rules: CodeownersRule[] = [{ pattern: '/src/index.ts', owners: ['alice'] }];
    expect(findCoveringRule('src/index.ts', rules)).not.toBeNull();
    expect(findCoveringRule('src/index.ts', rules)!.owners).toEqual(['alice']);
  });
});

// ---------------------------------------------------------------------------
// findCoveringRule — fixture file integration
// ---------------------------------------------------------------------------

describe('findCoveringRule — fixture file integration', () => {
  const fixtureDir = path.join(__dirname, '../fixtures/codeowners');

  it('fixture conflict-glob-vs-specific: payments path → @payments-team wins', () => {
    const content = fs.readFileSync(
      path.join(fixtureDir, 'conflict-glob-vs-specific.CODEOWNERS'),
      'utf8',
    );
    const rules = parseCodeownersRules(content);
    const result = findCoveringRule('src/payments/invoice.ts', rules);
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe('src/payments');
    expect(result!.owners).toEqual(['payments-team']);
  });

  it('fixture conflict-glob-vs-specific: non-payments src → @backend-team wins', () => {
    const content = fs.readFileSync(
      path.join(fixtureDir, 'conflict-glob-vs-specific.CODEOWNERS'),
      'utf8',
    );
    const rules = parseCodeownersRules(content);
    const result = findCoveringRule('src/horizon.ts', rules);
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe('src/**');
    expect(result!.owners).toEqual(['backend-team']);
  });

  it('fixture conflict-glob-vs-specific: root file → @global-owner wins', () => {
    const content = fs.readFileSync(
      path.join(fixtureDir, 'conflict-glob-vs-specific.CODEOWNERS'),
      'utf8',
    );
    const rules = parseCodeownersRules(content);
    const result = findCoveringRule('README.md', rules);
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe('*');
    expect(result!.owners).toEqual(['global-owner']);
  });

  it('fixture conflict-team-override: docs/api → @alice @bob wins', () => {
    const content = fs.readFileSync(
      path.join(fixtureDir, 'conflict-team-override.CODEOWNERS'),
      'utf8',
    );
    const rules = parseCodeownersRules(content);
    const result = findCoveringRule('docs/api/reference.md', rules);
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe('docs/api/**');
    expect(result!.owners).toEqual(['alice', 'bob']);
  });

  it('fixture conflict-team-override: other docs → @docs-team wins', () => {
    const content = fs.readFileSync(
      path.join(fixtureDir, 'conflict-team-override.CODEOWNERS'),
      'utf8',
    );
    const rules = parseCodeownersRules(content);
    const result = findCoveringRule('docs/USAGE.md', rules);
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe('docs/**');
    expect(result!.owners).toEqual(['docs-team']);
  });

  it('fixture conflict-team-override: unmatched path → null (uncovered)', () => {
    const content = fs.readFileSync(
      path.join(fixtureDir, 'conflict-team-override.CODEOWNERS'),
      'utf8',
    );
    const rules = parseCodeownersRules(content);
    expect(findCoveringRule('src/index.ts', rules)).toBeNull();
  });

  it('fixture conflict-duplicate-pattern: second identical pattern → @current-team wins', () => {
    const content = fs.readFileSync(
      path.join(fixtureDir, 'conflict-duplicate-pattern.CODEOWNERS'),
      'utf8',
    );
    const rules = parseCodeownersRules(content);
    const result = findCoveringRule('src/index.ts', rules);
    expect(result).not.toBeNull();
    expect(result!.owners).toEqual(['current-team']);
  });

  it('fixture conflict-negation-gap: generated file → @tooling-team wins', () => {
    const content = fs.readFileSync(
      path.join(fixtureDir, 'conflict-negation-gap.CODEOWNERS'),
      'utf8',
    );
    const rules = parseCodeownersRules(content);
    const result = findCoveringRule('src/generated/schema.ts', rules);
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe('src/generated/**');
    expect(result!.owners).toEqual(['tooling-team']);
  });

  it('fixture conflict-negation-gap: regular ts file → @typescript-guild wins', () => {
    const content = fs.readFileSync(
      path.join(fixtureDir, 'conflict-negation-gap.CODEOWNERS'),
      'utf8',
    );
    const rules = parseCodeownersRules(content);
    const result = findCoveringRule('src/codeowners.ts', rules);
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe('**/*.ts');
    expect(result!.owners).toEqual(['typescript-guild']);
  });

  it('fixture conflict-negation-gap: shell script → null (uncovered)', () => {
    const content = fs.readFileSync(
      path.join(fixtureDir, 'conflict-negation-gap.CODEOWNERS'),
      'utf8',
    );
    const rules = parseCodeownersRules(content);
    expect(findCoveringRule('scripts/build.sh', rules)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkCodeownersCoverage
// ---------------------------------------------------------------------------

describe('checkCodeownersCoverage', () => {
  it('marks files covered when a rule matches with owners', () => {
    const rules: CodeownersRule[] = [{ pattern: 'src/**', owners: ['alice'] }];
    const result = checkCodeownersCoverage(['src/index.ts', 'docs/README.md'], rules);
    expect(result.covered).toContain('src/index.ts');
    expect(result.uncovered).toContain('docs/README.md');
    expect(result.missingCodeowners).toBe(false);
  });

  it('sets missingCodeowners=true when rules array is empty', () => {
    const result = checkCodeownersCoverage(['src/index.ts'], []);
    expect(result.missingCodeowners).toBe(true);
    expect(result.uncovered).toContain('src/index.ts');
  });

  it('handles empty path list without throwing', () => {
    const result = checkCodeownersCoverage([], [{ pattern: '*', owners: ['alice'] }]);
    expect(result.covered).toHaveLength(0);
    expect(result.uncovered).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// checkCodeownersCoverageWithDetail — pattern citation
// ---------------------------------------------------------------------------

describe('checkCodeownersCoverageWithDetail', () => {
  const rules: CodeownersRule[] = [
    { pattern: '*', owners: ['global-owner'] },
    { pattern: 'src/**', owners: ['backend-team'] },
    { pattern: 'src/payments', owners: ['payments-team'] },
  ];

  it('returns matched pattern and owners for covered files', () => {
    const { details } = checkCodeownersCoverageWithDetail(
      ['src/payments/invoice.ts'],
      rules,
    );
    expect(details[0]!.covered).toBe(true);
    expect(details[0]!.matchedPattern).toBe('src/payments');
    expect(details[0]!.owners).toEqual(['payments-team']);
  });

  it('returns matchedPattern=null for uncovered files', () => {
    const noOwnerRules: CodeownersRule[] = [
      { pattern: 'docs/**', owners: ['docs-team'] },
    ];
    const { details } = checkCodeownersCoverageWithDetail(['src/index.ts'], noOwnerRules);
    expect(details[0]!.covered).toBe(false);
    expect(details[0]!.matchedPattern).toBeNull();
    expect(details[0]!.owners).toEqual([]);
  });

  it('covered and uncovered arrays are consistent with details', () => {
    // Use rules without a catch-all so scripts/build.sh is genuinely uncovered
    const narrowRules: CodeownersRule[] = [
      { pattern: 'src/**', owners: ['backend-team'] },
      { pattern: 'src/payments', owners: ['payments-team'] },
    ];
    const { details, covered, uncovered } = checkCodeownersCoverageWithDetail(
      ['src/payments/invoice.ts', 'scripts/build.sh'],
      narrowRules,
    );
    expect(covered).toContain('src/payments/invoice.ts');
    expect(uncovered).toContain('scripts/build.sh');
    expect(details).toHaveLength(2);
  });

  it('sets missingCodeowners=true when rules array is empty', () => {
    const { missingCodeowners, uncovered } = checkCodeownersCoverageWithDetail(
      ['src/index.ts'],
      [],
    );
    expect(missingCodeowners).toBe(true);
    expect(uncovered).toContain('src/index.ts');
  });

  it('handles an empty path list', () => {
    const { details, covered, uncovered } = checkCodeownersCoverageWithDetail([], rules);
    expect(details).toHaveLength(0);
    expect(covered).toHaveLength(0);
    expect(uncovered).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// formatMatchedPatternNote — preflight comment citation
// ---------------------------------------------------------------------------

describe('formatMatchedPatternNote', () => {
  it('formats a covered file with matched pattern and owners', () => {
    const note = formatMatchedPatternNote({
      filePath: 'src/payments/invoice.ts',
      covered: true,
      matchedPattern: 'src/payments',
      owners: ['payments-team'],
    });
    expect(note).toBe(
      'src/payments/invoice.ts → matched pattern `src/payments` → owners: @payments-team',
    );
  });

  it('formats a covered file with multiple owners', () => {
    const note = formatMatchedPatternNote({
      filePath: 'docs/api/reference.md',
      covered: true,
      matchedPattern: 'docs/api/**',
      owners: ['alice', 'bob'],
    });
    expect(note).toContain('@alice');
    expect(note).toContain('@bob');
    expect(note).toContain('`docs/api/**`');
  });

  it('formats an uncovered file with a stable message', () => {
    const note = formatMatchedPatternNote({
      filePath: 'scripts/build.sh',
      covered: false,
      matchedPattern: null,
      owners: [],
    });
    expect(note).toBe('scripts/build.sh → no CODEOWNERS rule matched');
  });

  it('covered=false with a non-null matchedPattern still reports uncovered (defensive)', () => {
    const note = formatMatchedPatternNote({
      filePath: 'some/file.ts',
      covered: false,
      matchedPattern: 'some/**',
      owners: [],
    });
    expect(note).toContain('no CODEOWNERS rule matched');
  });
});

// ---------------------------------------------------------------------------
// loadCodeowners branch safety
// ---------------------------------------------------------------------------

describe('loadCodeowners branch safety', () => {
  const mockOctokit = {
    rest: {
      repos: {
        getContent: jest.fn(),
      },
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fetches from remote base branch when isForkPr is true', async () => {
    const base64Codeowners = Buffer.from('* @remote-maintainer').toString('base64');
    mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
      data: { content: base64Codeowners },
    });

    const owners = await loadCodeowners({
      isForkPr: true,
      githubToken: 'ghp_mocktoken',
      octokit: mockOctokit as any,
      baseRef: 'main',
      owner: 'Stellar-TrustBridge',
      repo: 'trustbridge-action',
    });

    expect(mockOctokit.rest.repos.getContent).toHaveBeenCalledWith({
      owner: 'Stellar-TrustBridge',
      repo: 'trustbridge-action',
      path: '.github/CODEOWNERS',
      ref: 'main',
    });
    expect(owners.has('remote-maintainer')).toBe(true);
  });

  it('fails safe (returns empty set) if fork PR has no token', async () => {
    const owners = await loadCodeowners({
      isForkPr: true,
      githubToken: '',
    });

    expect(owners.size).toBe(0);
  });
});
