/** Issue #959 — keep the SARIF troubleshooting playbook aligned with src/sarif.ts and docs/examples. */
import * as fs from 'fs';
import * as path from 'path';
import { SARIF_VERSION, SARIF_FINGERPRINT_KEY, GENERIC_RULE_ID, CIRCUIT_OPEN_RULE_ID } from '../src/sarif';

const root = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('SARIF troubleshooting playbook', () => {
  const doc = read('docs/TROUBLESHOOTING.md');

  it('has the playbook section and links the example (happy path)', () => {
    expect(doc).toContain('## SARIF upload failures');
    expect(doc).toContain('examples/sarif-code-scanning.yml');
    expect(fs.existsSync(path.join(root, 'docs/examples/sarif-code-scanning.yml'))).toBe(true);
  });

  it('covers permission, size and schema failures', () => {
    expect(doc).toMatch(/security-events: write/);
    expect(doc).toMatch(/too large/i);
    expect(doc).toMatch(/not valid SARIF/);
  });

  it('matches constants exported by src/sarif.ts', () => {
    expect(doc).toContain(SARIF_VERSION);
    expect(doc).toContain(SARIF_FINGERPRINT_KEY);
    expect(doc).toContain(`${GENERIC_RULE_ID}`);
    expect(doc).toContain(`${CIRCUIT_OPEN_RULE_ID}`);
  });

  it('example workflow grants security-events and guards a missing file', () => {
    const ex = read('docs/examples/sarif-code-scanning.yml');
    expect(ex).toContain('security-events: write');
    expect(ex).toContain("hashFiles('trustbridge-results.sarif')");
    expect(ex).toContain('upload-sarif');
  });

  it('USAGE.md links the playbook', () => {
    expect(read('docs/USAGE.md')).toContain('TROUBLESHOOTING.md#sarif-upload-failures');
  });
});
