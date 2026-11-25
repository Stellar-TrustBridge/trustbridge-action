import {
  isFresh,
  freshnessRemainingMs,
  type FreshnessStamp,
} from '../src/freshness';
import { makeHorizonAccount } from './helpers/horizon-account';

const TTL_MS = 30_000;
const BASE_NOW = 1_700_000_000_000;

function stampAt(cachedAt: number): FreshnessStamp {
  return { cachedAt, ttlMs: TTL_MS };
}

describe('freshness TTL for cached Horizon account payloads', () => {
  it('treats a payload cached within the TTL as fresh (happy path)', () => {
    const account = makeHorizonAccount({ nativeBalance: '42.0000000' });
    const stamp = stampAt(BASE_NOW);

    expect(isFresh(stamp, BASE_NOW)).toBe(true);
    expect(isFresh(stamp, BASE_NOW + TTL_MS - 1)).toBe(true);
    expect(freshnessRemainingMs(stamp, BASE_NOW + 1_000)).toBe(TTL_MS - 1_000);
    expect(account.balances[0].balance).toBe('42.0000000');
  });

  it('treats a payload cached exactly at the TTL boundary as stale (failure path)', () => {
    const stamp = stampAt(BASE_NOW);

    expect(isFresh(stamp, BASE_NOW + TTL_MS)).toBe(false);
    expect(freshnessRemainingMs(stamp, BASE_NOW + TTL_MS)).toBe(0);
  });

  it('treats an expired payload as stale so Wave rechecks refetch', () => {
    const stamp = stampAt(BASE_NOW);

    expect(isFresh(stamp, BASE_NOW + TTL_MS + 1)).toBe(false);
    expect(freshnessRemainingMs(stamp, BASE_NOW + TTL_MS + 5_000)).toBe(0);
  });

  it('handles clock skew when the clock moves backward', () => {
    const stamp = stampAt(BASE_NOW);

    // Clock jumped back before the cache write: must not be treated as fresh forever.
    expect(isFresh(stamp, BASE_NOW - 60_000)).toBe(false);
    expect(freshnessRemainingMs(stamp, BASE_NOW - 60_000)).toBe(0);
  });

  it('handles clock skew when the clock moves forward past the TTL', () => {
    const stamp = stampAt(BASE_NOW);

    expect(isFresh(stamp, BASE_NOW + TTL_MS * 10)).toBe(false);
  });

  it('rejects malformed stamps with a stable result', () => {
    expect(isFresh({ cachedAt: Number.NaN, ttlMs: TTL_MS }, BASE_NOW)).toBe(false);
    expect(isFresh({ cachedAt: BASE_NOW, ttlMs: -1 }, BASE_NOW)).toBe(false);
    expect(freshnessRemainingMs({ cachedAt: Number.NaN, ttlMs: TTL_MS }, BASE_NOW)).toBe(0);
  });
});
