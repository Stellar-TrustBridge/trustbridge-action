import {
  lookupAddressFromContract,
  buildGetAddressXdr,
  parseAddressFromSimulateResult,
  parseContractExistsResult,
  contractExistsOnChain,
  ContractLookupError,
  ContractConfig,
} from '../src/soroban';
import fetch from 'node-fetch';

jest.mock('node-fetch');
const mockFetch = fetch as jest.MockedFunction<typeof fetch>;

const VALID_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const VALID_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const RPC_URL = 'https://soroban-testnet.stellar.org';

const baseConfig: ContractConfig = {
  sorobanRpcUrl: RPC_URL,
  contractId: VALID_CONTRACT,
  timeoutMs: 5000,
};

function makeRpcResponse(address: string | null): object {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: {
      retval:
        address !== null
          ? { type: 'address', value: address }
          : { type: 'void' },
    },
  };
}

function mockOkResponse(body: object): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => body,
  } as never);
}

function mockStatusResponse(status: number): void {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => ({}),
  } as never);
}

describe('lookupAddressFromContract', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns the resolved address when the registry has a mapping', async () => {
    mockOkResponse(makeRpcResponse(VALID_ADDRESS));

    const result = await lookupAddressFromContract('alice', baseConfig);

    expect(result.address).toBe(VALID_ADDRESS);
    expect(result.fromRegistry).toBe(true);
  });

  it('returns null address when username is not registered (void retval)', async () => {
    mockOkResponse(makeRpcResponse(null));

    const result = await lookupAddressFromContract('unknown-user', baseConfig);

    expect(result.address).toBeNull();
    expect(result.fromRegistry).toBe(false);
  });

  it('returns null address when retval is missing from response', async () => {
    mockOkResponse({ jsonrpc: '2.0', id: 1, result: {} });

    const result = await lookupAddressFromContract('alice', baseConfig);

    expect(result.address).toBeNull();
    expect(result.fromRegistry).toBe(false);
  });

  it('throws a retryable ContractLookupError on HTTP 429 (rate limit)', async () => {
    mockStatusResponse(429);

    await expect(lookupAddressFromContract('alice', baseConfig)).rejects.toMatchObject({
      name: 'ContractLookupError',
      retryable: true,
      message: expect.stringContaining('429'),
    });
  });

  it('throws a retryable ContractLookupError on HTTP 503 (service unavailable)', async () => {
    mockStatusResponse(503);

    await expect(lookupAddressFromContract('alice', baseConfig)).rejects.toMatchObject({
      name: 'ContractLookupError',
      retryable: true,
    });
  });

  it('throws a retryable ContractLookupError on HTTP 502', async () => {
    mockStatusResponse(502);

    await expect(lookupAddressFromContract('alice', baseConfig)).rejects.toMatchObject({
      name: 'ContractLookupError',
      retryable: true,
    });
  });

  it('throws a retryable ContractLookupError on HTTP 504', async () => {
    mockStatusResponse(504);

    await expect(lookupAddressFromContract('alice', baseConfig)).rejects.toMatchObject({
      name: 'ContractLookupError',
      retryable: true,
    });
  });

  it('throws a non-retryable ContractLookupError on HTTP 400', async () => {
    mockStatusResponse(400);

    await expect(lookupAddressFromContract('alice', baseConfig)).rejects.toMatchObject({
      name: 'ContractLookupError',
      retryable: false,
    });
  });

  it('throws a non-retryable ContractLookupError on HTTP 500', async () => {
    mockStatusResponse(500);

    await expect(lookupAddressFromContract('alice', baseConfig)).rejects.toMatchObject({
      name: 'ContractLookupError',
      retryable: false,
    });
  });

  it('throws a ContractLookupError when the network request fails (outage)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(lookupAddressFromContract('alice', baseConfig)).rejects.toMatchObject({
      name: 'ContractLookupError',
      message: expect.stringContaining('ECONNREFUSED'),
    });
  });

  it('throws a retryable ContractLookupError on timeout/abort', async () => {
    mockFetch.mockRejectedValueOnce(new Error('The operation was aborted'));

    await expect(lookupAddressFromContract('alice', baseConfig)).rejects.toMatchObject({
      name: 'ContractLookupError',
      retryable: true,
    });
  });

  it('throws a non-retryable ContractLookupError when JSON parsing fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    } as never);

    await expect(lookupAddressFromContract('alice', baseConfig)).rejects.toMatchObject({
      name: 'ContractLookupError',
      retryable: false,
      message: expect.stringContaining('invalid JSON'),
    });
  });

  it('uses the default timeout when timeoutMs is not provided', async () => {
    mockOkResponse(makeRpcResponse(VALID_ADDRESS));

    const configWithoutTimeout: ContractConfig = {
      sorobanRpcUrl: RPC_URL,
      contractId: VALID_CONTRACT,
    };

    const result = await lookupAddressFromContract('alice', configWithoutTimeout);
    expect(result.address).toBe(VALID_ADDRESS);
  });

  it('ignores a retval address that does not match the G-address format', async () => {
    mockOkResponse({
      jsonrpc: '2.0',
      id: 1,
      result: { retval: { type: 'address', value: 'not-a-valid-address' } },
    });

    const result = await lookupAddressFromContract('alice', baseConfig);
    expect(result.address).toBeNull();
    expect(result.fromRegistry).toBe(false);
  });
});

