const fs = require('fs');
const os = require('os');
const path = require('path');

const { checkMapPaths, sourceMapErrors } = require('../scripts/check-map-paths.js');

function writeMap(map: object): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trustbridge-map-'));
  fs.writeFileSync(path.join(directory, 'test.js.map'), JSON.stringify({ version: 3, mappings: '', ...map }));
  return directory;
}

describe('source-map path assertion', () => {
  test.each([
    ['a backslash', 'src\\index.ts'],
    ['a drive letter', 'C:/repo/src/index.ts'],
    ['a file URL', 'file:///repo/src/index.ts'],
    ['an absolute path', '/repo/src/index.ts'],
    ['a path escaping the root', '../src/index.ts'],
    ['a non-relative path', './src/index.ts'],
  ])('rejects %s', (_description, source) => {
    expect(() => checkMapPaths(writeMap({ sources: [source] }))).toThrow('test.js.map sources[0]');
  });

  test('accepts a repo-relative POSIX path', () => {
    expect(checkMapPaths(writeMap({ version: 3, sources: ['src/index.ts'], sourceRoot: '', file: 'dist/index.js', mappings: '' }))).toBe(1);
  });

  test('allows optional empty source-map fields', () => {
    expect(checkMapPaths(writeMap({ version: 3, sources: ['src/index.ts'], sourceRoot: '', file: '', mappings: '' }))).toBe(1);
  });

  test('requires valid source-map metadata and an application source', () => {
    expect(sourceMapErrors({ sources: ['src/index.ts'], mappings: '' }, 'test.js.map')).toContain('test.js.map: source map version must be 3');
    expect(sourceMapErrors({ version: 3, sources: ['vendor/index.ts'], mappings: '' }, 'test.js.map')).toContain('test.js.map: sources must point at src/');
    expect(sourceMapErrors({ version: 3, sources: ['node_modules/pkg/index.js'], mappings: '' }, 'vendor.js.map')).toEqual([]);
    expect(sourceMapErrors({ version: 3, sourceRoot: 'src', sources: ['index.ts'], mappings: '' }, 'test.js.map')).toEqual([]);
  });

  test('rejects a missing or empty map directory', () => {
    expect(() => checkMapPaths(path.join(os.tmpdir(), 'trustbridge-map-missing'))).toThrow('dist directory is missing');
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'trustbridge-map-empty-'));
    expect(() => checkMapPaths(empty)).toThrow('no source maps found');
  });
});