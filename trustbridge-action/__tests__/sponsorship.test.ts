import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { diagnoseSponsorship } from '../src/diagnostics';
import { ERROR_HANDLING, USAGE } from '../src/constants';

describe('sponsorship diagnostics', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a healthy sponsorship path', () => {
    const result = diagnoseSponsorship({
      sponsor: 'GSPONSOR',
      sponsored: 'GSPONSORED',
      balance: 1000,
      required: 100,
    });

    expect(result.status).toBe('healthy');
    expect(result.message).toBe(USAGE.SPONSORSHIP_HEALTHY);
    expect(result.coverage).toBe(1);
  });

  it('reports a missing sponsor', () => {
    const result = diagnoseSponsorship({
      sponsor: null,
      sponsored: 'GSPONSORED',
      balance: 0,
      required: 100,
    });

    expect(result.status).toBe('missing-sponsor');
    expect(result.message).toBe(ERROR_HANDLING.MISSING_SPONSOR);
    expect(result.coverage).toBe(0);
  });

  it('reports partial coverage', () => {
    const result = diagnoseSponsorship({
      sponsor: 'GSPONSOR',
      sponsored: 'GSPONSORED',
      balance: 50,
      required: 100,
    });

    expect(result.status).toBe('partial-coverage');
    expect(result.message).toBe(ERROR_HANDLING.PARTIAL_SPONSORSHIP);
    expect(result.coverage).toBe(0.5);
  });
});
