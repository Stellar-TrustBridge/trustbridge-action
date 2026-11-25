import {
  SNOOZE_MARKER_PATTERN,
  parseSnoozeMarker,
  formatSnoozeMarker,
  evaluateSnoozeState,
  isSnoozeReaction,
  evaluateReactionSnooze,
  evaluateCombinedSnoozeState,
  enforceSnoozeWindow,
  normalizeToUtc,
  normalizeSnoozeTimestamp,
  validateSnoozeTimestamp,
  formatSnoozeTimestampUtc,
  isWithinSnoozeWindow,
  getTimezoneOffsetMs,
  SnoozeMarker,
  SnoozeState,
  CommentReaction,
} from '../src/snooze';

describe('SNOOZE_MARKER_PATTERN', () => {
  it('matches valid snooze markers with pass status', () => {
    const marker = '<!-- trustbridge-action:snooze:status=pass,timestamp=1234567890 -->';
    const match = marker.match(SNOOZE_MARKER_PATTERN);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('pass');
    expect(match?.[2]).toBe('1234567890');
  });

  it('matches valid snooze markers with fail status', () => {
    const marker = '<!-- trustbridge-action:snooze:status=fail,timestamp=9876543210 -->';
    const match = marker.match(SNOOZE_MARKER_PATTERN);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('fail');
    expect(match?.[2]).toBe('9876543210');
  });

  it('does not match malformed markers', () => {
    expect('<!-- trustbridge-action:snooze:invalid -->'.match(SNOOZE_MARKER_PATTERN)).toBeNull();
    expect('<!-- wrong:snooze:status=pass,timestamp=123 -->'.match(SNOOZE_MARKER_PATTERN)).toBeNull();
  });
});

describe('parseSnoozeMarker', () => {
  it('parses valid marker from comment body', () => {
    const body = `Some text\n<!-- trustbridge-action:snooze:status=pass,timestamp=1000 -->\nMore text`;
    const marker = parseSnoozeMarker(body);
    expect(marker).toEqual({ status: 'pass', timestamp: 1000 });
  });

  it('returns undefined for missing marker', () => {
    expect(parseSnoozeMarker('<!-- other marker -->')).toBeUndefined();
    expect(parseSnoozeMarker('')).toBeUndefined();
    expect(parseSnoozeMarker(undefined)).toBeUndefined();
  });

  it('parses fail status marker', () => {
    const body = `## Comment\n<!-- trustbridge-action:snooze:status=fail,timestamp=5000 -->`;
    const marker = parseSnoozeMarker(body);
    expect(marker).toEqual({ status: 'fail', timestamp: 5000 });
  });
});

