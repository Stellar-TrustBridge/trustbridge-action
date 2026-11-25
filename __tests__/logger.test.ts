/**
 * Tests for Issue #34 — structured JSON logging of action inputs.
 * Tests for Issue #460 — Redact muxed M-addresses in logs.
 *
 * Covers:
 *   - buildInputsLogRecord: address/URL redaction per field
 *   - emitInputsLogRecord: calls core.info with the JSON artifact
 *   - StructuredLogger redaction helpers (redactStellarAddress, redactHorizonUrl,
 *     redactString) used internally by buildInputsLogRecord
 *   - Muxed M-address (69-char) redaction in all redaction paths (Issue #460)
 */

import * as core from '@actions/core';
import {
  buildInputsLogRecord,
  emitInputsLogRecord,
  redactStellarAddress,
  redactHorizonUrl,
  redactString,
  redactContext,
  isSensitiveSecretKey,
  logger,
  ActionInputsLogRecord,
  HorizonRetryEvent,
  HORIZON_RETRY_LOG_FIELDS,
  HORIZON_RETRY_REASON_CODES,
  buildHorizonRetryLogContext,
  formatHorizonRetryMessage,
  horizonRetryLogLevel,
  redactHorizonBaseUrl,
  LOG_CONTEXT_KEY_ALLOWLIST,
  isAllowedLogContextKey,
  RepeatWarningSampler,
  horizonRetrySampler,
  horizonRetrySampleKey,
  flushHorizonRetrySamples,
  formatRepeatSampleSummary,
  HORIZON_RETRY_SAMPLE_BURST,
  HORIZON_RETRY_SAMPLE_WINDOW_MS,
} from '../src/logger';

jest.mock('@actions/core');

const VALID_G_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const VALID_C_ADDRESS = 'C' + 'A'.repeat(55);
const HORIZON_URL = 'https://horizon.stellar.org';

/**
 * A syntactically valid 69-char muxed M-address shape used for redaction
 * tests. Note: this is not a checksum-valid StrKey — it is used only to
 * verify that the logger regex correctly identifies and redacts the shape.
 */
const VALID_M_ADDRESS = 'M' + 'A'.repeat(68);