describe('buildGetAddressXdr', () => {
  it('returns a non-empty base64 string', () => {
    const xdr = buildGetAddressXdr(VALID_CONTRACT, 'alice');
    expect(typeof xdr).toBe('string');
    expect(xdr.length).toBeGreaterThan(0);
    // Must be valid base64
    expect(() => Buffer.from(xdr, 'base64')).not.toThrow();
  });

  it('encodes contractId, function name, and username', () => {
    const xdr = buildGetAddressXdr(VALID_CONTRACT, 'alice');
    const decoded = Buffer.from(xdr, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    expect(parsed.contractId).toBe(VALID_CONTRACT);
    expect(parsed.fn).toBe('get_address');
    expect(parsed.args).toContain('alice');
  });

  it('produces different XDR for different usernames', () => {
    const xdr1 = buildGetAddressXdr(VALID_CONTRACT, 'alice');
    const xdr2 = buildGetAddressXdr(VALID_CONTRACT, 'bob');
    expect(xdr1).not.toBe(xdr2);
  });
});

describe('parseAddressFromSimulateResult', () => {
  it('extracts a valid G-address from a well-formed result', () => {
    const json = makeRpcResponse(VALID_ADDRESS);
    expect(parseAddressFromSimulateResult(json)).toBe(VALID_ADDRESS);
  });

  it('returns null for a void retval', () => {
    expect(parseAddressFromSimulateResult(makeRpcResponse(null))).toBeNull();
  });

  it('returns null when result is missing', () => {
    expect(parseAddressFromSimulateResult({ jsonrpc: '2.0', id: 1 })).toBeNull();
  });

  it('returns null for null input', () => {
    expect(parseAddressFromSimulateResult(null)).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(parseAddressFromSimulateResult('string')).toBeNull();
    expect(parseAddressFromSimulateResult(42)).toBeNull();
  });

  it('returns null when retval type is address but value is not a valid G-address', () => {
    const json = {
      result: { retval: { type: 'address', value: 'INVALID' } },
    };
    expect(parseAddressFromSimulateResult(json)).toBeNull();
  });

  it('returns null when retval is null', () => {
    expect(parseAddressFromSimulateResult({ result: { retval: null } })).toBeNull();
  });
});

describe('contractExistsOnChain', () => {
  it('returns true when Soroban RPC reports the contract exists', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { exists: true } }),
    } as never);

    await expect(contractExistsOnChain(VALID_CONTRACT, { sorobanRpcUrl: RPC_URL, timeoutMs: 5000 })).resolves.toBe(true);
  });

  it('returns false when Soroban RPC reports no contract code exists', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { exists: false } }),
    } as never);

    await expect(contractExistsOnChain(VALID_CONTRACT, { sorobanRpcUrl: RPC_URL, timeoutMs: 5000 })).resolves.toBe(false);
  });

  it('fails closed when rpc url is missing', async () => {
    await expect(contractExistsOnChain(VALID_CONTRACT, { sorobanRpcUrl: '', timeoutMs: 5000 })).rejects.toMatchObject({
      name: 'ContractLookupError',
      retryable: false,
    });
  });
});

