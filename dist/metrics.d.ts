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
/**
 * Tag key that flags a metric as carrying a Soroban contract ("C-address").
 * Metrics tagged this way are validated against the contract address
 * policy before being recorded, so a malformed or malicious value never
 * makes it into the JSON metrics artifact (see toJSON()).
 */
export declare const CONTRACT_ADDRESS_TAG_KEY = "contractAddress";
export declare class MetricsCollector {
    private metrics;
    private counters;
    private timers;
    /**
     * Record a numeric metric. If a `contractAddress` tag is present, it is
     * validated against the Soroban C-address policy first; an invalid
     * address throws rather than being silently recorded.
     */
    recordMetric(name: string, value: number, unit?: string, tags?: Record<string, string>): void;
    /**
     * Convenience wrapper for recording a metric tagged with a Soroban
     * contract address, enforcing the C-address policy up front.
     */
    recordContractMetric(name: string, value: number, contractAddress: string, unit?: string, extraTags?: Record<string, string>): void;
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
