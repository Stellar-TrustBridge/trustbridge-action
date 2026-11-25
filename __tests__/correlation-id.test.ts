/**
 * Tests for Issue #904 — per-run correlation id propagated into structured
 * logs, the metrics summary, the diagnostics block and the optional comment
 * footer.
 *
 * Covers:
 * - Happy path: a generated id is attached to every structured log line and
 *   rendered in the comment footer / diagnostics block.
 * - Happy path: a valid TRUSTBRIDGE_CORRELATION_ID is propagated unchanged.
 * - Failure path: a malformed propagated id is rejected (never echoed) and a
 *   fresh id is generated instead.
 * - Failure path: an id that would be altered by redaction (looks like a
 *   secret or a Stellar address) is rejected.
 * - Redaction safety: secrets and addresses in the same log line are still
 *   redacted while the correlation id survives verbatim.
 */

import * as core from '@actions/core';
import {
  CORRELATION_ID_ENV,
  CORRELATION_ID_PREFIX,
  buildDiagnosticsBlock,
  formatCorrelationFooter,
  formatCorrelationMarker,
  generateCorrelationId,
  getCorrelationId,
  initCorrelationId,
  isValidCorrelationId,
  parseCorrelationMarker,
  resetCorrelationId,
  validateCorrelationId,
} from '../src/diagnostics';
import {
  CORRELATION_ID_LOG_KEY,
  formatStructuredLog,
  getLogCorrelationId,
  logger,
} from '../src/logger';
import { MetricsCollector } from '../src/metrics';
import { formatCommentBody } from '../src/comment';
import type { ValidationResult } from '../src/checks';

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  setOutput: jest.fn(),
  setFailed: jest.fn(),
  getInput: jest.fn(),
}));

const G_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

const result: ValidationResult = {
  valid: true,
  accountFunded: true,
  trustlineExists: true,
  xlmBalance: '10.0',
  xlmReserveMet: true,
  assetBalance: '1.0',
  assetBalanceMet: true,
  checks: [{ passed: true, label: 'Account funded', detail: 'ok' }],
};

const commentConfig = {
  stellarAddress: G_ADDRESS,
  horizonUrl: 'https://horizon-testnet.stellar.org',
  assetCode: 'USDC',
  assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  minXlmReserve: 1.5,
};

afterEach(() => {
  resetCorrelationId();
});