describe('parseContractExistsResult', () => {
  it('accepts an exists=true payload', () => {
    expect(parseContractExistsResult({ result: { exists: true } })).toBe(true);
  });

  it('accepts a non-empty code payload', () => {
    expect(parseContractExistsResult({ result: { code: '...contract bytecode...' } })).toBe(true);
  });

  it('rejects an error payload', () => {
    expect(parseContractExistsResult({ error: { code: -32000 } })).toBe(false);
  });
});

describe('ContractLookupError', () => {
  it('is an instance of Error', () => {
    const err = new ContractLookupError('test', true);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ContractLookupError);
  });

  it('exposes retryable flag', () => {
    expect(new ContractLookupError('msg', true).retryable).toBe(true);
    expect(new ContractLookupError('msg', false).retryable).toBe(false);
  });

  it('has the correct name', () => {
    expect(new ContractLookupError('msg', false).name).toBe('ContractLookupError');
  });
});

// ---------------------------------------------------------------------------
// Issue #294: Contract fixture compatibility tests
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'soroban', 'get_address_simulate_result.json');

interface FixtureFile {
  _fixture_version: string;
  _generated_from: string;
  scenarios: Record<string, unknown>;
}

describe('contract fixture compatibility (issue #294)', () => {
  let fixture: FixtureFile;

  beforeAll(() => {
    const raw = fs.readFileSync(FIXTURE_PATH, 'utf8');
    fixture = JSON.parse(raw) as FixtureFile;
  });

  it('fixture file is valid JSON and has required top-level fields', () => {
    expect(typeof fixture._fixture_version).toBe('string');
    expect(fixture._fixture_version.length).toBeGreaterThan(0);
    expect(typeof fixture._generated_from).toBe('string');
    expect(typeof fixture.scenarios).toBe('object');
    expect(fixture.scenarios).not.toBeNull();
  });

  it('fixture version is semver-like (x.y.z)', () => {
    expect(fixture._fixture_version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('fixture has expected scenario keys', () => {
    const expectedScenarios = ['found', 'not_found', 'null_retval', 'missing_retval', 'missing_result'];
    for (const key of expectedScenarios) {
      expect(fixture.scenarios).toHaveProperty(key);
    }
  });

  it('scenario "found": parseAddressFromSimulateResult returns a valid G-address', () => {
    const scenario = fixture.scenarios['found'];
    const address = parseAddressFromSimulateResult(scenario);
    expect(address).not.toBeNull();
    expect(address).toMatch(/^G[A-Z2-7]{55}$/);
  });

  it('scenario "found_alt_address": parseAddressFromSimulateResult returns the correct address', () => {
    const scenario = fixture.scenarios['found_alt_address'];
    const address = parseAddressFromSimulateResult(scenario);
    expect(address).toBe('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');
  });

  it('scenario "not_found": parseAddressFromSimulateResult returns null (void retval)', () => {
    const scenario = fixture.scenarios['not_found'];
    const address = parseAddressFromSimulateResult(scenario);
    expect(address).toBeNull();
  });

  it('scenario "null_retval": parseAddressFromSimulateResult returns null safely', () => {
    const scenario = fixture.scenarios['null_retval'];
    const address = parseAddressFromSimulateResult(scenario);
    expect(address).toBeNull();
  });

  it('scenario "missing_retval": parseAddressFromSimulateResult returns null', () => {
    const scenario = fixture.scenarios['missing_retval'];
    const address = parseAddressFromSimulateResult(scenario);
    expect(address).toBeNull();
  });

  it('scenario "missing_result": parseAddressFromSimulateResult returns null (error response)', () => {
    const scenario = fixture.scenarios['missing_result'];
    const address = parseAddressFromSimulateResult(scenario);
    expect(address).toBeNull();
  });

  it('scenario "invalid_address_in_retval": parseAddressFromSimulateResult rejects non-G-address', () => {
    const scenario = fixture.scenarios['invalid_address_in_retval'];
    const address = parseAddressFromSimulateResult(scenario);
    expect(address).toBeNull();
  });

  it('all "found" scenarios produce fromRegistry=true when used with lookupAddressFromContract', async () => {
    // Exercise the full pipeline via mock — fixture response goes through the real parser
    const foundScenario = fixture.scenarios['found'];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => foundScenario,
    } as never);

    const result = await lookupAddressFromContract('alice', baseConfig);
    expect(result.fromRegistry).toBe(true);
    expect(result.address).toMatch(/^G[A-Z2-7]{55}$/);
  });

  it('the "not_found" fixture produces fromRegistry=false when used with lookupAddressFromContract', async () => {
    const notFoundScenario = fixture.scenarios['not_found'];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => notFoundScenario,
    } as never);

    const result = await lookupAddressFromContract('unknown-user', baseConfig);
    expect(result.fromRegistry).toBe(false);
    expect(result.address).toBeNull();
  });

  describe('XDR encoding round-trip', () => {
    it('buildGetAddressXdr produces base64 that decodes to expected JSON structure', () => {
      const xdr = buildGetAddressXdr(VALID_CONTRACT, 'alice');
      const decoded = JSON.parse(Buffer.from(xdr, 'base64').toString('utf8'));
      expect(decoded.contractId).toBe(VALID_CONTRACT);
      expect(decoded.fn).toBe('get_address');
      expect(decoded.args).toEqual(['alice']);
    });

    it('XDR payload matches the simulateTransaction params structure the fixture was generated from', () => {
      // The fixture _generated_from field describes the contract function
      expect(fixture._generated_from).toContain('get_address');
    });

    it('different usernames produce different XDR (no collision)', () => {
      const users = ['alice', 'bob', 'carol', 'dave', 'ALICE', 'Alice'];
      const xdrSet = new Set(users.map((u) => buildGetAddressXdr(VALID_CONTRACT, u)));
      expect(xdrSet.size).toBe(users.length);
    });
  });
});

