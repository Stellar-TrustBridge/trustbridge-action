/**
 * Outbound webhook body size-cap tests (Issue #894).
 *
 * `enforceWebhookPayloadSize` is the deterministic, multibyte-safe guard that
 * caps the serialized webhook body at `WEBHOOK_MAX_BODY_BYTES`. This suite is
 * the automated proof of the issue's acceptance criteria:
 *
 *  - happy path: an under-cap body is sent byte-for-byte unchanged, with no
 *    `truncated` marker and no size reason code;
 *  - failure path 1: an oversized body drops trailing `assets[]` entries,
 *    marks the body `truncated: true` / `dropped_fields: ["assets"]`, and is
 *    still delivered;
 *  - failure path 2: when dropping every asset is still not enough, trailing
 *    `result.checks[]` entries are dropped too and both fields are recorded;
 *  - failure path 3 (irreducible): a body that cannot be reduced below the cap
 *    is never sent — `WEBHOOK_SIZE_LIMIT_EXCEEDED` and no `fetch` call;
 *  - boundary sizes with multibyte (CJK / emoji) content, sized in UTF-8
 *    bytes, never splitting a character.
 */
import {
  enforceWebhookPayloadSize,
  deliverWebhook,
  validateWebhookPayload,
  computeWebhookSignature,
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOK_PAYLOAD_TRUNCATED,
  WEBHOOK_SIZE_LIMIT_EXCEEDED,
  WEBHOOK_TRUNCATABLE_FIELDS,
  WEBHOOK_PAYLOAD_OPTIONAL_FIELDS,
  WebhookConfig,
  WebhookPayload,
  WebhookAssetEntry,
} from '../src/webhook';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ADDRESS = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const SECRET = 'super-secret-key-1234';

const CONFIG: WebhookConfig = {
  webhookUrl: 'https://dashboard.example.com/webhook',
  webhookSecret: SECRET,
  timeoutMs: 2000,
};

function basePayload(): WebhookPayload {
  return {
    schema_version: '1',
    event: 'validation_complete',
    timestamp: '2026-11-21T00:00:00.000Z',
    repository: 'Stellar-TrustBridge/trustbridge-action',
    issue_number: 894,
    stellar_address: 'GA5Z...KZVN',
    result: {
      valid: true,
      account_funded: true,
      trustline_exists: true,
      xlm_balance: '10.5000000',
      checks: [
        { label: 'Account funded', passed: true },
        { label: 'USDC trustline', passed: true },
      ],
    },
  };
}

function withAssets(payload: WebhookPayload, assets: WebhookAssetEntry[]): WebhookPayload {
  return { ...payload, assets };
}

function withChecks(
  payload: WebhookPayload,
  checks: Array<{ label: string; passed: boolean }>,
): WebhookPayload {
  return { ...payload, result: { ...payload.result, checks } };
}

/** One schema-valid asset whose `asset_code` carries `size` filler characters. */
function asset(index: number, size: number, fill = 'x'): WebhookAssetEntry {
  return {
    asset_code: `${index}-${fill.repeat(size)}`,
    asset_issuer: 'GA5Z...KZVN',
    primary: index === 0,
    trustline_exists: true,
    clawback_enabled: false,
    reason_code: 'SUCCESS',
  };
}

/** One schema-valid check whose `label` carries `size` filler characters. */
function check(index: number, size: number, fill = 'x'): { label: string; passed: boolean } {
  return { label: `check-${index}-${fill.repeat(size)}`, passed: true };
}

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

// ---------------------------------------------------------------------------
// enforceWebhookPayloadSize — unit behaviour
// ---------------------------------------------------------------------------

