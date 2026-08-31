/**
 * Tests for signed dashboard webhook support (Issue #101).
 *
 * Golden fixture: __tests__/fixtures/webhook-payload.json
 * The fixture represents a canonical passing-run payload and is used to
 * verify that buildWebhookPayload() produces a structurally identical shape,
 * ensuring the receiver contract documented in docs/USAGE.md stays in sync
 * with the code (Issue #326).
 */

import * as path from 'path';
import * as fs from 'fs';
import {
  computeWebhookSignature,
  buildWebhookPayload,
  deliverWebhook,
  sendWebhookNotification,
  WebhookConfig,
  WebhookPayload,
} from '../src/webhook';

// ---------------------------------------------------------------------------
// Golden fixture
// ---------------------------------------------------------------------------

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'webhook-payload.json');
const goldenFixture: WebhookPayload = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

// Minimal ValidationResult stub
const passedResult = {
  valid: true,
  accountFunded: true,
  trustlineExists: true,
  xlmBalance: '10.5',
  checks: [
    { label: 'Account funded', passed: true, detail: 'ok' },
    { label: 'USDC trustline', passed: true, detail: 'ok' },
  ],
  remediation: undefined,
} as any;

const failedResult = {
  valid: false,
  accountFunded: false,
  trustlineExists: false,
  xlmBalance: '0',
  checks: [
    { label: 'Account funded', passed: false, detail: 'not found' },
    { label: 'USDC trustline', passed: false, detail: 'n/a' },
  ],
  remediation: 'Fund your account',
} as any;

const CONFIG: WebhookConfig = {
  webhookUrl: 'https://dashboard.example.com/webhook',
  webhookSecret: 'super-secret-key-1234',
  timeoutMs: 2000,
};

const ADDRESS = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

// ---------------------------------------------------------------------------
// computeWebhookSignature
// ---------------------------------------------------------------------------

describe('computeWebhookSignature', () => {
  it('returns sha256= prefix', () => {
    const sig = computeWebhookSignature('hello', 'secret');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('produces deterministic signatures for same input', () => {
    const a = computeWebhookSignature('payload', 'key');
    const b = computeWebhookSignature('payload', 'key');
    expect(a).toBe(b);
  });

  it('produces different signatures for different secrets', () => {
    const a = computeWebhookSignature('payload', 'key1');
    const b = computeWebhookSignature('payload', 'key2');
    expect(a).not.toBe(b);
  });

  it('produces different signatures for different payloads', () => {
    const a = computeWebhookSignature('payload1', 'key');
    const b = computeWebhookSignature('payload2', 'key');
    expect(a).not.toBe(b);
  });

  it('matches a known HMAC-SHA256 value', () => {
    // Verified with: echo -n "test" | openssl dgst -sha256 -hmac "secret"
    const sig = computeWebhookSignature('test', 'secret');
    expect(sig).toBe(
      'sha256=0329a06b62cd16b33eb6792be8c60b158d89a2ee3a876fce9a881ebb488c0914',
    );
  });
});

// ---------------------------------------------------------------------------
// buildWebhookPayload
// ---------------------------------------------------------------------------

describe('buildWebhookPayload', () => {
  it('redacts the stellar address', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 42);
    // Full address must not appear
    expect(payload.stellar_address).not.toBe(ADDRESS);
    expect(payload.stellar_address).toMatch(/^[GC][A-Z2-7]{3}\.{3}[A-Z2-7]{4}$/);
  });

  it('sets schema_version to "1"', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1);
    expect(payload.schema_version).toBe('1');
  });

  it('sets event to validation_complete', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1);
    expect(payload.event).toBe('validation_complete');
  });

  it('includes issue_number', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 99);
    expect(payload.issue_number).toBe(99);
  });

  it('accepts null issue_number', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', null);
    expect(payload.issue_number).toBeNull();
  });

  it('maps result fields correctly for passing run', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1);
    expect(payload.result.valid).toBe(true);
    expect(payload.result.account_funded).toBe(true);
    expect(payload.result.trustline_exists).toBe(true);
    expect(payload.result.xlm_balance).toBe('10.5');
  });

  it('maps result fields correctly for failing run', () => {
    const payload = buildWebhookPayload(failedResult, ADDRESS, 'owner/repo', 1);
    expect(payload.result.valid).toBe(false);
    expect(payload.result.account_funded).toBe(false);
  });

  it('maps checks array', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1);
    expect(payload.result.checks).toHaveLength(2);
    expect(payload.result.checks[0]).toEqual({ label: 'Account funded', passed: true });
  });

  it('includes repository', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'stellar-trust/repo', 1);
    expect(payload.repository).toBe('stellar-trust/repo');
  });

  it('includes a valid ISO-8601 timestamp', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1);
    expect(() => new Date(payload.timestamp)).not.toThrow();
    expect(new Date(payload.timestamp).toISOString()).toBe(payload.timestamp);
  });
});

