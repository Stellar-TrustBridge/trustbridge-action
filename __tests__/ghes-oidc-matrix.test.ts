/**
 * ghes-oidc-matrix.test.ts (Issue #677)
 *
 * Drift-detection test for the OIDC webhook matrix in
 * docs/GHES_COMPATIBILITY.md. Mirrors the error-catalog pattern: the matrix
 * lives between HTML comment markers, every row starts with a stable key, and
 * the cells are checked against the constants in src/webhook.ts and the
 * inputs in action.yml. Removing a required row, renaming the permissions
 * column, or changing an issuer/audience constant without updating the doc
 * fails CI.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_OIDC_AUDIENCE,
  GHES_OIDC_ISSUER_PATH,
  GITHUB_COM_OIDC_ISSUER,
  OIDC_MIN_GHES_VERSION,
  OIDC_REQUIRED_PERMISSION,
  OIDC_RUNTIME_ENV_VARS,
  resolveOidcIssuer,
} from '../src/webhook';

const REPO_ROOT = path.resolve(__dirname, '..');
const GHES_DOC_PATH = path.join(REPO_ROOT, 'docs', 'GHES_COMPATIBILITY.md');
const USAGE_DOC_PATH = path.join(REPO_ROOT, 'docs', 'USAGE.md');
const ACTION_YML_PATH = path.join(REPO_ROOT, 'action.yml');

const BEGIN_MARKER = '<!-- GHES_OIDC_MATRIX_BEGIN -->';
const END_MARKER = '<!-- GHES_OIDC_MATRIX_END -->';

const GHES_OIDC_ANCHOR = 'oidc-webhook-authentication-matrix-issue-677';
const USAGE_OIDC_ANCHOR = 'oidc-federation-for-dashboard-webhooks-issue-224';

/** Row keys the matrix must always document. */
const REQUIRED_ROW_KEYS = [
  'token-minting',
  'permission',
  'runtime-env',
  'issuer',
  'jwks-discovery',
  'audience',
  'fork-pull-request',
  'runner-type',
  'air-gapped',
  'hmac-fallback',
] as const;

/** Rows whose permissions cell must name `id-token: write`. */
const ID_TOKEN_ROWS = ['token-minting', 'permission', 'runtime-env', 'issuer', 'audience'] as const;

const GHES_HOST_PLACEHOLDER = 'https://HOSTNAME';

interface MatrixTable {
  header: string[];
  rows: Map<string, Record<string, string>>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readMatrixSection(doc: string): string {
  const begin = doc.indexOf(BEGIN_MARKER);
  const end = doc.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`GHES OIDC matrix markers missing or out of order`);
  }
  return doc.slice(begin + BEGIN_MARKER.length, end);
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** Parse the Markdown table between the markers, keyed by the backticked first column. */
function parseMatrix(section: string): MatrixTable {
  const lines = section
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'));
  if (lines.length < 2) throw new Error('GHES OIDC matrix table not found');

  const header = splitRow(lines[0]!);
  const rows = new Map<string, Record<string, string>>();
  for (const line of lines.slice(2)) {
    const cells = splitRow(line);
    const keyMatch = cells[0]?.match(/^`([a-z0-9-]+)`$/);
    if (!keyMatch) throw new Error(`Matrix row without a backticked key: ${line}`);
    if (cells.length !== header.length) {
      throw new Error(`Matrix row "${keyMatch[1]}" has ${cells.length} cells, expected ${header.length}`);
    }
    const record: Record<string, string> = {};
    header.forEach((column, idx) => {
      record[column] = cells[idx]!;
    });
    rows.set(keyMatch[1]!, record);
  }
  return { header, rows };
}

function missingRowKeys(table: MatrixTable): string[] {
  return REQUIRED_ROW_KEYS.filter((key) => !table.rows.has(key));
}

