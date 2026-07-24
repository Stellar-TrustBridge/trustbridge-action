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
export function validateNumericInput(
  value: string,
  fieldName: string,
  options: {
    min?: number;
    max?: number;
    allowNegative?: boolean;
  } = {},
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    errors.push(`${fieldName} must be a valid number, got: "${value}"`);
    return { valid: false, errors, warnings };
  }

  if (!options.allowNegative && parsed < 0) {
    errors.push(`${fieldName} cannot be negative, got: ${parsed}`);
  }

  if (options.min !== undefined && parsed < options.min) {
    errors.push(`${fieldName} must be >= ${options.min}, got: ${parsed}`);
  }

  if (options.max !== undefined && parsed > options.max) {
    errors.push(`${fieldName} must be <= ${options.max}, got: ${parsed}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/** Soroban contract address ("C-address") StrKey format: "C" + 55 base32 chars. */
const CONTRACT_ADDRESS_REGEX = /^C[A-Z2-7]{55}$/;

/**
 * Validates a Soroban contract address ("C-address") against the
 * StrKey structural policy: must be exactly 56 characters, start with
 * "C", and use only the Stellar base32 alphabet (A-Z, 2-7).
 */
export function validateContractAddress(address: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const trimmed = address.trim();

  if (!trimmed) {
    errors.push('Contract address cannot be empty');
    return { valid: false, errors, warnings };
  }

  if (!trimmed.startsWith('C')) {
    errors.push(`Contract address must start with "C", got: "${trimmed}"`);
  }

  if (trimmed.length !== 56) {
    errors.push(`Contract address must be 56 characters, got: ${trimmed.length}`);
  }

  if (!CONTRACT_ADDRESS_REGEX.test(trimmed)) {
    errors.push(
      `Contract address must match StrKey format "C" + 55 base32 characters (A-Z, 2-7), got: "${trimmed}"`,
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validates an asset code (e.g., "USDC", "ETH", "BTC").
 */
export function validateAssetCode(code: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const trimmed = code.trim();

  if (!trimmed) {
    errors.push('Asset code cannot be empty');
    return { valid: false, errors, warnings };
  }

  if (trimmed.length > 12) {
    errors.push(`Asset code must be <= 12 characters, got: ${trimmed.length}`);
  }

  if (!/^[A-Za-z0-9]+$/.test(trimmed)) {
    errors.push(`Asset code must be alphanumeric, got: "${trimmed}"`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validates a URL format and protocol.
 */
export function validateUrl(
  url: string,
  fieldName: string,
  options: { protocols?: string[] } = {},
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const trimmed = url.trim();
  if (!trimmed) {
    errors.push(`${fieldName} cannot be empty`);
    return { valid: false, errors, warnings };
  }

  try {
    const parsed = new URL(trimmed);
    const allowedProtos = options.protocols || ['http', 'https'];

    if (!allowedProtos.includes(parsed.protocol.replace(':', ''))) {
      errors.push(
        `${fieldName} must use one of these protocols: ${allowedProtos.join(', ')}`,
      );
    }
  } catch {
    errors.push(`${fieldName} is not a valid URL: "${trimmed}"`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Combines multiple validation results into a single summary.
 */
export function combineResults(...results: ValidationResult[]): ValidationResult {
  const allErrors = results.flatMap((r) => r.errors);
  const allWarnings = results.flatMap((r) => r.warnings);

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
  };
}
