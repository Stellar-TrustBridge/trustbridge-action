import * as fs from 'fs';
import * as path from 'path';

describe('.github/workflows/ci.yml', () => {
  const workflowPath = path.join(__dirname, '../.github/workflows/ci.yml');
  let content: string;

  beforeAll(() => {
    content = fs.readFileSync(workflowPath, 'utf8');
  });

  it('exists and contains valid workflow configuration', () => {
    expect(fs.existsSync(workflowPath)).toBe(true);

    expect(content).toContain('name: CI');
    expect(content).toContain('actions/checkout@');
    expect(content).toContain('actions/setup-node@');
    expect(content).toContain('npm ci');
    expect(content).toContain('npm run lint');
    expect(content).toContain('npm run typecheck');
    expect(content).toContain('npm test');
    expect(content).toContain('npm run build');
    expect(content).toContain('dist/index.js');
  });

  it('uses the check job name', () => {
    const content = fs.readFileSync(workflowPath, 'utf8');
    expect(content).toContain('check:');
  });

  it('does not contain || true shell fallbacks on typecheck or test steps', () => {
    const content = fs.readFileSync(workflowPath, 'utf8');
    // CI must propagate failures — no silent pass-through on typecheck or tests
    const lines = content.split('\n');
    const typecheckLine = lines.find((l) => l.includes('npm run typecheck'));
    const testLine = lines.find((l) => l.trim() === 'run: npm test');
    expect(typecheckLine).toBeDefined();
    expect(typecheckLine).not.toContain('|| true');
    expect(testLine).toBeDefined();
    expect(testLine).not.toContain('|| true');
  });

  it('includes comment golden snapshots and coverage verification steps', () => {
    expect(content).toContain('Verify comment golden snapshots and test coverage');
  });

  it('includes license-check job for GPL policy enforcement', () => {
    expect(content).toContain('license-check');
    expect(content).toContain('npm run license:check');
  });

  it('includes check-unpinned-actions job for supply-chain security', () => {
    expect(content).toContain('check-unpinned-actions');
    expect(content).toContain('scripts/check-unpinned-actions.sh');
  });

  it('pins all actions to full SHA hashes (no @vN tag refs)', () => {
    // Every uses: line must contain a 40-char hex SHA, not a vN tag
    const usesLines = content
      .split('\n')
      .filter((line) => /^\s+uses:\s+/.test(line));

    expect(usesLines.length).toBeGreaterThan(0);

    for (const line of usesLines) {
      // Local actions (./) and docker:// are exempt from SHA pinning
      if (/uses:\s+\.\//.test(line) || /uses:\s+docker:\/\//.test(line)) {
        continue;
      }
      expect(line).toMatch(/@[0-9a-f]{40}/);
    }
  });
});
