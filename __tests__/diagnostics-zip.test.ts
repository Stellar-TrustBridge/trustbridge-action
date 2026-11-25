/**
 * Optional diagnostics bundle (zip) writer — Issue #965.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import {
  buildDiagnosticsZip,
  buildZip,
  crc32,
  DIAGNOSTICS_ZIP_DEFAULT_MAX_BYTES,
  DIAGNOSTICS_ZIP_MANIFEST_SCHEMA,
  DiagnosticsConfig,
  DiagnosticsInputSnapshot,
  DiagnosticsZipError,
  parseDiagnosticsZipMaxBytes,
  redactBundleText,
  resolveDiagnosticsZipPath,
  writeDiagnosticsZip,
} from '../src/diagnostics';

const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const SEED = 'SAAPYAPTTRZMCUZFPG3G66V4ZMHTK4TWA6NS7U4F7Z3IMUD52EK4DDEH';

const INPUTS: DiagnosticsInputSnapshot = {
  horizonUrl: 'https://horizon.stellar.org',
  assetCode: 'USDC',
  assetIssuer: ISSUER,
  minXlmReserve: '1.5',
  horizonTimeoutMs: 15000,
  useCache: false,
  allowCrossNetworkFallback: false,
  debugMode: true,
};

const config = (overrides: Partial<DiagnosticsConfig> = {}): DiagnosticsConfig => ({ inputs: INPUTS, ...overrides });

/** Minimal zip reader so the tests verify the real bytes, not the writer's own bookkeeping. */
function readZip(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = buf.readUInt16LE(eocd + 10);
  let cd = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(cd)).toBe(0x02014b50);
    const method = buf.readUInt16LE(cd + 10);
    const crc = buf.readUInt32LE(cd + 16);
    const compSize = buf.readUInt32LE(cd + 20);
    const size = buf.readUInt32LE(cd + 24);
    const nameLen = buf.readUInt16LE(cd + 28);
    const local = buf.readUInt32LE(cd + 42);
    const name = buf.subarray(cd + 46, cd + 46 + nameLen).toString('utf8');
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    expect(data.length).toBe(size);
    expect(crc32(data)).toBe(crc);
    files.set(name, data);
    cd += 46 + nameLen;
  }
  return files;
}

let workspace: string;
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-diag-'));
});
afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('zip writer', () => {
  it('produces a valid archive whose entries round-trip with correct CRCs', () => {
    const big = Buffer.from('trustbridge '.repeat(500));
    const zip = buildZip([
      { name: 'b.txt', data: Buffer.from('hello') },
      { name: 'a/big.txt', data: big },
      { name: 'empty.txt', data: Buffer.alloc(0) },
    ]);
    const files = readZip(zip);
    expect([...files.keys()]).toEqual(['a/big.txt', 'b.txt', 'empty.txt']);
    expect(files.get('a/big.txt')!.equals(big)).toBe(true);
    expect(files.get('b.txt')!.toString()).toBe('hello');
    expect(zip.length).toBeLessThan(big.length); // highly repetitive data is deflated
  });

  it('matches the known CRC-32 check value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('rejects unsafe or duplicate entry names', () => {
    for (const name of ['../evil', '/abs', 'a\\b', 'a//b', '', 'a/./b']) {
      expect(() => buildZip([{ name, data: Buffer.from('x') }])).toThrow(DiagnosticsZipError);
    }
    expect(() => buildZip([{ name: 'a', data: Buffer.alloc(1) }, { name: 'a', data: Buffer.alloc(1) }])).toThrow(/duplicate/);
  });

  it('is deterministic: the same entries in any order give identical bytes', () => {
    const a = buildZip([{ name: 'x', data: Buffer.from('1') }, { name: 'y', data: Buffer.from('2') }]);
    const b = buildZip([{ name: 'y', data: Buffer.from('2') }, { name: 'x', data: Buffer.from('1') }]);
    expect(a.equals(b)).toBe(true);
  });
});

