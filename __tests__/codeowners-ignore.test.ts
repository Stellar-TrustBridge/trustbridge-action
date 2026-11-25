/**
 * Generated-path ignore patterns for ownership coverage — Issue #966.
 */

import {
  checkCodeownersCoverage,
  checkCodeownersCoverageWithDetail,
  CodeownersIgnoreError,
  CodeownersRule,
  DEFAULT_GENERATED_PATH_PATTERNS,
  findIgnoringPattern,
  compileIgnorePatterns,
  isIgnoredPath,
  MAX_IGNORE_PATTERN_LENGTH,
  MAX_IGNORE_PATTERNS,
  parseIgnorePatterns,
} from '../src/codeowners';
import {
  evaluateOwnershipPreflight,
  OWNERSHIP_WARNING_PATH_LIMIT,
} from '../src/preflight';

const RULES: CodeownersRule[] = [{ pattern: 'src/**', owners: ['alice'] }];

describe('DEFAULT_GENERATED_PATH_PATTERNS', () => {
  it('lists dist/ and coverage/ and cannot be mutated', () => {
    expect([...DEFAULT_GENERATED_PATH_PATTERNS]).toEqual(['dist/', 'coverage/']);
    expect(Object.isFrozen(DEFAULT_GENERATED_PATH_PATTERNS)).toBe(true);
  });
});

describe('parseIgnorePatterns', () => {
  it('accepts comma and newline separated strings, skipping blanks and comments', () => {
    expect(parseIgnorePatterns('dist/, coverage/\n\n# generated\n*.min.js,')).toEqual(['dist/', 'coverage/', '*.min.js']);
  });

  it('accepts arrays and treats undefined as no patterns', () => {
    expect(parseIgnorePatterns([' build/ ', ''])).toEqual(['build/']);
    expect(parseIgnorePatterns(undefined)).toEqual([]);
    expect(parseIgnorePatterns('')).toEqual([]);
  });

  it.each([
    ['!keep/', 'IGNORE_PATTERN_INVALID', /Negated/],
    ['../secret/', 'IGNORE_PATTERN_INVALID', /"\.\."/],
    ['a/../b', 'IGNORE_PATTERN_INVALID', /"\.\."/],
    ['dist\\out', 'IGNORE_PATTERN_INVALID', /backslash/],
    ['C:/build', 'IGNORE_PATTERN_INVALID', /drive path/],
    ['a\0b', 'IGNORE_PATTERN_INVALID', /NUL/],
  ])('rejects malformed pattern %j with a stable code', (pattern, code, message) => {
    try {
      parseIgnorePatterns(pattern);
      throw new Error('expected failure');
    } catch (err) {
      expect(err).toBeInstanceOf(CodeownersIgnoreError);
      expect((err as CodeownersIgnoreError).code).toBe(code);
      expect((err as Error).message).toMatch(message);
    }
  });

  it('rejects oversized patterns and too many patterns', () => {
    expect(() => parseIgnorePatterns('a'.repeat(MAX_IGNORE_PATTERN_LENGTH + 1))).toThrow(
      expect.objectContaining({ code: 'IGNORE_PATTERN_TOO_LONG' }),
    );
    const many = Array.from({ length: MAX_IGNORE_PATTERNS + 1 }, (_, i) => `gen${i}/`);
    expect(() => parseIgnorePatterns(many)).toThrow(expect.objectContaining({ code: 'IGNORE_TOO_MANY_PATTERNS' }));
    expect(parseIgnorePatterns(many.slice(0, MAX_IGNORE_PATTERNS))).toHaveLength(MAX_IGNORE_PATTERNS);
  });
});

