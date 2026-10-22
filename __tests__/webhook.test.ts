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
import * as core from '@actions/core';
import { EventEmitter } from 'events';
import { createServer } from 'http';
import {
  computeWebhookSignature,
  verifyWebhookSignature,
  buildWebhookPayload,
  deliverWebhook,
  validateWebhookPayload,
  listenForRunnerCancellation,
  sendWebhookNotification,
  describeOidcMintFailure,
  verifyWebhookSignatureWithRotation,
  buildWebhookSignatureHeaders,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_PREVIOUS_SIGNATURE_HEADER,
  WebhookConfig,
  WebhookPayload,
} from '../src/webhook';
import { logger } from '../src/logger';

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

async function startDelayedWebhookServer(): Promise<{
  url: string;
  requestReceived: Promise<void>;
  close: () => Promise<void>;
}> {
  let resolveRequestReceived!: () => void;
  const requestReceived = new Promise<void>((resolve) => {
    resolveRequestReceived = resolve;
  });
  const server = createServer(() => resolveRequestReceived());

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start delayed webhook test server');
  }

  return {
    url: `http://127.0.0.1:${address.port}/webhook`,
    requestReceived,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

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

describe('verifyWebhookSignature', () => {
  it('accepts a signature generated from the raw body', () => {
    const body = '{"schema_version":"1"}';
    const signature = computeWebhookSignature(body, 'secret');

    expect(verifyWebhookSignature(body, signature, 'secret')).toBe(true);
  });

  it('rejects a changed body or secret', () => {
    const body = '{"schema_version":"1"}';
    const signature = computeWebhookSignature(body, 'secret');

    expect(verifyWebhookSignature('{"schema_version":"2"}', signature, 'secret')).toBe(false);
    expect(verifyWebhookSignature(body, signature, 'wrong-secret')).toBe(false);
  });

  it('rejects malformed signatures without throwing', () => {
    expect(verifyWebhookSignature('body', 'sha256=short', 'secret')).toBe(false);
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

  it('aborts a delayed HTTP response when the configured timeout elapses', async () => {
    const server = await startDelayedWebhookServer();
    try {
      const deliveryPromise = deliverWebhook(
        makePayload(),
        { ...CONFIG, webhookUrl: server.url, timeoutMs: 250 },
      );
      await server.requestReceived;
      const result = await deliveryPromise;

      expect(result.sent).toBe(false);
      expect(result.error).toBeDefined();
    } finally {
      await server.close();
    }
  });

  it('aborts an in-flight delayed HTTP response when its parent signal fires', async () => {
    const server = await startDelayedWebhookServer();
    const controller = new AbortController();
    try {
      const deliveryPromise = deliverWebhook(
        makePayload(),
        {
          ...CONFIG,
          webhookUrl: server.url,
          timeoutMs: 5_000,
          signal: controller.signal,
        },
      );
      await server.requestReceived;
      controller.abort(new Error('job cancelled'));
      const result = await deliveryPromise;

      expect(result.sent).toBe(false);
      expect(result.error).toContain('job cancelled');
    } finally {
      await server.close();
    }
  });

  it('bridges runner SIGINT and SIGTERM into an abort signal and unregisters listeners', () => {
    const signalSource = Object.assign(new EventEmitter(), {
      exitCode: undefined as number | undefined,
    });
    const controller = new AbortController();
    const removeListeners = listenForRunnerCancellation(controller, signalSource as any);

    signalSource.emit('SIGTERM');

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason.message).toContain('SIGTERM');
    expect(signalSource.exitCode).toBe(143);

    removeListeners();
    expect(signalSource.listenerCount('SIGINT')).toBe(0);
    expect(signalSource.listenerCount('SIGTERM')).toBe(0);
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
// Issue #674 — OIDC mode fails closed when token minting fails
// ---------------------------------------------------------------------------

describe('OIDC fail-closed delivery (Issue #674)', () => {
  const FAKE_JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJ0cnVzdGJyaWRnZSJ9.c2lnbmF0dXJlLXZhbHVl';
  const OIDC_CONFIG: WebhookConfig = {
    webhookUrl: 'https://dashboard.example.com/webhook',
    webhookSecret: 'hmac-secret-that-must-not-be-used',
    timeoutMs: 1000,
    authMode: 'oidc',
  };

  let origFetch: typeof fetch;
  let fetchMock: jest.Mock;
  let setFailedSpy: jest.SpyInstance;
  let warningSpy: jest.SpyInstance;
  let infoSpy: jest.SpyInstance;
  let debugSpy: jest.SpyInstance;

  beforeEach(() => {
    origFetch = global.fetch;
    fetchMock = jest.fn().mockResolvedValue({ status: 200 });
    (global as any).fetch = fetchMock;
    setFailedSpy = jest.spyOn(core, 'setFailed').mockImplementation(() => {});
    warningSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    infoSpy = jest.spyOn(core, 'info').mockImplementation(() => {});
    debugSpy = jest.spyOn(core, 'debug').mockImplementation(() => {});
    jest.spyOn(core, 'setSecret').mockImplementation(() => {});
  });

  afterEach(() => {
    (global as any).fetch = origFetch;
    jest.restoreAllMocks();
  });

  const allLogText = (): string =>
    [setFailedSpy, warningSpy, infoSpy, debugSpy]
      .flatMap((spy) => spy.mock.calls.map((call: unknown[]) => String(call[0])))
      .join('\n');

  it('fails the step and sends nothing when id-token permission is missing', async () => {
    jest
      .spyOn(core, 'getIDToken')
      .mockRejectedValue(new Error('Unable to get ACTIONS_ID_TOKEN_REQUEST_URL env variable'));

    await sendWebhookNotification(passedResult, ADDRESS, OIDC_CONFIG, 'owner/repo', 1);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(setFailedSpy).toHaveBeenCalledTimes(1);
    const message = String(setFailedSpy.mock.calls[0][0]);
    expect(message).toContain('OIDC token minting failed');
    expect(message).toContain('id-token: write');
    expect(message).toContain('fork');
  });

  it('fails the step and sends nothing on an OIDC provider error, without leaking JWT material', async () => {
    jest
      .spyOn(core, 'getIDToken')
      .mockRejectedValue(new Error(`Failed to get ID Token. Error Code : 500 Error Message: bad response ${FAKE_JWT}`));

    await sendWebhookNotification(passedResult, ADDRESS, OIDC_CONFIG, 'owner/repo', 1);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(setFailedSpy).toHaveBeenCalledTimes(1);
    expect(String(setFailedSpy.mock.calls[0][0])).toContain('OIDC provider returned an error');
    expect(allLogText()).not.toContain(FAKE_JWT);
  });

  it('treats an empty minted token as a failure', async () => {
    jest.spyOn(core, 'getIDToken').mockResolvedValue('');

    await sendWebhookNotification(passedResult, ADDRESS, OIDC_CONFIG, 'owner/repo', 1);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(setFailedSpy).toHaveBeenCalledTimes(1);
  });

  it('never falls back to HMAC signing or unsigned delivery in oidc mode', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ status: 200 });
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1);

    const result = await deliverWebhook(payload, OIDC_CONFIG, mockFetch as any);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.sent).toBe(false);
    expect(result.error).toContain('oidc');
  });

  it('sends the bearer token (and no HMAC signature) when minting succeeds', async () => {
    jest.spyOn(core, 'getIDToken').mockResolvedValue(FAKE_JWT);

    await sendWebhookNotification(passedResult, ADDRESS, OIDC_CONFIG, 'owner/repo', 1);

    expect(setFailedSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${FAKE_JWT}`);
    expect(headers['X-TrustBridge-Signature']).toBeUndefined();
    expect(allLogText()).not.toContain(FAKE_JWT);
  });

  it('does not attempt to mint a token when webhook_url is unset', async () => {
    const mintSpy = jest.spyOn(core, 'getIDToken');

    await sendWebhookNotification(passedResult, ADDRESS, { ...OIDC_CONFIG, webhookUrl: '' }, 'owner/repo', 1);

    expect(mintSpy).not.toHaveBeenCalled();
    expect(setFailedSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('describeOidcMintFailure redacts JWTs embedded in the provider message', () => {
    const message = describeOidcMintFailure('trustbridge-dashboard', new Error(`bad ${FAKE_JWT}`));
    expect(message).not.toContain(FAKE_JWT);
    expect(message).toContain('[REDACTED_JWT]');
  });
});

// ---------------------------------------------------------------------------
// Issue #675 — Soroban C-address redaction in payloads and debug logs
// ---------------------------------------------------------------------------

describe('C-address redaction (Issue #675)', () => {
  const C_ADDRESS = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
  const FULL_C_ADDRESS_PATTERN = /C[A-Z2-7]{55}/;

  afterEach(() => jest.restoreAllMocks());

  it('redacts a C-address stellar_address and keeps the payload schema-valid', () => {
    const payload = buildWebhookPayload(passedResult, C_ADDRESS, 'owner/repo', 1);
    expect(payload.stellar_address).toBe('CAAA...D2KM');
    expect(validateWebhookPayload(payload)).toEqual([]);
  });

  it('redacts C-address asset issuers in the per-asset section', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1, [
      {
        assetCode: 'TOKN',
        assetIssuer: C_ADDRESS,
        primary: true,
        trustlineExists: true,
        clawbackEnabled: false,
        reasonCode: 'SUCCESS',
      },
    ]);
    expect(payload.assets![0].asset_issuer).toBe('CAAA...D2KM');
    expect(JSON.stringify(payload)).not.toMatch(FULL_C_ADDRESS_PATTERN);
    expect(validateWebhookPayload(payload)).toEqual([]);
  });

  it('redacts C-addresses embedded in check labels', () => {
    const result = {
      ...passedResult,
      checks: [{ label: `SAC issuer_${C_ADDRESS} reachable`, passed: true, detail: 'ok' }],
    };
    const payload = buildWebhookPayload(result, ADDRESS, 'owner/repo', 1);
    expect(payload.result.checks[0].label).toContain('CAAA...D2KM');
    expect(JSON.stringify(payload)).not.toMatch(FULL_C_ADDRESS_PATTERN);
  });

  it('keeps G-address redaction unchanged', () => {
    const payload = buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1);
    expect(payload.stellar_address).toBe('GA5Z...KZVN');
  });

  it('debug-mode webhook JSON log contains no full 56-char C-address', async () => {
    logger.setDebugMode(true);
    const debugSpy = jest.spyOn(core, 'debug').mockImplementation(() => {});
    jest.spyOn(core, 'info').mockImplementation(() => {});
    jest.spyOn(core, 'warning').mockImplementation(() => {});
    const origFetch = global.fetch;
    (global as any).fetch = jest.fn().mockResolvedValue({ status: 200 });
    try {
      await sendWebhookNotification(passedResult, C_ADDRESS, CONFIG, 'owner/repo', 1, [
        {
          assetCode: 'TOKN',
          assetIssuer: C_ADDRESS,
          primary: true,
          trustlineExists: true,
          clawbackEnabled: true,
          reasonCode: 'CLAWBACK_BLOCKED',
        },
      ]);
    } finally {
      (global as any).fetch = origFetch;
      logger.setDebugMode(false);
    }

    const logged = debugSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('Webhook payload');
    expect(logged).toContain('CAAA...D2KM');
    expect(logged).not.toMatch(FULL_C_ADDRESS_PATTERN);
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

// ---------------------------------------------------------------------------
// Secret rotation — dual-key accept window (Issue #795)
// ---------------------------------------------------------------------------

describe('webhook HMAC secret rotation dual-key accept window (#795)', () => {
  const OLD_KEY = 'old-secret-key-aaaa';
  const NEW_KEY = 'new-secret-key-bbbb';
  const BODY = '{"schema_version":"1","event":"validation_complete"}';

  const headersFrom = (fetchMock: jest.Mock): Record<string, string> =>
    (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
  const payload = (): WebhookPayload => buildWebhookPayload(passedResult, ADDRESS, 'owner/repo', 1);

  describe('sender (deliverWebhook)', () => {
    it('signs with both keys during the rotation window', async () => {
      const fetchMock = jest.fn().mockResolvedValue({ status: 200 });
      const p = payload();
      await deliverWebhook(p, { ...CONFIG, webhookSecret: NEW_KEY, webhookSecretPrevious: OLD_KEY }, fetchMock as any);

      const headers = headersFrom(fetchMock);
      const body = (fetchMock.mock.calls[0][1] as RequestInit).body as string;
      expect(headers[WEBHOOK_SIGNATURE_HEADER]).toBe(computeWebhookSignature(body, NEW_KEY));
      expect(headers[WEBHOOK_PREVIOUS_SIGNATURE_HEADER]).toBe(computeWebhookSignature(body, OLD_KEY));
    });

    it('a receiver still on the old key verifies a rotation-window request', async () => {
      const fetchMock = jest.fn().mockResolvedValue({ status: 200 });
      await deliverWebhook(payload(), { ...CONFIG, webhookSecret: NEW_KEY, webhookSecretPrevious: OLD_KEY }, fetchMock as any);
      const headers = headersFrom(fetchMock);
      const body = (fetchMock.mock.calls[0][1] as RequestInit).body as string;

      const oldReceiver = verifyWebhookSignatureWithRotation(
        body,
        [headers[WEBHOOK_SIGNATURE_HEADER], headers[WEBHOOK_PREVIOUS_SIGNATURE_HEADER]],
        [OLD_KEY],
      );
      expect(oldReceiver).toEqual({ valid: true, matchedKeyIndex: 0 });

      const newReceiver = verifyWebhookSignatureWithRotation(
        body,
        [headers[WEBHOOK_SIGNATURE_HEADER], headers[WEBHOOK_PREVIOUS_SIGNATURE_HEADER]],
        [NEW_KEY],
      );
      expect(newReceiver).toEqual({ valid: true, matchedKeyIndex: 0 });
    });

    it('sends only the primary header outside a rotation (unchanged v1 behaviour)', async () => {
      const fetchMock = jest.fn().mockResolvedValue({ status: 200 });
      await deliverWebhook(payload(), { ...CONFIG, webhookSecret: NEW_KEY }, fetchMock as any);
      const headers = headersFrom(fetchMock);
      expect(headers[WEBHOOK_SIGNATURE_HEADER]).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(headers[WEBHOOK_PREVIOUS_SIGNATURE_HEADER]).toBeUndefined();
    });

    it('never signs with the previous key alone when the current secret is empty', async () => {
      const fetchMock = jest.fn().mockResolvedValue({ status: 200 });
      await deliverWebhook(payload(), { ...CONFIG, webhookSecret: '', webhookSecretPrevious: OLD_KEY }, fetchMock as any);
      const headers = headersFrom(fetchMock);
      expect(headers[WEBHOOK_SIGNATURE_HEADER]).toBeUndefined();
      expect(headers[WEBHOOK_PREVIOUS_SIGNATURE_HEADER]).toBeUndefined();
    });

    it('OIDC mode sends no HMAC headers even when both secrets are set', async () => {
      const fetchMock = jest.fn().mockResolvedValue({ status: 200 });
      await deliverWebhook(
        payload(),
        { ...CONFIG, authMode: 'oidc', oidcToken: 'tok', webhookSecret: NEW_KEY, webhookSecretPrevious: OLD_KEY },
        fetchMock as any,
      );
      const headers = headersFrom(fetchMock);
      expect(headers['Authorization']).toBe('Bearer tok');
      expect(headers[WEBHOOK_SIGNATURE_HEADER]).toBeUndefined();
      expect(headers[WEBHOOK_PREVIOUS_SIGNATURE_HEADER]).toBeUndefined();
    });

    it('ignores a previous key identical to the current key', () => {
      expect(buildWebhookSignatureHeaders(BODY, NEW_KEY, NEW_KEY)).toEqual({
        [WEBHOOK_SIGNATURE_HEADER]: computeWebhookSignature(BODY, NEW_KEY),
      });
    });

    it('never puts either secret into a header value', () => {
      const values = Object.values(buildWebhookSignatureHeaders(BODY, NEW_KEY, OLD_KEY)).join(' ');
      expect(values).not.toContain(NEW_KEY);
      expect(values).not.toContain(OLD_KEY);
    });
  });

  describe('receiver (verifyWebhookSignatureWithRotation)', () => {
    const sigNew = computeWebhookSignature(BODY, NEW_KEY);
    const sigOld = computeWebhookSignature(BODY, OLD_KEY);

    it('accepts the new key and reports index 0', () => {
      expect(verifyWebhookSignatureWithRotation(BODY, [sigNew], [NEW_KEY, OLD_KEY])).toEqual({ valid: true, matchedKeyIndex: 0 });
    });

    it('accepts the old key during the window and reports index 1', () => {
      expect(verifyWebhookSignatureWithRotation(BODY, [sigOld], [NEW_KEY, OLD_KEY])).toEqual({ valid: true, matchedKeyIndex: 1 });
    });

    it('rejects an old-key-only request once the window closes', () => {
      expect(verifyWebhookSignatureWithRotation(BODY, [sigOld], [NEW_KEY])).toEqual({
        valid: false,
        matchedKeyIndex: null,
        reason: 'SIGNATURE_MISMATCH',
      });
    });

    it('rejects a tampered body under both keys', () => {
      expect(verifyWebhookSignatureWithRotation(`${BODY} `, [sigNew, sigOld], [NEW_KEY, OLD_KEY]).reason).toBe('SIGNATURE_MISMATCH');
    });

    it('returns stable reasons for missing or malformed input', () => {
      expect(verifyWebhookSignatureWithRotation(BODY, [], [NEW_KEY]).reason).toBe('NO_SIGNATURE');
      expect(verifyWebhookSignatureWithRotation(BODY, [undefined, '  '], [NEW_KEY]).reason).toBe('NO_SIGNATURE');
      expect(verifyWebhookSignatureWithRotation(BODY, ['md5=abc'], [NEW_KEY]).reason).toBe('MALFORMED_SIGNATURE');
      expect(verifyWebhookSignatureWithRotation(BODY, [sigNew], ['', undefined]).reason).toBe('NO_SECRETS');
    });
  });
});