describe('buildDiagnosticsZip', () => {
  it('bundles a manifest, redacted inputs and the diagnostics block', () => {
    const { zip, entries, omitted } = buildDiagnosticsZip({
      config: config({ runInfo: { horizonStatusCode: 200, horizonLatencyMs: 42 } }),
      now: new Date('2026-01-02T03:04:05Z'),
      actionVersion: '1.2.3',
    });
    expect(entries).toEqual(['diagnostics.md', 'inputs.json', 'manifest.json', 'run-info.json']);
    expect(omitted).toEqual([]);

    const files = readZip(zip);
    const manifest = JSON.parse(files.get('manifest.json')!.toString());
    expect(manifest.schema).toBe(DIAGNOSTICS_ZIP_MANIFEST_SCHEMA);
    expect(manifest.generatedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(manifest.actionVersion).toBe('1.2.3');
    expect(manifest.redaction).toMatchObject({ addressesMasked: true, secretsIncluded: false });
    expect(manifest.files.map((f: { name: string }) => f.name)).toEqual(['diagnostics.md', 'inputs.json', 'run-info.json']);
    for (const f of manifest.files) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.bytes).toBe(files.get(f.name)!.length);
    }
    const inputs = JSON.parse(files.get('inputs.json')!.toString());
    expect(inputs.assetCode).toBe('USDC');
    expect(inputs.assetIssuer).toBe('GA5Z...KZVN');
  });

  it('never contains secrets, tokens or unmasked addresses anywhere in the archive', () => {
    const { zip } = buildDiagnosticsZip({
      config: config({
        inputs: { ...INPUTS, github_token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', webhookSecret: 'hunter2hunter2' },
        runInfo: { horizonError: `Horizon failed for ${ISSUER} using ${SEED} with Bearer abc123def456ghi789` },
      }),
      extraFiles: [{ name: 'log-tail.txt', content: `token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\naccount ${ISSUER}\nseed ${SEED}` }],
    });
    const text = [...readZip(zip).values()].map((b) => b.toString()).join('\n');
    for (const secret of [ISSUER, SEED, 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'hunter2hunter2', 'abc123def456ghi789']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('GA5Z...KZVN');
  });

  it('redactBundleText masks seeds, GitHub tokens and bearer credentials', () => {
    expect(redactBundleText(SEED)).toBe('[REDACTED_SECRET_SEED]');
    expect(redactBundleText('gho_0123456789abcdefghij0123456789')).toBe('[REDACTED_TOKEN]');
    expect(redactBundleText('Authorization: Bearer abcdefghijkl')).not.toContain('abcdefghijkl');
  });

  it('truncates a single oversized file and records that in the manifest', () => {
    const { zip } = buildDiagnosticsZip({
      config: config(),
      maxBytes: 50 * 1024 * 1024,
      extraFiles: [{ name: 'huge.log', content: `${'x'.repeat(100)}\n`.repeat(6000) }],
    });
    const files = readZip(zip);
    const text = files.get('extra/huge.log')!.toString();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(256 * 1024);
    expect(text).toContain('[truncated by trustbridge-action]');
    const manifest = JSON.parse(files.get('manifest.json')!.toString());
    expect(manifest.files.find((f: { name: string }) => f.name === 'extra/huge.log').truncated).toBe(true);
  });

  it('drops optional files, largest first, to respect the size cap and says so', () => {
    // Pseudo-random text does not compress, so the cap is genuinely exceeded.
    const noisy = Array.from({ length: 2000 }, (_, i) => createHash('sha256').update(String(i)).digest('hex')).join('\n');
    const { zip, entries, omitted } = buildDiagnosticsZip({
      config: config(),
      maxBytes: 8 * 1024,
      extraFiles: [{ name: 'noisy.log', content: noisy }],
    });
    expect(zip.length).toBeLessThanOrEqual(8 * 1024);
    expect(omitted).toContain('extra/noisy.log');
    expect(entries).toContain('inputs.json');
    expect(entries).toContain('manifest.json');
    const manifest = JSON.parse(readZip(zip).get('manifest.json')!.toString());
    expect(manifest.omitted).toEqual(expect.arrayContaining([{ name: 'extra/noisy.log', reason: 'size_cap' }]));
  });

  it('fails with too_large when even the mandatory files cannot fit', () => {
    try {
      buildDiagnosticsZip({ config: config(), maxBytes: 200 });
      throw new Error('expected failure');
    } catch (err) {
      expect(err).toBeInstanceOf(DiagnosticsZipError);
      expect((err as DiagnosticsZipError).reason).toBe('too_large');
      expect((err as Error).message).toMatch(/diagnostics_zip_max_bytes/);
    }
  });

  it('stays fast on a huge unbroken blob by bounding line length before redaction', () => {
    const started = Date.now();
    const { zip } = buildDiagnosticsZip({
      config: config(),
      extraFiles: [{ name: 'blob.txt', content: 'x'.repeat(2 * 1024 * 1024) }],
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(readZip(zip).get('extra/blob.txt')!.toString()).toContain('[line truncated]');
  });

  it('rejects invalid extra file names', () => {
    for (const name of ['../x', 'a/b', '.hidden', '', 'x'.repeat(65)]) {
      expect(() => buildDiagnosticsZip({ config: config(), extraFiles: [{ name, content: 'x' }] })).toThrow(DiagnosticsZipError);
    }
  });
});

describe('parseDiagnosticsZipMaxBytes', () => {
  it('defaults when empty and accepts values inside the range', () => {
    expect(parseDiagnosticsZipMaxBytes(undefined)).toEqual({ ok: true, value: DIAGNOSTICS_ZIP_DEFAULT_MAX_BYTES });
    expect(parseDiagnosticsZipMaxBytes('  ')).toEqual({ ok: true, value: DIAGNOSTICS_ZIP_DEFAULT_MAX_BYTES });
    expect(parseDiagnosticsZipMaxBytes('65536')).toEqual({ ok: true, value: 65536 });
  });

  it.each(['abc', '-5', '1.5', '10', '999999999999', '1e6'])('rejects %s with a descriptive message', (raw) => {
    const result = parseDiagnosticsZipMaxBytes(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/diagnostics_zip_max_bytes/);
  });
});

describe('resolveDiagnosticsZipPath', () => {
  it('resolves relative paths inside the workspace', () => {
    expect(resolveDiagnosticsZipPath('out/diag.zip', workspace)).toBe(path.join(workspace, 'out', 'diag.zip'));
  });

  it.each([
    ['', /empty/],
    ['diag.txt', /must end in "\.zip"/],
    ['../escape.zip', /inside GITHUB_WORKSPACE/],
    ['/etc/passwd.zip', /inside GITHUB_WORKSPACE/],
    ['a/../../escape.zip', /inside GITHUB_WORKSPACE/],
    ['bad\0name.zip', /NUL/],
  ])('rejects %j', (input, message) => {
    expect(() => resolveDiagnosticsZipPath(input, workspace)).toThrow(message);
  });

  it('rejects a path that already is a directory and a symlinked escape', () => {
    fs.mkdirSync(path.join(workspace, 'dir.zip'));
    expect(() => resolveDiagnosticsZipPath('dir.zip', workspace)).toThrow(/directory/);

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-outside-'));
    try {
      fs.symlinkSync(outside, path.join(workspace, 'link'));
      expect(() => resolveDiagnosticsZipPath('link/diag.zip', workspace)).toThrow(/symlink/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('writeDiagnosticsZip', () => {
  const base = () => ({ config: config(), workspaceRoot: workspace, now: new Date('2026-01-01T00:00:00Z') });

  it('writes the archive atomically and reports what it contains', () => {
    const result = writeDiagnosticsZip({ ...base(), outputPath: 'artifacts/diag.zip' });
    expect(result).toMatchObject({ status: 'written', reason: 'written' });
    const target = path.join(workspace, 'artifacts', 'diag.zip');
    expect(result.path).toBe(target);
    expect(result.bytes).toBe(fs.statSync(target).size);
    expect([...readZip(fs.readFileSync(target)).keys()]).toEqual(result.entries);
    expect(fs.readdirSync(path.join(workspace, 'artifacts'))).toEqual(['diag.zip']); // no temp file left behind
  });

  it('is idempotent: a second identical call leaves the file untouched', () => {
    writeDiagnosticsZip({ ...base(), outputPath: 'diag.zip' });
    const target = path.join(workspace, 'diag.zip');
    const first = fs.statSync(target).mtimeMs;
    const again = writeDiagnosticsZip({ ...base(), outputPath: 'diag.zip' });
    expect(again).toMatchObject({ status: 'unchanged', reason: 'unchanged' });
    expect(fs.statSync(target).mtimeMs).toBe(first);
  });

  it('rewrites when the content changes', () => {
    writeDiagnosticsZip({ ...base(), outputPath: 'diag.zip' });
    const changed = writeDiagnosticsZip({ ...base(), outputPath: 'diag.zip', config: config({ runInfo: { horizonStatusCode: 503 } }) });
    expect(changed.status).toBe('written');
  });

  it('fails with invalid_path and writes nothing for traversal and bad extensions', () => {
    for (const outputPath of ['../x.zip', 'x.tar']) {
      const result = writeDiagnosticsZip({ ...base(), outputPath });
      expect(result).toMatchObject({ status: 'failed', reason: 'invalid_path' });
      expect(result.message).toMatch(/diagnostics_zip_path/);
    }
    expect(fs.readdirSync(workspace)).toEqual([]);
    expect(fs.existsSync(path.join(path.dirname(workspace), 'x.zip'))).toBe(false);
  });

  it('fails with too_large and leaves no partial file', () => {
    const result = writeDiagnosticsZip({ ...base(), outputPath: 'diag.zip', maxBytes: 200 });
    expect(result).toMatchObject({ status: 'failed', reason: 'too_large' });
    expect(fs.existsSync(path.join(workspace, 'diag.zip'))).toBe(false);
  });

  it('surfaces filesystem failures as write_failed with an actionable message and no leftovers', () => {
    // A regular file where a directory is needed makes mkdir fail on every platform and user (including root).
    fs.writeFileSync(path.join(workspace, 'blocker'), 'x');
    const result = writeDiagnosticsZip({ ...base(), outputPath: 'blocker/diag.zip' });
    expect(result).toMatchObject({ status: 'failed', reason: 'write_failed' });
    expect(result.message).toMatch(/Could not write diagnostics bundle/);
    expect(fs.readdirSync(workspace)).toEqual(['blocker']);
  });

  it('keeps secrets out of failure messages too', () => {
    fs.writeFileSync(path.join(workspace, 'blocker'), 'x');
    const result = writeDiagnosticsZip({ ...base(), outputPath: 'blocker/diag.zip', config: config({ inputs: { ...INPUTS, github_token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' } }) });
    expect(result.message).not.toContain('ghp_');
  });
});
