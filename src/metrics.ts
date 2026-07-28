/**
 * Metrics collection for monitoring action performance and behavior.
 *
 * Wave #27 additions:
 *   - `JobSummaryRow` / `JobSummarySection` types for structured summary output
 *   - `MetricsCollector.buildJobSummary()` — produce a machine-readable
 *     `JobSummaryReport` from the current metrics state
 *   - `writeJobSummary()` — write the summary to GitHub Actions Job Summary
 *     via `@actions/core`; no-ops outside a GitHub Actions context
 */

import * as core from '@actions/core';
import { validateContractAddress } from './validation';

export interface MetricPoint {
  name: string;
  value: number;
  unit: string;
  timestamp: number;
  tags?: Record<string, string>;
}

/**
 * Tag key that flags a metric as carrying a Soroban contract ("C-address").
 * Metrics tagged this way are validated against the contract address
 * policy before being recorded, so a malformed or malicious value never
 * makes it into the JSON metrics artifact (see toJSON()).
 */
export const CONTRACT_ADDRESS_TAG_KEY = 'contractAddress';

export class MetricsCollector {
  private metrics: MetricPoint[] = [];
  private counters: Map<string, number> = new Map();
  private timers: Map<string, number> = new Map();

  /**
   * Record a numeric metric. If a `contractAddress` tag is present, it is
   * validated against the Soroban C-address policy first; an invalid
   * address throws rather than being silently recorded.
   */
  recordMetric(name: string, value: number, unit: string = '', tags?: Record<string, string>): void {
    const contractAddress = tags?.[CONTRACT_ADDRESS_TAG_KEY];
    if (contractAddress !== undefined) {
      const result = validateContractAddress(contractAddress);
      if (!result.valid) {
        throw new Error(
          `Invalid ${CONTRACT_ADDRESS_TAG_KEY} tag on metric "${name}": ${result.errors.join('; ')}`,
        );
      }
    }

    this.metrics.push({
      name,
      value,
      unit,
      timestamp: Date.now(),
      tags,
    });
  }

  /**
   * Convenience wrapper for recording a metric tagged with a Soroban
   * contract address, enforcing the C-address policy up front.
   */
  recordContractMetric(
    name: string,
    value: number,
    contractAddress: string,
    unit: string = '',
    extraTags?: Record<string, string>,
  ): void {
    this.recordMetric(name, value, unit, {
      ...extraTags,
      [CONTRACT_ADDRESS_TAG_KEY]: contractAddress,
    });
  }

  /**
   * Increment a counter.
   */
  incrementCounter(name: string, amount: number = 1): void {
    const current = this.counters.get(name) ?? 0;
    this.counters.set(name, current + amount);
  }

  /**
   * Get counter value.
   */
  getCounter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  /**
   * Start a timer.
   */
  startTimer(name: string): void {
    this.timers.set(name, Date.now());
  }

  /**
   * Stop a timer and record the elapsed time.
   */
  stopTimer(name: string, unit: string = 'ms'): number | null {
    const startTime = this.timers.get(name);
    if (startTime === undefined) {
      return null;
    }

    const elapsed = Date.now() - startTime;
    this.recordMetric(`${name}_duration`, elapsed, unit);
    this.timers.delete(name);
    return elapsed;
  }

  /**
   * Get a summary of all recorded metrics.
   */
  getSummary(): {
    metrics: MetricPoint[];
    counters: Record<string, number>;
    totalMetrics: number;
  } {
    return {
      metrics: this.metrics,
      counters: Object.fromEntries(this.counters),
      totalMetrics: this.metrics.length,
    };
  }

  /**
   * Export metrics in JSON format.
   */
  toJSON(): string {
    return JSON.stringify(this.getSummary(), null, 2);
  }

  /**
   * Clear all metrics.
   */
  reset(): void {
    this.metrics = [];
    this.counters.clear();
    this.timers.clear();
  }

  /**
   * Get average value for a metric.
   */
  getAverageMetric(name: string): number | null {
    const metricPoints = this.metrics.filter((m) => m.name === name);
    if (metricPoints.length === 0) {
      return null;
    }

    const sum = metricPoints.reduce((acc, m) => acc + m.value, 0);
    return sum / metricPoints.length;
  }

