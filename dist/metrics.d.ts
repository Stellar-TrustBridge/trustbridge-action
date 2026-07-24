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
export declare class MetricsCollector {
    private metrics;
    private counters;
    private timers;
    /**
     * Record a numeric metric.
     */
    recordMetric(name: string, value: number, unit?: string, tags?: Record<string, string>): void;
    /**
     * Increment a counter.
     */
    incrementCounter(name: string, amount?: number): void;
    /**
     * Get counter value.
     */
    getCounter(name: string): number;
    /**
     * Start a timer.
     */
    startTimer(name: string): void;
    /**
     * Stop a timer and record the elapsed time.
     */
    stopTimer(name: string, unit?: string): number | null;
    /**
     * Get a summary of all recorded metrics.
     */
    getSummary(): {
        metrics: MetricPoint[];
        counters: Record<string, number>;
        totalMetrics: number;
    };
    /**
     * Export metrics in JSON format.
     */
    toJSON(): string;
    /**
     * Clear all metrics.
     */
    reset(): void;
    /**
     * Get average value for a metric.
     */
    getAverageMetric(name: string): number | null;
}
export declare const globalMetrics: MetricsCollector;
