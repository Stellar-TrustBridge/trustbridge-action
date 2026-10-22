/**
 * Issue #789 — typescript-snippets examples for local mocked Horizon runs.
 *
 * Proves the snippets in docs/typescript-snippets.md work against the real
 * `fetchAccount` with production-shaped fixture JSON, and that the docs keep
 * pointing at the example module.
 */
import * as fs from 'fs';
import * as path from 'path';
import { HorizonError } from '../src/horizon';
import { createMockHorizon, fetchMockedAccount, loadAccountFixture } from '../docs/examples/mocked-horizon';
import { TEST_HORIZON_ACCOUNT_ID, TEST_HORIZON_ASSET_ISSUER, makeHorizonAccount } from './helpers/horizon-account';

jest.mock('@actions/core');

const DOCS = path.join(__dirname, '..', 'docs');

describe('mocked Horizon snippets (#789)', () => {
  it('serves a recorded production fixture to fetchAccount (happy path)', async () => {
    const funded = loadAccountFixture('account-funded');
    const horizon = createMockHorizon({ [funded.account_id]: funded });

    const account = await fetchMockedAccount(horizon.fetchFn, funded.account_id);

    expect(account.account_id).toBe(TEST_HORIZON_ACCOUNT_ID);
    const usdc = account.balances.find((b) => 'asset_code' in b && b.asset_code === 'USDC');
    expect(usdc).toMatchObject({ asset_issuer: TEST_HORIZON_ASSET_ISSUER });
    expect(horizon.calls).toEqual([`https://horizon-testnet.stellar.org/accounts/${funded.account_id}`]);
  });

  it('works with fixtures built by makeHorizonAccount', async () => {
    const account = makeHorizonAccount({ nativeBalance: '0.5000000' });
    const horizon = createMockHorizon({ [account.account_id]: account });
    const fetched = await fetchMockedAccount(horizon.fetchFn, account.account_id);
    expect(fetched.balances[0]).toMatchObject({ asset_type: 'native', balance: '0.5000000' });
  });

  it('surfaces an unfunded account as a 404 HorizonError (failure path)', async () => {
    const horizon = createMockHorizon({});
    await expect(fetchMockedAccount(horizon.fetchFn, TEST_HORIZON_ACCOUNT_ID)).rejects.toMatchObject({
      name: expect.stringMatching(/HorizonError/),
      statusCode: 404,
    });
  });

  it('surfaces a simulated Horizon outage as a HorizonError', async () => {
    const horizon = createMockHorizon({ [TEST_HORIZON_ACCOUNT_ID]: { status: 503, body: { title: 'Service Unavailable' } } });
    await expect(fetchMockedAccount(horizon.fetchFn, TEST_HORIZON_ACCOUNT_ID)).rejects.toBeInstanceOf(HorizonError);
  });

  it('rejects malformed or missing fixtures with clear errors', () => {
    expect(() => loadAccountFixture('../etc/passwd')).toThrow('Invalid fixture name');
    expect(() => loadAccountFixture('does-not-exist')).toThrow('Horizon fixture not found: does-not-exist.json');
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tb-fixture-'));
    fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ hello: 'world' }));
    expect(() => loadAccountFixture('bad', dir)).toThrow('is not account JSON');
  });

  it.each(['typescript-snippets.md', 'javascript-snippets.md'])('%s documents the mocked Horizon snippets', (file) => {
    const doc = fs.readFileSync(path.join(DOCS, file), 'utf8');
    expect(doc).toContain('## Local mocked Horizon runs');
    expect(doc).toContain('createMockHorizon');
    expect(doc).toContain('loadAccountFixture');
    expect(doc).toContain('docs/examples/mocked-horizon.ts');
  });
});
