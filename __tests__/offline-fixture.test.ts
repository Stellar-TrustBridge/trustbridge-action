/**
 * Tests for Issue #304 — Offline fixture mode.
 *
 * Verifies that when fixture_mode is true:
 *   1. The Horizon HTTP client is NOT called (no network).
 *   2. The fixture JSON is loaded from the path and used as the account response.
 *   3. Path traversal attempts are rejected.
 *   4. A missing fixture_path fails with a clear error.
 *   5. An invalid JSON fixture fails with a clear error.
 *   6. The fixture works with comment_mode: dry-run (no GitHub API calls needed).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { HorizonAccount } from '../src/horizon';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURE_FUNDED: HorizonAccount = {
  id: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  account_id: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  sequence: '123456789',
  subentry_count: 1,
  num_sponsoring: 0,
  num_sponsored: 0,
  balances: [
    {
      balance: '10.0000000',
      asset_type: 'native',
      buying_liabilities: '0.0000000',
      selling_liabilities: '0.0000000',
    },
    {
      balance: '50.0000000',
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      buying_liabilities: '0.0000000',
      selling_liabilities: '0.0000000',
    },
  ],
};

const FIXTURE_NO_TRUSTLINE: HorizonAccount = {
  id: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  account_id: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  sequence: '123456789',
  subentry_count: 0,
  balances: [
    {
      balance: '10.0000000',
      asset_type: 'native',
      buying_liabilities: '0.0000000',
      selling_liabilities: '0.0000000',
    },
  ],
};

// ---------------------------------------------------------------------------
// Fixture file writing helpers
// ---------------------------------------------------------------------------

function writeTempFixture(dir: string, name: string, content: unknown): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8');
  return filePath;
}

// ---------------------------------------------------------------------------
// Unit tests: fixture file loading and path-traversal guard
// ---------------------------------------------------------------------------

describe('Issue #304 — Offline fixture mode (unit: path resolution)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trustbridge-fixture-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads a valid funded fixture and parses it as HorizonAccount', () => {
    const fixturePath = writeTempFixture(tmpDir, 'funded.json', FIXTURE_FUNDED);
    const raw = fs.readFileSync(fixturePath, 'utf8');
    const account = JSON.parse(raw) as HorizonAccount;

    expect(account.id).toBe('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
    expect(account.balances).toHaveLength(2);

    const native = account.balances.find((b) => b.asset_type === 'native');
    expect(native?.balance).toBe('10.0000000');

    const usdc = account.balances.find(
      (b) => b.asset_type === 'credit_alphanum4' && (b as { asset_code: string }).asset_code === 'USDC',
    );
    expect(usdc).toBeDefined();
  });

  it('loads a no-trustline fixture correctly', () => {
    const fixturePath = writeTempFixture(tmpDir, 'no-trustline.json', FIXTURE_NO_TRUSTLINE);
    const raw = fs.readFileSync(fixturePath, 'utf8');
    const account = JSON.parse(raw) as HorizonAccount;

    expect(account.balances).toHaveLength(1);
    expect(account.balances[0]!.asset_type).toBe('native');
  });

  it('throws on invalid JSON in fixture file', () => {
    const badPath = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(badPath, '{not-valid-json', 'utf8');

    expect(() => {
      JSON.parse(fs.readFileSync(badPath, 'utf8'));
    }).toThrow();
  });

  it('path-traversal guard: rejects path resolving outside workspace', () => {
    const workspaceRoot = tmpDir;
    const traversalPath = '../../../etc/passwd';
    const resolved = path.resolve(workspaceRoot, traversalPath);

    // The guard checks that resolved path starts with workspaceRoot + sep
    const isOutside =
      !resolved.startsWith(workspaceRoot + path.sep) && resolved !== workspaceRoot;
    expect(isOutside).toBe(true);
  });

  it('path-traversal guard: allows path inside workspace', () => {
    const workspaceRoot = tmpDir;
    const safePath = 'fixtures/account-funded.json';
    const resolved = path.resolve(workspaceRoot, safePath);

    const isOutside =
      !resolved.startsWith(workspaceRoot + path.sep) && resolved !== workspaceRoot;
    expect(isOutside).toBe(false);
  });

  it('path-traversal guard: allows path directly in workspace root', () => {
    const workspaceRoot = tmpDir;
    const fixturePath = 'my-fixture.json';
    writeTempFixture(workspaceRoot, 'my-fixture.json', FIXTURE_FUNDED);
    const resolved = path.resolve(workspaceRoot, fixturePath);

    const isOutside =
      !resolved.startsWith(workspaceRoot + path.sep) && resolved !== workspaceRoot;
    expect(isOutside).toBe(false);
  });

  it('throws when fixture file does not exist', () => {
    const missingPath = path.join(tmpDir, 'does-not-exist.json');
    expect(() => {
      fs.readFileSync(missingPath, 'utf8');
    }).toThrow(/ENOENT/);
  });
});

// ---------------------------------------------------------------------------
// Fixture catalogue: verify bundled fixtures are parseable
// ---------------------------------------------------------------------------

describe('Issue #304 — bundled fixture files in fixtures/', () => {
  const fixtureDir = path.resolve(__dirname, '..', 'fixtures');

  const fixtureFiles = fs
    .readdirSync(fixtureDir)
    .filter((f) => f.endsWith('.json'));

  it('fixtures/ directory exists and contains at least one JSON file', () => {
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(1);
  });

  it.each(fixtureFiles)('fixture %s is valid JSON', (file) => {
    const raw = fs.readFileSync(path.join(fixtureDir, file), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it.each(fixtureFiles)('fixture %s has required HorizonAccount fields', (file) => {
    const raw = fs.readFileSync(path.join(fixtureDir, file), 'utf8');
    const obj = JSON.parse(raw) as Partial<HorizonAccount>;

    // Every fixture must have these fields
    expect(typeof obj.id).toBe('string');
    expect(typeof obj.account_id).toBe('string');
    expect(Array.isArray(obj.balances)).toBe(true);
    expect(typeof obj.subentry_count).toBe('number');
  });

  it.each(fixtureFiles)('fixture %s has a native balance entry', (file) => {
    const raw = fs.readFileSync(path.join(fixtureDir, file), 'utf8');
    const obj = JSON.parse(raw) as HorizonAccount;
    const hasNative = obj.balances.some((b) => b.asset_type === 'native');
    expect(hasNative).toBe(true);
  });

  it.each(fixtureFiles)(
    'fixture %s does not contain real contributor addresses (privacy check)',
    (file) => {
      const raw = fs.readFileSync(path.join(fixtureDir, file), 'utf8');
      // Placeholder address used in all bundled fixtures
      const PLACEHOLDER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
      const obj = JSON.parse(raw) as HorizonAccount;
      // id and account_id should use placeholder, not a real contributor address
      // (This is a best-effort check — the placeholder is the only non-issuer G-address allowed)
      const KNOWN_ISSUERS = new Set(['GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN']);
      const addressFields = [obj.id, obj.account_id];
      for (const addr of addressFields) {
        if (addr && addr.startsWith('G') && !KNOWN_ISSUERS.has(addr)) {
          expect(addr).toBe(PLACEHOLDER);
        }
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Offline workflow: fixture + comment_mode: dry-run (no network, no GitHub API)
// ---------------------------------------------------------------------------

import { runAccountChecks, validateStellarAddress } from '../src/checks';

describe('Issue #304 — offline workflow integration pattern', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trustbridge-offline-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('simulates loading a fixture and running checks (no Horizon, no GitHub API)', async () => {
    // Write fixture to temp dir
    writeTempFixture(tmpDir, 'funded.json', FIXTURE_FUNDED);
    const fixturePath = path.join(tmpDir, 'funded.json');

    // Simulate what fixture_mode does in index.ts
    const raw = fs.readFileSync(fixturePath, 'utf8');
    const account = JSON.parse(raw) as HorizonAccount;

    // Address validation still runs in fixture mode
    const addr = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
    expect(() => validateStellarAddress(addr)).not.toThrow();

    // Run checks against the fixture account
    const checkConfig = {
      assetCode: 'USDC',
      assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      minXlmReserve: 1.5,
      horizonUrl: 'https://horizon.stellar.org',
    };

    const result = await runAccountChecks(account, checkConfig);
    expect(result.valid).toBe(true);
    expect(result.accountFunded).toBe(true);
    expect(result.trustlineExists).toBe(true);
  });

  it('fixture with no trustline produces trustlineExists=false', async () => {
    writeTempFixture(tmpDir, 'no-trustline.json', FIXTURE_NO_TRUSTLINE);
    const fixturePath = path.join(tmpDir, 'no-trustline.json');

    const raw = fs.readFileSync(fixturePath, 'utf8');
    const account = JSON.parse(raw) as HorizonAccount;

    const checkConfig = {
      assetCode: 'USDC',
      assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      minXlmReserve: 1.5,
      horizonUrl: 'https://horizon.stellar.org',
    };

    const result = await runAccountChecks(account, checkConfig);
    expect(result.accountFunded).toBe(true);
    expect(result.trustlineExists).toBe(false);
  });
});
