import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  VALIDATION_ARTIFACT_SCHEMA_VERSION,
  buildValidationArtifact,
  computeValidationDelta,
  formatDeltaMarkdown,
  hashAddressForPrivacy,
  loadPreviousValidationArtifact,
  privacyMaskAddress,
  stripSensitiveFields,
} from '../src/delta';
import { ValidationResult } from '../src/checks';
import { writeValidationJson } from '../src/outputs';

const fundedPassing: ValidationResult = {
  valid: true,
  accountFunded: true,
  trustlineExists: true,
  xlmBalance: '5.0000000',
  xlmReserveMet: true,
  checks: [
    { passed: true, label: 'Account funded', detail: 'ok' },
    { passed: true, label: 'USDC trustline', detail: 'ok' },
    { passed: true, label: 'XLM reserve', detail: 'ok' },
  ],
};

const address = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const issuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

describe('computeValidationDelta', () => {
  it('returns null when there is no previous artifact (first run)', () => {
    expect(computeValidationDelta(null, fundedPassing)).toBeNull();
    expect(computeValidationDelta(undefined, fundedPassing)).toBeNull();
    expect(computeValidationDelta({ checks: [] }, fundedPassing)).toBeNull();
  });

  it('detects improved (newly passed) checks', () => {
    const previous = {
      timestamp: '2026-07-01T00:00:00.000Z',
      checks: [
        { label: 'Account funded', passed: true },
        { label: 'USDC trustline', passed: false },
        { label: 'XLM reserve', passed: false },
      ],
    };
    const current = {
      checks: [
        { label: 'Account funded', passed: true },
        { label: 'USDC trustline', passed: true },
        { label: 'XLM reserve', passed: true },
      ],
    };

    const delta = computeValidationDelta(previous, current);
    expect(delta).toEqual({
      previousTimestamp: '2026-07-01T00:00:00.000Z',
      newlyPassed: ['USDC trustline', 'XLM reserve'],
      newlyFailed: [],
      unchanged: ['Account funded'],
      improved: true,
      regressed: false,
    });
  });

  it('detects regressed (newly failed) checks', () => {
    const previous = {
      timestamp: '2026-07-01T00:00:00.000Z',
      checks: [
        { label: 'Account funded', passed: true },
        { label: 'USDC trustline', passed: true },
        { label: 'XLM reserve', passed: true },
      ],
    };
    const current = {
      checks: [
        { label: 'Account funded', passed: true },
        { label: 'USDC trustline', passed: false },
        { label: 'XLM reserve', passed: true },
      ],
    };

    const delta = computeValidationDelta(previous, current);
    expect(delta).toEqual({
      previousTimestamp: '2026-07-01T00:00:00.000Z',
      newlyPassed: [],
      newlyFailed: ['USDC trustline'],
      unchanged: ['Account funded', 'XLM reserve'],
      improved: false,
      regressed: true,
    });
  });

  it('reports unchanged when all check statuses match', () => {
    const previous = {
      checks: fundedPassing.checks.map((c) => ({ label: c.label, passed: c.passed })),
    };
    const delta = computeValidationDelta(previous, fundedPassing);
    expect(delta).toEqual({
      previousTimestamp: undefined,
      newlyPassed: [],
      newlyFailed: [],
      unchanged: ['Account funded', 'USDC trustline', 'XLM reserve'],
      improved: false,
      regressed: false,
    });
  });
});

describe('formatDeltaMarkdown', () => {
  it('returns empty string when delta is absent', () => {
    expect(formatDeltaMarkdown(null)).toBe('');
    expect(formatDeltaMarkdown(undefined)).toBe('');
  });

  it('renders newly passed and newly failed lines', () => {
    const md = formatDeltaMarkdown({
      previousTimestamp: '2026-07-01T12:00:00.000Z',
      newlyPassed: ['Account funded'],
      newlyFailed: ['XLM reserve'],
      unchanged: ['USDC trustline'],
      improved: true,
      regressed: true,
    });
    expect(md).toContain('### Delta vs previous run');
    expect(md).toContain('Newly passed:** Account funded');
    expect(md).toContain('Newly failed:** XLM reserve');
    expect(md).toContain('Unchanged: 1 check(s)');
    expect(md).toContain('Regression detected');
  });

  it('renders unchanged-only message', () => {
    const md = formatDeltaMarkdown({
      newlyPassed: [],
      newlyFailed: [],
      unchanged: ['Account funded', 'USDC trustline', 'XLM reserve'],
      improved: false,
      regressed: false,
    });
    expect(md).toContain('No check status changes');
  });
});