describe('formatSnoozeMarker', () => {
  it('formats pass status marker with default timestamp', () => {
    const before = Date.now();
    const marker = formatSnoozeMarker('pass');
    const after = Date.now();

    expect(marker).toMatch(/<!-- trustbridge-action:snooze:status=pass,timestamp=\d+ -->/);
    
    // Extract timestamp and verify it's in range
    const match = marker.match(/timestamp=(\d+)/);
    const timestamp = Number(match?.[1]);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  it('formats fail status marker with custom timestamp', () => {
    const marker = formatSnoozeMarker('fail', 1234567890);
    expect(marker).toBe('<!-- trustbridge-action:snooze:status=fail,timestamp=1234567890 -->');
  });

  it('formats pass status marker with custom timestamp', () => {
    const marker = formatSnoozeMarker('pass', 9999999999);
    expect(marker).toBe('<!-- trustbridge-action:snooze:status=pass,timestamp=9999999999 -->');
  });
});

describe('evaluateSnoozeState', () => {
  describe('when current check passes', () => {
    it('always posts (unsnoozes) regardless of prior state', () => {
      const priorMarker: SnoozeMarker = { status: 'fail', timestamp: Date.now() - 1000 };
      const state = evaluateSnoozeState(true, priorMarker, 60000);
      
      expect(state.isSnoozed).toBe(false);
      expect(state.lastStatus).toBe('fail');
      expect(state.lastTimestamp).toBe(priorMarker.timestamp);
    });

    it('posts with no prior marker', () => {
      const state = evaluateSnoozeState(true, undefined, 60000);
      expect(state.isSnoozed).toBe(false);
      expect(state.lastStatus).toBeUndefined();
      expect(state.lastTimestamp).toBeUndefined();
    });
  });

  describe('when current check fails with no prior marker', () => {
    it('posts (first failure)', () => {
      const state = evaluateSnoozeState(false, undefined, 60000);
      expect(state.isSnoozed).toBe(false);
      expect(state.lastStatus).toBeUndefined();
    });
  });

  describe('when current check fails and prior status was pass', () => {
    it('posts (status changed)', () => {
      const priorMarker: SnoozeMarker = { status: 'pass', timestamp: Date.now() - 10000 };
      const state = evaluateSnoozeState(false, priorMarker, 60000);
      
      expect(state.isSnoozed).toBe(false);
      expect(state.lastStatus).toBe('pass');
      expect(state.elapsedMs).toBeGreaterThan(0);
    });
  });

  describe('when current check fails and prior status was fail', () => {
    it('snoozes when within window', () => {
      const now = Date.now();
      const priorMarker: SnoozeMarker = { status: 'fail', timestamp: now - 5000 }; // 5s ago
      const snoozeWindowMs = 60000; // 1 minute
      
      const state = evaluateSnoozeState(false, priorMarker, snoozeWindowMs);
      
      expect(state.isSnoozed).toBe(true);
      expect(state.snoozeExpired).toBe(false);
      expect(state.lastStatus).toBe('fail');
      expect(state.lastTimestamp).toBe(priorMarker.timestamp);
      expect(state.elapsedMs).toBeLessThan(snoozeWindowMs);
      expect(state.elapsedMs).toBeGreaterThan(0);
    });

    it('posts when outside window', () => {
      const now = Date.now();
      const priorMarker: SnoozeMarker = { status: 'fail', timestamp: now - 70000 }; // 70s ago
      const snoozeWindowMs = 60000; // 1 minute

      const state = evaluateSnoozeState(false, priorMarker, snoozeWindowMs);

      expect(state.isSnoozed).toBe(false);
      expect(state.snoozeExpired).toBe(true);
      expect(state.lastStatus).toBe('fail');
      expect(state.elapsedMs).toBeGreaterThan(snoozeWindowMs);
    });

    it('exactly at window boundary posts', () => {
      const now = Date.now();
      const priorMarker: SnoozeMarker = { status: 'fail', timestamp: now - 60000 }; // exactly 1 min ago
      const snoozeWindowMs = 60000;
      
      const state = evaluateSnoozeState(false, priorMarker, snoozeWindowMs);
      
      // At the boundary, we're not withinWindow (elapsed >= window)
      expect(state.isSnoozed).toBe(false);
    });
  });

  describe('zero snooze window', () => {
    it('never snoozes even with repeated failures', () => {
      const now = Date.now();
      const priorMarker: SnoozeMarker = { status: 'fail', timestamp: now - 5000 };
      
      const state = evaluateSnoozeState(false, priorMarker, 0);
      
      // window is 0, so elapsed >= window is always true
      expect(state.isSnoozed).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles very large elapsed times', () => {
      const priorMarker: SnoozeMarker = { status: 'fail', timestamp: 1000 };
      const state = evaluateSnoozeState(false, priorMarker, 60000);
      
      expect(state.isSnoozed).toBe(false);
      expect(state.elapsedMs).toBeGreaterThan(60000);
    });

    it('handles negative elapsed (clock skew)', () => {
      // Even if clock skewed backwards, if elapsed < window we snooze
      const now = Date.now();
      const futureMarker: SnoozeMarker = { status: 'fail', timestamp: now + 5000 };
      
      const state = evaluateSnoozeState(false, futureMarker, 60000);
      
      // Even though elapsed is technically negative, we treat it as < window
      // The condition is: elapsedMs < snoozeWindowMs
      // If timestamp is future, elapsedMs is negative, so yes < 60000
      expect(state.isSnoozed).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Issue #227 — Reaction-based snooze (:zzz:)
// ---------------------------------------------------------------------------

describe('Issue #227 — Reaction-based snooze', () => {
  describe('isSnoozeReaction', () => {
    it('identifies valid snooze emojis', () => {
      expect(isSnoozeReaction('zzz')).toBe(true);
      expect(isSnoozeReaction(':zzz:')).toBe(true);
      expect(isSnoozeReaction('ZZZ')).toBe(true);
      expect(isSnoozeReaction('eyes')).toBe(true);
      expect(isSnoozeReaction(':eyes:')).toBe(true);
      expect(isSnoozeReaction('💤')).toBe(true);
    });

    it('rejects non-snooze reactions', () => {
      expect(isSnoozeReaction('+1')).toBe(false);
      expect(isSnoozeReaction('-1')).toBe(false);
      expect(isSnoozeReaction('👍')).toBe(false);
      expect(isSnoozeReaction('heart')).toBe(false);
      expect(isSnoozeReaction('rocket')).toBe(false);
      expect(isSnoozeReaction('laugh')).toBe(false);
      expect(isSnoozeReaction('')).toBe(false);
      expect(isSnoozeReaction(undefined)).toBe(false);
    });
  });

  describe('evaluateReactionSnooze', () => {
    const now = Date.now();
    const snoozeWindowMs = 30 * 60 * 1000; // 30 mins

    it('snoozes when maintainer reacted with :zzz: within window', () => {
      const reactions: CommentReaction[] = [
        {
          content: ':zzz:',
          created_at: new Date(now - 5 * 60 * 1000).toISOString(),
          user: { login: 'maintainer', type: 'User' },
        },
      ];

      const state = evaluateReactionSnooze(false, reactions, snoozeWindowMs, now);
      expect(state.isSnoozed).toBe(true);
      expect(state.elapsedMs).toBe(5 * 60 * 1000);
    });

    it('snoozes when maintainer reacted with eyes within window', () => {
      const reactions: CommentReaction[] = [
        {
          content: 'eyes',
          createdAt: new Date(now - 10 * 60 * 1000).toISOString(),
          user: { login: 'maintainer', type: 'User' },
        },
      ];

      const state = evaluateReactionSnooze(false, reactions, snoozeWindowMs, now);
      expect(state.isSnoozed).toBe(true);
    });

    it('does not snooze when reaction timestamp is outside window (expiry honored)', () => {
      const reactions: CommentReaction[] = [
        {
          content: ':zzz:',
          created_at: new Date(now - 45 * 60 * 1000).toISOString(), // 45m ago > 30m
          user: { login: 'maintainer', type: 'User' },
        },
      ];

      const state = evaluateReactionSnooze(false, reactions, snoozeWindowMs, now);
      expect(state.isSnoozed).toBe(false);
      expect(state.elapsedMs).toBe(45 * 60 * 1000);
    });

    it('does not snooze on random emojis like +1 or thumbs up', () => {
      const reactions: CommentReaction[] = [
        {
          content: '+1',
          created_at: new Date(now - 5 * 60 * 1000).toISOString(),
          user: { login: 'contributor', type: 'User' },
        },
        {
          content: 'heart',
          created_at: new Date(now - 2 * 60 * 1000).toISOString(),
          user: { login: 'contributor', type: 'User' },
        },
      ];

      const state = evaluateReactionSnooze(false, reactions, snoozeWindowMs, now);
      expect(state.isSnoozed).toBe(false);
    });

    it('ignores bot reactions', () => {
      const reactions: CommentReaction[] = [
        {
          content: ':zzz:',
          created_at: new Date(now - 5 * 60 * 1000).toISOString(),
          user: { login: 'dependabot[bot]', type: 'Bot' },
        },
      ];

      const state = evaluateReactionSnooze(false, reactions, snoozeWindowMs, now);
      expect(state.isSnoozed).toBe(false);
    });

    it('never snoozes when current check passes (auto-unsnooze on fix)', () => {
      const reactions: CommentReaction[] = [
        {
          content: ':zzz:',
          created_at: new Date(now - 5 * 60 * 1000).toISOString(),
          user: { login: 'maintainer', type: 'User' },
        },
      ];

      const state = evaluateReactionSnooze(true, reactions, snoozeWindowMs, now);
      expect(state.isSnoozed).toBe(false);
    });
  });

  describe('evaluateCombinedSnoozeState', () => {
    const now = Date.now();
    const snoozeWindowMs = 30 * 60 * 1000;

    it('snoozes when UI reaction is active even without a prior failure marker', () => {
      const reactions: CommentReaction[] = [
        {
          content: ':zzz:',
          created_at: new Date(now - 5 * 60 * 1000).toISOString(),
          user: { login: 'maintainer', type: 'User' },
        },
      ];

      const state = evaluateCombinedSnoozeState(false, undefined, reactions, snoozeWindowMs, now);
      expect(state.isSnoozed).toBe(true);
    });

    it('snoozes when body marker is active even without UI reactions', () => {
      const priorMarker: SnoozeMarker = { status: 'fail', timestamp: now - 5 * 60 * 1000 };
      const state = evaluateCombinedSnoozeState(false, priorMarker, [], snoozeWindowMs, now);
      expect(state.isSnoozed).toBe(true);
    });

    it('unsnoozes immediately when check passes', () => {
      const priorMarker: SnoozeMarker = { status: 'fail', timestamp: now - 5 * 60 * 1000 };
      const reactions: CommentReaction[] = [
        {
          content: ':zzz:',
          created_at: new Date(now - 5 * 60 * 1000).toISOString(),
          user: { login: 'maintainer', type: 'User' },
        },
      ];

      const state = evaluateCombinedSnoozeState(true, priorMarker, reactions, snoozeWindowMs, now);
      expect(state.isSnoozed).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // snoozeExpired — Issue #799
  // -------------------------------------------------------------------------

  describe('snoozeExpired flag (Issue #799)', () => {
    it('happy path: a window that has lapsed is reported as expired', () => {
      const now = Date.now();
      const priorMarker: SnoozeMarker = { status: 'fail', timestamp: now - 70_000 };
      const state = evaluateCombinedSnoozeState(false, priorMarker, [], 60_000, now);

      expect(state.isSnoozed).toBe(false);
      expect(state.snoozeExpired).toBe(true);
    });

    it('failure path: a window still active is not reported as expired', () => {
      const now = Date.now();
      const priorMarker: SnoozeMarker = { status: 'fail', timestamp: now - 5_000 };
      const state = evaluateCombinedSnoozeState(false, priorMarker, [], 60_000, now);

      expect(state.isSnoozed).toBe(true);
      expect(state.snoozeExpired).toBe(false);
    });

    it('failure path: the very first failure (no prior marker) is not an expiry', () => {
      const state = evaluateCombinedSnoozeState(false, undefined, [], 60_000);

      expect(state.isSnoozed).toBe(false);
      expect(state.snoozeExpired).toBe(false);
    });

    it('failure path: a status flip from pass to fail is not an expiry', () => {
      const now = Date.now();
      const priorMarker: SnoozeMarker = { status: 'pass', timestamp: now - 70_000 };
      const state = evaluateCombinedSnoozeState(false, priorMarker, [], 60_000, now);

      expect(state.isSnoozed).toBe(false);
      expect(state.snoozeExpired).toBe(false);
    });

    it('failure path: the check passing is not an expiry, even if a window had lapsed', () => {
      const now = Date.now();
      const priorMarker: SnoozeMarker = { status: 'fail', timestamp: now - 70_000 };
      const state = evaluateCombinedSnoozeState(true, priorMarker, [], 60_000, now);

      expect(state.isSnoozed).toBe(false);
      expect(state.snoozeExpired).toBe(false);
    });

    it('a lapsed reaction-based snooze is also reported as expired', () => {
      const now = Date.now();
      const reactions: CommentReaction[] = [
        {
          content: ':zzz:',
          created_at: new Date(now - 70_000).toISOString(),
          user: { login: 'maintainer', type: 'User' },
        },
      ];
      const state = evaluateCombinedSnoozeState(false, undefined, reactions, 60_000, now);

      expect(state.isSnoozed).toBe(false);
      expect(state.snoozeExpired).toBe(true);
    });

    it('enforceSnoozeWindow surfaces the expiry on its underlying state', () => {
      const now = Date.now();
      const priorMarker: SnoozeMarker = { status: 'fail', timestamp: now - 70_000 };

      const enforcement = enforceSnoozeWindow(false, priorMarker, [], 60_000, { now });

      expect(enforcement.skipValidation).toBe(false);
      expect(enforcement.state.snoozeExpired).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Issue #873 — Timezone and DST boundary enforcement
  // -------------------------------------------------------------------------

  describe('Issue #873 — Timezone and DST boundary enforcement', () => {
    describe('normalizeToUtc / normalizeSnoozeTimestamp', () => {
      it('happy path: normalizes numeric unix-ms timestamp unchanged', () => {
        const ms = 1761960600000;
        expect(normalizeToUtc(ms)).toBe(ms);
        expect(normalizeSnoozeTimestamp(ms)).toBe(ms);
      });

      it('happy path: normalizes ISO-8601 UTC string with Z', () => {
        const iso = '2026-11-01T01:30:00Z';
        const expected = Date.parse(iso);
        expect(normalizeToUtc(iso)).toBe(expected);
      });

      it('happy path: normalizes ISO-8601 with positive timezone offset to UTC ms', () => {
        // 03:30:00+02:00 corresponds to 01:30:00Z
        const withOffset = '2026-11-01T03:30:00+02:00';
        const expected = Date.parse('2026-11-01T01:30:00Z');
        expect(normalizeToUtc(withOffset)).toBe(expected);
      });

      it('happy path: normalizes ISO-8601 with negative timezone offset to UTC ms', () => {
        // 2026-10-31T21:30:00-04:00 corresponds to 2026-11-01T01:30:00Z
        const withOffset = '2026-10-31T21:30:00-04:00';
        const expected = Date.parse('2026-11-01T01:30:00Z');
        expect(normalizeToUtc(withOffset)).toBe(expected);
      });

      it('happy path: normalizes naive ISO string without timezone context to UTC', () => {
        // When stored without timezone context, it must be treated strictly as UTC
        const naive = '2026-11-01T01:30:00';
        const expectedUtc = Date.parse('2026-11-01T01:30:00Z');
        expect(normalizeToUtc(naive)).toBe(expectedUtc);
      });

      it('happy path: normalizes date-time string with space to UTC', () => {
        const spaceDelimited = '2026-11-01 01:30:00';
        const expectedUtc = Date.parse('2026-11-01T01:30:00Z');
        expect(normalizeToUtc(spaceDelimited)).toBe(expectedUtc);
      });

      it('happy path: normalizes simple YYYY-MM-DD date to UTC midnight', () => {
        const dateOnly = '2026-11-01';
        const expectedUtc = Date.parse('2026-11-01T00:00:00.000Z');
        expect(normalizeToUtc(dateOnly)).toBe(expectedUtc);
      });

      it('happy path: normalizes Date object to its UTC epoch ms', () => {
        const date = new Date('2026-11-01T01:30:00Z');
        expect(normalizeToUtc(date)).toBe(date.getTime());
      });

      it('happy path: normalizes string containing unix timestamp digits', () => {
        expect(normalizeToUtc('1761960600000')).toBe(1761960600000);
      });

      it('happy path: resolves IANA timezone when specified for wall-clock time', () => {
        // America/New_York on 2026-11-01 at 00:30 is EDT (UTC-4)
        // 00:30 EDT = 04:30:00Z UTC
        const resolved = normalizeToUtc('2026-11-01T00:30:00', 'America/New_York');
        expect(resolved).toBe(Date.parse('2026-11-01T04:30:00Z'));
      });

      // Failure paths
      it('failure path 1: returns undefined for empty or whitespace string', () => {
        expect(normalizeToUtc('')).toBeUndefined();
        expect(normalizeToUtc('   ')).toBeUndefined();
        expect(normalizeToUtc(undefined)).toBeUndefined();
        expect(normalizeToUtc(null)).toBeUndefined();
      });

      it('failure path 2: returns undefined for malformed non-date strings', () => {
        expect(normalizeToUtc('not-a-date')).toBeUndefined();
        expect(normalizeToUtc('2026-99-99T99:99:99')).toBeUndefined();
        expect(normalizeToUtc('invalid-timestamp-value')).toBeUndefined();
      });

      it('failure path 3: returns undefined for negative numbers or negative digit strings', () => {
        expect(normalizeToUtc(-1)).toBeUndefined();
        expect(normalizeToUtc(-5000)).toBeUndefined();
        expect(normalizeToUtc('-1000')).toBeUndefined();
      });

      it('failure path 4: returns undefined for non-finite numbers', () => {
        expect(normalizeToUtc(NaN)).toBeUndefined();
        expect(normalizeToUtc(Infinity)).toBeUndefined();
        expect(normalizeToUtc(-Infinity)).toBeUndefined();
      });

      it('failure path 5: returns undefined for oversized timestamps beyond valid range', () => {
        expect(normalizeToUtc(9e16)).toBeUndefined();
      });
    });

    describe('validateSnoozeTimestamp', () => {
      it('happy path: returns valid status with normalized ms and UTC ISO', () => {
        const result = validateSnoozeTimestamp('2026-11-01T01:30:00Z');
        expect(result.valid).toBe(true);
        expect(result.timestamp).toBe(Date.parse('2026-11-01T01:30:00Z'));
        expect(result.utcIso).toBe('2026-11-01T01:30:00.000Z');
        expect(result.error).toBeUndefined();
      });

      it('failure path 1: rejects empty input with stable error', () => {
        const result = validateSnoozeTimestamp('');
        expect(result.valid).toBe(false);
        expect(result.error).toBe('Snooze timestamp cannot be empty');
      });

      it('failure path 2: rejects malformed input with actionable message', () => {
        const result = validateSnoozeTimestamp('malformed-date');
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/Malformed snooze timestamp/);
      });

      it('failure path 3: rejects invalid data types', () => {
        const result = validateSnoozeTimestamp({ foo: 'bar' });
        expect(result.valid).toBe(false);
        expect(result.error).toBe('Snooze timestamp must be a number, string, or Date');
      });
    });

    describe('formatSnoozeTimestampUtc', () => {
      it('happy path: formats unix-ms number into ISO 8601 UTC string', () => {
        const ms = Date.parse('2026-11-01T01:30:00Z');
        expect(formatSnoozeTimestampUtc(ms)).toBe('2026-11-01T01:30:00.000Z');
      });

      it('happy path: formats naive date string into UTC ISO string with Z', () => {
        expect(formatSnoozeTimestampUtc('2026-11-01T01:30:00')).toBe('2026-11-01T01:30:00.000Z');
      });

      it('failure path: throws on invalid timestamp input', () => {
        expect(() => formatSnoozeTimestampUtc('invalid')).toThrow(/Cannot format invalid snooze timestamp/);
      });
    });

    describe('isWithinSnoozeWindow', () => {
      const start = '2026-11-01T01:00:00Z';
      const windowMs = 60 * 60 * 1000; // 1 hour

      it('happy path: returns true when within UTC physical duration', () => {
        const now = '2026-11-01T01:30:00Z'; // 30 mins later
        expect(isWithinSnoozeWindow(start, windowMs, now)).toBe(true);
      });

      it('happy path: returns false when past UTC physical duration', () => {
        const now = '2026-11-01T02:00:01Z'; // 60m 1s later
        expect(isWithinSnoozeWindow(start, windowMs, now)).toBe(false);
      });

      it('failure path: returns false on invalid start timestamp', () => {
        expect(isWithinSnoozeWindow('invalid-timestamp', windowMs)).toBe(false);
      });

      it('failure path: returns false on non-positive snooze window', () => {
        expect(isWithinSnoozeWindow(start, 0)).toBe(false);
        expect(isWithinSnoozeWindow(start, -1000)).toBe(false);
      });
    });

    describe('parseSnoozeMarker with timezone & ISO timestamps', () => {
      it('happy path: parses ISO UTC timestamp marker', () => {
        const body = '<!-- trustbridge-action:snooze:status=fail,timestamp=2026-11-01T01:30:00Z -->';
        const marker = parseSnoozeMarker(body);
        expect(marker).toEqual({
          status: 'fail',
          timestamp: Date.parse('2026-11-01T01:30:00Z'),
        });
      });

      it('happy path: parses naive ISO marker normalized to UTC', () => {
        const body = '<!-- trustbridge-action:snooze:status=fail,timestamp=2026-11-01T01:30:00 -->';
        const marker = parseSnoozeMarker(body);
        expect(marker).toEqual({
          status: 'fail',
          timestamp: Date.parse('2026-11-01T01:30:00Z'),
        });
      });

      it('happy path: parses marker with timezone parameter', () => {
        const body = '<!-- trustbridge-action:snooze:status=pass,timestamp=2026-11-01T01:30:00,timezone=UTC -->';
        const marker = parseSnoozeMarker(body);
        expect(marker).toEqual({
          status: 'pass',
          timestamp: Date.parse('2026-11-01T01:30:00Z'),
          timezone: 'UTC',
        });
      });

      it('failure path 1: returns undefined for marker with malformed timestamp', () => {
        const body = '<!-- trustbridge-action:snooze:status=fail,timestamp=invalid-time -->';
        expect(parseSnoozeMarker(body)).toBeUndefined();
      });

      it('failure path 2: returns undefined for marker with negative timestamp', () => {
        const body = '<!-- trustbridge-action:snooze:status=fail,timestamp=-500 -->';
        expect(parseSnoozeMarker(body)).toBeUndefined();
      });
    });

    describe('DST boundary enforcement — Autumn Fall-Back (EDT -> EST)', () => {
      // Transition: America/New_York on 2026-11-01:
      // At 02:00 EDT (06:00Z), clocks fall back 1 hour to 01:00 EST (06:00Z).
      // Snooze window: 3 hours (180 mins = 10,800,000 ms).
      // Start: 2026-11-01T00:30:00-04:00 (UTC 04:30:00Z).
      const startIso = '2026-11-01T04:30:00Z';
      const priorMarker: SnoozeMarker = {
        status: 'fail',
        timestamp: Date.parse(startIso),
      };
      const snoozeWindowMs = 3 * 60 * 60 * 1000; // 3 hours

      it('happy path: remains snoozed across the fall-back boundary at 2 physical hours elapsed', () => {
        // Physical 2 hours elapsed = UTC 06:30:00Z.
        // In local wall-clock time in New York, the time is 01:30:00 EST (clocks fell back!).
        // Wall-clock time difference is (01:30 - 00:30) = 1 hour, but physical elapsed is 2 hours.
        const now2h = Date.parse('2026-11-01T06:30:00Z');
        const state = evaluateSnoozeState(false, priorMarker, snoozeWindowMs, now2h);

        expect(state.isSnoozed).toBe(true);
        expect(state.snoozeExpired).toBe(false);
        expect(state.elapsedMs).toBe(2 * 60 * 60 * 1000);
      });

      it('happy path: remains snoozed at 2h 59m physical elapsed across fall-back', () => {
        const now2h59m = Date.parse('2026-11-01T07:29:00Z');
        const state = evaluateSnoozeState(false, priorMarker, snoozeWindowMs, now2h59m);

        expect(state.isSnoozed).toBe(true);
        expect(state.snoozeExpired).toBe(false);
      });

      it('happy path: expires precisely when 3 physical hours elapse across fall-back', () => {
        // Physical 3 hours elapsed = UTC 07:30:00Z (02:30:00 EST).
        const now3h = Date.parse('2026-11-01T07:30:00Z');
        const state = evaluateSnoozeState(false, priorMarker, snoozeWindowMs, now3h);

        expect(state.isSnoozed).toBe(false);
        expect(state.snoozeExpired).toBe(true);
        expect(state.elapsedMs).toBe(3 * 60 * 60 * 1000);
      });
    });

    describe('DST boundary enforcement — Spring Forward (EST -> EDT) Wave Freeze Protection', () => {
      // Transition: America/New_York on 2026-03-08:
      // At 02:00 EST (07:00Z), clocks spring forward 1 hour to 03:00 EDT (07:00Z).
      // Snooze window: 2 hours (120 mins = 7,200,000 ms).
      // Wave freeze begins: 2026-03-08T01:30:00-05:00 (UTC 06:30:00Z).
      const startIso = '2026-03-08T06:30:00Z';
      const priorMarker: SnoozeMarker = {
        status: 'fail',
        timestamp: Date.parse(startIso),
      };
      const snoozeWindowMs = 2 * 60 * 60 * 1000; // 2 hours

      it('CRITICAL: protects assignee from early reopen when local clock jumped forward 1 hour', () => {
        // At 1 physical hour elapsed (UTC 07:30:00Z):
        // In local wall-clock time in New York, the time jumped to 03:30:00 EDT!
        // A naive wall-clock comparison (03:30 - 01:30) would see 2 hours elapsed and reopen early,
        // prematurely failing the Wave assignee!
        // With UTC normalization, physical elapsed time is exactly 1 hour (3,600,000 ms).
        const now1h = Date.parse('2026-03-08T07:30:00Z');
        const state = evaluateSnoozeState(false, priorMarker, snoozeWindowMs, now1h);

        // Verification: Must NOT reopen early! Assignee is protected.
        expect(state.isSnoozed).toBe(true);
        expect(state.snoozeExpired).toBe(false);
        expect(state.elapsedMs).toBe(1 * 60 * 60 * 1000);
      });

      it('happy path: expires precisely when full 2 physical hours elapse after spring-forward', () => {
        // Full 2 physical hours elapsed = UTC 08:30:00Z (04:30:00 EDT).
        const now2h = Date.parse('2026-03-08T08:30:00Z');
        const state = evaluateSnoozeState(false, priorMarker, snoozeWindowMs, now2h);

        expect(state.isSnoozed).toBe(false);
        expect(state.snoozeExpired).toBe(true);
        expect(state.elapsedMs).toBe(2 * 60 * 60 * 1000);
      });
    });

    describe('Reaction-based snooze across DST boundaries', () => {
      // Reaction created at 01:30 EDT before fall-back (UTC 05:30:00Z)
      const reactionCreatedAt = '2026-11-01T05:30:00Z';
      const snoozeWindowMs = 2 * 60 * 60 * 1000; // 2 hours

      it('happy path: maintains active reaction snooze across DST fall-back', () => {
        const reactions: CommentReaction[] = [
          {
            content: ':zzz:',
            created_at: reactionCreatedAt,
            user: { login: 'wave-operator', type: 'User' },
          },
        ];
        // 1 hour later in physical time: UTC 06:30:00Z
        const now = Date.parse('2026-11-01T06:30:00Z');
        const state = evaluateReactionSnooze(false, reactions, snoozeWindowMs, now);

        expect(state.isSnoozed).toBe(true);
        expect(state.snoozeExpired).toBe(false);
        expect(state.elapsedMs).toBe(1 * 60 * 60 * 1000);
      });

      it('happy path: reaction snooze with naive timestamp is normalized to UTC', () => {
        const reactions: CommentReaction[] = [
          {
            content: 'eyes',
            // Stored without timezone context
            createdAt: '2026-11-01T05:30:00',
            user: { login: 'wave-operator', type: 'User' },
          },
        ];
        const now = Date.parse('2026-11-01T06:30:00Z');
        const state = evaluateReactionSnooze(false, reactions, snoozeWindowMs, now);

        expect(state.isSnoozed).toBe(true);
        expect(state.elapsedMs).toBe(1 * 60 * 60 * 1000);
      });
    });

    describe('enforceSnoozeWindow across DST boundaries', () => {
      const startUtc = Date.parse('2026-03-08T06:30:00Z');
      const priorMarker: SnoozeMarker = { status: 'fail', timestamp: startUtc };
      const snoozeWindowMs = 2 * 60 * 60 * 1000;

      it('happy path: skips validation with reasonCode snoozed during active DST window', () => {
        // 1 physical hour after spring forward (clock shows 03:30 EDT)
        const nowUtc = Date.parse('2026-03-08T07:30:00Z');
        const enforcement = enforceSnoozeWindow(false, priorMarker, [], snoozeWindowMs, { now: nowUtc });

        expect(enforcement.skipValidation).toBe(true);
        expect(enforcement.reasonCode).toBe('snoozed');
        expect(enforcement.commentNotice).toContain('Validation snoozed');
        expect(enforcement.commentNotice).toContain('~1h 0m');
      });

      it('happy path: allows validation to proceed when physical window elapses', () => {
        const nowUtc = Date.parse('2026-03-08T08:30:01Z');
        const enforcement = enforceSnoozeWindow(false, priorMarker, [], snoozeWindowMs, { now: nowUtc });

        expect(enforcement.skipValidation).toBe(false);
        expect(enforcement.state.snoozeExpired).toBe(true);
      });
    });
  });
});