describe('ignore pattern matching', () => {
  const matches = (pattern: string, filePath: string) => isIgnoredPath(filePath, [pattern]);

  it('matches a directory at any depth and everything under it', () => {
    expect(matches('dist/', 'dist/index.js')).toBe(true);
    expect(matches('dist/', 'packages/app/dist/bundle.js')).toBe(true);
    expect(matches('dist/', 'dist')).toBe(true);
    expect(matches('coverage/', 'coverage/lcov-report/index.html')).toBe(true);
  });

  it('does not match similarly named paths', () => {
    expect(matches('dist/', 'distribution/readme.md')).toBe(false);
    expect(matches('dist/', 'src/redist/a.js')).toBe(false);
    expect(matches('dist/', 'src/mydist/a.js')).toBe(false);
    expect(matches('coverage/', 'src/coverage.ts')).toBe(false);
  });

  it('anchors patterns with a leading or interior slash to the repository root', () => {
    expect(matches('/dist/', 'dist/a.js')).toBe(true);
    expect(matches('/dist/', 'packages/app/dist/a.js')).toBe(false);
    expect(matches('build/out/', 'build/out/x.js')).toBe(true);
    expect(matches('build/out/', 'pkg/build/out/x.js')).toBe(false);
  });

  it('supports * and ** globs', () => {
    expect(matches('*.min.js', 'assets/app.min.js')).toBe(true);
    expect(matches('*.min.js', 'app.min.js')).toBe(true);
    expect(matches('*.min.js', 'assets/app.js')).toBe(false);
    expect(matches('**/generated/', 'a/b/generated/c.ts')).toBe(true);
    expect(matches('src/**/*.pb.ts', 'src/deep/er/x.pb.ts')).toBe(true);
    expect(matches('src/*.gen.ts', 'src/a/x.gen.ts')).toBe(false);
  });

  it('normalizes leading ./ and / on file paths and escapes regex metacharacters', () => {
    expect(matches('dist/', './dist/a.js')).toBe(true);
    expect(matches('dist/', '/dist/a.js')).toBe(true);
    expect(matches('a+b/', 'a+b/x')).toBe(true);
    expect(matches('a+b/', 'aab/x')).toBe(false);
  });

  it('returns the first matching pattern for citation', () => {
    const compiled = compileIgnorePatterns(['coverage/', 'dist/']);
    expect(findIgnoringPattern('x/dist/a.js', compiled)).toBe('dist/');
    expect(findIgnoringPattern('src/a.ts', compiled)).toBeNull();
  });
});

describe('checkCodeownersCoverage with ignores', () => {
  const touched = ['src/index.ts', 'dist/index.js', 'coverage/lcov.info', 'scripts/build.sh', 'packages/a/dist/x.js'];

  it('is unchanged without options: generated paths still count as uncovered', () => {
    const result = checkCodeownersCoverage(touched, RULES);
    expect(result.uncovered).toEqual(['dist/index.js', 'coverage/lcov.info', 'scripts/build.sh', 'packages/a/dist/x.js']);
    expect(result.ignored).toBeUndefined();
  });

  it('skips generated paths when ignoreGenerated is set, keeping real gaps', () => {
    const result = checkCodeownersCoverage(touched, RULES, { ignoreGenerated: true });
    expect(result.covered).toEqual(['src/index.ts']);
    expect(result.uncovered).toEqual(['scripts/build.sh']);
    expect(result.ignored).toEqual(['dist/index.js', 'coverage/lcov.info', 'packages/a/dist/x.js']);
  });

  it('merges custom patterns with the generated defaults', () => {
    const result = checkCodeownersCoverage([...touched, 'docs/api.min.js'], RULES, {
      ignoreGenerated: true,
      ignorePatterns: '*.min.js',
    });
    expect(result.ignored).toContain('docs/api.min.js');
    expect(result.uncovered).toEqual(['scripts/build.sh']);
  });

  it('honors custom patterns alone without the defaults', () => {
    const result = checkCodeownersCoverage(touched, RULES, { ignorePatterns: ['scripts/'] });
    expect(result.ignored).toEqual(['scripts/build.sh']);
    expect(result.uncovered).toContain('dist/index.js');
  });

  it('ignores a path even when a CODEOWNERS rule would cover it', () => {
    const result = checkCodeownersCoverage(['dist/a.js'], [{ pattern: '*', owners: ['bob'] }], { ignoreGenerated: true });
    expect(result.ignored).toEqual(['dist/a.js']);
    expect(result.covered).toEqual([]);
  });

  it('keeps missingCodeowners independent of ignores', () => {
    const result = checkCodeownersCoverage(['dist/a.js', 'src/b.ts'], [], { ignoreGenerated: true });
    expect(result.missingCodeowners).toBe(true);
    expect(result.uncovered).toEqual(['src/b.ts']);
  });

  it('surfaces malformed ignore patterns instead of silently ignoring nothing', () => {
    expect(() => checkCodeownersCoverage(touched, RULES, { ignorePatterns: '!dist/' })).toThrow(CodeownersIgnoreError);
  });

  it('is idempotent across repeated calls with the same input', () => {
    const options = { ignoreGenerated: true, ignorePatterns: ['*.snap'] };
    expect(checkCodeownersCoverage(touched, RULES, options)).toEqual(checkCodeownersCoverage(touched, RULES, options));
  });
});

