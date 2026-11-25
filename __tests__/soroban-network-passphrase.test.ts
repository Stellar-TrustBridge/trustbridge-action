/**
 * Issue #925: Soroban network passphrase mismatch detection before RPC calls.
 */
import fetch from 'node-fetch';
import {
  assertSorobanNetworkPassphrase,
  contractExistsOnChain,
  ContractLookupError,
  lookupAddressFromContract,
  NetworkPassphraseMismatchError,
  SOROBAN_NETWORK_MISMATCH_REASON_CODE,
  __resetVerifiedSorobanNetworksForTests,
} from '../src/soroban';
import { buildSorobanContractConfig } from '../src/inputs';

jest.mock('node-fetch');
const mockFetch = fetch as jest.MockedFunction<typeof fetch>;

const RPC_URL = 'https://soroban-testnet.stellar.org';
const CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const TESTNET = 'Test SDF Network ; September 2015';
const PUBNET = 'Public Global Stellar Network ; September 2015';

function respond(body: unknown, status = 200): void {
  mockFetch.mockResolvedValueOnce({ ok: status < 400, status, json: async () => body } as never);
}

function rpcMethods(): string[] {
  return mockFetch.mock.calls.map((c) => JSON.parse(String((c[1] as { body: string }).body)).method);
}

beforeEach(() => {
  mockFetch.mockReset();
  __resetVerifiedSorobanNetworksForTests();
});

describe('Soroban network passphrase verification (Issue #925)', () => {
  it('verifies the network once, then performs lookups (happy path)', async () => {
    respond({ result: { passphrase: TESTNET } });
    respond({ result: { retval: { type: 'address', value: ADDRESS } } });
    respond({ result: { retval: { type: 'address', value: ADDRESS } } });

    const config = { sorobanRpcUrl: RPC_URL, contractId: CONTRACT, networkPassphrase: TESTNET };
    await expect(lookupAddressFromContract('alice', config)).resolves.toEqual({
      address: ADDRESS,
      fromRegistry: true,
    });
    await lookupAddressFromContract('alice', config);

    expect(rpcMethods()).toEqual(['getNetwork', 'simulateTransaction', 'simulateTransaction']);
  });

  it('fails with SOROBAN_NETWORK_MISMATCH before any contract call when networks differ', async () => {
    respond({ result: { passphrase: PUBNET } });
    const config = { sorobanRpcUrl: RPC_URL, contractId: CONTRACT, networkPassphrase: TESTNET };

    const error = await lookupAddressFromContract('alice', config).catch((e) => e);
    expect(error).toBeInstanceOf(NetworkPassphraseMismatchError);
    expect(error.reasonCode).toBe(SOROBAN_NETWORK_MISMATCH_REASON_CODE);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain(SOROBAN_NETWORK_MISMATCH_REASON_CODE);
    expect(rpcMethods()).toEqual(['getNetwork']);
  });

  it('also guards contractExistsOnChain', async () => {
    respond({ result: { passphrase: PUBNET } });
    await expect(
      contractExistsOnChain(CONTRACT, { sorobanRpcUrl: RPC_URL, networkPassphrase: TESTNET }),
    ).rejects.toBeInstanceOf(NetworkPassphraseMismatchError);
    expect(rpcMethods()).toEqual(['getNetwork']);
  });

  it('rejects a getNetwork response without a passphrase', async () => {
    respond({ result: {} });
    await expect(
      assertSorobanNetworkPassphrase({ sorobanRpcUrl: RPC_URL, networkPassphrase: TESTNET }),
    ).rejects.toThrow('did not include a network passphrase');
  });

  it('surfaces retryable HTTP failures from getNetwork', async () => {
    respond({}, 503);
    const error = await assertSorobanNetworkPassphrase({
      sorobanRpcUrl: RPC_URL,
      networkPassphrase: TESTNET,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(ContractLookupError);
    expect(error.retryable).toBe(true);
  });

  it('skips verification when no passphrase is configured (previous behavior)', async () => {
    respond({ result: { retval: { type: 'void' } } });
    await lookupAddressFromContract('alice', { sorobanRpcUrl: RPC_URL, contractId: CONTRACT });
    expect(rpcMethods()).toEqual(['simulateTransaction']);
  });

  it('buildSorobanContractConfig forwards network_passphrase', () => {
    expect(
      buildSorobanContractConfig({
        soroban_rpc_url: RPC_URL,
        contract_id: CONTRACT,
        network_passphrase: ` ${TESTNET} `,
      }),
    ).toEqual({ sorobanRpcUrl: RPC_URL, contractId: CONTRACT, networkPassphrase: TESTNET });
    expect(buildSorobanContractConfig({ soroban_rpc_url: '', contract_id: CONTRACT })).toBeNull();
  });
});
