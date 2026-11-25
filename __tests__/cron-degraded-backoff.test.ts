/**
 * Issue #909 — cron backoff when Horizon is degraded.
 *
 * Unit tests for the pause / backoff helpers in src/resilience.ts plus a
 * drift check that docs/CRON_REVALIDATION.md and docs/TROUBLESHOOTING.md
 * document the same reason codes, defaults and resilience settings.
 *
 * Validate with: npm test -- --testPathPattern cron-degraded-backoff
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  computeCronBackoffDelayMs,
  DEFAULT_CRON_BACKOFF_POLICY,
  HORIZON_DEGRADED_REASON_CODES,
  isHorizonDegradedReasonCode,
  shouldPauseCronSweep,
} from '../src/resilience';
import { REASON_CODES } from '../src/reasonCodes';

const MINUTE = 60 * 1000;
const mid = () => 0.5; // zero jitter

describe('isHorizonDegradedReasonCode', () => {
  it.each(HORIZON_DEGRADED_REASON_CODES)('%s is degraded', (code) => {
    expect(isHorizonDegradedReasonCode(code)).toBe(true);
  });

  it.each(['SUCCESS', 'TRUSTLINE_MISSING', 'RESERVE_TOO_LOW', 'ACCOUNT_NOT_FUNDED', '', 'horizon_error'])(
    '%j is not degraded',
    (code) => {
      expect(isHorizonDegradedReasonCode(code)).toBe(false);
    },
  );

  it('every degraded code is a cataloged reason code', () => {
    for (const code of HORIZON_DEGRADED_REASON_CODES) {
      expect(REASON_CODES).toContain(code);
    }
  });
});

describe('shouldPauseCronSweep', () => {
  it('happy path: a healthy sweep never pauses', () => {
    expect(shouldPauseCronSweep(['SUCCESS', 'SUCCESS', 'TRUSTLINE_MISSING', 'SUCCESS', 'RESERVE_TOO_LOW'])).toBe(false);
  });

  it('pauses once >= 20% of at least 5 results are degraded', () => {
    expect(shouldPauseCronSweep(['SUCCESS', 'SUCCESS', 'SUCCESS', 'SUCCESS', 'HORIZON_TIMEOUT'])).toBe(true);
    expect(shouldPauseCronSweep(['CIRCUIT_OPEN', 'HORIZON_ERROR', 'SUCCESS', 'SUCCESS', 'SUCCESS'])).toBe(true);
  });

  it('does not pause below the minimum sample size', () => {
    expect(shouldPauseCronSweep(['HORIZON_TIMEOUT', 'HORIZON_TIMEOUT'])).toBe(false);
    expect(shouldPauseCronSweep([])).toBe(false);
  });

  it('wallet failures alone never pause the sweep', () => {
    expect(shouldPauseCronSweep(Array(10).fill('TRUSTLINE_MISSING'))).toBe(false);
  });
});

describe('computeCronBackoffDelayMs', () => {
  it('returns 0 when the previous sweep was healthy', () => {
    expect(computeCronBackoffDelayMs(0, DEFAULT_CRON_BACKOFF_POLICY, mid)).toBe(0);
  });

  it.each([
    [1, 15],
    [2, 30],
    [3, 60],
    [4, 120],
    [5, 240],
    [6, 360],
    [50, 360],
  ])('%d consecutive degraded sweep(s) → %d min (no jitter)', (n, minutes) => {
    expect(computeCronBackoffDelayMs(n, DEFAULT_CRON_BACKOFF_POLICY, mid)).toBe(minutes * MINUTE);
  });

  it('applies ± jitterPercent jitter and never exceeds maxDelayMs', () => {
    expect(computeCronBackoffDelayMs(1, DEFAULT_CRON_BACKOFF_POLICY, () => 0)).toBe(12 * MINUTE);
    expect(computeCronBackoffDelayMs(1, DEFAULT_CRON_BACKOFF_POLICY, () => 0.999999)).toBeLessThanOrEqual(18 * MINUTE);
    expect(computeCronBackoffDelayMs(10, DEFAULT_CRON_BACKOFF_POLICY, () => 0.999999)).toBe(
      DEFAULT_CRON_BACKOFF_POLICY.maxDelayMs,
    );
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid counter %p', (n) => {
    expect(() => computeCronBackoffDelayMs(n)).toThrow(/non-negative finite number/);
  });
});

describe('docs stay aligned with src/resilience.ts', () => {
  const root = path.resolve(__dirname, '..');
  const cronDoc = fs.readFileSync(path.join(root, 'docs', 'CRON_REVALIDATION.md'), 'utf8');
  const troubleshooting = fs.readFileSync(path.join(root, 'docs', 'TROUBLESHOOTING.md'), 'utf8');

  it('CRON_REVALIDATION.md lists every degraded reason code', () => {
    for (const code of HORIZON_DEGRADED_REASON_CODES) {
      expect(cronDoc).toContain(`\`${code}\``);
    }
  });

  it('CRON_REVALIDATION.md documents the default policy and resilience inputs', () => {
    expect(cronDoc).toContain('## Backoff when Horizon is degraded');
    expect(cronDoc).toContain('≥ 20 %');
    expect(cronDoc).toContain('± 20 % jitter');
    expect(cronDoc).toContain('6 h');
    for (const input of [
      'max_retries',
      'retry_base_delay_ms',
      'retry_max_delay_ms',
      'retry_max_total_wait_ms',
      'horizon_timeout_ms',
      'horizon_max_requests',
    ]) {
      expect(cronDoc).toContain(`\`${input}\``);
    }
  });

  it('TROUBLESHOOTING.md links to the cron backoff section', () => {
    expect(troubleshooting).toContain('CRON_REVALIDATION.md#backoff-when-horizon-is-degraded');
  });
});
