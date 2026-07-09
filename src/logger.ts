import * as core from '@actions/core';

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

class StructuredLogger {
  private debugMode: boolean;

  constructor(debugMode: boolean = false) {
    this.debugMode = debugMode;
  }

  /**
   * Enable or disable debug output.
   */
  setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
  }

  /**
   * Log an informational message.
   */
  info(message: string, context?: LogContext): void {
    core.info(this.formatMessage(message, context));
  }

  /**
   * Log a warning message.
   */
  warn(message: string, context?: LogContext): void {
    core.warning(this.formatMessage(message, context));
  }

  /**
   * Log an error message.
   */
  error(message: string, context?: LogContext, error?: Error): void {
    let fullMessage = this.formatMessage(message, context);
    if (error) {
      fullMessage += `\n  Error: ${error.message}`;
      if (error.stack) {
        fullMessage += `\n  Stack: ${error.stack}`;
      }
    }
    core.error(fullMessage);
  }

  /**
   * Log a debug message (only shown in debug mode).
   */
  debug(message: string, context?: LogContext): void {
    if (this.debugMode) {
      core.debug(this.formatMessage(`[DEBUG] ${message}`, context));
    }
  }

  /**
   * Log performance metrics.
   */
  logMetric(name: string, value: number, unit: string = 'ms', context?: LogContext): void {
    const message = `METRIC: ${name}=${value}${unit}`;
    this.info(message, context);
  }

  /**
   * Format a message with context information.
   */
  private formatMessage(message: string, context?: LogContext): string {
    if (!context) {
      return message;
    }

    const parts: string[] = [message];

    if (context.component) {
      parts.push(`[${context.component}]`);
    }

    const otherKeys = Object.keys(context).filter((k) => k !== 'component');
    if (otherKeys.length > 0) {
      const contextStr = otherKeys
        .map((k) => `${k}=${context[k]}`)
        .join(', ');
      parts.push(`(${contextStr})`);
    }

    return parts.join(' ');
  }
}

export const logger = new StructuredLogger();

/**
 * Create a timing helper for performance measurement.
 */
export class Timer {
  private startTime: number;
  private name: string;

  constructor(name: string) {
    this.name = name;
    this.startTime = Date.now();
  }

  /**
   * Get elapsed time since timer creation.
   */
  elapsed(): number {
    return Date.now() - this.startTime;
  }

  /**
   * Log the elapsed time and reset the timer.
   */
  logAndReset(): number {
    const elapsed = this.elapsed();
    logger.logMetric(this.name, elapsed, 'ms');
    this.startTime = Date.now();
    return elapsed;
  }

  /**
   * Return a formatted elapsed time string.
   */
  toString(): string {
    const elapsed = this.elapsed();
    return `${elapsed}ms`;
  }
}