// ---------------------------------------------------------------------------
// Issue #549 — github_username fallback for Soroban get_address lookup
//
// When the GitHub event context does not provide an assignee login (e.g.
// workflow_dispatch or cron runs), the caller must pass the username
// explicitly via the `github_username` action input.  The Soroban layer
// accepts any non-empty string as the lookup key — it has no concept of
// "event context" vs "explicit input".  These tests verify that
// lookupAddressFromContract works correctly when the caller supplies a
// username that originated from the `github_username` input rather than
// from an event payload.
// ---------------------------------------------------------------------------

describe('Issue #549 — github_username fallback: lookupAddressFromContract accepts explicit username', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('resolves address when username comes from github_username input (not event context)', async () => {
    // Simulate the scenario where no event-context assignee is available and
    // the caller passes the github_username input value directly.
    const explicitUsername = 'contributor-without-event-context';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => makeRpcResponse(VALID_ADDRESS),
    } as never);

    const result = await lookupAddressFromContract(explicitUsername, baseConfig);

    expect(result.address).toBe(VALID_ADDRESS);
    expect(result.fromRegistry).toBe(true);
  });

  it('encodes the github_username value correctly in the XDR lookup key', () => {
    const githubUsername = 'wave-contributor-42';
    const xdr = buildGetAddressXdr(VALID_CONTRACT, githubUsername);
    const decoded = JSON.parse(Buffer.from(xdr, 'base64').toString('utf8'));

    // The username must be passed verbatim as the first arg to get_address
    expect(decoded.args[0]).toBe(githubUsername);
    expect(decoded.fn).toBe('get_address');
  });

  it('returns null when the github_username is not registered in the contract', async () => {
    const unregisteredUser = 'newcomer-not-in-registry';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => makeRpcResponse(null),
    } as never);

    const result = await lookupAddressFromContract(unregisteredUser, baseConfig);

    expect(result.address).toBeNull();
    expect(result.fromRegistry).toBe(false);
  });

  it('propagates retryable errors regardless of whether username came from event or input', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
    } as never);

    await expect(
      lookupAddressFromContract('any-username', baseConfig),
    ).rejects.toMatchObject({
      name: 'ContractLookupError',
      retryable: true,
    });
  });

  it('buildGetAddressXdr produces distinct XDR for github_username vs event-derived username', () => {
    // Demonstrates that the lookup key is username-specific regardless of source
    const eventDerivedUsername = 'github-assignee-from-event';
    const explicitGithubUsername = 'github-username-from-input';

    const xdr1 = buildGetAddressXdr(VALID_CONTRACT, eventDerivedUsername);
    const xdr2 = buildGetAddressXdr(VALID_CONTRACT, explicitGithubUsername);

    expect(xdr1).not.toBe(xdr2);

    const decoded1 = JSON.parse(Buffer.from(xdr1, 'base64').toString('utf8'));
    const decoded2 = JSON.parse(Buffer.from(xdr2, 'base64').toString('utf8'));

    expect(decoded1.args[0]).toBe(eventDerivedUsername);
    expect(decoded2.args[0]).toBe(explicitGithubUsername);
  });
});

