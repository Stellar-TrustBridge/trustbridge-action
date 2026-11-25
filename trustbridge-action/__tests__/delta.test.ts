import { describe, it, expect } from 'vitest';
import { createDeltaZip, type DeltaArtifact } from '../src/delta';

/**
 * Minimal ZIP central-directory reader used to assert file membership
 * without pulling in an extra dependency. It scans the End Of Central
 * Directory record and walks the central directory entries, returning the
 * list of stored file names.
 */
function listZipEntries(zip: Buffer): string[] {
  const eocdSignature = 0x06054b50;
  let eocdOffset = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === eocdSignature) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Not a valid ZIP archive: missing end of central directory');
  }

  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  let offset = zip.readUInt32LE(eocdOffset + 16);
  const names: string[] = [];

  for (let i = 0; i < entryCount; i++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Corrupt ZIP central directory entry');
    }
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    names.push(zip.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return names;
}

function readZipEntry(zip: Buffer, name: string): string {
  const eocdSignature = 0x06054b50;
  let eocdOffset = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === eocdSignature) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Not a valid ZIP archive: missing end of central directory');
  }

  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  let offset = zip.readUInt32LE(eocdOffset + 16);

  for (let i = 0; i < entryCount; i++) {
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const entryName = zip.toString('utf8', offset + 46, offset + 46 + nameLength);

    if (entryName === name) {
      const localNameLength = zip.readUInt16LE(localOffset + 26);
      const localExtraLength = zip.readUInt16LE(localOffset + 28);
      const compressedSize = zip.readUInt32LE(offset + 20);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      return zip.toString('utf8', dataStart, dataStart + compressedSize);
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  throw new Error(`Entry not found in ZIP: ${name}`);
}

function makeArtifact(overrides: Partial<DeltaArtifact> = {}): DeltaArtifact {
  return {
    id: 'delta-1',
    createdAt: '2024-01-01T00:00:00.000Z',
    files: {
      'summary.json': JSON.stringify({ ok: true }),
      'report.md': '# Delta report\n',
    },
    ...overrides,
  };
}

describe('delta ZIP packaging', () => {
  it('includes the expected files inside the delta ZIP', () => {
    const zip = createDeltaZip(makeArtifact());
    const entries = listZipEntries(zip);

    expect(entries).toContain('summary.json');
    expect(entries).toContain('report.md');
    expect(entries).toContain('manifest.json');
  });

  it('preserves file contents in the packaged ZIP', () => {
    const artifact = makeArtifact();
    const zip = createDeltaZip(artifact);

    expect(readZipEntry(zip, 'summary.json')).toBe(artifact.files['summary.json']);
    expect(readZipEntry(zip, 'report.md')).toBe(artifact.files['report.md']);
  });

  it('applies privacy_mode redactions as documented', () => {
    const artifact = makeArtifact({
      privacyMode: true,
      files: {
        'summary.json': JSON.stringify({
          ok: true,
          email: 'user@example.com',
          token: 'secret-token',
        }),
        'report.md': 'Contact user@example.com for details.\n',
      },
    });

    const zip = createDeltaZip(artifact);
    const summary = readZipEntry(zip, 'summary.json');
    const report = readZipEntry(zip, 'report.md');

    expect(summary).not.toContain('user@example.com');
    expect(summary).not.toContain('secret-token');
    expect(summary).toContain('[REDACTED]');
    expect(report).not.toContain('user@example.com');
    expect(report).toContain('[REDACTED]');
  });

  it('fails gracefully on an empty delta input', () => {
    expect(() => createDeltaZip(makeArtifact({ files: {} }))).toThrow(
      /empty|no files/i,
    );
  });

  it('fails gracefully on a corrupt delta input', () => {
    expect(() =>
      createDeltaZip(makeArtifact({ files: { 'summary.json': '{not json' } })),
    ).toThrow(/corrupt|invalid|parse/i);
  });
});
