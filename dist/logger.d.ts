/**
 * Enhanced logging with context and structured output.
 * Useful for debugging TrustBridge Action execution.
 */
export interface LogContext {
    component?: string;
    stellarAddress?: string;
    horizonUrl?: string;
    [key: string]: unknown;
}
declare class StructuredLogger {
    private debugMode;
    constructor(debugMode?: boolean);
    /**
     * Enable or disable debug output.
     */
    setDebugMode(enabled: boolean): void;
    /**
     * Log an informational message.
     */
    info(message: string, context?: LogContext): void;
    /**
     * Log a warning message.
     */
    warn(message: string, context?: LogContext): void;
    /**
     * Log an error message.
     */
    error(message: string, context?: LogContext, error?: Error): void;
    /**
     * Log a debug message (only shown in debug mode).
     */
    debug(message: string, context?: LogContext): void;
    /**
     * Log performance metrics.
     */
    logMetric(name: string, value: number, unit?: string, context?: LogContext): void;
    /**
     * Format a message with context information.
     */
    private formatMessage;
}
export declare const logger: StructuredLogger;
/**
 * Create a timing helper for performance measurement.
 */
export declare class Timer {
    private startTime;
    private name;
    constructor(name: string);
    /**
     * Get elapsed time since timer creation.
     */
    elapsed(): number;
    /**
     * Log the elapsed time and reset the timer.
     */
    logAndReset(): number;
    /**
     * Return a formatted elapsed time string.
     */
    toString(): string;
}
export {};
