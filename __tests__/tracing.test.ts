/**
 * Tests for opt-in OpenTelemetry tracing (Issue #299).
 *
 * Validates:
 * 1. Tracing is off by default (zero overhead).
 * 2. When enabled, spans are collected with correct names and attributes.
 * 3. PII redaction: addresses masked, URLs stripped, secrets blocked.
 * 4. The three instrumented phases (horizon, comment, webhook) produce correct spans.
 * 5. Errors set status=ERROR and include the error message.
 * 6. Export paths work (log, console, none) — no collector required.
 * 7. emitTraceSummary does not throw.
 *
 * Validate with: npm test -- --testPathPattern 'metrics|index|tracing'
 */

import {
  isTracingEnabled,
  getExporterType,
  getTraceSpans,
  clearTraceSpans,
  withSpan,
  withSpanSync,
  redactSpanAttributes,
  exportSpan,
  traceHorizonFetch,
  traceCommentPost,
  traceWebhookDeliver,
  traceActionRun,
  emitTraceSummary,
  TraceSpan,
} from '../src/tracing';

// ---------------------------------------------------------------------------
// Test setup: isolate env vars per test
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  clearTraceSpans();
  // Reset env to original before each test
  for (const key of ['OTEL_TRACES_ENABLED', 'OTEL_TRACES_EXPORTER', 'OTEL_EXPORTER_OTLP_ENDPOINT']) {
    delete process.env[key];
  }
});

afterAll(() => {
  Object.assign(process.env, ORIGINAL_ENV);
});

function enableTracing(exporter: 'log' | 'console' | 'none' | 'otlp' = 'none') {
  process.env['OTEL_TRACES_ENABLED'] = 'true';
  process.env['OTEL_TRACES_EXPORTER'] = exporter;
}

// ---------------------------------------------------------------------------
// Default state: tracing OFF
// ---------------------------------------------------------------------------

