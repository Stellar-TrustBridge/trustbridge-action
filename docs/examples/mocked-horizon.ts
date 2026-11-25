/**
 * Local mocked-Horizon helpers (Issue #789).
 *
 * Unit-test code that calls `fetchAccount` against recorded production-shaped
 * account JSON (`fixtures/*.json`) instead of a live Horizon. No network,
 * no Docker. Rendered in docs/typescript-snippets.md and
 * docs/javascript-snippets.md; exercised by
 * __tests__/typescript-snippets-mocked-horizon.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fetchAccount, type FetchLike, type HorizonAccount } from '../../src/horizon';

/** Load a recorded Horizon `/accounts/:id` response from `fixtures/`. */
export function loadAccountFixture(name: string, dir = path.join(__dirname, '..', '..', 'fixtures')): HorizonAccount {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`Invalid fixture name: "${name}"`);
  const file = path.join(dir, name.endsWith('.json') ? name : `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`Horizon fixture not found: ${path.basename(file)}`);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as HorizonAccount;
  if (!parsed || typeof parsed.account_id !== 'string' || !Array.isArray(parsed.balances)) {
    throw new Error(`Horizon fixture ${path.basename(file)} is not account JSON (needs account_id and balances[])`);
  }
  return parsed;
}

/** A recorded response for one account id, or an HTTP status to simulate. */
export type MockHorizonRoute = HorizonAccount | { status: number; body?: unknown };

/**
 * Build a `fetchFn` for `fetchAccount` that serves `/accounts/:id` from an
 * in-memory map. Unknown accounts get Horizon's real 404 problem JSON.
 * Every requested URL is recorded in `calls` for assertions.
 */
export function createMockHorizon(routes: Record<string, MockHorizonRoute>): { fetchFn: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const respond = (status: number, body: unknown) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      headers: { get: () => null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Awaited<ReturnType<FetchLike>>;

  const fetchFn: FetchLike = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    const id = decodeURIComponent(new URL(url).pathname.split('/accounts/')[1] ?? '').replace(/\/.*$/, '');
    const route = routes[id];
    if (!route) {
      return respond(404, { type: 'https://stellar.org/horizon-errors/not_found', title: 'Resource Missing', status: 404 });
    }
    if ('status' in route && typeof route.status === 'number') return respond(route.status, route.body ?? {});
    return respond(200, route);
  };
  return { fetchFn, calls };
}

/** Fetch an account through the mock: no cache, no retries, so tests stay deterministic. */
export function fetchMockedAccount(fetchFn: FetchLike, accountId: string, horizonUrl = 'https://horizon-testnet.stellar.org') {
  return fetchAccount(horizonUrl, accountId, { fetchFn, useCache: false, cacheTtlMs: 0, maxRetries: 0 });
}
