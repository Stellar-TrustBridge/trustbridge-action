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

  // Issue #550-era gap called out by Issue #551: the function documents
  // "Fails open on 403 / API errors" (the classic response when the provided
  // GITHUB_TOKEN lacks `actions: read` on a private repo), but only network
  // rejections were covered. Each HTTP 403 surface below must resolve to
  // `null` without throwing and without leaking the token anywhere.
  describe('Actions API returns 403 (Issue #551)', () => {
    const OLD_ENV_403 = process.env;

    beforeEach(() => {
      jest.resetModules();
      process.env = { ...OLD_ENV_403 };
      process.env.GITHUB_REPOSITORY = 'owner/repo';
      process.env.GITHUB_RUN_ID = '123';
    });

    afterEach(() => {
      process.env = OLD_ENV_403;
      jest.restoreAllMocks();
    });

    function fetchResponse(status: number, body: unknown = {}): Response {
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    }

    it('returns null when listing workflow runs is 403 (token lacks actions:read)', async () => {
      const { discoverPreviousValidationArtifact } = require('../src/delta');

      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(fetchResponse(403, { message: 'Forbidden' }));

      const result = await discoverPreviousValidationArtifact('ghp_test');

      expect(result).toBeNull();
      // Exactly one call: the runs list. No artifact/download calls follow.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![0]).toContain('/actions/runs?');
    });

    it('skips a run whose artifacts listing is 403 and keeps scanning (fail open per run)', async () => {
      const { discoverPreviousValidationArtifact } = require('../src/delta');

      // Two prior runs. The first returns 403 on its artifacts listing (e.g.
      // a run from another workflow with restricted visibility); the second
      // has no matching artifact. The loop must continue past the 403.
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(
          fetchResponse(200, {
            workflow_runs: [{ id: 111 }, { id: 222 }],
          }),
        )
        .mockResolvedValueOnce(fetchResponse(403, { message: 'Forbidden' }))
        .mockResolvedValueOnce(fetchResponse(200, { artifacts: [] }));

      const result = await discoverPreviousValidationArtifact('ghp_test');

      expect(result).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const calledUrls = fetchMock.mock.calls.map(([url]) => String(url));
      expect(calledUrls[1]).toContain('/actions/runs/111/artifacts');
      expect(calledUrls[2]).toContain('/actions/runs/222/artifacts');
    });

    it('continues scanning when an artifact download is 403', async () => {
      const { discoverPreviousValidationArtifact } = require('../src/delta');

      // Run 111 has a matching artifact whose download endpoint answers 403
      // (insufficient token scope for download). The loop must not throw and
      // must not attempt any further fetch for that run.
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(
          fetchResponse(200, { workflow_runs: [{ id: 111 }] }),
        )
        .mockResolvedValueOnce(
          fetchResponse(200, {
            artifacts: [{ name: 'validation-json', id: 42, expired: false }],
          }),
        )
        .mockResolvedValueOnce(fetchResponse(403, { message: 'Forbidden' }));

      const result = await discoverPreviousValidationArtifact('ghp_test');

      expect(result).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(String(fetchMock.mock.calls[2]![0])).toContain(
        '/actions/artifacts/42/zip',
      );
    });

    it('recovers and returns the artifact when a later run succeeds after a 403', async () => {
      const { discoverPreviousValidationArtifact } = require('../src/delta');

      // Prior run 111 artifacts listing is 403; run 222 exposes a valid
      // validation.json artifact. Auto-discovery must still find it.
      const artifactPayload = {
        schemaVersion: VALIDATION_ARTIFACT_SCHEMA_VERSION,
        timestamp: '2026-09-01T00:00:00.000Z',
        address,
        asset: { code: 'USDC', issuer },
        checks: [
          { label: 'Account funded', passed: true, detail: 'ok' },
          { label: 'USDC trustline', passed: false, detail: 'missing' },
        ],
        balances: { xlm: '5.0000000' },
      };

      // Minimal stored (uncompressed) ZIP wrapping validation.json.
      const makeStoredZip = (file: string, content: string): Buffer => {
        const name = Buffer.from(file, 'utf8');
        const data = Buffer.from(content, 'utf8');
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(0, 8); // stored
        header.writeUInt32LE(data.length, 18);
        header.writeUInt32LE(data.length, 22);
        header.writeUInt16LE(name.length, 26);
        header.writeUInt16LE(0, 28);
        return Buffer.concat([header, name, data]);
      };

      const zipBytes = makeStoredZip(
        'validation.json',
        JSON.stringify(artifactPayload),
      );
      const zipArrayBuffer = zipBytes.buffer.slice(
        zipBytes.byteOffset,
        zipBytes.byteOffset + zipBytes.byteLength,
      ) as ArrayBuffer;

      const downloadResponse = {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () => zipArrayBuffer,
      } as unknown as Response;

      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(
          fetchResponse(200, { workflow_runs: [{ id: 111 }, { id: 222 }] }),
        )
        .mockResolvedValueOnce(fetchResponse(403, { message: 'Forbidden' }))
        .mockResolvedValueOnce(
          fetchResponse(200, {
            artifacts: [{ name: 'validation-json', id: 42, expired: false }],
          }),
        )
        .mockResolvedValueOnce(downloadResponse);

      const result = await discoverPreviousValidationArtifact('ghp_test');

      expect(result).not.toBeNull();
      expect(result!.checks).toHaveLength(2);
      expect(result!.checks.map((c: { label: string }) => c.label)).toEqual([
        'Account funded',
        'USDC trustline',
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('never includes the token in any outgoing header echo or result', async () => {
      const { discoverPreviousValidationArtifact } = require('../src/delta');

      const token = 'ghp_super_secret_token_value';
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(fetchResponse(403, { message: 'Forbidden' }));

      const result = await discoverPreviousValidationArtifact(token);

      expect(result).toBeNull();
      // The Authorization header must still be present for the API call...
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${token}`,
      );
      // ...but the token must never appear in the returned payload.
      expect(JSON.stringify(result)).not.toContain(token);
    });
  });
});