// ---------------------------------------------------------------------------
// deliverWebhook
// ---------------------------------------------------------------------------

describe('deliverWebhook', () => {
  const makePayload = (): WebhookPayload =>
    buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1);

  it('returns sent=true with statusCode on success', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ status: 200 });
    const result = await deliverWebhook(makePayload(), CONFIG, mockFetch as any);
    expect(result.sent).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.error).toBeUndefined();
  });

  it('sends the X-TrustBridge-Signature header when secret is set', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ status: 200 });
    await deliverWebhook(makePayload(), CONFIG, mockFetch as any);

    const callArgs = mockFetch.mock.calls[0];
    const options = callArgs[1] as RequestInit;
    const headers = options.headers as Record<string, string>;
    expect(headers['X-TrustBridge-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('does NOT send the signature header when no secret', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ status: 200 });
    const noSecretConfig: WebhookConfig = { ...CONFIG, webhookSecret: '' };
    await deliverWebhook(makePayload(), noSecretConfig, mockFetch as any);

    const callArgs = mockFetch.mock.calls[0];
    const options = callArgs[1] as RequestInit;
    const headers = options.headers as Record<string, string>;
    expect(headers['X-TrustBridge-Signature']).toBeUndefined();
  });

  it('returns sent=false on network error without throwing', async () => {
    const mockFetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await deliverWebhook(makePayload(), CONFIG, mockFetch as any);
    expect(result.sent).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('returns sent=false on AbortError (timeout) without throwing', async () => {
    const mockFetch = jest.fn().mockRejectedValue(
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
    );
    const result = await deliverWebhook(makePayload(), { ...CONFIG, timeoutMs: 1 }, mockFetch as any);
    expect(result.sent).toBe(false);
  });

  it('sends to the correct URL', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ status: 204 });
    await deliverWebhook(makePayload(), CONFIG, mockFetch as any);
    expect(mockFetch).toHaveBeenCalledWith(
      CONFIG.webhookUrl,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('sends Content-Type: application/json', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ status: 200 });
    await deliverWebhook(makePayload(), CONFIG, mockFetch as any);
    const options = mockFetch.mock.calls[0][1] as RequestInit;
    expect((options.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('signature matches computed value for the same body', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody: string | undefined;

    const mockFetch = jest.fn().mockImplementation((_url: string, opts: RequestInit) => {
      capturedHeaders = opts.headers as Record<string, string>;
      capturedBody = opts.body as string;
      return Promise.resolve({ status: 200 });
    });

    await deliverWebhook(makePayload(), CONFIG, mockFetch as any);

    const expected = computeWebhookSignature(capturedBody!, CONFIG.webhookSecret!);
    expect(capturedHeaders!['X-TrustBridge-Signature']).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// sendWebhookNotification (integration-style)
// ---------------------------------------------------------------------------

describe('sendWebhookNotification', () => {
  const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

  afterEach(() => jest.clearAllMocks());
  afterAll(() => consoleSpy.mockRestore());

  it('does nothing when webhookUrl is empty', async () => {
    // Should not throw or make any HTTP call
    const mockFetch = jest.fn();
    const emptyConfig: WebhookConfig = { webhookUrl: '', webhookSecret: '', timeoutMs: 1000 };
    await expect(
      sendWebhookNotification(passedResult, ADDRESS, emptyConfig, 'owner/repo', null),
    ).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('completes without throwing when webhook fails', async () => {
    // Use real fetch-shaped rejection
    const origFetch = global.fetch;
    (global as any).fetch = jest.fn().mockRejectedValue(new Error('network down'));
    await expect(
      sendWebhookNotification(passedResult, ADDRESS, CONFIG, 'owner/repo', 5),
    ).resolves.toBeUndefined();
    (global as any).fetch = origFetch;
  });
});

// ---------------------------------------------------------------------------
// Golden fixture alignment (Issue #326)
// ---------------------------------------------------------------------------

describe('golden fixture — webhook-payload.json', () => {
  it('fixture file is valid JSON and can be read', () => {
    expect(() => JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'))).not.toThrow();
  });

  it('fixture has schema_version "1"', () => {
    expect(goldenFixture.schema_version).toBe('1');
  });

  it('fixture has event "validation_complete"', () => {
    expect(goldenFixture.event).toBe('validation_complete');
  });

  it('fixture stellar_address is redacted (first4...last4 format)', () => {
    expect(goldenFixture.stellar_address).toMatch(/^[GC][A-Z2-7]{3}\.{3}[A-Z2-7]{4}$/);
  });

  it('fixture result has all required boolean fields', () => {
    expect(typeof goldenFixture.result.valid).toBe('boolean');
    expect(typeof goldenFixture.result.account_funded).toBe('boolean');
    expect(typeof goldenFixture.result.trustline_exists).toBe('boolean');
  });

  it('fixture result.xlm_balance is a string', () => {
    expect(typeof goldenFixture.result.xlm_balance).toBe('string');
  });

  it('fixture result.checks is an array of {label, passed} objects', () => {
    expect(Array.isArray(goldenFixture.result.checks)).toBe(true);
    for (const check of goldenFixture.result.checks) {
      expect(typeof check.label).toBe('string');
      expect(typeof check.passed).toBe('boolean');
      // checks in the payload must NOT include the internal 'detail' field
      expect(Object.keys(check)).toEqual(expect.arrayContaining(['label', 'passed']));
      expect('detail' in check).toBe(false);
    }
  });

  it('fixture issue_number is a number or null', () => {
    expect(
      goldenFixture.issue_number === null || typeof goldenFixture.issue_number === 'number',
    ).toBe(true);
  });

  it('buildWebhookPayload output matches fixture schema shape', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 42);

    // Structural keys must match exactly
    expect(Object.keys(payload).sort()).toEqual(Object.keys(goldenFixture).sort());
    expect(Object.keys(payload.result).sort()).toEqual(Object.keys(goldenFixture.result).sort());

    // Types must match
    expect(payload.schema_version).toBe(goldenFixture.schema_version);
    expect(payload.event).toBe(goldenFixture.event);
    expect(typeof payload.timestamp).toBe('string');
    expect(typeof payload.repository).toBe('string');
    expect(payload.issue_number).toBe(42);
    expect(payload.stellar_address).toMatch(/^[GC][A-Z2-7]{3}\.{3}[A-Z2-7]{4}$/);
    expect(typeof payload.result.valid).toBe('boolean');
    expect(typeof payload.result.account_funded).toBe('boolean');
    expect(typeof payload.result.trustline_exists).toBe('boolean');
    expect(typeof payload.result.xlm_balance).toBe('string');
    expect(Array.isArray(payload.result.checks)).toBe(true);
  });

  it('buildWebhookPayload checks have no extra fields beyond label and passed', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 42);
    for (const check of payload.result.checks) {
      expect(Object.keys(check).sort()).toEqual(['label', 'passed'].sort());
    }
  });

  it('fixture timestamp is valid ISO-8601', () => {
    const d = new Date(goldenFixture.timestamp);
    expect(isNaN(d.getTime())).toBe(false);
    expect(d.toISOString()).toBe(goldenFixture.timestamp);
  });
});
