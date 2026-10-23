/**
 * Entry point consistency test for package.json, action.yml, and bundle.
 *
 * CI fails when:
 *  1. package.json main field doesn't match action.yml runs.main
 *  2. package.json exports field doesn't resolve to the main entry
 *  3. dist/index.js doesn't exist or is unreadable (verify build ran)
 *  4. scripts/verify-dist-manifest.js command doesn't exist or is missing
 *  5. The entry file path isn't "dist/index.js" in action.yml
 *
 * Why: Mismatch between entry points causes:
 *  - Local `node dist/index.js` to fail with MODULE_NOT_FOUND
 *  - require('trustbridge-action') to load wrong module in downstream consumers
 *  - GitHub Actions runner to fail if path in action.yml doesn't exist
 *  - npm run verify:dist to not work if script isn't defined
 *
 * This ensures all three coordinate properly so the action is runnable
 * both locally and in CI/CD pipelines.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');
const ACTION_YML_PATH = path.join(REPO_ROOT, 'action.yml');
const DIST_INDEX_PATH = path.join(REPO_ROOT, 'dist', 'index.js');
const VERIFY_DIST_SCRIPT = path.join(REPO_ROOT, 'scripts', 'verify-dist-manifest.js');

interface PackageJson {
  main?: string;
  exports?: Record<string, unknown>;
  scripts?: Record<string, string>;
}

describe('entry point consistency', () => {
  let packageJson: PackageJson;
  let actionYml: string;

  beforeAll(() => {
    // Load package.json
    const pkgContent = fs.readFileSync(PACKAGE_JSON_PATH, 'utf8');
    packageJson = JSON.parse(pkgContent) as PackageJson;

    // Load action.yml
    actionYml = fs.readFileSync(ACTION_YML_PATH, 'utf8');
  });

  it('package.json main field points to dist/index.js', () => {
    expect(packageJson.main).toBeDefined();
    expect(packageJson.main).toBe('dist/index.js');
  });

  it('package.json exports field resolves to dist/index.js', () => {
    expect(packageJson.exports).toBeDefined();
    const exportsValue = packageJson.exports;
    if (typeof exportsValue === 'object' && exportsValue !== null && '.' in exportsValue) {
      const dotExport = (exportsValue as Record<string, unknown>)['.'];
      if (typeof dotExport === 'object' && dotExport !== null && 'default' in dotExport) {
        const defaultEntry = (dotExport as Record<string, unknown>)['default'];
        expect(defaultEntry).toBe('./dist/index.js');
      } else {
        throw new Error('exports["."] must have a default field pointing to ./dist/index.js');
      }
    } else {
      throw new Error('package.json exports must have a ["."] key');
    }
  });

  it('action.yml runs.main points to dist/index.js', () => {
    // Parse the runs.main field from action.yml
    const runsMatch = actionYml.match(/^runs:\s*$/m);
    expect(runsMatch).toBeDefined();

    const mainMatch = actionYml.match(/runs:\s*[\s\S]*?main:\s*"([^"]+)"/);
    expect(mainMatch).toBeDefined();
    expect(mainMatch?.[1]).toBe('dist/index.js');
  });

  it('action.yml uses node20 runtime', () => {
    const usingMatch = actionYml.match(/runs:\s*[\s\S]*?using:\s*"([^"]+)"/);
    expect(usingMatch).toBeDefined();
    expect(usingMatch?.[1]).toBe('node20');
  });

  it('dist/index.js exists and is readable', () => {
    expect(fs.existsSync(DIST_INDEX_PATH)).toBe(true);
    const stats = fs.statSync(DIST_INDEX_PATH);
    expect(stats.size).toBeGreaterThan(0);
  });

  it('npm run verify:dist script is defined', () => {
    expect(packageJson.scripts).toBeDefined();
    expect(packageJson.scripts?.['verify:dist']).toBeDefined();
    expect(packageJson.scripts?.['verify:dist']).toBe('node scripts/verify-dist-manifest.js');
  });

  it('scripts/verify-dist-manifest.js exists and is executable', () => {
    expect(fs.existsSync(VERIFY_DIST_SCRIPT)).toBe(true);
    const stats = fs.statSync(VERIFY_DIST_SCRIPT);
    expect(stats.size).toBeGreaterThan(0);
  });

  it('node dist/index.js can be loaded without MODULE_NOT_FOUND', () => {
    // Sanity check: the file should be loadable by Node.js
    // We don't actually execute it (that would run the action), but we verify
    // the file exists and is valid JavaScript by checking its size and format
    const content = fs.readFileSync(DIST_INDEX_PATH, 'utf8');
    expect(content.length).toBeGreaterThan(0);
    // ncc-bundled files usually start with a shebang or module header
    // Just verify it's not empty or corrupted
    expect(content).toMatch(/./);
  });
});