describe('enforceWebhookPayloadSize (Issue #894)', () => {
  it('happy path: leaves an under-cap payload byte-for-byte unchanged and unmarked', () => {
    const payload = basePayload();
    const guard = enforceWebhookPayloadSize(payload);

    expect(guard.fits).toBe(true);
    expect(guard.truncated).toBe(false);
    expect(guard.droppedFields).toEqual([]);
    // Same object reference: no `truncated` / `dropped_fields` keys are added,
    // so the frozen v1 shape is preserved when nothing needs dropping.
    expect(guard.payload).toBe(payload);
    expect('truncated' in guard.payload).toBe(false);
    expect('dropped_fields' in guard.payload).toBe(false);
    expect(guard.originalBytes).toBe(guard.finalBytes);
    expect(guard.finalBytes).toBeLessThanOrEqual(WEBHOOK_MAX_BODY_BYTES);
  });

  it('exact boundary: a body whose JSON is exactly maxBytes is not truncated', () => {
    const payload = basePayload();
    const exact = bytesOf(payload);
    const guard = enforceWebhookPayloadSize(payload, exact);

    expect(guard.truncated).toBe(false);
    expect(guard.payload).toBe(payload);
  });

  it('exact boundary: one byte under the required size truncates', () => {
    const payload = withAssets(basePayload(), [asset(0, 40), asset(1, 40)]);
    const exact = bytesOf(payload);
    const guard = enforceWebhookPayloadSize(payload, exact - 1);

    expect(guard.fits).toBe(true);
    expect(guard.truncated).toBe(true);
    expect(guard.droppedFields).toEqual(['assets']);
    expect(guard.finalBytes).toBeLessThanOrEqual(exact - 1);
  });

  it('failure path 1: drops trailing assets entries and records dropped_fields: ["assets"]', () => {
    const assets = Array.from({ length: 30 }, (_, i) => asset(i, 200));
    const payload = withAssets(basePayload(), assets);
    const budget = 5_000;
    expect(bytesOf(payload)).toBeGreaterThan(budget);

    const guard = enforceWebhookPayloadSize(payload, budget);

    expect(guard.fits).toBe(true);
    expect(guard.truncated).toBe(true);
    expect(guard.droppedFields).toEqual(['assets']);
    expect(guard.finalBytes).toBeLessThanOrEqual(budget);
    expect(guard.payload.truncated).toBe(true);
    expect(guard.payload.dropped_fields).toEqual(['assets']);
    // The core result signal — every check — is preserved at this stage.
    expect(guard.payload.result.checks).toEqual(payload.result.checks);
    // Kept assets are a strict, deterministic prefix of the original list.
    const kept = guard.payload.assets ?? [];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(assets.length);
    expect(kept).toEqual(assets.slice(0, kept.length));
  });

  it('failure path 2: trims result.checks too when dropping every asset is not enough', () => {
    const assets = [asset(0, 400)];
    const checks = Array.from({ length: 8 }, (_, i) => check(i, 300));
    const payload = withChecks(withAssets(basePayload(), assets), checks);
    const budget = 2_000;
    expect(bytesOf(payload)).toBeGreaterThan(budget);

    const guard = enforceWebhookPayloadSize(payload, budget);

    expect(guard.fits).toBe(true);
    expect(guard.truncated).toBe(true);
    expect(guard.droppedFields).toEqual(['assets', 'result.checks']);
    expect(guard.finalBytes).toBeLessThanOrEqual(budget);
    expect(guard.payload.dropped_fields).toEqual(['assets', 'result.checks']);
    // Every asset is gone; checks survive only as a prefix.
    expect(guard.payload.assets).toBeUndefined();
    const keptChecks = guard.payload.result.checks;
    expect(keptChecks.length).toBeGreaterThan(0);
    expect(keptChecks.length).toBeLessThan(checks.length);
    expect(keptChecks).toEqual(checks.slice(0, keptChecks.length));
  });

  it('failure path 3 (irreducible): reports fits:false when even the empty body exceeds the cap', () => {
    const payload = withChecks(basePayload(), []);
    payload.result.xlm_balance = '9'.repeat(600);
    const guard = enforceWebhookPayloadSize(payload, 200);

    expect(guard.fits).toBe(false);
    expect(guard.truncated).toBe(true);
    expect(guard.originalBytes).toBeGreaterThan(200);
    expect(guard.droppedFields).toEqual(['result.checks']);
  });

  it('is deterministic across repeated calls with the same input', () => {
    const payload = withAssets(basePayload(), Array.from({ length: 20 }, (_, i) => asset(i, 100)));
    const a = enforceWebhookPayloadSize(payload, 3_000);
    const b = enforceWebhookPayloadSize(payload, 3_000);

    expect(a).toEqual(b);
    expect(a.droppedFields).toEqual(b.droppedFields);
  });

  it('measures the cap in UTF-8 bytes and never splits a multibyte character', () => {
    const assets = Array.from({ length: 40 }, (_, i) => asset(i, 100, '🎉検証'));
    const payload = withAssets(basePayload(), assets);
    const full = JSON.stringify(payload);
    // Premise check: UTF-8 bytes must exceed the UTF-16 `.length` for this
    // content, or the multibyte assertion below proves nothing.
    expect(Buffer.byteLength(full, 'utf8')).toBeGreaterThan(full.length);

    const budget = 4_000;
    const guard = enforceWebhookPayloadSize(payload, budget);

    expect(guard.truncated).toBe(true);
    expect(guard.finalBytes).toBeLessThanOrEqual(budget);

    const json = JSON.stringify(guard.payload);
    // Whole entries are dropped, never raw bytes, so no replacement character
    // (U+FFFD) can appear from a split surrogate pair / codepoint.
    expect(json).not.toContain('\uFFFD');
    expect(() => JSON.parse(json)).not.toThrow();

    const parsed = JSON.parse(json) as WebhookPayload;
    const kept = parsed.assets ?? [];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(assets.length);
    expect(kept).toEqual(assets.slice(0, kept.length));
  });

  it('only ever names fields from the documented WEBHOOK_TRUNCATABLE_FIELDS set', () => {
    const payload = withChecks(
      withAssets(basePayload(), [asset(0, 400)]),
      Array.from({ length: 8 }, (_, i) => check(i, 300)),
    );
    const guard = enforceWebhookPayloadSize(payload, 2_000);
    for (const field of guard.droppedFields) {
      expect(WEBHOOK_TRUNCATABLE_FIELDS).toContain(field);
    }
  });
});

