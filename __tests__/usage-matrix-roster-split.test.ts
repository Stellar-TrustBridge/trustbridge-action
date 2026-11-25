import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { MAX_BATCH_CONCURRENCY } from '../src/batch';

const root = path.join(__dirname, '..');
const example = yaml.load(
  fs.readFileSync(path.join(root, 'docs/examples/batch-validation-with-matrix-outputs.yml'), 'utf8'),
) as { jobs: Record<string, any> };
const usage = fs.readFileSync(path.join(root, 'docs/USAGE.md'), 'utf8');

describe('USAGE.md large roster matrix split patterns (Issue #952)', () => {
  it('example defines plan → sharded-validate → aggregate jobs', () => {
    expect(Object.keys(example.jobs)).toEqual(
      expect.arrayContaining(['plan-shards', 'sharded-validate', 'aggregate-shards']),
    );
    expect(example.jobs['sharded-validate'].needs).toBe('plan-shards');
    expect(example.jobs['aggregate-shards'].needs).toEqual(['plan-shards', 'sharded-validate']);
  });

  it('matrix legs do not cancel each other and aggregation always runs', () => {
    expect(example.jobs['sharded-validate'].strategy['fail-fast']).toBe(false);
    expect(example.jobs['aggregate-shards'].if).toBe('always()');
  });

  it('aggregation fails on missing shards and gates on truncation', () => {
    const steps = JSON.stringify(example.jobs);
    expect(steps).toContain('shard_count');
    expect(steps).toContain('outputs_truncated');
    expect(steps).toMatch(/-ne \\"\$EXPECTED\\"/);
  });

  it('every shard uses stellar_addresses with posting disabled', () => {
    const step = example.jobs['sharded-validate'].steps.find((s: any) => s.id === 'trustbridge');
    expect(step.with.stellar_addresses).toContain('matrix.shard.addresses');
    expect(step.with.posting_mode).toBe('off');
  });

  it('USAGE.md documents the caps it relies on and links the example', () => {
    expect(usage).toContain('## Matrix strategy patterns for large roster splits (Issue #952)');
    expect(usage).toContain(`MAX_BATCH_CONCURRENCY\` (${MAX_BATCH_CONCURRENCY}`);
    expect(usage).toContain('MAX_OUTPUT_VALUE_BYTES');
    expect(usage).toContain('examples/batch-validation-with-matrix-outputs.yml');
  });
});