// ---------------------------------------------------------------------------
// Issue #730 — Soroban SAC (Stellar Asset Contract) issuer support
//
// A SAC issues an asset from a contract id, so the issuer is a C-address and
// the classic Horizon trustline path can never confirm the balance. These
// tests drive the real parsers against contract-representative fixtures (see
// docs/SOROBAN_CONTRACT_FIXTURES.md) plus the synthetic malformed-id cases.
// ---------------------------------------------------------------------------

import {
  fetchSacContractMetadata,
  parseSacContractMetadata,
  verifySacIssuerAssetCode,
  isSorobanContractId,
  classifyAssetIssuer,
  isSorobanContractIssuer,
} from '../src/soroban';
import {
  assertValidSacAssetCode,
  classifyAssetIssuer as classifyAssetIssuerFromAssets,
  isSorobanContractIssuer as isSorobanContractIssuerFromAssets,
} from '../src/assets';
import { redactContractAddress, redactContext, redactStellarAddress } from '../src/logger';

const SAC_CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const SAC_CONTRACT_ID_2 = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB4X';
const SAC_FIXTURE_PATH = path.join(
  __dirname,
  'fixtures',
  'soroban',
  'sac_contract_metadata.json',
);

interface SacFixtureFile {
  _fixture_version: string;
  _generated_from: string;
  _fixture_contract_id: string;
  scenarios: Record<string, unknown>;
}

function loadSacFixture(): SacFixtureFile {
  return JSON.parse(fs.readFileSync(SAC_FIXTURE_PATH, 'utf8')) as SacFixtureFile;
}

