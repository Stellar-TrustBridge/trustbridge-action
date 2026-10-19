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