describe('generateCorrelationId / validateCorrelationId', () => {
  it('generates prefixed, valid, unique ids', () => {
    const a = generateCorrelationId();
    const b = generateCorrelationId();
    expect(a.startsWith(CORRELATION_ID_PREFIX)).toBe(true);
    expect(a).toMatch(/^tb-[0-9a-f]{16}$/);
    expect(isValidCorrelationId(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('rejects empty, too-short, oversized and malformed values with stable reasons', () => {
    expect(validateCorrelationId('')).toMatch(/non-empty/);
    expect(validateCorrelationId(undefined)).toMatch(/non-empty/);
    expect(validateCorrelationId('abc')).toMatch(/8-64 characters/);
    expect(validateCorrelationId('a'.repeat(65))).toMatch(/8-64 characters/);
    expect(validateCorrelationId('run id with spaces')).toMatch(/may only contain/);
    expect(validateCorrelationId('<script>alert(1)</script>')).toMatch(/may only contain/);
  });

  it('rejects ids that the redaction policy would alter (secrets / addresses)', () => {
    expect(validateCorrelationId(G_ADDRESS)).toMatch(/would be redacted/);
    expect(validateCorrelationId('token=abcdef123456')).toBeDefined();
  });
});

describe('initCorrelationId', () => {
  it('generates an id and propagates it to the logger when no env id is set', () => {
    const init = initCorrelationId({});
    expect(init.source).toBe('generated');
    expect(init.rejectedReason).toBeUndefined();
    expect(getCorrelationId()).toBe(init.correlationId);
    expect(getLogCorrelationId()).toBe(init.correlationId);
  });

  it('reuses a valid propagated TRUSTBRIDGE_CORRELATION_ID', () => {
    const init = initCorrelationId({ [CORRELATION_ID_ENV]: 'wave-run-42.attempt_1' });
    expect(init).toEqual({ correlationId: 'wave-run-42.attempt_1', source: 'env' });
  });

  it('failure path: rejects a malformed propagated id without echoing it', () => {
    const init = initCorrelationId({ [CORRELATION_ID_ENV]: 'bad id; rm -rf /' });
    expect(init.source).toBe('generated');
    expect(init.rejectedReason).toMatch(/may only contain/);
    expect(init.rejectedReason).not.toContain('rm -rf');
    expect(init.correlationId).toMatch(/^tb-[0-9a-f]{16}$/);
  });

  it('failure path: rejects a propagated id that looks like a Stellar address', () => {
    const init = initCorrelationId({ [CORRELATION_ID_ENV]: G_ADDRESS });
    expect(init.source).toBe('generated');
    expect(init.rejectedReason).toMatch(/would be redacted/);
    expect(init.correlationId).not.toBe(G_ADDRESS);
  });

  it('is idempotent within a run', () => {
    const first = initCorrelationId({});
    const second = initCorrelationId({ [CORRELATION_ID_ENV]: 'another-id-123' });
    expect(second.correlationId).toBe(first.correlationId);
  });
});

describe('logger propagation', () => {
  it('omits correlation_id before initCorrelationId (output unchanged)', () => {
    const line = formatStructuredLog('hello', { component: 'x' });
    expect(line).not.toContain(CORRELATION_ID_LOG_KEY);
  });

  it('adds correlation_id to every structured log line once set', () => {
    const { correlationId } = initCorrelationId({});
    const line = formatStructuredLog('hello', { component: 'x', reason_code: 'R', check: 'c' });
    const json = JSON.parse(line.slice(line.indexOf('{')));
    expect(json[CORRELATION_ID_LOG_KEY]).toBe(correlationId);

    logger.info('structured info', { component: 'test' });
    const infoCalls = (core.info as jest.Mock).mock.calls;
    expect(infoCalls[infoCalls.length - 1]?.[0]).toContain(
      `${CORRELATION_ID_LOG_KEY}=${correlationId}`,
    );
  });

  it('keeps redacting secrets and addresses on the same line', () => {
    const { correlationId } = initCorrelationId({});
    const line = formatStructuredLog(`checked ${G_ADDRESS}`, {
      github_token: 'ghp_supersecretvalue',
      stellarAddress: G_ADDRESS,
    });
    expect(line).toContain(correlationId);
    expect(line).not.toContain('ghp_supersecretvalue');
    expect(line).not.toContain(G_ADDRESS);
  });
});

describe('metrics summary', () => {
  it('carries the correlation id as a top-level field, never as a tag', () => {
    const metrics = new MetricsCollector();
    expect(metrics.getSummary().correlationId).toBeUndefined();
    metrics.setCorrelationId('tb-0123456789abcdef');
    metrics.recordMetric('x', 1, 'count');
    const summary = metrics.getSummary();
    expect(summary.correlationId).toBe('tb-0123456789abcdef');
    expect(summary.metrics[0]!.tags).toBeUndefined();
  });
});

describe('comment footer and diagnostics block', () => {
  const id = 'tb-0123456789abcdef';

  it('renders marker + visible footer when correlationFooter is on', () => {
    const body = formatCommentBody(result, { ...commentConfig, correlationId: id, correlationFooter: true });
    expect(body).toContain(formatCorrelationMarker(id));
    expect(body).toContain(formatCorrelationFooter(id));
    expect(parseCorrelationMarker(body)).toBe(id);
  });

  it('omits the footer by default, keeping the body unchanged', () => {
    const withoutId = formatCommentBody(result, commentConfig);
    const withIdOff = formatCommentBody(result, { ...commentConfig, correlationId: id });
    expect(withIdOff).not.toContain(id);
    expect(withIdOff.replace(/timestamp=\d+/, '')).toBe(withoutId.replace(/timestamp=\d+/, ''));
  });

  it('failure path: never renders an invalid id', () => {
    const body = formatCommentBody(result, {
      ...commentConfig,
      correlationId: 'not valid!',
      correlationFooter: true,
    });
    expect(body).not.toContain('Correlation ID');
    expect(formatCorrelationFooter(G_ADDRESS)).toBe('');
    expect(formatCorrelationMarker(undefined)).toBe('');
  });

  it('shows the id in the expert diagnostics block', () => {
    const block = buildDiagnosticsBlock({
      correlationId: id,
      inputs: {
        horizonUrl: 'https://horizon.stellar.org',
        assetCode: 'USDC',
        assetIssuer: G_ADDRESS,
        minXlmReserve: '1',
        horizonTimeoutMs: 1000,
        useCache: false,
        allowCrossNetworkFallback: false,
        debugMode: true,
      },
    });
    expect(block).toContain(`**Correlation ID:** \`${id}\``);
  });
});
