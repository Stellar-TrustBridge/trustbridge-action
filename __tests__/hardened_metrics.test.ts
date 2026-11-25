/**
 * Tests for hardened metrics JSON export in src/comment.ts (Issue #33).
 * Covers: buildHardenedMetricsJson safety, size-capping, tag stripping,
 * and integration with formatCommentBody.
 */

import {
  MAX_METRICS_JSON_BYTES,
  buildHardenedMetricsJson,
  formatCommentBody,
} from '../src/comment';
import { MetricsCollector } from '../src/metrics';
import { ValidationResult } from '../src/checks';

const VALID_CONTRACT = 'C' + 'A'.repeat(55);

const baseConfig = {
  stellarAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  assetCode: 'USDC',
  assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  minXlmReserve: 1.5,
  horizonUrl: 'https://horizon.stellar.org',
};

const failedResult: ValidationResult = {
  valid: false,
  accountFunded: false,
  trustlineExists: false,
  xlmBalance: '0',
  xlmReserveMet: false,
  assetBalance: '0',
  assetBalanceMet: false,
  checks: [
    { passed: false, label: 'Account funded', detail: 'Not found.' },
  ],
};

// ---------------------------------------------------------------------------
// buildHardenedMetricsJson
// ---------------------------------------------------------------------------

describe('buildHardenedMetricsJson', () => {
  it('produces valid JSON', () => {
    const m = new MetricsCollector();
    m.recordMetric('latency', 42, 'ms');
    expect(() => JSON.parse(buildHardenedMetricsJson(m))).not.toThrow();
  });

  it('includes totalMetrics and counters', () => {
    const m = new MetricsCollector();
    m.recordMetric('latency', 42, 'ms');
    m.incrementCounter('runs');
    const obj = JSON.parse(buildHardenedMetricsJson(m));
    expect(obj.totalMetrics).toBe(1);
    expect(obj.counters.runs).toBe(1);
  });

  it('includes metric name, value, unit, and timestamp', () => {
    const m = new MetricsCollector();
    m.recordMetric('check_duration', 150, 'ms');
    const obj = JSON.parse(buildHardenedMetricsJson(m));
    const metric = obj.metrics[0];
    expect(metric.name).toBe('check_duration');
    expect(metric.value).toBe(150);
    expect(metric.unit).toBe('ms');
    expect(typeof metric.timestamp).toBe('number');
  });

  it('strips tags entirely (including contractAddress)', () => {
    const m = new MetricsCollector();
    m.recordContractMetric('asset_issuer_contract_validated', 1, VALID_CONTRACT);
    const json = buildHardenedMetricsJson(m);
    const obj = JSON.parse(json);
    expect(obj.metrics[0].tags).toBeUndefined();
    // Raw contract address must not appear in the output
    expect(json).not.toContain(VALID_CONTRACT);
  });

  it('truncates when output exceeds MAX_METRICS_JSON_BYTES', () => {
    const m = new MetricsCollector();
    // Fill with enough metrics to exceed the size cap
    for (let i = 0; i < 300; i++) {
      m.recordMetric(`metric_with_a_long_name_${i}`, i, 'milliseconds_unit');
    }
    const json = buildHardenedMetricsJson(m);
    const obj = JSON.parse(json);
    expect(obj.truncated).toBe(true);
    expect(obj.note).toContain(`${MAX_METRICS_JSON_BYTES} bytes`);
    // Truncated output still has totalMetrics and counters
    expect(obj.totalMetrics).toBeDefined();
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(MAX_METRICS_JSON_BYTES * 2);
  });

  it('returns empty metrics array for a fresh collector', () => {
    const m = new MetricsCollector();
    const obj = JSON.parse(buildHardenedMetricsJson(m));
    expect(obj.totalMetrics).toBe(0);
    expect(obj.metrics).toEqual([]);
    expect(obj.counters).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// formatCommentBody with metricsSnapshot
// ---------------------------------------------------------------------------

describe('formatCommentBody — metrics section', () => {
  it('omits metrics section when metricsSnapshot is not provided', () => {
    const body = formatCommentBody(failedResult, baseConfig);
    expect(body).not.toContain('### Metrics');
  });

  it('includes metrics section when metricsSnapshot is provided', () => {
    const m = new MetricsCollector();
    m.recordMetric('latency', 42, 'ms');
    const body = formatCommentBody(failedResult, { ...baseConfig, metricsSnapshot: m });
    expect(body).toContain('### Metrics');
    expect(body).toContain('```json');
    expect(body).toContain('"totalMetrics": 1');
  });

  it('metrics JSON in comment does not contain raw contract addresses', () => {
    const m = new MetricsCollector();
    m.recordContractMetric('validated', 1, VALID_CONTRACT);
    const body = formatCommentBody(failedResult, { ...baseConfig, metricsSnapshot: m });
    // The raw contract address must not leak into the comment
    expect(body).not.toContain(VALID_CONTRACT);
  });

  it('metrics section appears before the footer', () => {
    const m = new MetricsCollector();
    const body = formatCommentBody(failedResult, { ...baseConfig, metricsSnapshot: m });
    const metricsIdx = body.indexOf('### Metrics');
    const footerIdx = body.indexOf('_Posted by');
    expect(metricsIdx).toBeLessThan(footerIdx);
  });
});

// ---------------------------------------------------------------------------
// formatCommentBody with sep0007DeepLinks
// ---------------------------------------------------------------------------

describe('formatCommentBody — SEP-0007 section', () => {
  it('omits SEP-0007 section when sep0007DeepLinks is false (default)', () => {
    const body = formatCommentBody(failedResult, baseConfig);
    expect(body).not.toContain('SEP-0007');
    expect(body).not.toContain('web+stellar:');
  });

  it('includes SEP-0007 section when sep0007DeepLinks is true', () => {
    const body = formatCommentBody(failedResult, { ...baseConfig, sep0007DeepLinks: true });
    expect(body).toContain('### Quick wallet actions (SEP-0007)');
    expect(body).toContain('web+stellar:pay');
  });

  it('uses testnet passphrase for testnet horizon URL', () => {
    const body = formatCommentBody(failedResult, {
      ...baseConfig,
      horizonUrl: 'https://horizon-testnet.stellar.org',
      sep0007DeepLinks: true,
    });
    expect(body.replace(/\+/g, ' ')).toContain('Test SDF Network');
  });
});
