import * as fs from 'fs';
import * as path from 'path';

describe('.github/workflows/ci.yml', () => {
  const workflowPath = path.join(__dirname, '../.github/workflows/ci.yml');

  it('exists and verifies the published action package', () => {
    expect(fs.existsSync(workflowPath)).toBe(true);
    const content = fs.readFileSync(workflowPath, 'utf8');

    expect(content).toContain('name: CI');
    expect(content).toContain('actions/checkout@');
    expect(content).toContain('action.yml');
    expect(content).toContain('dist/index.js');
    expect(content).toContain('npm run typecheck');
    expect(content).toContain('npm test');
    expect(content).toContain('npm run lint');
  });

  it('runs a dedicated coverage job enforcing the jest.config.js thresholds', () => {
    const content = fs.readFileSync(workflowPath, 'utf8');

    // Dedicated CI job runs the exact npm script documented in the README.
    expect(content).toContain('test-coverage:');
    expect(content).toContain('run: npm run test:coverage');

    // The gate it enforces must exist in jest.config.js with real thresholds.
    const jestConfigPath = path.join(__dirname, '../jest.config.js');
    expect(fs.existsSync(jestConfigPath)).toBe(true);
    const jestConfig = require(jestConfigPath);
    expect(jestConfig.coverageDirectory).toBe('coverage');

    const globalThresholds = jestConfig.coverageThreshold?.global;
    expect(globalThresholds).toBeDefined();
    for (const metric of ['branches', 'functions', 'lines', 'statements'] as const) {
      const value = globalThresholds[metric];
      expect(typeof value).toBe('number');
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(100);
    }

    // Per-file gate for src/horizon.ts must stay wired up as documented.
    expect(Object.keys(jestConfig.coverageThreshold)).toContain('./src/horizon.ts');
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

  it('declares comment_mode and posting_mode inputs', () => {
    expect(content).toContain('comment_mode:');
    expect(content).toContain('posting_mode:');
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
