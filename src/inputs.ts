export function parseBooleanInput(value: string, defaultValue: boolean): boolean {
  if (value === undefined || value === '') {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

export function parseNumberInput(
  value: string,
  defaultValue: number,
  options: { min?: number; max?: number } = {},
): number {
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }

  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a numeric input, but received: "${value}"`);
  }

  if (options.min !== undefined && parsed < options.min) {
    throw new Error(`Value must be at least ${options.min}. Received: ${parsed}`);
  }

  if (options.max !== undefined && parsed > options.max) {
    throw new Error(`Value must be at most ${options.max}. Received: ${parsed}`);
  }

  return parsed;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type UnauthorizedTrustlinePolicy = 'fail' | 'warn' | 'ignore';

/**
 * Parses the `unauthorized_trustline_policy` input, which controls how a
 * trustline that exists but is not yet authorized by the issuer
 * (AUTHORIZATION_REQUIRED) is treated:
 *   - "fail"   — the trustline check does not pass; readiness outputs
 *                reflect the stricter meaning.
 *   - "warn"   — the trustline check still passes, but a warning is added
 *                to the comment. This is the safe default: it surfaces the
 *                risk without breaking existing green workflows.
 *   - "ignore" — no additional check or warning (pre-#72 behavior).
 */
export function parseUnauthorizedTrustlinePolicy(value: string): UnauthorizedTrustlinePolicy {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return 'warn';
  }
  if (normalized === 'fail' || normalized === 'warn' || normalized === 'ignore') {
    return normalized;
  }
  throw new Error(
    `unauthorized_trustline_policy must be one of "fail", "warn", or "ignore". Received: "${value}"`,
  );
}
