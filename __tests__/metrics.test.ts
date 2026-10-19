import { CONTRACT_ADDRESS_TAG_KEY, MetricsCollector, writeJobSummary, JobSummaryReport } from '../src/metrics';
import * as core from '@actions/core';

jest.mock('@actions/core');

const mockCore = core as jest.Mocked<typeof core>;

const VALID_CONTRACT_ADDRESS = 'C' + 'A'.repeat(55);

// ---------------------------------------------------------------------------
// Existing MetricsCollector tests (unchanged)
// ---------------------------------------------------------------------------

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

  it('records campaign preset metrics and counter', () => {
    const metrics = new MetricsCollector();
    metrics.recordPresetMetric('testnet', 'testnet');

    const summary = metrics.getSummary();
    expect(summary.totalMetrics).toBe(1);
    expect(summary.metrics[0]).toMatchObject({
      name: 'campaign_preset_applied',
      value: 1,
      unit: 'count',
      tags: { preset: 'testnet', network: 'testnet' },
    });
    expect(metrics.getCounter('preset_testnet_applied')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Wave #27: buildJobSummary
// ---------------------------------------------------------------------------

describe('MetricsCollector.buildJobSummary (Wave #27)', () => {
  it('returns null latencyMs when no duration metrics recorded', () => {
    const m = new MetricsCollector();
    const report = m.buildJobSummary();
    expect(report.latencyMs).toBeNull();
  });

  it('computes average latency across duration metrics', () => {
    const m = new MetricsCollector();
    m.recordMetric('horizon_fetch_duration', 100, 'ms');
    m.recordMetric('horizon_fetch_duration', 200, 'ms');
    const report = m.buildJobSummary();
    expect(report.latencyMs).toBe(150);
  });

  it('only considers *_duration metrics for latency (not other metrics)', () => {
    const m = new MetricsCollector();
    m.recordMetric('check_count', 5, 'count');
    m.recordMetric('horizon_fetch_duration', 80, 'ms');
    const report = m.buildJobSummary();
    expect(report.latencyMs).toBe(80);
  });

  it('captures unique HTTP failure codes from horizon_error metrics', () => {
    const m = new MetricsCollector();
    m.recordMetric('horizon_error', 429, 'http_status');
    m.recordMetric('horizon_error', 503, 'http_status');
    m.recordMetric('horizon_error', 429, 'http_status'); // duplicate
    const report = m.buildJobSummary();
    expect(report.failureCodes).toEqual([429, 503]);
  });

  it('returns empty failureCodes when no horizon_error metrics recorded', () => {
    const m = new MetricsCollector();
    const report = m.buildJobSummary();
    expect(report.failureCodes).toEqual([]);
  });

  it('ignores non-http_status unit metrics named horizon_error', () => {
    const m = new MetricsCollector();
    m.recordMetric('horizon_error', 42, 'count'); // wrong unit
    const report = m.buildJobSummary();
    expect(report.failureCodes).toEqual([]);
  });

  it('reports totalRuns from the runs counter', () => {
    const m = new MetricsCollector();
    m.incrementCounter('runs', 3);
    const report = m.buildJobSummary();
    expect(report.totalRuns).toBe(3);
  });

  it('reports totalErrors from the errors counter', () => {
    const m = new MetricsCollector();
    m.incrementCounter('errors', 2);
    const report = m.buildJobSummary();
    expect(report.totalErrors).toBe(2);
  });

  it('defaults totalRuns and totalErrors to 0', () => {
    const m = new MetricsCollector();
    const report = m.buildJobSummary();
    expect(report.totalRuns).toBe(0);
    expect(report.totalErrors).toBe(0);
  });

  it('produces valid JSON in jsonArtifact', () => {
    const m = new MetricsCollector();
    m.recordMetric('latency', 50, 'ms');
    m.incrementCounter('runs');
    const report = m.buildJobSummary();
    expect(() => JSON.parse(report.jsonArtifact)).not.toThrow();
  });

  it('strips tags from jsonArtifact (no contract addresses)', () => {
    const m = new MetricsCollector();
    m.recordContractMetric('asset_issuer_contract_validated', 1, VALID_CONTRACT_ADDRESS);
    const report = m.buildJobSummary();
    expect(report.jsonArtifact).not.toContain(VALID_CONTRACT_ADDRESS);
    const obj = JSON.parse(report.jsonArtifact);
    expect(obj.metrics[0].tags).toBeUndefined();
  });

  it('jsonArtifact contains totalMetrics, counters, and metrics array', () => {
    const m = new MetricsCollector();
    m.recordMetric('check_run', 1, 'count');
    m.incrementCounter('runs', 1);
    const report = m.buildJobSummary();
    const obj = JSON.parse(report.jsonArtifact);
    expect(obj.totalMetrics).toBe(1);
    expect(obj.counters.runs).toBe(1);
    expect(Array.isArray(obj.metrics)).toBe(true);
  });

  it('failure path: records 404 as failure code 404 is not included (only retryable codes are)', () => {
    // 404 is handled as unfundedAccountResult, not recorded as horizon_error
    const m = new MetricsCollector();
    m.recordMetric('horizon_error', 429, 'http_status');
    const report = m.buildJobSummary();
    expect(report.failureCodes).toContain(429);
    expect(report.failureCodes).not.toContain(404);
  });

  it('100+ metrics: latency averages correctly at scale', () => {
    const m = new MetricsCollector();
    for (let i = 1; i <= 100; i++) {
      m.recordMetric('horizon_fetch_duration', i, 'ms');
    }
    const report = m.buildJobSummary();
    // Sum of 1..100 = 5050, avg = 50.5
    expect(report.latencyMs).toBeCloseTo(50.5, 5);
  });
});

// ---------------------------------------------------------------------------
// Wave #27: writeJobSummary
// ---------------------------------------------------------------------------

describe('writeJobSummary (Wave #27)', () => {
  let summaryAddHeadingMock: jest.Mock;
  let summaryAddTableMock: jest.Mock;
  let summaryAddDetailsMock: jest.Mock;
  let summaryWriteMock: jest.Mock;

  beforeEach(() => {
    summaryAddHeadingMock = jest.fn().mockReturnThis();
    summaryAddTableMock = jest.fn().mockReturnThis();
    summaryAddDetailsMock = jest.fn().mockReturnThis();
    summaryWriteMock = jest.fn().mockResolvedValue(undefined);

    (mockCore.summary as unknown as Record<string, jest.Mock>) = {
      addHeading: summaryAddHeadingMock,
      addTable: summaryAddTableMock,
      addDetails: summaryAddDetailsMock,
      write: summaryWriteMock,
    };
  });

  function makeReport(overrides: Partial<JobSummaryReport> = {}): JobSummaryReport {
    return {
      latencyMs: 42.5,
      failureCodes: [429, 503],
      totalRuns: 5,
      totalErrors: 2,
      jsonArtifact: '{"totalMetrics":0,"counters":{},"metrics":[]}',
      ...overrides,
    };
  }

  it('calls core.summary.write', async () => {
    await writeJobSummary(makeReport());
    expect(summaryWriteMock).toHaveBeenCalled();
  });

  it('adds a heading with TrustBridge Metrics', async () => {
    await writeJobSummary(makeReport());
    expect(summaryAddHeadingMock).toHaveBeenCalledWith(
      expect.stringContaining('TrustBridge Metrics'),
      2,
    );
  });

  it('includes run label in heading when provided', async () => {
    await writeJobSummary(makeReport(), 'Wave #27');
    expect(summaryAddHeadingMock).toHaveBeenCalledWith(
      expect.stringContaining('Wave #27'),
      2,
    );
  });

  it('includes a table with totals and latency', async () => {
    await writeJobSummary(makeReport({ totalRuns: 7, latencyMs: 99.9 }));
    const tableArg = summaryAddTableMock.mock.calls[0][0] as unknown[][];
    const flat = tableArg.flat().map(String);
    expect(flat.join(' ')).toContain('7');
    expect(flat.join(' ')).toContain('99.9');
  });

  it('renders failure codes in table row', async () => {
    await writeJobSummary(makeReport({ failureCodes: [429, 503] }));
    const tableArg = summaryAddTableMock.mock.calls[0][0] as unknown[][];
    const flat = tableArg.flat().map(String).join(' ');
    expect(flat).toContain('429');
    expect(flat).toContain('503');
  });

  it('shows _none_ when no failure codes', async () => {
    await writeJobSummary(makeReport({ failureCodes: [] }));
    const tableArg = summaryAddTableMock.mock.calls[0][0] as unknown[][];
    const flat = tableArg.flat().map(String).join(' ');
    expect(flat).toContain('_none_');
  });

  it('shows _none recorded_ when latencyMs is null', async () => {
    await writeJobSummary(makeReport({ latencyMs: null }));
    const tableArg = summaryAddTableMock.mock.calls[0][0] as unknown[][];
    const flat = tableArg.flat().map(String).join(' ');
    expect(flat).toContain('_none recorded_');
  });

  it('includes JSON artifact in addDetails call', async () => {
    const artifact = '{"totalMetrics":1,"counters":{},"metrics":[]}';
    await writeJobSummary(makeReport({ jsonArtifact: artifact }));
    expect(summaryAddDetailsMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining(artifact),
    );
  });

  it('does not throw if core.summary.write rejects (observability-only)', async () => {
    summaryWriteMock.mockRejectedValue(new Error('GITHUB_STEP_SUMMARY not set'));
    await expect(writeJobSummary(makeReport())).resolves.not.toThrow();
  });

  it('does not throw if core.summary methods throw (outside Actions context)', async () => {
    summaryAddHeadingMock.mockImplementation(() => { throw new Error('no summary'); });
    await expect(writeJobSummary(makeReport())).resolves.not.toThrow();
  });
});
