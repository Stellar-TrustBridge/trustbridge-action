/** Issue #962 — snooze max duration cap with maintainer override. */
import {
  capSnoozeWindow,
  enforceSnoozeWindow,
  MAX_SNOOZE_WINDOW_MS,
  MAX_SNOOZE_WINDOW_OVERRIDE_MS,
  SNOOZE_CAPPED_REASON_CODE,
} from '../src/snooze';

const DAY = 24 * 60 * 60 * 1000;

describe('capSnoozeWindow', () => {
  it('passes through windows within the cap (happy path)', () => {
    expect(capSnoozeWindow(60_000)).toEqual({ windowMs: 60_000, capped: false });
  });
  it('accepts exactly the cap without clamping', () => {
    expect(capSnoozeWindow(MAX_SNOOZE_WINDOW_MS)).toEqual({ windowMs: MAX_SNOOZE_WINDOW_MS, capped: false });
  });
  it('clamps one ms over the cap', () => {
    expect(capSnoozeWindow(MAX_SNOOZE_WINDOW_MS + 1)).toEqual({
      windowMs: MAX_SNOOZE_WINDOW_MS,
      capped: true,
      reasonCode: SNOOZE_CAPPED_REASON_CODE,
    });
  });
  it('maintainer override raises but never removes the cap', () => {
    expect(capSnoozeWindow(14 * DAY, { maintainerOverride: true })).toEqual({ windowMs: 14 * DAY, capped: false });
    expect(capSnoozeWindow(365 * DAY, { maintainerOverride: true }).windowMs).toBe(MAX_SNOOZE_WINDOW_OVERRIDE_MS);
  });
  it('treats negative, NaN and Infinity as disabled', () => {
    expect(capSnoozeWindow(-1).windowMs).toBe(0);
    expect(capSnoozeWindow(NaN).windowMs).toBe(0);
    expect(capSnoozeWindow(Infinity).windowMs).toBe(0);
  });
});

describe('enforceSnoozeWindow applies the cap', () => {
  const now = 1_700_000_000_000;
  const reaction = (ageMs: number) => [{ content: 'zzz', created_at: new Date(now - ageMs).toISOString(), user: { login: 'maint', type: 'User' } }];

  it('a reaction older than the cap no longer snoozes even with a huge window', () => {
    const r = enforceSnoozeWindow(false, undefined, reaction(8 * DAY), 365 * DAY, { now });
    expect(r.skipValidation).toBe(false);
  });
  it('maintainer override extends the effective window', () => {
    const r = enforceSnoozeWindow(false, undefined, reaction(8 * DAY), 365 * DAY, { now, maintainerOverride: true });
    expect(r.skipValidation).toBe(true);
  });
  it('snoozes within the cap (happy path)', () => {
    const r = enforceSnoozeWindow(false, undefined, reaction(DAY), 2 * DAY, { now });
    expect(r.skipValidation).toBe(true);
  });
});