describe('loadPreviousValidationArtifact', () => {
  it('returns null for empty path or missing file without throwing', () => {
    expect(loadPreviousValidationArtifact('')).toBeNull();
    expect(loadPreviousValidationArtifact('does-not-exist-validation.json')).toBeNull();
  });

  it('loads a valid previous artifact and strips sensitive keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-delta-'));
    const filePath = path.join(dir, 'previous.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        timestamp: '2026-07-01T00:00:00.000Z',
        address,
        github_token: 'ghp_SHOULD_NEVER_LEAK',
        token: 'secret',
        checks: [
          { label: 'Account funded', passed: false, detail: 'missing' },
          { label: 'USDC trustline', passed: false, detail: 'missing' },
          { label: 'XLM reserve', passed: false, detail: 'missing' },
        ],
        balances: { xlm: '0' },
      }),
      'utf-8',
    );

    const loaded = loadPreviousValidationArtifact(filePath);
    expect(loaded).not.toBeNull();
    expect(loaded!.checks).toHaveLength(3);
    expect(loaded!.timestamp).toBe('2026-07-01T00:00:00.000Z');
    expect(JSON.stringify(loaded)).not.toContain('ghp_SHOULD_NEVER_LEAK');
    expect(JSON.stringify(loaded)).not.toContain('github_token');
    expect(JSON.stringify(loaded)).not.toContain('"token"');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null for invalid JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-delta-bad-'));
    const filePath = path.join(dir, 'bad.json');
    fs.writeFileSync(filePath, '{not-json', 'utf-8');
    expect(loadPreviousValidationArtifact(filePath)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('privacy and redaction', () => {
  it('hashes addresses in privacy mode', () => {
    const hashed = hashAddressForPrivacy(address);
    expect(hashed).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(privacyMaskAddress(address, true)).toBe(hashed);
    expect(privacyMaskAddress(address, false)).toBe('GAAA...AWHF');
  });

  it('buildValidationArtifact never includes tokens and respects privacy_mode', () => {
    const artifact = buildValidationArtifact({
      result: fundedPassing,
      stellarAddress: address,
      assetCode: 'USDC',
      assetIssuer: issuer,
      horizonUrl: `https://horizon.stellar.org/accounts/${address}`,
      privacyMode: true,
      delta: {
        newlyPassed: ['USDC trustline'],
        newlyFailed: [],
        unchanged: ['Account funded', 'XLM reserve'],
        improved: true,
        regressed: false,
      },
      timestamp: '2026-07-28T00:00:00.000Z',
    });

    expect(artifact.schemaVersion).toBe(VALIDATION_ARTIFACT_SCHEMA_VERSION);
    expect(artifact.address).toMatch(/^sha256:/);
    expect(artifact.asset.issuer).toMatch(/^sha256:/);
    expect(artifact.address).not.toBe(address);
    expect(JSON.stringify(artifact)).not.toMatch(/github_token|ghp_|Authorization/i);
    expect(artifact.delta?.newlyPassed).toEqual(['USDC trustline']);
    expect(artifact.privacyMode).toBe(true);
  });

  it('stripSensitiveFields removes known secret keys', () => {
    const cleaned = stripSensitiveFields({
      ok: 1,
      github_token: 'x',
      nested: { api_key: 'y', keep: true },
    });
    expect(cleaned).toEqual({ ok: 1, nested: { keep: true } });
  });
});

describe('writeValidationJson', () => {
  it('writes artifact with delta to disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-write-'));
    const outPath = path.join(dir, 'validation.json');
    const previous = {
      timestamp: '2026-07-01T00:00:00.000Z',
      checks: [
        { label: 'Account funded', passed: false },
        { label: 'USDC trustline', passed: false },
        { label: 'XLM reserve', passed: false },
      ],
    };
    const delta = computeValidationDelta(previous, fundedPassing);

    const written = writeValidationJson({
      result: fundedPassing,
      stellarAddress: address,
      assetCode: 'USDC',
      assetIssuer: issuer,
      horizonUrl: 'https://horizon.stellar.org',
      outputPath: outPath,
      delta,
      privacyMode: false,
      workspaceRoot: dir,
    });

    expect(fs.existsSync(outPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    expect(parsed.delta.newlyPassed).toEqual([
      'Account funded',
      'USDC trustline',
      'XLM reserve',
    ]);
    expect(parsed.delta.regressed).toBe(false);
    expect(written.delta?.improved).toBe(true);
    expect(JSON.stringify(parsed)).not.toMatch(/github_token|Authorization/i);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('extractFromZip', () => {
  it('returns null for an empty buffer', () => {
    const { extractFromZip } = require('../src/delta');
    expect(extractFromZip(Buffer.alloc(0), 'test.json')).toBeNull();
  });

  it('returns null when target file is not found', () => {
    const { extractFromZip } = require('../src/delta');
    expect(extractFromZip(Buffer.from('not a zip'), 'test.json')).toBeNull();
  });
});

describe('discoverPreviousValidationArtifact', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('returns null when GITHUB_REPOSITORY is missing', async () => {
    const { discoverPreviousValidationArtifact } = require('../src/delta');
    delete process.env.GITHUB_REPOSITORY;
    process.env.GITHUB_RUN_ID = '123';
    const result = await discoverPreviousValidationArtifact('ghp_test');
    expect(result).toBeNull();
  });

  it('returns null when GITHUB_RUN_ID is missing', async () => {
    const { discoverPreviousValidationArtifact } = require('../src/delta');
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    delete process.env.GITHUB_RUN_ID;
    const result = await discoverPreviousValidationArtifact('ghp_test');
    expect(result).toBeNull();
  });

  it('returns null when github token is empty', async () => {
    const { discoverPreviousValidationArtifact } = require('../src/delta');
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    process.env.GITHUB_RUN_ID = '123';
    const result = await discoverPreviousValidationArtifact('');
    expect(result).toBeNull();
  });

  it('returns null on API error (fail open)', async () => {
    const { discoverPreviousValidationArtifact } = require('../src/delta');

    process.env.GITHUB_REPOSITORY = 'owner/repo';
    process.env.GITHUB_RUN_ID = '123';

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('API unavailable'));

    try {
      const result = await discoverPreviousValidationArtifact('ghp_test');
      expect(result).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