describe('Issue #730: SAC contract fixtures', () => {
  const fixture = loadSacFixture();

  it('fixture file is valid JSON with the documented shape', () => {
    expect(typeof fixture._fixture_version).toBe('string');
    expect(fixture._fixture_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(fixture._generated_from).toContain('/contracts/');
    expect(fixture._fixture_contract_id).toBe(SAC_CONTRACT_ID);
    expect(Object.keys(fixture.scenarios).length).toBeGreaterThan(0);
  });

  it('the fixture contract id is a well-formed Soroban contract id', () => {
    expect(isSorobanContractId(fixture._fixture_contract_id)).toBe(true);
    expect(isSorobanContractIssuerFromAssets(fixture._fixture_contract_id)).toBe(true);
  });
});

describe('Issue #730: isSorobanContractId', () => {
  it('accepts a well-formed C-address', () => {
    expect(isSorobanContractId(SAC_CONTRACT_ID)).toBe(true);
    expect(isSorobanContractId(`  ${SAC_CONTRACT_ID}  `)).toBe(true);
  });

  it('rejects a G-address, a short id and a wrong-alphabet id', () => {
    expect(isSorobanContractId('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')).toBe(false);
    expect(isSorobanContractId('CNOTACONTRACT')).toBe(false);
    expect(isSorobanContractId('C' + '0'.repeat(55))).toBe(false);
    expect(isSorobanContractId('')).toBe(false);
  });
});

describe('Issue #730: issuer classification (src/assets.ts)', () => {
  it('classifies a C-address as a soroban contract', () => {
    expect(classifyAssetIssuer(SAC_CONTRACT_ID)).toBe('soroban-contract');
    expect(classifyAssetIssuerFromAssets(SAC_CONTRACT_ID)).toBe('soroban-contract');
  });

  it('classifies a G-address as classic', () => {
    const issuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
    expect(classifyAssetIssuer(issuer)).toBe('classic');
    expect(isSorobanContractIssuerFromAssets(issuer)).toBe(false);
  });

  it('classifies an invalid issuer as classic so existing flows are unchanged', () => {
    expect(classifyAssetIssuer('not-an-issuer')).toBe('classic');
    expect(classifyAssetIssuer('')).toBe('classic');
  });

  it('validates a SAC asset code with a contract-specific error message', () => {
    expect(() => assertValidSacAssetCode(SAC_CONTRACT_ID, 'USDC')).not.toThrow();
    expect(() => assertValidSacAssetCode(SAC_CONTRACT_ID, 'usdc')).not.toThrow();
    expect(() => assertValidSacAssetCode(SAC_CONTRACT_ID, 'way-too-long-asset-code')).toThrow(
      /Soroban SAC contract issuer/,
    );
  });
});

describe('Issue #730: parseSacContractMetadata', () => {
  const fixture = loadSacFixture();

  it('reads the SAC reporting fields from a node that exposes them', () => {
    const meta = parseSacContractMetadata(
      fixture.scenarios['sac_with_reporting_fields'],
      SAC_CONTRACT_ID,
    );

    expect(meta.exists).toBe(true);
    expect(meta.name).toBe('USD Coin');
    expect(meta.symbol).toBe('USDC');
    expect(meta.decimals).toBe(7);
    expect(meta.symbolVerified).toBe(true);
    expect(meta.issuerKind).toBe('soroban-contract');
    expect(meta.source).toBe('horizon');
  });

  it('coerces a string decimals value', () => {
    const meta = parseSacContractMetadata(
      fixture.scenarios['sac_reporting_fields_string_decimals'],
      SAC_CONTRACT_ID,
    );

    expect(meta.exists).toBe(true);
    expect(meta.decimals).toBe(7);
    expect(meta.symbol).toBe('USDC');
  });

  it('reports an older node without reporting fields as unverified, not missing', () => {
    const meta = parseSacContractMetadata(
      fixture.scenarios['sac_without_reporting_fields'],
      SAC_CONTRACT_ID,
    );

    expect(meta.exists).toBe(true);
    expect(meta.symbol).toBeUndefined();
    expect(meta.symbolVerified).toBe(false);
    // Inconclusive — the caller must not fail on it.
    expect(verifySacIssuerAssetCode(meta, 'USDC')).toBeNull();
  });

  it('returns exists=false for a JSON-RPC error envelope', () => {
    const meta = parseSacContractMetadata(fixture.scenarios['error_envelope'], SAC_CONTRACT_ID);

    expect(meta.exists).toBe(false);
    expect(meta.symbolVerified).toBe(false);
  });

  it('returns exists=false for non-object input', () => {
    expect(parseSacContractMetadata(null, SAC_CONTRACT_ID).exists).toBe(false);
    expect(parseSacContractMetadata('nope', SAC_CONTRACT_ID).exists).toBe(false);
  });
});

describe('Issue #730: verifySacIssuerAssetCode', () => {
  const fixture = loadSacFixture();

  it('accepts a matching symbol (case-insensitive)', () => {
    const meta = parseSacContractMetadata(
      fixture.scenarios['sac_with_reporting_fields'],
      SAC_CONTRACT_ID,
    );
    expect(verifySacIssuerAssetCode(meta, 'USDC')).toBe(true);
    expect(verifySacIssuerAssetCode(meta, 'usdc')).toBe(true);
  });

  it('rejects a symbol mismatch', () => {
    const meta = parseSacContractMetadata(
      fixture.scenarios['sac_symbol_mismatch'],
      SAC_CONTRACT_ID_2,
    );
    expect(meta.symbol).toBe('TST');
    expect(verifySacIssuerAssetCode(meta, 'USDC')).toBe(false);
  });

  it('returns null when no reporting field is available', () => {
    expect(
      verifySacIssuerAssetCode(
        { contractId: SAC_CONTRACT_ID, issuerKind: 'soroban-contract', exists: true, symbolVerified: false, source: 'horizon' },
        'USDC',
      ),
    ).toBeNull();
  });
});

describe('Issue #730: fetchSacContractMetadata', () => {
  const fixture = loadSacFixture();

  beforeEach(() => {
    mockFetch.mockReset();
  });

  function mockGet(status: number, body: unknown): void {
    mockFetch.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as never);
  }

  it('happy path: resolves SAC metadata from the Horizon contracts endpoint', async () => {
    mockGet(200, fixture.scenarios['sac_with_reporting_fields']);

    const meta = await fetchSacContractMetadata(SAC_CONTRACT_ID, {
      horizonUrl: RPC_URL,
      timeoutMs: 5000,
    });

    expect(meta.exists).toBe(true);
    expect(meta.symbol).toBe('USDC');
    expect(verifySacIssuerAssetCode(meta, 'USDC')).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      `${RPC_URL}/contracts/${SAC_CONTRACT_ID}`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('treats a 404 from an older node as "not exposed", never as a throw', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => fixture.scenarios['not_found'],
    } as never);

    const meta = await fetchSacContractMetadata(SAC_CONTRACT_ID, { horizonUrl: RPC_URL });

    expect(meta.exists).toBe(false);
    expect(meta.source).toBe('horizon');
    expect(meta.symbolVerified).toBe(false);
  });

  it('skips the live fetch entirely in offline mode', async () => {
    const meta = await fetchSacContractMetadata(SAC_CONTRACT_ID, {});

    expect(meta.source).toBe('skipped');
    expect(meta.exists).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses a malformed contract id before any network call', async () => {
    const malformed = (fixture.scenarios['malformed_contract_id'] as { value: string }).value;

    const meta = await fetchSacContractMetadata(malformed, { horizonUrl: RPC_URL });

    expect(meta.source).toBe('invalid-contract-id');
    expect(meta.issuerKind).toBe('classic');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('surfaces a retryable error on HTTP 503', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) } as never);

    await expect(
      fetchSacContractMetadata(SAC_CONTRACT_ID, { horizonUrl: RPC_URL }),
    ).rejects.toMatchObject({ name: 'ContractLookupError', retryable: true });
  });

  it('surfaces a non-retryable error on HTTP 500', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as never);

    await expect(
      fetchSacContractMetadata(SAC_CONTRACT_ID, { horizonUrl: RPC_URL }),
    ).rejects.toMatchObject({ name: 'ContractLookupError', retryable: false });
  });
});

