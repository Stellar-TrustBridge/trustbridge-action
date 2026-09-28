import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseCodeowners,
  resolveOwners,
  findCodeownersFile,
  isForkRemote,
} from '../src/codeowners';

/**
 * Unit tests for CODEOWNERS resolution, focused on fork edge cases.
 *
 * Behavior under test mirrors trustbridge-action/docs/USAGE.md:
 *  - CODEOWNERS is looked up in .github/, then the repo root, then docs/.
 *  - A missing CODEOWNERS file resolves to an empty owner list (no throw).
 *  - Fork remotes are detected and ownership is resolved against the fork's
 *    own CODEOWNERS; when the fork has no CODEOWNERS the result is empty.
 *  - Owner matching is exact on the normalized login (case-insensitive).
 *
 * All tests use local temp directories; no network access is performed.
 */

describe('CODEOWNERS fork edge cases', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeowners-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const writeCodeowners = (relPath: string, contents: string): string => {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, 'utf8');
    return full;
  };

  describe('missing CODEOWNERS', () => {
    it('returns null when no CODEOWNERS file exists', () => {
      expect(findCodeownersFile(tmpDir)).toBeNull();
    });

    it('resolves to an empty owner list without throwing', () => {
      const owners = resolveOwners(tmpDir, 'src/index.ts');
      expect(owners).toEqual([]);
    });

    it('does not treat an empty CODEOWNERS file as an error', () => {
      writeCodeowners('.github/CODEOWNERS', '');
      expect(parseCodeowners(path.join(tmpDir, '.github/CODEOWNERS'))).toEqual([]);
      expect(resolveOwners(tmpDir, 'src/index.ts')).toEqual([]);
    });
  });

  describe('fork remote resolution', () => {
    it('detects a fork remote by owner mismatch', () => {
      expect(
        isForkRemote('https://github.com/contributor/repo.git', 'upstream-org/repo'),
      ).toBe(true);
    });

    it('does not flag the canonical remote as a fork', () => {
      expect(
        isForkRemote('https://github.com/upstream-org/repo.git', 'upstream-org/repo'),
      ).toBe(false);
    });

    it('resolves owners from the fork checkout when present', () => {
      writeCodeowners('.github/CODEOWNERS', '* @fork-owner\n');
      const owners = resolveOwners(tmpDir, 'src/index.ts');
      expect(owners).toEqual(['@fork-owner']);
    });

    it('returns empty owners for a fork with no CODEOWNERS', () => {
      // Fork checkout exists but carries no CODEOWNERS file.
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      expect(resolveOwners(tmpDir, 'src/index.ts')).toEqual([]);
    });
  });

  describe('owner match and mismatch', () => {
    beforeEach(() => {
      writeCodeowners(
        '.github/CODEOWNERS',
        [
          '# default owners',
          '* @default-owner',
          'src/** @src-owner @second-owner',
          'docs/** @docs-owner',
        ].join('\n') + '\n',
      );
    });

    it('matches the most specific pattern for a path', () => {
      expect(resolveOwners(tmpDir, 'src/index.ts')).toEqual([
        '@src-owner',
        '@second-owner',
      ]);
    });

    it('falls back to the default owner on mismatch', () => {
      expect(resolveOwners(tmpDir, 'README.md')).toEqual(['@default-owner']);
    });

    it('matches owners case-insensitively', () => {
      const owners = resolveOwners(tmpDir, 'docs/guide.md');
      expect(owners.map((o) => o.toLowerCase())).toEqual(['@docs-owner']);
    });

    it('returns no owners when the path matches no pattern', () => {
      writeCodeowners('.github/CODEOWNERS', 'src/** @src-owner\n');
      expect(resolveOwners(tmpDir, 'other/file.ts')).toEqual([]);
    });
  });
});