  /**
   * Build a structured Job Summary report from current metrics state.
   *
   * The report contains:
   *   - `latencyMs`     – average duration of any `*_duration` metrics (ms)
   *   - `failureCodes`  – unique HTTP status codes recorded via
   *                       `recordMetric('horizon_error', code, 'http_status')`
   *   - `totalRuns`     – value of the `runs` counter
   *   - `totalErrors`   – value of the `errors` counter
   *   - `jsonArtifact`  – the full `getSummary()` payload serialised as JSON
   *                       (tags stripped — no contract addresses)
   *
   * Safe to call at any time; never throws.
   */
  buildJobSummary(): JobSummaryReport {
    // Latency: average of all *_duration metrics
    const durationPoints = this.metrics.filter((m) => m.name.endsWith('_duration'));
    const latencyMs =
      durationPoints.length > 0
        ? durationPoints.reduce((sum, m) => sum + m.value, 0) / durationPoints.length
        : null;

    // Failure codes: values of metrics named "horizon_error" with unit "http_status"
    const failureCodes = [
      ...new Set(
        this.metrics
          .filter((m) => m.name === 'horizon_error' && m.unit === 'http_status')
          .map((m) => m.value),
      ),
    ].sort((a, b) => a - b);

    // JSON artifact (tags stripped to avoid leaking contract addresses)
    const summary = this.getSummary();
    const safeArtifact = {
      totalMetrics: summary.totalMetrics,
      counters: summary.counters,
      metrics: summary.metrics.map((m) => ({
        name: m.name,
        value: m.value,
        unit: m.unit,
        timestamp: m.timestamp,
      })),
    };

    return {
      latencyMs,
      failureCodes,
      totalRuns: this.counters.get('runs') ?? 0,
      totalErrors: this.counters.get('errors') ?? 0,
      jsonArtifact: JSON.stringify(safeArtifact, null, 2),
    };
  }
}

// ---------------------------------------------------------------------------
// Job Summary types (Wave #27)
// ---------------------------------------------------------------------------

/**
 * Structured report produced by `MetricsCollector.buildJobSummary()`.
 */
export interface JobSummaryReport {
  /** Average latency across all `*_duration` metrics, or null if none recorded. */
  latencyMs: number | null;
  /** Unique HTTP failure codes recorded as `horizon_error` metrics. */
  failureCodes: number[];
  /** Value of the `runs` counter (how many account checks were attempted). */
  totalRuns: number;
  /** Value of the `errors` counter (how many runs ended in an error state). */
  totalErrors: number;
  /** Sanitised JSON artifact — no tags, no contract addresses. */
  jsonArtifact: string;
}

/**
 * Write a `JobSummaryReport` to the GitHub Actions Job Summary markdown
 * table using `core.summary`.
 *
 * No-ops (safe to call) when `GITHUB_STEP_SUMMARY` is not set, which is
 * always the case in local development and test environments.
 *
 * The output is intentionally human-readable so maintainers can inspect
 * the Job Summary tab in GitHub Actions for latency and failure-code trends
 * across Wave runs without reading raw log output.
 *
 * @param report   The report to render, typically from `MetricsCollector.buildJobSummary()`.
 * @param runLabel Optional label for the run (e.g. the Stellar address prefix, wave issue
 *                 number) — must not contain raw addresses; callers should redact before passing.
 */
export async function writeJobSummary(
  report: JobSummaryReport,
  runLabel?: string,
): Promise<void> {
  try {
    const label = runLabel ? ` — ${runLabel}` : '';
    core.summary.addHeading(`TrustBridge Metrics${label}`, 2);

    // Overview table
    core.summary.addTable([
      [
        { data: 'Metric', header: true },
        { data: 'Value', header: true },
      ],
      ['Total runs', String(report.totalRuns)],
      ['Total errors', String(report.totalErrors)],
      ['Avg latency', report.latencyMs !== null ? `${report.latencyMs.toFixed(1)} ms` : '_none recorded_'],
      [
        'Failure codes',
        report.failureCodes.length > 0
          ? report.failureCodes.map((c) => `HTTP ${c}`).join(', ')
          : '_none_',
      ],
    ]);

    // JSON artifact in a collapsible details block
    core.summary.addDetails(
      'Metrics JSON artifact',
      `\`\`\`json\n${report.jsonArtifact}\n\`\`\``,
    );

    await core.summary.write();
  } catch {
    // Never let Job Summary I/O fail the action — it is observability-only.
  }
}

export const globalMetrics = new MetricsCollector();

/**
 * Normalizes a URL to a clean host key for metrics reporting.
 * Strips credentials, path traversal artifacts, and ports if default.
 */
export function normalizeMetricHost(url: string): string {
  if (!url || typeof url !== 'string') {
    return 'unknown_host';
  }
  try {
    const parsed = new URL(url.trim());
    return parsed.hostname || 'unknown_host';
  } catch {
    return 'unknown_host';
  }
}

