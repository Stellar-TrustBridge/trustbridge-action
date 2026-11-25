/**
 * Tests for Issue #905 — max rendered length for custom comment templates.
 *
 * Covers:
 * - Happy path: a normal template renders unchanged under the cap.
 * - Failure path: an "expansion bomb" (small file, many long placeholders)
 *   fails with TEMPLATE_OUTPUT_TOO_LARGE.
 * - Failure path: too many placeholders fails with
 *   TEMPLATE_TOO_MANY_PLACEHOLDERS before any substitution.
 * - comment.ts omits the partial with a warning naming the error code
 *   instead of posting an oversized comment.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as core from '@actions/core';
import {
  interpolateTemplate,
  loadCommentTemplate,
  MAX_TEMPLATE_BYTES,
  MAX_TEMPLATE_PLACEHOLDERS,
  MAX_TEMPLATE_RENDERED_BYTES,
  TemplateRenderError,
} from '../src/template';
import type { TemplateContext } from '../src/template';
import { formatCommentBody, MAX_COMMENT_LENGTH } from '../src/comment';
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

const ctx: TemplateContext = {
  account: 'GAAA…WHF',
  asset: 'USDC',
  issuer: 'GA5Z…KZVN',
  network: 'testnet',
  horizon: 'https://horizon-testnet.stellar.org/' + 'a'.repeat(200),
  status: '✅ ready',
  locale: 'en',
};

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected function to throw');
}

describe('interpolateTemplate rendered-output cap', () => {
  it('happy path: renders a normal template unchanged', () => {
    const out = interpolateTemplate('Asset {{asset}} on {{network}} — {{status}}', ctx);
    expect(out).toBe('Asset USDC on testnet — ✅ ready');
  });

  it('allows output exactly at the cap', () => {
    const out = interpolateTemplate('x'.repeat(100), ctx, { maxOutputBytes: 100 });
    expect(out).toHaveLength(100);
  });

  it('failure path: expansion bomb fails with TEMPLATE_OUTPUT_TOO_LARGE', () => {
    // 150 placeholders (under the placeholder cap) × ~240-byte value ≈ 36 KB.
    const bomb = '{{horizon}}'.repeat(150);
    expect(Buffer.byteLength(bomb)).toBeLessThan(MAX_TEMPLATE_BYTES);
    const err = catchError(() => interpolateTemplate(bomb, ctx));
    expect(err).toBeInstanceOf(TemplateRenderError);
    expect((err as TemplateRenderError).code).toBe('TEMPLATE_OUTPUT_TOO_LARGE');
    expect((err as Error).message).toContain(String(MAX_TEMPLATE_RENDERED_BYTES));
  });

  it('failure path: too many placeholders fails with TEMPLATE_TOO_MANY_PLACEHOLDERS', () => {
    const many = '{{asset}}'.repeat(MAX_TEMPLATE_PLACEHOLDERS + 1);
    const err = catchError(() => interpolateTemplate(many, ctx));
    expect(err).toBeInstanceOf(TemplateRenderError);
    expect((err as TemplateRenderError).code).toBe('TEMPLATE_TOO_MANY_PLACEHOLDERS');
    expect((err as Error).message).toMatch(/^\[TEMPLATE_TOO_MANY_PLACEHOLDERS\]/);
  });

  it('honours a custom maxOutputBytes and ignores malformed values', () => {
    expect(() => interpolateTemplate('{{asset}}{{asset}}', ctx, { maxOutputBytes: 5 })).toThrow(
      /TEMPLATE_OUTPUT_TOO_LARGE/,
    );
    expect(interpolateTemplate('{{asset}}', ctx, { maxOutputBytes: Number.NaN })).toBe('USDC');
    expect(interpolateTemplate('{{asset}}', ctx, { maxOutputBytes: -1 })).toBe('USDC');
  });
});

describe('loadCommentTemplate / formatCommentBody with an expansion bomb', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-template-limit-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('loadCommentTemplate throws the stable error code', () => {
    fs.writeFileSync(path.join(root, 'bomb.md'), '{{horizon}}'.repeat(150));
    expect(() => loadCommentTemplate('bomb.md', ctx, root)).toThrow(/TEMPLATE_OUTPUT_TOO_LARGE/);
  });

  it('formatCommentBody omits the partial and warns instead of posting an oversized body', () => {
    const prev = process.env['GITHUB_WORKSPACE'];
    process.env['GITHUB_WORKSPACE'] = root;
    try {
      fs.writeFileSync(path.join(root, 'bomb.md'), '{{locale:resultsHeading}}'.repeat(20) + '{{horizon}}'.repeat(150));
      const result: ValidationResult = {
        valid: true,
        accountFunded: true,
        trustlineExists: true,
        xlmBalance: '10',
        xlmReserveMet: true,
        assetBalance: '1',
        assetBalanceMet: true,
        checks: [{ passed: true, label: 'Account funded', detail: 'ok' }],
      };
      const body = formatCommentBody(result, {
        stellarAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        horizonUrl: 'https://horizon-testnet.stellar.org/' + 'a'.repeat(200),
        assetCode: 'USDC',
        assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        minXlmReserve: 1.5,
        customCommentTemplatePath: 'bomb.md',
      });
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(MAX_COMMENT_LENGTH);
      const warnings = (core.warning as jest.Mock).mock.calls.map((c) => String(c[0]));
      expect(warnings.some((w) => w.includes('TEMPLATE_OUTPUT_TOO_LARGE'))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env['GITHUB_WORKSPACE'];
      else process.env['GITHUB_WORKSPACE'] = prev;
    }
  });
});
