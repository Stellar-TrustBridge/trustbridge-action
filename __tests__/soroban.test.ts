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
