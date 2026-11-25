/**
 * Trace sampling ratio tests (Issue #967).
 *
 * Tracing stays opt-in. The new `trace_sampling_ratio` input must be
 * conservatively off on pull_request runs and for any invalid/out-of-range
 * value, while still allowing operators to opt into a fraction of runs.
 */
import { resolveTraceSamplingRatio } from '../src/inputs';
import {
  clearTraceSpans,
  configureTraceSampling,
  getTraceSamplingRatio,
  getTraceSpans,
  isTracingEnabled,
  resetTraceSampling,
  withSpan,
} from '../src/tracing';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  clearTraceSpans();
  resetTraceSampling();
  delete process.env['OTEL_TRACES_ENABLED'];
  delete process.env['OTEL_TRACES_EXPORTER'];
});

afterAll(() => {
  Object.assign(process.env, ORIGINAL_ENV);
  resetTraceSampling();
});

describe('resolveTraceSamplingRatio (Issue #967)', () => {
  it('accepts ratios in the inclusive [0, 1] range', () => {
    expect(resolveTraceSamplingRatio('0', 'push')).toBe(0);
    expect(resolveTraceSamplingRatio('0.25', 'push')).toBe(0.25);
    expect(resolveTraceSamplingRatio('1', 'push')).toBe(1);
    expect(resolveTraceSamplingRatio(' 0.5 ', 'push')).toBe(0.5);
  });

  it('defaults to off on pull_request runs (conservative default)', () => {
    expect(resolveTraceSamplingRatio('', 'pull_request')).toBe(0);
    expect(resolveTraceSamplingRatio(undefined, 'pull_request')).toBe(0);
  });

  it('rejects out-of-range, non-numeric and malformed ratios', () => {
    expect(resolveTraceSamplingRatio('-0.1', 'push')).toBe(0);
    expect(resolveTraceSamplingRatio('1.5', 'push')).toBe(0);
    expect(resolveTraceSamplingRatio('not-a-number', 'push')).toBe(0);
    expect(resolveTraceSamplingRatio('NaN', 'push')).toBe(0);
    expect(resolveTraceSamplingRatio('0,5', 'push')).toBe(0);
  });
});

describe('configureTraceSampling (Issue #967)', () => {
  it('records spans when tracing is enabled and the run is sampled', async () => {
    process.env['OTEL_TRACES_ENABLED'] = 'true';
    process.env['OTEL_TRACES_EXPORTER'] = 'none';
    configureTraceSampling(1);
    expect(getTraceSamplingRatio()).toBe(1);
    expect(isTracingEnabled()).toBe(true);

    await withSpan({ name: 'sampled.op' }, async () => 'ok');
    expect(getTraceSpans()).toHaveLength(1);
  });

  it('keeps tracing off when the ratio is zero, even if OTEL is enabled', async () => {
    process.env['OTEL_TRACES_ENABLED'] = 'true';
    process.env['OTEL_TRACES_EXPORTER'] = 'none';
    configureTraceSampling(resolveTraceSamplingRatio('', 'pull_request'));
    expect(isTracingEnabled()).toBe(false);

    await withSpan({ name: 'unsampled.op' }, async () => 'ok');
    expect(getTraceSpans()).toHaveLength(0);
  });

  it('samples deterministically from a supplied random draw', () => {
    process.env['OTEL_TRACES_ENABLED'] = 'true';
    configureTraceSampling(0.5, () => 0.2);
    expect(isTracingEnabled()).toBe(true);
    configureTraceSampling(0.5, () => 0.8);
    expect(isTracingEnabled()).toBe(false);
  });

  it('preserves PII redaction for sampled spans', async () => {
    process.env['OTEL_TRACES_ENABLED'] = 'true';
    process.env['OTEL_TRACES_EXPORTER'] = 'none';
    configureTraceSampling(1);
    const address = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    await withSpan({ name: 'sampled.pii', attributes: { stellar_address: address } }, async () => 1);
    const span = getTraceSpans()[0];
    expect(span.attributes.stellar_address).not.toContain(address);
    expect(span.attributes.stellar_address).toMatch(/^GAAA\.\.\.AWHF$/);
  });
});