// ---------------------------------------------------------------------------
// deliverWebhook — end-to-end delivery with the size cap wired in
// ---------------------------------------------------------------------------

describe('deliverWebhook payload size cap (Issue #894)', () => {
  it('happy path: sends an under-cap body byte-for-byte with no size reason code', async () => {
    const payload = basePayload();
    const expectedBody = JSON.stringify(payload);
    const mockFetch = jest.fn().mockResolvedValue({ status: 200 });

    const result = await deliverWebhook(payload, CONFIG, mockFetch as any);

    expect(result.sent).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.reason).toBeUndefined();

    const options = mockFetch.mock.calls[0][1] as RequestInit;
    expect(options.body).toBe(expectedBody);
    expect(options.body as string).not.toContain('truncated');
    const headers = options.headers as Record<string, string>;
    expect(headers['X-TrustBridge-Signature']).toBe(computeWebhookSignature(expectedBody, SECRET));
  });

  it('failure path 1: truncates oversized assets, marks the body, and still delivers', async () => {
    const assets = Array.from({ length: 30 }, (_, i) => asset(i, 40_000));
    const payload = withAssets(basePayload(), assets);
    expect(bytesOf(payload)).toBeGreaterThan(WEBHOOK_MAX_BODY_BYTES);
    expect(validateWebhookPayload(payload)).toEqual([]);

    const mockFetch = jest.fn().mockResolvedValue({ status: 200 });
    const result = await deliverWebhook(payload, CONFIG, mockFetch as any);

    expect(result.sent).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.reason).toBe(WEBHOOK_PAYLOAD_TRUNCATED);

    const options = mockFetch.mock.calls[0][1] as RequestInit;
    const body = options.body as string;
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(WEBHOOK_MAX_BODY_BYTES);

    const sent = JSON.parse(body) as WebhookPayload;
    expect(sent.truncated).toBe(true);
    expect(sent.dropped_fields).toEqual(['assets']);
    expect(sent.result.checks).toEqual(payload.result.checks);
    const kept = sent.assets ?? [];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(assets.length);
    expect(kept).toEqual(assets.slice(0, kept.length));

    // The signature covers the truncated bytes actually sent, and the schema
    // version header still matches the body.
    const headers = options.headers as Record<string, string>;
    expect(headers['X-TrustBridge-Signature']).toBe(computeWebhookSignature(body, SECRET));
    expect(headers['X-TrustBridge-Schema-Version']).toBe(sent.schema_version);
  });

  it('failure path 2: trims result.checks and records both dropped fields on delivery', async () => {
    const assets = [asset(0, 500_000), asset(1, 500_000)];
    const checks = Array.from({ length: 40 }, (_, i) => check(i, 40_000));
    const payload = withChecks(withAssets(basePayload(), assets), checks);
    expect(validateWebhookPayload(payload)).toEqual([]);

    const mockFetch = jest.fn().mockResolvedValue({ status: 200 });
    const result = await deliverWebhook(payload, CONFIG, mockFetch as any);

    expect(result.sent).toBe(true);
    expect(result.reason).toBe(WEBHOOK_PAYLOAD_TRUNCATED);

    const body = (mockFetch.mock.calls[0][1] as RequestInit).body as string;
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(WEBHOOK_MAX_BODY_BYTES);

    const sent = JSON.parse(body) as WebhookPayload;
    expect(sent.truncated).toBe(true);
    expect(sent.dropped_fields).toEqual(['assets', 'result.checks']);
    expect(sent.assets).toBeUndefined();
    expect(sent.result.checks.length).toBeGreaterThan(0);
    expect(sent.result.checks.length).toBeLessThan(checks.length);
    expect(sent.result.checks).toEqual(checks.slice(0, sent.result.checks.length));
  });

  it('failure path 3 (irreducible): refuses to send and returns WEBHOOK_SIZE_LIMIT_EXCEEDED', async () => {
    const payload = withChecks(basePayload(), []);
    payload.result.xlm_balance = '9'.repeat(WEBHOOK_MAX_BODY_BYTES + 1_000);
    expect(validateWebhookPayload(payload)).toEqual([]);

    const mockFetch = jest.fn().mockResolvedValue({ status: 200 });
    const result = await deliverWebhook(payload, CONFIG, mockFetch as any);

    expect(result.sent).toBe(false);
    expect(result.reason).toBe(WEBHOOK_SIZE_LIMIT_EXCEEDED);
    expect(result.error).toContain(WEBHOOK_SIZE_LIMIT_EXCEEDED);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('preserves fail-closed schema validation: an invalid payload is still never sent', async () => {
    const payload = { ...basePayload(), bogus: 'nope' } as unknown as WebhookPayload;
    const mockFetch = jest.fn().mockResolvedValue({ status: 200 });

    const result = await deliverWebhook(payload, CONFIG, mockFetch as any);

    expect(result.sent).toBe(false);
    expect(result.error).toContain('bogus');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// validateWebhookPayload — the new marker fields
// ---------------------------------------------------------------------------

describe('validateWebhookPayload marker fields (Issue #894)', () => {
  it('accepts a truncated payload that carries dropped_fields', () => {
    const payload = { ...basePayload(), truncated: true, dropped_fields: ['assets', 'result.checks'] };
    expect(validateWebhookPayload(payload)).toEqual([]);
  });

  it('rejects a non-boolean truncated marker', () => {
    const payload = { ...basePayload(), truncated: 'yes' };
    expect(validateWebhookPayload(payload)).toContain('truncated: must be a boolean');
  });

  it('rejects a dropped_fields entry that is not a known truncatable field', () => {
    const payload = { ...basePayload(), dropped_fields: ['assets', 'result.valid'] };
    const errors = validateWebhookPayload(payload);
    expect(errors.some((e) => e.includes('dropped_fields[1]'))).toBe(true);
  });

  it('rejects a dropped_fields value that is not an array of strings', () => {
    const payload = { ...basePayload(), dropped_fields: [1] };
    expect(validateWebhookPayload(payload)).toContain('dropped_fields: must be an array of strings');
  });

  it('exposes the documented, closed sets of optional fields and reason codes', () => {
    expect(WEBHOOK_PAYLOAD_OPTIONAL_FIELDS).toEqual(['assets', 'truncated', 'dropped_fields']);
    expect(WEBHOOK_TRUNCATABLE_FIELDS).toEqual(['assets', 'result.checks']);
    expect(WEBHOOK_PAYLOAD_TRUNCATED).toBe('WEBHOOK_PAYLOAD_TRUNCATED');
    expect(WEBHOOK_SIZE_LIMIT_EXCEEDED).toBe('WEBHOOK_SIZE_LIMIT_EXCEEDED');
  });
});