describe('Issue #730: C-address redaction in logs (src/logger.ts)', () => {
  it('redacts a contract id to first4...last4', () => {
    expect(redactContractAddress(SAC_CONTRACT_ID)).toBe('CAAA...D2KM');
  });

  it('agrees with redactStellarAddress so the two policies cannot drift', () => {
    expect(redactContractAddress(SAC_CONTRACT_ID)).toBe(redactStellarAddress(SAC_CONTRACT_ID));
  });

  it('never leaks a full C-address through a log context key', () => {
    for (const key of ['contractAddress', 'contractId', 'sacContractId', 'issuerContractId', 'assetIssuer']) {
      const safe = redactContext({ [key]: SAC_CONTRACT_ID });
      expect(safe?.[key]).toBe('CAAA...D2KM');
      expect(String(safe?.[key])).not.toContain(SAC_CONTRACT_ID);
    }
  });

  it('redacts a C-address embedded in free-form debug text', () => {
    const safe = redactContext({ note: `issuer ${SAC_CONTRACT_ID} is a SAC` });
    expect(safe?.note).toBe('issuer CAAA...D2KM is a SAC');
  });

  it('leaves a non-contract value untouched', () => {
    expect(redactContractAddress('not-a-contract')).toBe('not-a-contract');
    expect(redactContractAddress('')).toBe('');
  });
});
