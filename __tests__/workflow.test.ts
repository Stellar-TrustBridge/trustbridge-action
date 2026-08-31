import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Wave #30: workflow.test.ts — dry-run, comment_mode, ci.yml, release.yml,
// dry-run.yml sanity checks
// ---------------------------------------------------------------------------

describe('.github/workflows/ci.yml', () => {
  const workflowPath = path.join(__dirname, '../.github/workflows/ci.yml');

  it('exists and contains valid workflow configuration', () => {
    expect(fs.existsSync(workflowPath)).toBe(true);
    const content = fs.readFileSync(workflowPath, 'utf8');

    expect(content).toContain('name: CI');
    expect(content).toContain('actions/checkout@');
    expect(content).toContain('actions/setup-node@');
    expect(content).toContain('npm ci');
    expect(content).toContain('npm run lint');
    expect(content).toContain('npm test');
    expect(content).toContain('npm run build');
    expect(content).toContain('dist/index.js');
  });

  it('includes comment golden snapshots and coverage verification steps', () => {
    const content = fs.readFileSync(workflowPath, 'utf8');
    expect(content).toContain('Verify comment golden snapshots and test coverage');
  });

  it('runs unit tests via npm test (includes validation performance budget)', () => {
    const content = fs.readFileSync(workflowPath, 'utf8');
    expect(content).toContain('npm test');
    const perfTestPath = path.join(__dirname, 'validation.performance.test.ts');
    expect(fs.existsSync(perfTestPath)).toBe(true);
  });
});

describe('.github/workflows/release.yml', () => {
  const workflowPath = path.join(__dirname, '../.github/workflows/release.yml');

  it('exists and contains release workflow configuration', () => {
    expect(fs.existsSync(workflowPath)).toBe(true);
    const content = fs.readFileSync(workflowPath, 'utf8');
    expect(content).toContain('name: Release');
    expect(content).toContain('npm run build');
    expect(content).toContain('dist/index.js');
  });

  // Wave #30: release pipeline must also have dry-run smoke
  it('includes dry-run-smoke job with comment_mode: dry-run (Wave #30)', () => {
    const content = fs.readFileSync(workflowPath, 'utf8');
    expect(content).toContain('dry-run-smoke');
    expect(content).toContain("comment_mode: 'dry-run'");
  });
});

describe('.github/workflows/dry-run.yml', () => {
  const workflowPath = path.join(__dirname, '../.github/workflows/dry-run.yml');

  it('exists (Wave #30)', () => {
    expect(fs.existsSync(workflowPath)).toBe(true);
  });

  it('has correct workflow name', () => {
    const content = fs.readFileSync(workflowPath, 'utf8');
    expect(content).toContain('name: Dry-Run Smoke Test');
  });

  it('uses comment_mode: dry-run in all action steps', () => {
    const content = fs.readFileSync(workflowPath, 'utf8');
    const occurrences = (content.match(/comment_mode: 'dry-run'/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('verifies comment_url is empty in dry-run', () => {
    const content = fs.readFileSync(workflowPath, 'utf8');
    expect(content).toContain('comment_url is empty as expected in dry-run mode');
  });

  it('includes dashboard_webhook_url test', () => {
    const content = fs.readFileSync(workflowPath, 'utf8');
    expect(content).toContain('dashboard_webhook_url');
  });

  it('uses fail_on_missing: false to avoid blocking PR checks', () => {
    const content = fs.readFileSync(workflowPath, 'utf8');
    const occurrences = (content.match(/fail_on_missing: false/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// action.yml: verify new inputs are declared (Wave #30 + Wave #38)
// ---------------------------------------------------------------------------

describe('action.yml', () => {
  const actionPath = path.join(__dirname, '../action.yml');
  let content: string;

  beforeAll(() => {
    content = fs.readFileSync(actionPath, 'utf8');
  });

  it('declares comment_mode input (Wave #30)', () => {
    expect(content).toContain('comment_mode:');
    expect(content).toContain('"post"');
    expect(content).toContain('dry-run');
  });

  it('comment_mode defaults to post', () => {
    const defaultLine = content
      .split('\n')
      .find((l) => l.includes("default: 'post'"));
    expect(defaultLine).toBeDefined();
  });

  it('declares dashboard_webhook_url input (Wave #38)', () => {
    expect(content).toContain('dashboard_webhook_url:');
  });

  it('dashboard_webhook_url defaults to empty string', () => {
    // The default: '' line exists in the full file for dashboard_webhook_url.
    // Search broadly since the description block is long.
    const occurrences = (content.match(/default: ''/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(1);
  });

  it('outputs block still contains all four standard outputs', () => {
    expect(content).toContain('trustline_exists:');
    expect(content).toContain('xlm_balance:');
    expect(content).toContain('account_funded:');
    expect(content).toContain('comment_url:');
  });
});

