import { CONTRACT_ADDRESS_TAG_KEY, MetricsCollector } from '../src/metrics';

const VALID_CONTRACT_ADDRESS = 'C' + 'A'.repeat(55);

describe('MetricsCollector.recordMetric', () => {
  it('records a metric without a contract address tag', () => {
    const metrics = new MetricsCollector();
    metrics.recordMetric('latency', 42, 'ms');

    const summary = metrics.getSummary();
    expect(summary.totalMetrics).toBe(1);
    expect(summary.metrics[0]).toMatchObject({ name: 'latency', value: 42, unit: 'ms' });
  });

  it('records a metric with a valid contractAddress tag', () => {
    const metrics = new MetricsCollector();
    metrics.recordMetric('trustline_check', 1, 'count', {
      [CONTRACT_ADDRESS_TAG_KEY]: VALID_CONTRACT_ADDRESS,
    });

    const summary = metrics.getSummary();
    expect(summary.metrics[0].tags?.[CONTRACT_ADDRESS_TAG_KEY]).toBe(VALID_CONTRACT_ADDRESS);
  });

  it('throws when the contractAddress tag fails the C-address policy', () => {
    const metrics = new MetricsCollector();

    expect(() =>
      metrics.recordMetric('trustline_check', 1, 'count', {
        [CONTRACT_ADDRESS_TAG_KEY]: 'not-a-contract-address',
      }),
    ).toThrow(/Invalid contractAddress tag/);

    expect(metrics.getSummary().totalMetrics).toBe(0);
  });
});

describe('MetricsCollector.recordContractMetric', () => {
  it('tags the metric with the given contract address', () => {
    const metrics = new MetricsCollector();
    metrics.recordContractMetric('asset_issuer_contract_validated', 1, VALID_CONTRACT_ADDRESS);

    const summary = metrics.getSummary();
    expect(summary.metrics[0]).toMatchObject({
      name: 'asset_issuer_contract_validated',
      value: 1,
      tags: { [CONTRACT_ADDRESS_TAG_KEY]: VALID_CONTRACT_ADDRESS },
    });
  });

  it('rejects an invalid contract address without recording a metric', () => {
    const metrics = new MetricsCollector();

    expect(() =>
      metrics.recordContractMetric('asset_issuer_contract_validated', 1, 'GNOTACONTRACT'),
    ).toThrow(/Invalid contractAddress tag/);
    expect(metrics.getSummary().totalMetrics).toBe(0);
  });
});

describe('MetricsCollector counters, timers, and export', () => {
  it('increments and reads counters', () => {
    const metrics = new MetricsCollector();
    metrics.incrementCounter('retries');
    metrics.incrementCounter('retries', 2);
    expect(metrics.getCounter('retries')).toBe(3);
  });

  it('times an operation and records its duration', () => {
    const metrics = new MetricsCollector();
    metrics.startTimer('horizon_fetch');
    const elapsed = metrics.stopTimer('horizon_fetch');

    expect(elapsed).not.toBeNull();
    expect(metrics.getAverageMetric('horizon_fetch_duration')).toBe(elapsed);
  });

  it('returns null when stopping a timer that was never started', () => {
    const metrics = new MetricsCollector();
    expect(metrics.stopTimer('missing')).toBeNull();
  });

  it('exports a JSON summary and resets cleanly', () => {
    const metrics = new MetricsCollector();
    metrics.recordMetric('latency', 10);
    metrics.incrementCounter('runs');

    const json = JSON.parse(metrics.toJSON());
    expect(json.totalMetrics).toBe(1);
    expect(json.counters.runs).toBe(1);

    metrics.reset();
    expect(metrics.getSummary().totalMetrics).toBe(0);
    expect(metrics.getCounter('runs')).toBe(0);
  });
});
