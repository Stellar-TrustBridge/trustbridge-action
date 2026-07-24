/**
 * Extended input validation utilities for TrustBridge Action.
 * Provides reusable validators with detailed error messages.
 */
export interface ValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
}
/**
 * Validates a numeric input string with min/max bounds.
 */
export declare function validateNumericInput(value: string, fieldName: string, options?: {
    min?: number;
    max?: number;
    allowNegative?: boolean;
}): ValidationResult;
/**
 * Validates an asset code (e.g., "USDC", "ETH", "BTC").
 */
export declare function validateAssetCode(code: string): ValidationResult;
/**
 * Validates a URL format and protocol.
 */
export declare function validateUrl(url: string, fieldName: string, options?: {
    protocols?: string[];
}): ValidationResult;
/**
 * Combines multiple validation results into a single summary.
 */
export declare function combineResults(...results: ValidationResult[]): ValidationResult;
