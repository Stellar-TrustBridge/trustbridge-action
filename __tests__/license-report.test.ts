/**
 * Issue #791 — LICENSE_REPORT.md regeneration script and CI drift check.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const report = require('../scripts/generate-license-report.js');

const REPO_ROOT = path.resolve(__dirname, '..');

const LOCK = {
  name: 'fixture',
  lockfileVersion: 3,
  packages: {
    '': { name: 'fixture', version: '1.0.0' },
    'node_modules/@scope/pkg': { version: '2.0.0', license: 'MIT' },
    'node_modules/zeta': { version: '1.0.0', license: 'ISC' },
    'node_modules/@scope/pkg/node_modules/zeta': { version: '0.9.0', license: 'ISC' },
    'node_modules/devonly': { version: '3.0.0', license: 'MIT', dev: true },
    'node_modules/devopt': { version: '3.0.0', license: 'MIT', devOptional: true },
    'node_modules/nolicense': { version: '0.0.1' },
    'node_modules/pipe': { version: '1.0.0', license: 'MIT | Apache' },
  },
};

const DOC = `# Report\n\nIntro.\n\n${report.BEGIN_MARKER}\nstale\n${report.END_MARKER}\n\n## After\n`;

function tmpRepo(lock: unknown, doc: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'license-report-'));
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), typeof lock === 'string' ? lock : JSON.stringify(lock));
  fs.writeFileSync(path.join(dir, 'docs', 'LICENSE_REPORT.md'), doc);
  return dir;
}

const silent = { log: jest.fn(), error: jest.fn() };

beforeEach(() => jest.clearAllMocks());

describe('collectProductionPackages', () => {
  it('keeps production entries only, including nested copies, sorted', () => {
    const rows = report.collectProductionPackages(LOCK);
    expect(rows.map((r: { name: string; version: string }) => `${r.name}@${r.version}`)).toEqual([
      '@scope/pkg@2.0.0',
      'nolicense@0.0.1',
      'pipe@1.0.0',
      'zeta@0.9.0',
      'zeta@1.0.0',
    ]);
  });

  it('marks packages without license metadata as UNKNOWN', () => {
    const rows = report.collectProductionPackages(LOCK);
    expect(rows.find((r: { name: string }) => r.name === 'nolicense').license).toBe('UNKNOWN');
  });

  it('rejects lockfiles without a packages map (npm 6, lockfileVersion 1)', () => {
    expect(() => report.collectProductionPackages({ lockfileVersion: 1, dependencies: {} })).toThrow(/UNSUPPORTED_LOCKFILE|npm >= 7/);
  });
});

describe('renderReportBlock / replaceReportBlock', () => {
  it('renders a table with a license summary and escapes pipes', () => {
    const block = report.renderReportBlock(report.collectProductionPackages(LOCK));
    expect(block.startsWith(report.BEGIN_MARKER)).toBe(true);
    expect(block.endsWith(report.END_MARKER)).toBe(true);
    expect(block).toContain('5 production package(s)');
    expect(block).toContain('| `@scope/pkg` | 2.0.0 | MIT |');
    expect(block).toContain('MIT \\| Apache');
  });

  it('only rewrites the text between the markers', () => {
    const out = report.replaceReportBlock(DOC, `${report.BEGIN_MARKER}\nNEW\n${report.END_MARKER}`);
    expect(out).toContain('Intro.');
    expect(out).toContain('## After');
    expect(out).toContain('NEW');
    expect(out).not.toContain('stale');
  });

  it('fails with a stable error when the markers are missing', () => {
    expect(() => report.replaceReportBlock('# no markers', 'x')).toThrow(expect.objectContaining({ code: 'MARKERS_MISSING' }));
  });
});

describe('main (CLI)', () => {
  it('regenerates the report, after which --check passes (happy path)', () => {
    const dir = tmpRepo(LOCK, DOC);
    expect(report.main([], dir, silent)).toBe(0);
    expect(report.main(['--check'], dir, silent)).toBe(0);
    const doc = fs.readFileSync(path.join(dir, 'docs', 'LICENSE_REPORT.md'), 'utf8');
    expect(doc).toContain('| `zeta` | 1.0.0 | ISC |');
  });

  it('--check exits 1 when the lockfile changed since the report was generated (drift)', () => {
    const dir = tmpRepo(LOCK, DOC);
    report.main([], dir, silent);
    const bumped = JSON.parse(JSON.stringify(LOCK));
    bumped.packages['node_modules/zeta'].version = '1.1.0';
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(bumped));

    expect(report.main(['--check'], dir, silent)).toBe(1);
    expect(silent.error).toHaveBeenCalledWith(expect.stringContaining('npm run license:report'));
  });

  it('--check never writes the report', () => {
    const dir = tmpRepo(LOCK, DOC);
    report.main(['--check'], dir, silent);
    expect(fs.readFileSync(path.join(dir, 'docs', 'LICENSE_REPORT.md'), 'utf8')).toBe(DOC);
  });

  it('exits 2 with clear errors for malformed or missing inputs', () => {
    expect(report.main([], tmpRepo('{not json', DOC), silent)).toBe(2);
    expect(silent.error).toHaveBeenCalledWith(expect.stringContaining('INVALID_LOCKFILE'));
    expect(report.main(['--report', 'nope.md'], tmpRepo(LOCK, DOC), silent)).toBe(2);
    expect(silent.error).toHaveBeenCalledWith(expect.stringContaining('FILE_NOT_FOUND'));
    expect(report.main(['--bogus'], tmpRepo(LOCK, DOC), silent)).toBe(2);
  });

  it('the committed docs/LICENSE_REPORT.md matches package-lock.json', () => {
    const { drift } = report.computeReport(
      fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'),
      fs.readFileSync(path.join(REPO_ROOT, 'docs', 'LICENSE_REPORT.md'), 'utf8'),
    );
    expect(drift).toBe(false);
  });
});