describe('tracing defaults', () => {
  it('isTracingEnabled returns false when env var is unset', () => {
    expect(isTracingEnabled()).toBe(false);
  });

  it('isTracingEnabled returns false when OTEL_TRACES_ENABLED=false', () => {
    process.env['OTEL_TRACES_ENABLED'] = 'false';
    expect(isTracingEnabled()).toBe(false);
  });

  it('isTracingEnabled returns true for OTEL_TRACES_ENABLED=true', () => {
    process.env['OTEL_TRACES_ENABLED'] = 'true';
    expect(isTracingEnabled()).toBe(true);
  });

  it('isTracingEnabled returns true for OTEL_TRACES_ENABLED=1', () => {
    process.env['OTEL_TRACES_ENABLED'] = '1';
    expect(isTracingEnabled()).toBe(true);
  });

  it('getExporterType defaults to "log"', () => {
    expect(getExporterType()).toBe('log');
  });

  it('getExporterType returns "none" for OTEL_TRACES_EXPORTER=none', () => {
    process.env['OTEL_TRACES_EXPORTER'] = 'none';
    expect(getExporterType()).toBe('none');
  });

  it('getExporterType returns "console" for OTEL_TRACES_EXPORTER=console', () => {
    process.env['OTEL_TRACES_EXPORTER'] = 'console';
    expect(getExporterType()).toBe('console');
  });

  it('getExporterType returns "otlp" for OTEL_TRACES_EXPORTER=otlp', () => {
    process.env['OTEL_TRACES_EXPORTER'] = 'otlp';
    expect(getExporterType()).toBe('otlp');
  });

  it('getTraceSpans returns empty array initially', () => {
    expect(getTraceSpans()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// withSpan: zero overhead when tracing is disabled
// ---------------------------------------------------------------------------

describe('withSpan when tracing is disabled', () => {
  it('calls fn and returns its result without recording a span', async () => {
    const result = await withSpan({ name: 'test.op' }, async () => 42);
    expect(result).toBe(42);
    expect(getTraceSpans()).toHaveLength(0);
  });

  it('propagates errors without recording a span when disabled', async () => {
    await expect(
      withSpan({ name: 'test.error' }, async () => { throw new Error('boom'); })
    ).rejects.toThrow('boom');
    expect(getTraceSpans()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// withSpan: span collection when tracing is enabled
// ---------------------------------------------------------------------------

describe('withSpan when tracing is enabled (exporter=none)', () => {
  beforeEach(() => enableTracing('none'));

  it('records a span after a successful async operation', async () => {
    await withSpan({ name: 'horizon.fetch_account' }, async () => 'ok');
    const spans = getTraceSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('horizon.fetch_account');
    expect(spans[0].status).toBe('OK');
    expect(spans[0].error).toBeUndefined();
  });

  it('span has a valid startTimeMs and durationMs ≥ 0', async () => {
    await withSpan({ name: 'test.timing' }, async () => 'result');
    const span = getTraceSpans()[0];
    expect(span.startTimeMs).toBeGreaterThan(0);
    expect(span.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records status=ERROR and error message when fn throws', async () => {
    await expect(
      withSpan({ name: 'test.fail' }, async () => { throw new Error('network down'); })
    ).rejects.toThrow('network down');

    const spans = getTraceSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status).toBe('ERROR');
    expect(spans[0].error).toBe('network down');
  });

  it('attaches provided attributes to the span', async () => {
    await withSpan(
      { name: 'test.attrs', attributes: { endpoint: 'primary', retries: 2 } },
      async () => 'ok',
    );
    const span = getTraceSpans()[0];
    expect(span.attributes['endpoint']).toBe('primary');
    expect(span.attributes['retries']).toBe(2);
  });

  it('records parentName when provided', async () => {
    await withSpan(
      { name: 'child.op', parentName: 'trustbridge.run' },
      async () => 'ok',
    );
    const span = getTraceSpans()[0];
    expect(span.parentName).toBe('trustbridge.run');
  });

  it('accumulates spans across multiple calls', async () => {
    await withSpan({ name: 'op.1' }, async () => 'a');
    await withSpan({ name: 'op.2' }, async () => 'b');
    await withSpan({ name: 'op.3' }, async () => 'c');
    expect(getTraceSpans()).toHaveLength(3);
  });

  it('clearTraceSpans resets the store', async () => {
    await withSpan({ name: 'op' }, async () => 'x');
    clearTraceSpans();
    expect(getTraceSpans()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// withSpanSync
// ---------------------------------------------------------------------------

describe('withSpanSync when tracing is enabled', () => {
  beforeEach(() => enableTracing('none'));

  it('records a span after a synchronous operation', () => {
    const result = withSpanSync({ name: 'sync.op' }, () => 99);
    expect(result).toBe(99);
    const spans = getTraceSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('sync.op');
    expect(spans[0].status).toBe('OK');
  });

  it('records status=ERROR when sync fn throws', () => {
    expect(() => withSpanSync({ name: 'sync.fail' }, () => { throw new Error('sync error'); }))
      .toThrow('sync error');
    const spans = getTraceSpans();
    expect(spans[0].status).toBe('ERROR');
    expect(spans[0].error).toBe('sync error');
  });
});

// ---------------------------------------------------------------------------
// PII redaction
// ---------------------------------------------------------------------------

describe('redactSpanAttributes', () => {
  const FULL_ADDRESS = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

  it('masks a full Stellar G-address to first-4…last-4', () => {
    const attrs = redactSpanAttributes({ stellar_address: FULL_ADDRESS });
    expect(attrs['stellar_address']).not.toBe(FULL_ADDRESS);
    expect(attrs['stellar_address']).toMatch(/^[GC][A-Z2-7]{3}\.{3}[A-Z2-7]{4}$/);
  });

  it('full address does not appear in any attribute value', () => {
    const attrs = redactSpanAttributes({
      stellar_address: FULL_ADDRESS,
      label: `Account ${FULL_ADDRESS} checked`,
    });
    expect(JSON.stringify(attrs)).not.toContain(FULL_ADDRESS);
  });

  it('redacts github_token to [REDACTED]', () => {
    const attrs = redactSpanAttributes({ github_token: 'ghp_secret123' });
    expect(attrs['github_token']).toBe('[REDACTED]');
  });

  it('redacts webhook_secret to [REDACTED]', () => {
    const attrs = redactSpanAttributes({ webhook_secret: 'my-shared-secret' });
    expect(attrs['webhook_secret']).toBe('[REDACTED]');
  });

  it('redacts token key to [REDACTED]', () => {
    const attrs = redactSpanAttributes({ token: 'secret-value' });
    expect(attrs['token']).toBe('[REDACTED]');
  });

  it('does not redact non-secret string values', () => {
    const attrs = redactSpanAttributes({ comment_action: 'create', retries: 2 });
    expect(attrs['comment_action']).toBe('create');
    expect(attrs['retries']).toBe(2);
  });

  it('passes through boolean attributes unchanged', () => {
    const attrs = redactSpanAttributes({ valid: true, cached: false });
    expect(attrs['valid']).toBe(true);
    expect(attrs['cached']).toBe(false);
  });

  it('passes through numeric attributes unchanged', () => {
    const attrs = redactSpanAttributes({ duration_ms: 150, retries: 3 });
    expect(attrs['duration_ms']).toBe(150);
    expect(attrs['retries']).toBe(3);
  });

  it('strips path from URL-keyed attributes', () => {
    const attrs = redactSpanAttributes({
      horizon_url: 'https://horizon.stellar.org/accounts/GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    });
    // Path should not contain the account address or full path
    expect(attrs['horizon_url'] as string).not.toContain(FULL_ADDRESS);
  });
});

// ---------------------------------------------------------------------------
// Instrumented phase helpers
// ---------------------------------------------------------------------------

const ADDRESS = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

describe('traceHorizonFetch', () => {
  beforeEach(() => enableTracing('none'));

  it('records a horizon.fetch_account span on success', async () => {
    await traceHorizonFetch('https://horizon.stellar.org', ADDRESS, async () => ({ ok: true }));
    const spans = getTraceSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('horizon.fetch_account');
    expect(spans[0].status).toBe('OK');
  });

  it('horizon.fetch_account span does not contain full Stellar address', async () => {
    await traceHorizonFetch('https://horizon.stellar.org', ADDRESS, async () => 'result');
    const span = getTraceSpans()[0];
    expect(JSON.stringify(span.attributes)).not.toContain(ADDRESS);
  });

  it('records status=ERROR when Horizon fetch throws', async () => {
    await expect(
      traceHorizonFetch('https://horizon.stellar.org', ADDRESS, async () => {
        throw new Error('connection refused');
      })
    ).rejects.toThrow('connection refused');
    expect(getTraceSpans()[0].status).toBe('ERROR');
    expect(getTraceSpans()[0].error).toBe('connection refused');
  });
});

describe('traceCommentPost', () => {
  beforeEach(() => enableTracing('none'));

  it('records a github.post_comment span on success', async () => {
    await traceCommentPost(42, 'create', async () => ({ url: 'https://github.com/issue/42#comment-1' }));
    const spans = getTraceSpans();
    expect(spans[0].name).toBe('github.post_comment');
    expect(spans[0].status).toBe('OK');
    expect(spans[0].attributes['issue_number']).toBe(42);
    expect(spans[0].attributes['comment_action']).toBe('create');
  });

  it('handles null issue_number (workflow_dispatch context)', async () => {
    await traceCommentPost(null, 'skip', async () => undefined);
    const span = getTraceSpans()[0];
    expect(span.attributes['issue_number']).toBe(0);
    expect(span.attributes['comment_action']).toBe('skip');
  });
});

describe('traceWebhookDeliver', () => {
  beforeEach(() => enableTracing('none'));

  it('records a webhook.deliver span on success', async () => {
    await traceWebhookDeliver('https://dashboard.example.com/webhook', 'hmac', async () => ({ sent: true }));
    const spans = getTraceSpans();
    expect(spans[0].name).toBe('webhook.deliver');
    expect(spans[0].status).toBe('OK');
    expect(spans[0].attributes['auth_mode']).toBe('hmac');
  });

  it('webhook.deliver span redacts any embedded Stellar address in webhook URL', async () => {
    const urlWithAddress = `https://dashboard.example.com/webhook/GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`;
    await traceWebhookDeliver(urlWithAddress, 'hmac', async () => undefined);
    const span = getTraceSpans()[0];
    // Full 56-char address should be redacted in the URL attribute
    expect(String(span.attributes['webhook_url'])).not.toContain('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');
  });
});

describe('traceActionRun', () => {
  beforeEach(() => enableTracing('none'));

  it('records a trustbridge.run span', async () => {
    await traceActionRun(ADDRESS, async () => 'done');
    const spans = getTraceSpans();
    expect(spans[0].name).toBe('trustbridge.run');
    expect(spans[0].status).toBe('OK');
  });

  it('trustbridge.run span does not contain full Stellar address', async () => {
    await traceActionRun(ADDRESS, async () => 'done');
    const span = getTraceSpans()[0];
    expect(JSON.stringify(span.attributes)).not.toContain(ADDRESS);
  });
});

// ---------------------------------------------------------------------------
// exportSpan: paths that don't need a real collector
// ---------------------------------------------------------------------------

describe('exportSpan', () => {
  const mockSpan: TraceSpan = {
    name: 'test.span',
    startTimeMs: Date.now(),
    durationMs: 10,
    status: 'OK',
    attributes: { key: 'value' },
  };

  it('does not throw for exporter=none', () => {
    process.env['OTEL_TRACES_EXPORTER'] = 'none';
    expect(() => exportSpan(mockSpan)).not.toThrow();
  });

  it('does not throw for exporter=log', () => {
    process.env['OTEL_TRACES_EXPORTER'] = 'log';
    expect(() => exportSpan(mockSpan)).not.toThrow();
  });

  it('does not throw for exporter=console', () => {
    process.env['OTEL_TRACES_EXPORTER'] = 'console';
    // Suppress console output in tests
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => exportSpan(mockSpan)).not.toThrow();
    consoleSpy.mockRestore();
  });

  it('does not throw for exporter=otlp when endpoint is unset', () => {
    process.env['OTEL_TRACES_EXPORTER'] = 'otlp';
    delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    expect(() => exportSpan(mockSpan)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// emitTraceSummary
// ---------------------------------------------------------------------------

describe('emitTraceSummary', () => {
  it('does not throw when tracing is disabled', () => {
    expect(() => emitTraceSummary()).not.toThrow();
  });

  it('does not throw when tracing is enabled and spans exist', async () => {
    enableTracing('none');
    await withSpan({ name: 'test.span' }, async () => 'ok');
    expect(() => emitTraceSummary()).not.toThrow();
  });

  it('does not throw when tracing is enabled but no spans collected', () => {
    enableTracing('none');
    expect(() => emitTraceSummary()).not.toThrow();
  });
});