/** GitHub-style heading slug: lowercase, drop punctuation, spaces → hyphens. */
function githubSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function headingAnchors(doc: string): Set<string> {
  const anchors = new Set<string>();
  for (const line of doc.split('\n')) {
    const match = line.match(/^#{1,6}\s+(.*?)\s*(\{#([^}]+)\})?\s*$/);
    if (match) {
      anchors.add(githubSlug(match[1]!));
      if (match[3]) anchors.add(match[3]);
    }
  }
  return anchors;
}

function actionInputDefault(actionYml: string, input: string): string | undefined {
  const match = actionYml.match(new RegExp(`\\n  ${input}:\\n[\\s\\S]*?\\n    default:\\s*["']?([^"'\\n]*)["']?`));
  return match?.[1];
}

function actionInputDescription(actionYml: string, input: string): string {
  const match = actionYml.match(new RegExp(`\\n  ${input}:\\n([\\s\\S]*?)\\n    required:`));
  return (match?.[1] ?? '').replace(/\s+/g, ' ');
}

const githubComColumn = 'github.com';
const ghesSupportedColumn = `GHES ${OIDC_MIN_GHES_VERSION}+`;
const ghesUnsupportedColumn = `GHES < ${OIDC_MIN_GHES_VERSION}`;

// ── Tests ────────────────────────────────────────────────────────────────────

describe('docs/GHES_COMPATIBILITY.md — OIDC webhook matrix (Issue #677)', () => {
  let ghesDoc: string;
  let table: MatrixTable;

  beforeAll(() => {
    ghesDoc = fs.readFileSync(GHES_DOC_PATH, 'utf8');
    table = parseMatrix(readMatrixSection(ghesDoc));
  });

  it('contains the matrix markers in order', () => {
    expect(ghesDoc.indexOf(BEGIN_MARKER)).toBeGreaterThan(-1);
    expect(ghesDoc.indexOf(END_MARKER)).toBeGreaterThan(ghesDoc.indexOf(BEGIN_MARKER));
  });

  it('has platform columns derived from OIDC_MIN_GHES_VERSION and a Permissions column', () => {
    expect(table.header).toEqual(
      expect.arrayContaining([
        'Key',
        githubComColumn,
        ghesSupportedColumn,
        ghesUnsupportedColumn,
        'Permissions',
      ]),
    );
  });

  it('documents every required row', () => {
    expect(missingRowKeys(table)).toEqual([]);
  });

  it('fails the required-row check when a row is removed (parser sanity)', () => {
    const section = readMatrixSection(ghesDoc);
    const tampered = section
      .split('\n')
      .filter((line) => !line.includes('`issuer`'))
      .join('\n');
    expect(missingRowKeys(parseMatrix(tampered))).toEqual(['issuer']);
  });

  it('names id-token: write in the permissions column of every token-dependent row', () => {
    for (const key of ID_TOKEN_ROWS) {
      expect(table.rows.get(key)?.Permissions).toContain(OIDC_REQUIRED_PERMISSION);
    }
  });

  it('documents the github.com and GHES issuer URLs from src/webhook.ts', () => {
    const issuer = table.rows.get('issuer')!;
    expect(issuer[githubComColumn]).toContain(GITHUB_COM_OIDC_ISSUER);
    expect(issuer[ghesSupportedColumn]).toContain(`${GHES_HOST_PLACEHOLDER}${GHES_OIDC_ISSUER_PATH}`);
    expect(issuer[ghesSupportedColumn]).toContain(resolveOidcIssuer(GHES_HOST_PLACEHOLDER));
  });

  it('documents the discovery endpoints under each issuer', () => {
    const jwks = table.rows.get('jwks-discovery')!;
    expect(jwks[githubComColumn]).toContain(`${GITHUB_COM_OIDC_ISSUER}/.well-known/openid-configuration`);
    expect(jwks[ghesSupportedColumn]).toContain(
      `${GHES_HOST_PLACEHOLDER}${GHES_OIDC_ISSUER_PATH}/.well-known/openid-configuration`,
    );
  });

  it('documents the runner variables core.getIDToken depends on', () => {
    const runtime = table.rows.get('runtime-env')!;
    for (const variable of OIDC_RUNTIME_ENV_VARS) {
      expect(runtime[githubComColumn]).toContain(variable);
      expect(runtime[ghesSupportedColumn]).toContain(variable);
    }
  });

  it('documents the default audience and the webhook_oidc_audience input', () => {
    const audience = table.rows.get('audience')!;
    for (const column of [githubComColumn, ghesSupportedColumn]) {
      expect(audience[column]).toContain('webhook_oidc_audience');
      expect(audience[column]).toContain(DEFAULT_OIDC_AUDIENCE);
    }
  });

  it('marks every OIDC row unsupported on GHES releases below the minimum version', () => {
    for (const [key, row] of table.rows) {
      if (key === 'hmac-fallback') {
        expect(row[ghesUnsupportedColumn]).toContain('Supported');
        continue;
      }
      expect(row[ghesUnsupportedColumn]).toContain('Unsupported');
    }
  });

  it('carries an explicit unsupported callout for GHES versions without OIDC', () => {
    expect(ghesDoc).toContain(`Unsupported: GHES releases older than ${OIDC_MIN_GHES_VERSION}`);
    expect(ghesDoc).toContain('webhook_auth_mode: hmac');
  });

  it('documents the air-gapped limitation', () => {
    const airGapped = table.rows.get('air-gapped')!;
    expect(airGapped.Notes).toMatch(/cannot validate tokens against a live provider/);
  });
});

describe('action.yml ↔ OIDC matrix constants (Issue #677)', () => {
  let actionYml: string;

  beforeAll(() => {
    actionYml = fs.readFileSync(ACTION_YML_PATH, 'utf8');
  });

  it('webhook_oidc_audience default matches DEFAULT_OIDC_AUDIENCE', () => {
    expect(actionInputDefault(actionYml, 'webhook_oidc_audience')).toBe(DEFAULT_OIDC_AUDIENCE);
  });

  it('webhook_auth_mode documents the id-token: write permission', () => {
    expect(actionInputDescription(actionYml, 'webhook_auth_mode')).toContain(OIDC_REQUIRED_PERMISSION);
  });
});

describe('USAGE.md ↔ GHES_COMPATIBILITY.md OIDC cross-links (Issue #677)', () => {
  let usageDoc: string;
  let ghesDoc: string;

  beforeAll(() => {
    usageDoc = fs.readFileSync(USAGE_DOC_PATH, 'utf8');
    ghesDoc = fs.readFileSync(GHES_DOC_PATH, 'utf8');
  });

  it('both link targets exist as headings', () => {
    expect(headingAnchors(ghesDoc).has(GHES_OIDC_ANCHOR)).toBe(true);
    expect(headingAnchors(usageDoc).has(USAGE_OIDC_ANCHOR)).toBe(true);
  });

  it('USAGE.md OIDC section links to the GHES matrix', () => {
    const start = usageDoc.indexOf('## OIDC Federation for Dashboard Webhooks');
    const end = usageDoc.indexOf('\n## ', start + 1);
    const section = usageDoc.slice(start, end === -1 ? undefined : end);
    expect(start).toBeGreaterThan(-1);
    expect(section).toContain(`GHES_COMPATIBILITY.md#${GHES_OIDC_ANCHOR}`);
  });

  it('GHES matrix links back to the USAGE.md OIDC section', () => {
    expect(ghesDoc).toContain(`USAGE.md#${USAGE_OIDC_ANCHOR}`);
  });

  it('every USAGE.md / GHES_COMPATIBILITY.md cross-link anchor resolves', () => {
    const targets: Array<[string, string, Set<string>]> = [
      [ghesDoc, 'USAGE.md', headingAnchors(usageDoc)],
      [usageDoc, 'GHES_COMPATIBILITY.md', headingAnchors(ghesDoc)],
    ];
    for (const [source, file, anchors] of targets) {
      const pattern = new RegExp(`\\]\\(${file.replace('.', '\\.')}#([^)\\s]+)\\)`, 'g');
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) !== null) {
        expect({ file, anchor: match[1], resolves: anchors.has(match[1]!) }).toEqual({
          file,
          anchor: match[1],
          resolves: true,
        });
      }
    }
  });

  it('the USAGE.md issuer claim is not documented as github.com-only', () => {
    const issLine = usageDoc.split('\n').find((line) => line.startsWith('- `iss`:'));
    expect(issLine).toBeDefined();
    expect(issLine).toContain(GITHUB_COM_OIDC_ISSUER);
    expect(issLine).toContain(GHES_OIDC_ISSUER_PATH);
  });
});

describe('resolveOidcIssuer (Issue #677)', () => {
  it('returns the github.com issuer for github.com', () => {
    expect(resolveOidcIssuer('https://github.com')).toBe(GITHUB_COM_OIDC_ISSUER);
    expect(resolveOidcIssuer('https://github.com/')).toBe(GITHUB_COM_OIDC_ISSUER);
  });

  it('returns HOSTNAME/_services/token for a GHES server URL', () => {
    expect(resolveOidcIssuer('https://ghes.corp.example.com')).toBe(
      'https://ghes.corp.example.com/_services/token',
    );
    expect(resolveOidcIssuer('https://ghes.corp.example.com/')).toBe(
      'https://ghes.corp.example.com/_services/token',
    );
  });

  it('falls back to the github.com issuer for an unparsable server URL', () => {
    expect(resolveOidcIssuer('not a url')).toBe(GITHUB_COM_OIDC_ISSUER);
  });
});
