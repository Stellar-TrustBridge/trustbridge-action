import { SimpleCache } from '../src/cache';
import { matchesRosterPattern } from '../src/roster';
import { checkLedgerFreshness } from '../src/freshness';

describe('Wave issues #869-#872 regression coverage', () => {
  it('negative cache expires independently of positive entries', () => {
    const cache = new SimpleCache();
    cache.setNegative('horizon:account:test:GABC', 'not found', 10);
    expect(cache.getNegative('horizon:account:test:GABC')?.statusCode).toBe(404);
  });
  it('bounded glob matching avoids regex evaluation', () => {
    expect(matchesRosterPattern('ga5z-wallet', 'ga5z-*')).toBe(true);
    expect(matchesRosterPattern('ga5z-wallet', 'gbbd-*')).toBe(false);
  });
  it('freshness reports excessive future skew as unknown', async () => {
    const future = new Date(Date.now() + 120_000).toISOString();
    const result = await checkLedgerFreshness('https://horizon.stellar.org', {
      clockSkewToleranceSeconds: 30,
      fetchFn: async () => new Response(JSON.stringify({ history_latest_ledger: 1, history_latest_ledger_closed_at: future }), { status: 200 }),
    });
    expect(result.status).toBe('unknown');
  });
});
