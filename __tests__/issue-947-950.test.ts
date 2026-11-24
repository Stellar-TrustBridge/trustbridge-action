import { Response } from 'node-fetch';
import { SimpleCache } from '../src/cache';
import { fetchAccount, FetchLike } from '../src/horizon';
import { isSSRFBlocked } from '../src/ssrf';
import { computeWebhookSignature, verifyWebhookSignatureWithRotation } from '../src/webhook';
import { buildTldr, CommentConfig } from '../src/comment';
import { ValidationResult } from '../src/checks';

const ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const URL_ = 'https://horizon.stellar.org';
const body = JSON.stringify({ id: ADDRESS, account_id: ADDRESS, sequence: '1', subentry_count: 0, balances: [] });

describe('#947 conditional requests', () => {
  async function run(responses: Array<() => Response>) {
    const cache = new SimpleCache();
    const sent: Array<Record<string, string>> = [];
    const fetchFn = (async (_u: unknown, init: { headers: Record<string, string> }) => {
      sent.push({ ...init.headers });
      return responses[sent.length - 1]();
    }) as unknown as FetchLike;
    const call = async () => {
      const p = await fetchAccount(URL_, ADDRESS, { cache, fetchFn, cacheTtlMs: 1, maxRetries: 0, negativeCacheTtlMs: 0 });
      await new Promise((r) => setTimeout(r, 5));
      return p;
    };
    return { sent, call };
  }
  const ok = (headers: Record<string, string> = {}) => () => new Response(body, { status: 200, headers });
  const status = (s: number) => () => new Response(s === 304 ? '' : '{}', { status: s });

  it('round-trips validators and serves 304 from cache', async () => {
    const { sent, call } = await run([ok({ ETag: 'W/"a"', 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT' }), status(304)]);
    await call();
    expect((await call()).id).toBe(ADDRESS);
    expect(sent[0]['If-None-Match']).toBeUndefined();
    expect(sent[1]).toMatchObject({ 'If-None-Match': 'W/"a"', 'If-Modified-Since': 'Mon, 01 Jan 2024 00:00:00 GMT' });
  });
  it('rejects an unsolicited 304', async () => {
    const { call } = await run([status(304)]);
    await expect(call()).rejects.toMatchObject({ statusCode: 304 });
  });
  it('ignores oversized validators', async () => {
    const { sent, call } = await run([ok({ ETag: 'x'.repeat(600) }), ok()]);
    await call(); await call();
    expect(sent[1]['If-None-Match']).toBeUndefined();
  });
  it('drops validators after 404 and never hides a 500', async () => {
    const { sent, call } = await run([ok({ ETag: '"a"' }), status(500), status(404), ok()]);
    await call();
    await expect(call()).rejects.toMatchObject({ statusCode: 500 });
    await expect(call()).rejects.toMatchObject({ statusCode: 404 });
    await call();
    expect(sent[3]['If-None-Match']).toBeUndefined();
  });
});

describe('#948 IPv6 SSRF', () => {
  it.each(['fc00::1', 'fdff::1', 'fe80::1', 'febf::1%eth0', 'fec0::1', '[::ffff:127.0.0.1]', '::ffff:a9fe:a9fe',
    '::ffff:0:10.0.0.1', '64:ff9b:1::1', '2001:0:1:2:3:4:80ff:fffe', '::127.0.0.1', '::gg::1'.replace('gg', 'ff'), '1:2:3'])(
    'blocks %s', (h) => expect(isSSRFBlocked(h).blocked).toBe(true));
  it.each(['2606:4700::1111', '::ffff:8.8.8.8', 'horizon.stellar.org'])(
    'allows %s', (h) => expect(isSSRFBlocked(h).blocked).toBe(false));
});

describe('#949 rotation window', () => {
  const check = (key: string, options = {}) =>
    verifyWebhookSignatureWithRotation('{}', [computeWebhookSignature('{}', key)], ['new', 'old'], options);
  it('accepts either key during overlap', () => {
    expect(check('new').matchedKeyIndex).toBe(0);
    expect(check('old', { previousAcceptUntilMs: 10, nowMs: 9 }).matchedKeyIndex).toBe(1);
  });
  it.each([10, NaN])('rejects the old key once the window closes (%s)', (previousAcceptUntilMs) => {
    expect(check('old', { previousAcceptUntilMs, nowMs: 10 }).reason).toBe('ROTATION_WINDOW_EXPIRED');
    expect(check('new', { previousAcceptUntilMs, nowMs: 10 }).valid).toBe(true);
  });
  it('rejects unknown keys', () => expect(check('bad').reason).toBe('SIGNATURE_MISMATCH'));
});

describe('#950 TL;DR', () => {
  const tldr = (valid: boolean, labels: string[], reasonCode?: string) =>
    buildTldr(
      { valid, reasonCode, checks: labels.map((label) => ({ label, passed: valid, detail: '' })) } as unknown as ValidationResult,
      {} as CommentConfig,
    );
  it('renders pass, capped failures and missing reason code', () => {
    expect(tldr(true, ['a'])).toMatchInlineSnapshot(`
"> **TL;DR** ✅ Ready to proceed: all checks passed.
> Reason code: \`SUCCESS\`"
`);
    expect(tldr(false, ['a', 'b', 'c', 'd'], 'TRUSTLINE_MISSING')).toMatchInlineSnapshot(`
"> **TL;DR** ❌ Blocked by: a, b, c +1
> Reason code: \`TRUSTLINE_MISSING\`"
`);
    expect(tldr(false, [])).toContain('`FAILED`');
  });
});
