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
 * Validates a Soroban contract address ("C-address") against the
 * StrKey structural policy: must be exactly 56 characters, start with
 * "C", and use only the Stellar base32 alphabet (A-Z, 2-7).
 */
export declare function validateContractAddress(address: string): ValidationResult;
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
