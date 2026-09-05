import * as fs from 'fs';
import * as path from 'path';

describe('.github/workflows/ci.yml', () => {
  const workflowPath = path.join(__dirname, '../.github/workflows/ci.yml');

  it('exists and verifies the published action package', () => {
    expect(fs.existsSync(workflowPath)).toBe(true);
    const content = fs.readFileSync(workflowPath, 'utf8');

    expect(content).toContain('name: CI');
    expect(content).toContain('actions/checkout@v4');
    expect(content).toContain('action.yml');
    expect(content).toContain('dist/index.js');
  });
});

describe('.github/workflows/release.yml', () => {
  const workflowPath = path.join(__dirname, '../.github/workflows/release.yml');

  it('exists and verifies the action bundle before release', () => {
    expect(fs.existsSync(workflowPath)).toBe(true);
    const content = fs.readFileSync(workflowPath, 'utf8');
    expect(content).toContain('name: Release');
    expect(content).toContain('dist/index.js');
  });
});

describe('action.yml', () => {
  const actionPath = path.join(__dirname, '../action.yml');
  let content: string;

  beforeAll(() => {
    content = fs.readFileSync(actionPath, 'utf8');
  });

  it('declares comment_mode input', () => {
    expect(content).toContain('comment_mode:');
    expect(content).toContain('dry-run');
  });

  it('declares dashboard_webhook_url input', () => {
    expect(content).toContain('dashboard_webhook_url:');
  });

  it('outputs block still contains all four standard outputs', () => {
    expect(content).toContain('trustline_exists:');
    expect(content).toContain('xlm_balance:');
    expect(content).toContain('account_funded:');
    expect(content).toContain('comment_url:');
  });
});