/** Build a minimal valid ActionInputsLogRecord with sensible defaults. */
function makeInputs(overrides: Partial<ActionInputsLogRecord> = {}): ActionInputsLogRecord {
  return {
    horizonUrl: HORIZON_URL,
    horizonUrlFallback: '',
    rpcFallbackUrl: '',
    assetCode: 'USDC',
    assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    minXlmReserve: '1.5',
    minTrustlineLimit: '',
    stellarAddress: VALID_G_ADDRESS,
    failOnMissing: true,
    debugMode: false,
    horizonTimeoutMs: 15000,
    stickyComment: true,
    waitUntilFunded: false,
    waitUntilFundedTimeoutMs: 120000,
    waitUntilFundedIntervalMs: 5000,
    horizonCacheTtlMs: 60000,
    useCache: false,
    horizonMaxRequests: 0,
    retryMaxDelayMs: 30000,
    logInputs: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// redactStellarAddress
// ---------------------------------------------------------------------------
describe('redactStellarAddress', () => {
  it('masks a valid G-address to first-4…last-4', () => {
    expect(redactStellarAddress(VALID_G_ADDRESS)).toBe('GAAA...AWHF');
  });

  it('masks a valid C-address to first-4…last-4', () => {
    expect(redactStellarAddress(VALID_C_ADDRESS)).toBe('CAAA...AAAA');
  });

  it('masks a muxed M-address (69 chars) to first-4…last-4', () => {
    expect(redactStellarAddress(VALID_M_ADDRESS)).toBe('MAAA...AAAA');
  });

  it('does not mask a short M-prefix string that is not a real M-address', () => {
    // Only 10 chars starting with M — not an address shape
    const notAddr = 'MSHORTADDR';
    expect(redactStellarAddress(notAddr)).toBe(notAddr);
  });

  it('returns non-address strings unchanged', () => {
    expect(redactStellarAddress('not-an-address')).toBe('not-an-address');
  });

  it('returns an empty string unchanged', () => {
    expect(redactStellarAddress('')).toBe('');
  });

  it('trims before validating — a padded valid G-address is still redacted', () => {
    const padded = `  ${VALID_G_ADDRESS}  `;
    expect(redactStellarAddress(padded)).toBe('GAAA...AWHF');
  });
});

// ---------------------------------------------------------------------------
// redactHorizonUrl
// ---------------------------------------------------------------------------
describe('redactHorizonUrl', () => {
  it('preserves the base hostname', () => {
    const result = redactHorizonUrl(HORIZON_URL);
    expect(result).toContain('horizon.stellar.org');
  });

  it('masks an embedded G-address in the account path', () => {
    const url = `${HORIZON_URL}/accounts/${VALID_G_ADDRESS}`;
    const result = redactHorizonUrl(url);
    expect(result).not.toContain(VALID_G_ADDRESS);
    expect(result).toContain('GAAA...AWHF');
  });

  it('masks an embedded muxed M-address (69 chars) in the account path (Issue #460)', () => {
    const url = `${HORIZON_URL}/accounts/${VALID_M_ADDRESS}`;
    const result = redactHorizonUrl(url);
    expect(result).not.toContain(VALID_M_ADDRESS);
    expect(result).toContain('MAAA...AAAA');
  });

  it('returns empty string unchanged', () => {
    expect(redactHorizonUrl('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// redactString
// ---------------------------------------------------------------------------
describe('redactString', () => {
  it('masks embedded G-addresses in a free-form string', () => {
    const msg = `Account ${VALID_G_ADDRESS} was not found`;
    const result = redactString(msg);
    expect(result).not.toContain(VALID_G_ADDRESS);
    expect(result).toContain('GAAA...AWHF');
  });

  it('masks real muxed M-addresses (69-char shape) and webhook secrets in a free-form string (Issue #460)', () => {
    const muxed = VALID_M_ADDRESS; // 69-char M-address
    const msg = `account=${muxed}; webhook_secret=supersecret-123; X-TrustBridge-Signature: sha256=abc123def456`;
    const result = redactString(msg);
    expect(result).not.toContain(muxed);
    expect(result).not.toContain('supersecret-123');
    expect(result).not.toContain('abc123def456');
    expect(result).toContain('MAAA...AAAA');
  });

  it('masks multiple muxed M-addresses in the same string (Issue #460)', () => {
    const addr2 = 'M' + 'B'.repeat(68);
    const msg = `from=${VALID_M_ADDRESS} to=${addr2}`;
    const result = redactString(msg);
    expect(result).not.toContain(VALID_M_ADDRESS);
    expect(result).not.toContain(addr2);
    expect(result).toContain('MAAA...AAAA');
    expect(result).toContain('MBBB...BBBB');
  });

  it('leaves a string with no address unchanged', () => {
    const msg = 'No address here';
    expect(redactString(msg)).toBe(msg);
  });

  it('returns empty string unchanged', () => {
    expect(redactString('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Issue #460 — Muxed M-address redaction in all log output paths
// ---------------------------------------------------------------------------

describe('Issue #460 — Muxed M-address redaction', () => {
  beforeEach(() => {
    logger.setDebugMode(false);
    jest.clearAllMocks();
  });

  it('redactStellarAddress handles a 69-char M-address', () => {
    expect(redactStellarAddress(VALID_M_ADDRESS)).toBe('MAAA...AAAA');
  });

  it('redactString masks a 69-char M-address embedded in free-form text', () => {
    const msg = `muxed account ${VALID_M_ADDRESS} processed`;
    expect(redactString(msg)).not.toContain(VALID_M_ADDRESS);
    expect(redactString(msg)).toContain('MAAA...AAAA');
  });

  it('redactHorizonUrl masks a 69-char M-address in an /accounts/ path', () => {
    const url = `https://horizon.stellar.org/accounts/${VALID_M_ADDRESS}`;
    const result = redactHorizonUrl(url);
    expect(result).not.toContain(VALID_M_ADDRESS);
    expect(result).toContain('MAAA...AAAA');
  });

  it('logger.info does not leak muxed M-addresses in info output', () => {
    const infoSpy = core.info as jest.MockedFunction<typeof core.info>;
    logger.info(`Payment routing: muxed=${VALID_M_ADDRESS}`, { component: 'payment' });
    const [message] = infoSpy.mock.calls[0];
    expect(message).not.toContain(VALID_M_ADDRESS);
    expect(message).toContain('MAAA...AAAA');
  });

  it('logger.warn does not leak muxed M-addresses in warn output', () => {
    const warnSpy = core.warning as jest.MockedFunction<typeof core.warning>;
    logger.warn(`Muxed address used: ${VALID_M_ADDRESS}`);
    const [message] = warnSpy.mock.calls[0];
    expect(message).not.toContain(VALID_M_ADDRESS);
    expect(message).toContain('MAAA...AAAA');
  });

  it('logger.debug does not leak muxed M-addresses in debug output', () => {
    const debugSpy = core.debug as jest.MockedFunction<typeof core.debug>;
    logger.setDebugMode(true);
    logger.debug(`Fetching muxed account ${VALID_M_ADDRESS}`, { component: 'horizon' });
    const [message] = debugSpy.mock.calls[0];
    expect(message).not.toContain(VALID_M_ADDRESS);
    expect(message).toContain('MAAA...AAAA');
  });

  it('redactContext masks a muxed M-address in a stellarAddress context key', () => {
    const ctx = { component: 'test', stellarAddress: VALID_M_ADDRESS };
    const safe = redactContext(ctx);
    expect(safe?.stellarAddress).not.toContain(VALID_M_ADDRESS);
    expect(safe?.stellarAddress).toBe('MAAA...AAAA');
  });

  it('does not double-redact when G-address and M-address both appear', () => {
    const msg = `g=${VALID_G_ADDRESS} m=${VALID_M_ADDRESS}`;
    const result = redactString(msg);
    expect(result).not.toContain(VALID_G_ADDRESS);
    expect(result).not.toContain(VALID_M_ADDRESS);
    expect(result).toContain('GAAA...AWHF');
    expect(result).toContain('MAAA...AAAA');
  });
});

describe('logger redaction in output paths', () => {
  beforeEach(() => {
    logger.setDebugMode(false);
    jest.clearAllMocks();
  });

  it('redacts muxed addresses and webhook secret values from debug output', () => {
    const muxed = VALID_M_ADDRESS; // real 69-char M-address
    const debugSpy = core.debug as jest.MockedFunction<typeof core.debug>;
    logger.setDebugMode(true);
    logger.debug('Debug call with account data', {
      component: 'index',
      stellarAddress: muxed,
      webhookSecret: 'super-secret-value',
      url: `https://horizon.example.com/accounts/${VALID_G_ADDRESS}?webhookSecret=super-secret-value`,
    });

    expect(debugSpy).toHaveBeenCalledTimes(1);
    const [message] = debugSpy.mock.calls[0];
    expect(message).not.toContain(muxed);
    expect(message).not.toContain(VALID_G_ADDRESS);
    expect(message).not.toContain('super-secret-value');
    expect(message).toContain('MAAA...AAAA');
    expect(message).toContain('GAAA...AWHF');
  });

  it('redacts address-bearing URLs and error details in logger.error output', () => {
    const errorSpy = core.error as jest.MockedFunction<typeof core.error>;
    const rawUrl = `https://horizon.example.com/accounts/${VALID_G_ADDRESS}?webhookSecret=redacted-value`;
    const err = new Error(`fetch failed for ${rawUrl} and secret=high-value-secret`);

    logger.error('Gateway failure', { component: 'index', horizonUrl: rawUrl }, err);

    const [message] = errorSpy.mock.calls[0];
    expect(message).not.toContain(VALID_G_ADDRESS);
    expect(message).not.toContain('redacted-value');
    expect(message).not.toContain('high-value-secret');
    expect(message).toContain('GAAA...AWHF');
    expect(message).toContain('[REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// buildInputsLogRecord — field-level redaction
// ---------------------------------------------------------------------------
describe('buildInputsLogRecord', () => {
  it('redacts stellarAddress to first-4…last-4', () => {
    const record = buildInputsLogRecord(makeInputs({ stellarAddress: VALID_G_ADDRESS }));
    expect(record.stellarAddress).toBe('GAAA...AWHF');
    expect(record.stellarAddress).not.toBe(VALID_G_ADDRESS);
  });

  it('redacts assetIssuer (G-address) to first-4…last-4', () => {
    const issuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
    const record = buildInputsLogRecord(makeInputs({ assetIssuer: issuer }));
    expect(record.assetIssuer).toBe('GA5Z...KZVN');
    expect(record.assetIssuer).not.toBe(issuer);
  });

  it('redacts assetIssuer when it is a C-address (Soroban contract)', () => {
    const record = buildInputsLogRecord(makeInputs({ assetIssuer: VALID_C_ADDRESS }));
    expect(record.assetIssuer).toBe('CAAA...AAAA');
  });

  it('preserves horizonUrl hostname but masks any embedded address', () => {
    const record = buildInputsLogRecord(makeInputs({ horizonUrl: HORIZON_URL }));
    expect(record.horizonUrl).toContain('horizon.stellar.org');
  });

  it('redacts horizonUrlFallback when provided', () => {
    const fallback = `https://horizon-alt.stellar.org/accounts/${VALID_G_ADDRESS}`;
    const record = buildInputsLogRecord(makeInputs({ horizonUrlFallback: fallback }));
    expect(record.horizonUrlFallback).not.toContain(VALID_G_ADDRESS);
    expect(record.horizonUrlFallback).toContain('horizon-alt.stellar.org');
  });

  it('returns empty string for horizonUrlFallback when not set', () => {
    const record = buildInputsLogRecord(makeInputs({ horizonUrlFallback: '' }));
    expect(record.horizonUrlFallback).toBe('');
  });

  it('redacts rpcFallbackUrl free-form string for embedded addresses', () => {
    const rpc = `https://rpc.example.com/path?account=${VALID_G_ADDRESS}`;
    const record = buildInputsLogRecord(makeInputs({ rpcFallbackUrl: rpc }));
    expect(record.rpcFallbackUrl).not.toContain(VALID_G_ADDRESS);
  });

  it('returns empty string for rpcFallbackUrl when not set', () => {
    const record = buildInputsLogRecord(makeInputs({ rpcFallbackUrl: '' }));
    expect(record.rpcFallbackUrl).toBe('');
  });

  it('passes through non-sensitive scalar fields unchanged', () => {
    const inputs = makeInputs({
      assetCode: 'USDC',
      minXlmReserve: '2.5',
      failOnMissing: false,
      debugMode: true,
      horizonTimeoutMs: 30000,
      stickyComment: false,
      waitUntilFunded: true,
      waitUntilFundedTimeoutMs: 60000,
      waitUntilFundedIntervalMs: 10000,
      horizonCacheTtlMs: 0,
      useCache: true,
      logInputs: true,
    });
    const record = buildInputsLogRecord(inputs);
    expect(record.assetCode).toBe('USDC');
    expect(record.minXlmReserve).toBe('2.5');
    expect(record.failOnMissing).toBe(false);
    expect(record.debugMode).toBe(true);
    expect(record.horizonTimeoutMs).toBe(30000);
    expect(record.stickyComment).toBe(false);
    expect(record.waitUntilFunded).toBe(true);
    expect(record.waitUntilFundedTimeoutMs).toBe(60000);
    expect(record.waitUntilFundedIntervalMs).toBe(10000);
    expect(record.horizonCacheTtlMs).toBe(0);
    expect(record.useCache).toBe(true);
    expect(record.logInputs).toBe(true);
  });

  it('returns a plain JSON-serialisable object (no circular refs, no undefined)', () => {
    const record = buildInputsLogRecord(makeInputs({ maxRetries: 3, retryBaseDelayMs: 1000 }));
    expect(() => JSON.stringify(record)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(record));
    // Every key that exists in the record must survive the JSON round-trip
    for (const key of Object.keys(record) as (keyof ActionInputsLogRecord)[]) {
      expect(parsed[key]).not.toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// emitInputsLogRecord — integration with core.info
// ---------------------------------------------------------------------------
describe('emitInputsLogRecord', () => {
  let infoSpy: jest.MockedFunction<typeof core.info>;

  beforeEach(() => {
    infoSpy = core.info as jest.MockedFunction<typeof core.info>;
    infoSpy.mockClear();
  });

  it('calls core.info exactly once', () => {
    emitInputsLogRecord(makeInputs());
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });

  it('emits a message prefixed with [TrustBridge] action inputs:', () => {
    emitInputsLogRecord(makeInputs());
    const [message] = infoSpy.mock.calls[0];
    expect(message).toMatch(/^\[TrustBridge\] action inputs:/);
  });

  it('emits valid JSON after the prefix', () => {
    emitInputsLogRecord(makeInputs());
    const [message] = infoSpy.mock.calls[0];
    const jsonPart = message.replace('[TrustBridge] action inputs: ', '');
    expect(() => JSON.parse(jsonPart)).not.toThrow();
  });

  it('does not include any raw Stellar address in the emitted log line', () => {
    emitInputsLogRecord(makeInputs({ stellarAddress: VALID_G_ADDRESS }));
    const [message] = infoSpy.mock.calls[0];
    expect(message).not.toContain(VALID_G_ADDRESS);
  });

  it('does not include the raw asset issuer address in the emitted log line', () => {
    const issuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
    emitInputsLogRecord(makeInputs({ assetIssuer: issuer }));
    const [message] = infoSpy.mock.calls[0];
    expect(message).not.toContain(issuer);
  });

  it('emitted JSON contains expected redacted stellarAddress shape', () => {
    emitInputsLogRecord(makeInputs({ stellarAddress: VALID_G_ADDRESS }));
    const [message] = infoSpy.mock.calls[0];
    const parsed = JSON.parse(message.replace('[TrustBridge] action inputs: ', ''));
    expect(parsed.stellarAddress).toBe('GAAA...AWHF');
  });

  it('emitted JSON preserves non-sensitive fields', () => {
    emitInputsLogRecord(makeInputs({ assetCode: 'USDC', horizonTimeoutMs: 20000 }));
    const [message] = infoSpy.mock.calls[0];
    const parsed = JSON.parse(message.replace('[TrustBridge] action inputs: ', ''));
    expect(parsed.assetCode).toBe('USDC');
    expect(parsed.horizonTimeoutMs).toBe(20000);
  });
});

// ---------------------------------------------------------------------------
// Issue #225 — Token and Private Key Redaction Tests
// ---------------------------------------------------------------------------
describe('Issue #225 — Token and Private Key Redaction', () => {
  it('identifies sensitive secret keys', () => {
    expect(isSensitiveSecretKey('github_token')).toBe(true);
    expect(isSensitiveSecretKey('github_app_token')).toBe(true);
    expect(isSensitiveSecretKey('app_private_key')).toBe(true);
    expect(isSensitiveSecretKey('privateKey')).toBe(true);
    expect(isSensitiveSecretKey('secret')).toBe(true);
    expect(isSensitiveSecretKey('apiKey')).toBe(true);
    expect(isSensitiveSecretKey('assetCode')).toBe(false);
  });

  it('redacts PEM private keys embedded in free-form strings', () => {
    const raw = 'Error loading key: -----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0\n-----END RSA PRIVATE KEY----- occurred';
    const redacted = redactString(raw);
    expect(redacted).not.toContain('MIIEowIBAAKCAQEA0');
    expect(redacted).toContain('[REDACTED_PRIVATE_KEY]');
  });

  it('redacts sensitive token keys in LogContext to [REDACTED]', () => {
    const context = {
      component: 'AuthHelper',
      github_token: 'ghp_secretToken12345',
      github_app_token: 'ghs_installationToken67890',
      app_private_key: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
      user: 'alice',
    };

    const redacted = redactContext(context);
    expect(redacted?.github_token).toBe('[REDACTED]');
    expect(redacted?.github_app_token).toBe('[REDACTED]');
    expect(redacted?.app_private_key).toBe('[REDACTED]');
    expect(redacted?.user).toBe('alice');
  });

  it('redacts tokens embedded in nested context objects', () => {
    const context = {
      credentials: {
        token: 'secret-token-val',
        user: 'alice',
      },
    };

    const redacted = redactContext(context);
    expect((redacted?.credentials as Record<string, unknown>).token).toBe('[REDACTED]');
    expect((redacted?.credentials as Record<string, unknown>).user).toBe('alice');
  });
});


// ---------------------------------------------------------------------------
// Issue #697 — structured Horizon retry events
// ---------------------------------------------------------------------------
describe('structured Horizon retry events (Issue #697)', () => {
  const RAW_ADDRESSES = [VALID_G_ADDRESS, VALID_C_ADDRESS, VALID_M_ADDRESS];

  function retryEvent(
    overrides: Partial<HorizonRetryEvent> = {},
  ): HorizonRetryEvent {
    return {
      phase: 'scheduled',
      attempt: 0,
      maxAttempts: 4,
      status: 429,
      delayMs: 2000,
      capped: false,
      kind: 'http',
      endpointKind: 'primary',
      horizonUrl: HORIZON_URL,
      stellarAddress: VALID_G_ADDRESS,
      ...overrides,
    };
  }

  function emittedLines(): string[] {
    return [
      ...(core.debug as jest.Mock).mock.calls,
      ...(core.info as jest.Mock).mock.calls,
      ...(core.warning as jest.Mock).mock.calls,
    ].map((args) => String(args[0]));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    logger.setDebugMode(true);
    horizonRetrySampler.reset();
  });

  afterEach(() => {
    logger.setDebugMode(false);
  });

  it('emits only the documented fixed schema fields', () => {
    const context = buildHorizonRetryLogContext(retryEvent());
    const keys = Object.keys(context!).filter((k) => k !== 'component');
    expect(keys.sort()).toEqual([...HORIZON_RETRY_LOG_FIELDS].sort());
  });

  it('routes scheduled retries to debug and exhaustion to warning', () => {
    expect(horizonRetryLogLevel(retryEvent())).toBe('debug');
    expect(horizonRetryLogLevel(retryEvent({ phase: 'exhausted' }))).toBe('warning');

    logger.horizonRetry(retryEvent());
    expect(core.debug).toHaveBeenCalledTimes(1);
    expect(core.warning).not.toHaveBeenCalled();

    logger.horizonRetry(retryEvent({ phase: 'exhausted', attempt: 3 }));
    expect(core.warning).toHaveBeenCalledTimes(1);
    const line = (core.warning as jest.Mock).mock.calls[0][0] as string;
    expect(line).toContain('HORIZON_RETRIES_EXHAUSTED');
    expect(line).toContain('4/4 attempt(s)');
  });

  it('suppresses scheduled retry lines when debug mode is off', () => {
    logger.setDebugMode(false);
    logger.horizonRetry(retryEvent());
    expect(core.debug).not.toHaveBeenCalled();
  });

  it('includes attempt, status, delayMs and capped in scheduled events', () => {
    const context = buildHorizonRetryLogContext(
      retryEvent({ attempt: 2, status: 503, delayMs: 30000, capped: true }),
    )!;
    expect(context.attempt).toBe(2);
    expect(context.nextAttempt).toBe(3);
    expect(context.status).toBe(503);
    expect(context.delayMs).toBe(30000);
    expect(context.capped).toBe(true);
    expect(context.reasonCode).toBe(HORIZON_RETRY_REASON_CODES.scheduled);
  });

  it('logs very short capped delays accurately', () => {
    const context = buildHorizonRetryLogContext(retryEvent({ delayMs: 1, capped: true }))!;
    expect(context.delayMs).toBe(1);
    expect(context.capped).toBe(true);
  });

  it('tags wait-budget exhaustion with its own reason code', () => {
    const context = buildHorizonRetryLogContext(
      retryEvent({ phase: 'exhausted', reason: 'wait_budget' }),
    )!;
    expect(context.reasonCode).toBe(HORIZON_RETRY_REASON_CODES.wait_budget);
    expect(context.delayMs).toBe(0);
    expect(context.nextAttempt).toBeNull();
  });

  it.each([
    ['G-address', VALID_G_ADDRESS, 'GAAA...AWHF'],
    ['C-address', VALID_C_ADDRESS, 'CAAA...AAAA'],
    ['M-address', VALID_M_ADDRESS, 'MAAA...AAAA'],
  ])('redacts a %s passed as stellarAddress', (_label, raw, redacted) => {
    const context = buildHorizonRetryLogContext(retryEvent({ stellarAddress: raw }))!;
    expect(context.stellarAddress).toBe(redacted);
    logger.horizonRetry(retryEvent({ stellarAddress: raw }));
    logger.horizonRetry(retryEvent({ stellarAddress: raw, phase: 'exhausted' }));
    for (const line of emittedLines()) {
      expect(line).not.toContain(raw);
    }
  });

  it.each([
    ['G-address', VALID_G_ADDRESS],
    ['C-address', VALID_C_ADDRESS],
    ['M-address', VALID_M_ADDRESS],
  ])('redacts a %s embedded in the horizonUrl path and query', (_label, raw) => {
    logger.horizonRetry(
      retryEvent({
        horizonUrl: `https://horizon-testnet.stellar.org/accounts/${raw}?account=${raw}&api_key=secret`,
        phase: 'exhausted',
      }),
    );
    const lines = emittedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(raw);
    expect(lines[0]).not.toContain('secret');
    expect(lines[0]).not.toContain('?');
    expect(lines[0]).toContain('horizon-testnet.stellar.org');
  });

  it('keeps addresses out of every retry line for all address shapes at once', () => {
    for (const raw of RAW_ADDRESSES) {
      logger.horizonRetry(retryEvent({ stellarAddress: raw, horizonUrl: `${HORIZON_URL}/accounts/${raw}` }));
      logger.horizonRetry(retryEvent({ stellarAddress: raw, kind: 'network', status: 0, phase: 'exhausted' }));
    }
    const lines = emittedLines();
    expect(lines.length).toBe(RAW_ADDRESSES.length * 2);
    for (const line of lines) {
      for (const raw of RAW_ADDRESSES) {
        expect(line).not.toContain(raw);
      }
    }
  });

  it('formats summary messages without URLs or addresses', () => {
    expect(formatHorizonRetryMessage(retryEvent())).toBe('Horizon retry scheduled');
    expect(formatHorizonRetryMessage(retryEvent({ kind: 'timeout', status: 0 }))).toBe(
      'Horizon transport retry scheduled',
    );
    const exhausted = formatHorizonRetryMessage(
      retryEvent({ phase: 'exhausted', endpointKind: 'fallback', attempt: 1, maxAttempts: 2 }),
    );
    expect(exhausted).toBe(
      'Horizon retries exhausted (HORIZON_RETRIES_EXHAUSTED): HTTP 429 on fallback endpoint after 2/2 attempt(s)',
    );
  });

  it('redactHorizonBaseUrl strips credentials, query and fragment', () => {
    expect(redactHorizonBaseUrl('https://user:pw@horizon.example.com/?token=abc#frag')).toBe(
      'https://horizon.example.com',
    );
  });
});

// ---------------------------------------------------------------------------
// Issue #858 — structured field allowlist and redaction regression suite
// ---------------------------------------------------------------------------

describe('LOG_CONTEXT_KEY_ALLOWLIST / isAllowedLogContextKey (Issue #858)', () => {
  it('allows every key LogContext itself declares', () => {
    for (const key of ['component', 'stellarAddress', 'horizonUrl', 'reason_code', 'check']) {
      expect(isAllowedLogContextKey(key)).toBe(true);
    }
  });

  it('allows the generic operational metadata keys documented in docs/ARCHITECTURE.md', () => {
    for (const key of ['operation', 'status', 'count', 'durationMs']) {
      expect(isAllowedLogContextKey(key)).toBe(true);
    }
  });

  it('allows every address-bearing key with a defined redaction policy', () => {
    for (const key of ['assetIssuer', 'accountId', 'contractAddress', 'issuerContractId']) {
      expect(LOG_CONTEXT_KEY_ALLOWLIST.has(key)).toBe(true);
    }
  });

  it('rejects an arbitrary, unreviewed key', () => {
    expect(isAllowedLogContextKey('rawPayload')).toBe(false);
    expect(isAllowedLogContextKey('someFutureField')).toBe(false);
  });

  it('accepts an unreviewed key only when explicitly passed as extraAllowedKeys', () => {
    expect(isAllowedLogContextKey('pluginId', ['pluginId'])).toBe(true);
    expect(isAllowedLogContextKey('pluginId')).toBe(false);
  });
});

describe('redactContext strict mode (Issue #858)', () => {
  it('non-strict (default) mode keeps every key, exactly as before this change', () => {
    const result = redactContext({ component: 'checks', rawPayload: 'hello', count: 3 } as any);
    expect(result).toEqual({ component: 'checks', rawPayload: 'hello', count: 3 });
  });

  it('strict mode drops a key not on the allowlist', () => {
    const result = redactContext({ component: 'checks', rawPayload: 'hello' } as any, { strict: true });
    expect(result).toEqual({ component: 'checks' });
    expect('rawPayload' in result).toBe(false);
  });

  it('strict mode drops an unreviewed key even when its value contains an address (fail-closed, not just redacted)', () => {
    const result = redactContext(
      { component: 'checks', debugDump: VALID_G_ADDRESS } as any,
      { strict: true },
    );
    expect(result).toEqual({ component: 'checks' });
    expect(JSON.stringify(result)).not.toContain(VALID_G_ADDRESS);
  });

  it('strict mode still redacts (not just keeps) an allowed address-bearing key', () => {
    const result = redactContext({ stellarAddress: VALID_G_ADDRESS } as any, { strict: true });
    expect(result.stellarAddress).toBe(redactStellarAddress(VALID_G_ADDRESS));
  });

  it('strict mode honors extraAllowedKeys for a call-site-specific field', () => {
    const result = redactContext({ component: 'plugin-loader', pluginId: 'my-plugin' } as any, {
      strict: true,
      extraAllowedKeys: ['pluginId'],
    });
    expect(result).toEqual({ component: 'plugin-loader', pluginId: 'my-plugin' });
  });

  it('strict mode with no context and no options drops nothing (empty in, empty out)', () => {
    expect(redactContext({}, { strict: true })).toEqual({});
  });
});

describe('redactValue nested objects and arrays regression suite (Issue #858)', () => {
  it('redacts a secret nested three levels deep inside objects', () => {
    const result = redactContext({
      component: 'webhook',
      payload: { outer: { inner: { token: 'super-secret-value' } } },
    } as any);
    expect(JSON.stringify(result)).not.toContain('super-secret-value');
    expect((result as any).payload.outer.inner.token).toBe('[REDACTED]');
  });

  it('redacts an address nested inside an array of objects', () => {
    const result = redactContext({
      component: 'batch',
      rows: [{ stellarAddress: VALID_G_ADDRESS }, { stellarAddress: VALID_C_ADDRESS }],
    } as any);
    const rows = (result as any).rows;
    expect(rows[0].stellarAddress).toBe(redactStellarAddress(VALID_G_ADDRESS));
    expect(rows[1].stellarAddress).toBe(redactStellarAddress(VALID_C_ADDRESS));
    expect(JSON.stringify(result)).not.toContain(VALID_G_ADDRESS);
    expect(JSON.stringify(result)).not.toContain(VALID_C_ADDRESS);
  });

  it('redacts an array of plain strings containing an embedded address', () => {
    const result = redactContext({
      component: 'batch',
      lines: [`fetched ${VALID_G_ADDRESS} ok`, 'no address here'],
    } as any);
    const lines = (result as any).lines;
    expect(lines[0]).not.toContain(VALID_G_ADDRESS);
    expect(lines[1]).toBe('no address here');
  });

  it('redacts a token embedded inside an array nested inside an object', () => {
    const result = redactContext({
      component: 'webhook',
      payload: { attempts: [{ authorization: 'Bearer abc.def.ghi' }] },
    } as any);
    const attempts = (result as any).payload.attempts;
    expect(attempts[0].authorization).toBe('[REDACTED]');
  });

  it('handles an array of arrays (nested arrays, not just nested objects)', () => {
    const result = redactContext({
      component: 'batch',
      matrix: [[VALID_G_ADDRESS, 'ok'], ['ok', VALID_C_ADDRESS]],
    } as any);
    const matrix = (result as any).matrix;
    expect(matrix[0][0]).not.toContain(VALID_G_ADDRESS);
    expect(matrix[1][1]).not.toContain(VALID_C_ADDRESS);
  });

  it('caps recursion at MAX_REDACT_DEPTH instead of stack-overflowing on a very deep object', () => {
    let deep: any = { token: 'deepest-secret' };
    for (let i = 0; i < 50; i++) {
      deep = { nested: deep };
    }
    expect(() => redactContext({ component: 'x', deep } as any)).not.toThrow();
    const serialized = JSON.stringify(redactContext({ component: 'x', deep } as any));
    expect(serialized).not.toContain('deepest-secret');
    expect(serialized).toContain('REDACTED_DEPTH_EXCEEDED');
  });

  it('does not crash or hang on a self-referential (circular) object', () => {
    const circular: any = { component: 'x', token: 'secret-value' };
    circular.self = circular;

    let result: unknown;
    expect(() => {
      result = redactContext(circular);
    }).not.toThrow();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('secret-value');
    expect(serialized).toContain('CIRCULAR');
  });

  it('does not crash on a circular reference nested inside an array', () => {
    const node: any = { stellarAddress: VALID_G_ADDRESS };
    const arr: any[] = [node];
    node.siblings = arr; // array contains an object that references the array back

    expect(() => redactContext({ component: 'x', list: arr } as any)).not.toThrow();
  });

  it('does not falsely flag the same object referenced twice (a DAG, not a cycle) as circular', () => {
    const shared = { stellarAddress: VALID_G_ADDRESS };
    const result = redactContext({ component: 'x', a: shared, b: shared } as any);
    const a = (result as any).a;
    const b = (result as any).b;
    expect(a.stellarAddress).toBe(redactStellarAddress(VALID_G_ADDRESS));
    expect(b.stellarAddress).toBe(redactStellarAddress(VALID_G_ADDRESS));
    expect(JSON.stringify(result)).not.toContain('CIRCULAR');
  });

  it('strict mode + nested redaction compose: a dropped top-level key never reaches redactValue at all', () => {
    const result = redactContext(
      { component: 'x', rawDump: { token: 'secret', stellarAddress: VALID_G_ADDRESS } } as any,
      { strict: true },
    );
    expect(result).toEqual({ component: 'x' });
  });
});

// Issue #924: repeated Horizon retry warnings are sampled per failure pattern.
describe('Horizon retry warning sampling (Issue #924)', () => {
  const HORIZON = 'https://horizon.stellar.org';

  function exhausted(overrides: Partial<HorizonRetryEvent> = {}): HorizonRetryEvent {
    return {
      phase: 'exhausted',
      reason: 'max_retries',
      attempt: 3,
      maxAttempts: 4,
      status: 429,
      delayMs: 0,
      capped: false,
      kind: 'http',
      endpointKind: 'primary',
      horizonUrl: HORIZON,
      stellarAddress: VALID_G_ADDRESS,
      ...overrides,
    };
  }

  function warnings(): string[] {
    return (core.warning as jest.Mock).mock.calls.map((args) => String(args[0]));
  }

  function fakeClock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    horizonRetrySampler.reset();
    logger.setDebugMode(true);
  });

  afterEach(() => {
    logger.setDebugMode(false);
  });

  describe('RepeatWarningSampler', () => {
    it('emits the first burst events and suppresses the rest in one window', () => {
      const sampler = new RepeatWarningSampler<string>(3, 60_000, fakeClock().now);
      const decisions = [1, 2, 3, 4, 5].map(() => sampler.record('k', 'sample').emit);
      expect(decisions).toEqual([true, true, true, false, false]);
      const [summary] = sampler.flush();
      expect(summary).toMatchObject({ key: 'k', total: 5, suppressed: 2, sample: 'sample' });
    });

    it('closes a window after windowMs and returns its summary on the next event', () => {
      const clock = fakeClock();
      const sampler = new RepeatWarningSampler<string>(1, 1_000, clock.now);
      sampler.record('k', 'first');
      sampler.record('k', 'second');
      sampler.record('k', 'third');
      clock.advance(999);
      expect(sampler.record('k', 'still-open').rolled).toBeUndefined();
      clock.advance(1_000);
      const next = sampler.record('k', 'fresh-window');
      expect(next.emit).toBe(true);
      // first (emitted), then second, third and still-open are suppressed.
      expect(next.rolled).toMatchObject({ total: 4, suppressed: 3, sample: 'first' });
      // last in-window event ('still-open') was at +999ms.
      expect(next.rolled!.lastAt - next.rolled!.firstAt).toBe(999);
    });

    it('keeps first and last timestamps and counts for each window', () => {
      const clock = fakeClock(5_000);
      const sampler = new RepeatWarningSampler<string>(0, 10_000, clock.now);
      sampler.record('k', 'a');
      clock.advance(250);
      sampler.record('k', 'b');
      clock.advance(250);
      sampler.record('k', 'c');
      const [summary] = sampler.flush();
      expect(summary).toMatchObject({ total: 3, suppressed: 3, firstAt: 5_000, lastAt: 5_500 });
    });

    it('flush returns nothing when no event was suppressed, and clears state', () => {
      const sampler = new RepeatWarningSampler<string>(3, 60_000, fakeClock().now);
      sampler.record('a', 'x');
      sampler.record('b', 'y');
      expect(sampler.flush()).toEqual([]);
      expect(sampler.flush()).toEqual([]);
    });

    it('tracks keys independently', () => {
      const sampler = new RepeatWarningSampler<string>(1, 60_000, fakeClock().now);
      expect(sampler.record('a', '1').emit).toBe(true);
      expect(sampler.record('b', '2').emit).toBe(true);
      expect(sampler.record('a', '3').emit).toBe(false);
      expect(sampler.record('b', '4').emit).toBe(false);
    });

    it('rejects a negative burst and a non-positive window', () => {
      expect(() => new RepeatWarningSampler<string>(-1, 1_000)).toThrow(RangeError);
      expect(() => new RepeatWarningSampler<string>(1, 0)).toThrow(RangeError);
      expect(() => new RepeatWarningSampler<string>(1.5, 1_000)).toThrow(RangeError);
    });
  });

  it('defaults to the documented burst and window', () => {
    expect(HORIZON_RETRY_SAMPLE_BURST).toBe(3);
    expect(HORIZON_RETRY_SAMPLE_WINDOW_MS).toBe(60_000);
  });

  it('logs the first burst of identical exhaustion warnings and counts the rest', () => {
    for (let i = 0; i < 6; i += 1) {
      logger.horizonRetry(exhausted({ stellarAddress: undefined }));
    }
    expect(core.warning).toHaveBeenCalledTimes(3);
    expect(warnings().every((line) => line.includes('HORIZON_RETRIES_EXHAUSTED'))).toBe(true);

    expect(flushHorizonRetrySamples()).toBe(1);
    expect(core.warning).toHaveBeenCalledTimes(4);
    const summary = warnings()[3];
    expect(summary).toContain('Horizon retry warnings sampled (HORIZON_RETRIES_EXHAUSTED): 3 suppressed of 6');
    expect(summary).toContain('event=horizon_retry_sampled');
    expect(summary).toContain('suppressedCount=3');
    expect(summary).toContain('totalCount=6');
  });

  it('samples by failure pattern, so a different endpoint is not suppressed', () => {
    for (let i = 0; i < 5; i += 1) {
      logger.horizonRetry(exhausted());
    }
    logger.horizonRetry(exhausted({ endpointKind: 'fallback' }));
    // 3 primary + 1 fallback are logged in full.
    expect(core.warning).toHaveBeenCalledTimes(4);
    expect(warnings().filter((line) => line.includes('fallback'))).toHaveLength(1);
  });

  it('keeps the same key across different account addresses', () => {
    const keyA = horizonRetrySampleKey(exhausted({ stellarAddress: VALID_G_ADDRESS }));
    const keyB = horizonRetrySampleKey(exhausted({ stellarAddress: VALID_C_ADDRESS }));
    expect(keyA).toBe(keyB);
    expect(keyA).not.toContain(VALID_G_ADDRESS);
  });

  it('never samples scheduled retries, which stay at debug level', () => {
    for (let i = 0; i < 10; i += 1) {
      logger.horizonRetry(exhausted({ phase: 'scheduled', reason: undefined, attempt: i }));
    }
    expect(core.debug).toHaveBeenCalledTimes(10);
    expect(core.warning).not.toHaveBeenCalled();
    expect(flushHorizonRetrySamples()).toBe(0);
  });

  it('redacts addresses in the summary line and keeps the reason code', () => {
    const summary = formatRepeatSampleSummary({
      key: 'k',
      sample: buildHorizonRetryLogContext(exhausted({ stellarAddress: VALID_G_ADDRESS }))!,
      total: 4,
      suppressed: 1,
      firstAt: 0,
      lastAt: 0,
    });
    expect(summary.message).toContain('1 suppressed of 4');
    expect(JSON.stringify(summary.context)).not.toContain(VALID_G_ADDRESS);
    expect(summary.context.reasonCode).toBe('HORIZON_RETRIES_EXHAUSTED');
  });
});