describe('checkCodeownersCoverageWithDetail with ignores', () => {
  it('reports which pattern ignored each path and leaves them out of details', () => {
    const result = checkCodeownersCoverageWithDetail(['src/a.ts', 'dist/a.js', 'x/coverage/b.html'], RULES, {
      ignoreGenerated: true,
    });
    expect(result.details.map((d) => d.filePath)).toEqual(['src/a.ts']);
    expect(result.ignored).toEqual([
      { filePath: 'dist/a.js', pattern: 'dist/' },
      { filePath: 'x/coverage/b.html', pattern: 'coverage/' },
    ]);
  });

  it('omits ignored entirely when no ignore option is given', () => {
    expect(checkCodeownersCoverageWithDetail(['dist/a.js'], RULES).ignored).toBeUndefined();
  });
});

describe('evaluateOwnershipPreflight (Wave PR preflight)', () => {
  it('raises no warning for a PR that only touches owned and generated paths', () => {
    const result = evaluateOwnershipPreflight(['src/a.ts', 'dist/index.js', 'coverage/lcov.info'], RULES);
    expect(result.warnings).toEqual([]);
    expect(result.ignored).toEqual(['dist/index.js', 'coverage/lcov.info']);
  });

  it('warns about genuinely uncovered paths and names them', () => {
    const result = evaluateOwnershipPreflight(['src/a.ts', 'scripts/deploy.sh', 'dist/x.js'], RULES);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/1 touched path\(s\) have no CODEOWNERS owner: scripts\/deploy\.sh/);
    expect(result.warnings[0]).not.toContain('dist/x.js');
  });

  it('caps the number of paths named in the warning', () => {
    const many = Array.from({ length: OWNERSHIP_WARNING_PATH_LIMIT + 5 }, (_, i) => `tools/t${i}.sh`);
    const [warning] = evaluateOwnershipPreflight(many, RULES).warnings;
    expect(warning).toContain('(+5 more)');
    expect(warning).toContain(`${many.length} touched path(s)`);
  });

  it('explains a missing CODEOWNERS file separately', () => {
    const result = evaluateOwnershipPreflight(['src/a.ts', 'dist/x.js'], []);
    expect(result.missingCodeowners).toBe(true);
    expect(result.warnings[0]).toMatch(/No CODEOWNERS rules were found, so 1 touched path/);
  });

  it('can check everything when generated ignores are disabled', () => {
    const result = evaluateOwnershipPreflight(['dist/x.js'], RULES, { ignoreGenerated: false });
    expect(result.uncovered).toEqual(['dist/x.js']);
    expect(result.warnings).toHaveLength(1);
  });

  it('applies extra ignore patterns and rejects bad ones loudly', () => {
    const result = evaluateOwnershipPreflight(['gen/api.ts', 'scripts/x.sh'], RULES, { ignorePatterns: ['gen/'] });
    expect(result.ignored).toContain('gen/api.ts');
    expect(result.uncovered).toEqual(['scripts/x.sh']);
    expect(() => evaluateOwnershipPreflight(['a'], RULES, { ignorePatterns: '../x' })).toThrow(CodeownersIgnoreError);
  });
});
