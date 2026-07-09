/**
 * Metrics collection for monitoring action performance and behavior.
 */

export interface MetricPoint {
  name: string;
  value: number;
  unit: string;
  timestamp: number;
  tags?: Record<string, string>;
}

export class MetricsCollector {
  private metrics: MetricPoint[] = [];
  private counters: Map<string, number> = new Map();
  private timers: Map<string, number> = new Map();

  /**
   * Record a numeric metric.
   */
  recordMetric(name: string, value: number, unit: string = '', tags?: Record<string, string>): void {
    this.metrics.push({
      name,
      value,
      unit,
      timestamp: Date.now(),
      tags,
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
}

export const globalMetrics = new MetricsCollector();
