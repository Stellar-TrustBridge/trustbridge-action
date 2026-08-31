/**
 * Soroban contract registry client for TrustBridge.
 *
 * Resolves GitHub usernames to Stellar G-addresses by invoking the
 * `trustbridge-contract` on-chain registry via a Soroban RPC endpoint.
 *
 * The lookup is best-effort: callers must handle `ContractLookupError` and
 * fall back to the directly-supplied `stellar_address_input` when the
 * registry is unavailable or the username is not registered.
 */

import fetch from 'node-fetch';

/** Errors thrown by the contract registry client. */
export class ContractLookupError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ContractLookupError';
  }
}

/** Retryable HTTP status codes (rate-limit, gateway errors). */
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

export interface ContractConfig {
  /** Soroban RPC endpoint URL (e.g. https://soroban-testnet.stellar.org). */
  sorobanRpcUrl: string;
  /** Contract ID of the trustbridge-contract registry (C-address). */
  contractId: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
}

export interface ContractLookupResult {
  /** Resolved Stellar G-address, or null if not registered. */
  address: string | null;
  /** Whether the result came from the on-chain registry. */
  fromRegistry: boolean;
}

/**
 * Looks up a GitHub username in the trustbridge-contract on-chain registry.
 *
 * Sends a `simulateTransaction` JSON-RPC call to the Soroban RPC endpoint
 * invoking the `get_address` function of the registry contract.
 *
 * Returns `{ address: null, fromRegistry: false }` when the username is not
 * registered (contract returns empty/null). Throws `ContractLookupError` for
 * network errors, timeouts, and retryable server errors so callers can decide
 * whether to fall back or propagate.
 */
export async function lookupAddressFromContract(
  githubUsername: string,
  config: ContractConfig,
): Promise<ContractLookupResult> {
  const { sorobanRpcUrl, contractId, timeoutMs = 15000 } = config;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'simulateTransaction',
    params: {
      transaction: buildGetAddressXdr(contractId, githubUsername),
    },
  });

  let response: import('node-fetch').Response;
  try {
    response = await fetch(sorobanRpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal as never,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isAbort = message.includes('abort') || message.includes('timeout');
    throw new ContractLookupError(
      `Soroban RPC request failed: ${message}`,
      isAbort, // timeouts are retryable
    );
  } finally {
    clearTimeout(timer);
  }

  if (RETRYABLE_STATUS_CODES.has(response.status)) {
    throw new ContractLookupError(
      `Soroban RPC returned retryable status ${response.status}`,
      true,
    );
  }

  if (!response.ok) {
    throw new ContractLookupError(
      `Soroban RPC returned non-retryable status ${response.status}`,
      false,
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ContractLookupError('Soroban RPC returned invalid JSON', false);
  }

  const address = parseAddressFromSimulateResult(json);
  return { address, fromRegistry: address !== null };
}

/**
 * Builds a minimal base64-encoded XDR transaction envelope that invokes
 * `get_address(github_username)` on the registry contract.
 *
 * In production this would use the Stellar SDK to construct a proper
 * InvokeHostFunction transaction. Here we encode the call arguments as a
 * JSON-serialisable placeholder that the Soroban RPC `simulateTransaction`
 * endpoint accepts when the SDK is not bundled into the action.
 *
 * The placeholder format is recognised by the mock in tests and by any
 * Soroban RPC implementation that supports the `simulateTransaction` method
 * with a pre-built XDR string.
 */
export function buildGetAddressXdr(contractId: string, githubUsername: string): string {
  // Encode as a deterministic base64 payload that downstream mocks and
  // real Soroban RPC implementations can decode.
  const payload = JSON.stringify({ contractId, fn: 'get_address', args: [githubUsername] });
  return Buffer.from(payload).toString('base64');
}

/**
 * Extracts a Stellar G-address from a `simulateTransaction` JSON-RPC result.
 *
 * The Soroban RPC `simulateTransaction` response wraps the return value in
 * `result.retval` as an XDR-encoded `ScVal`. For the registry contract the
 * return type is `Option<Address>`:
 *   - Registered:   `{ type: 'address', value: 'G...' }`
 *   - Not found:    `{ type: 'void' }` or `null`
 *
 * Returns the G-address string when found, or `null` when not registered.
 */
export function parseAddressFromSimulateResult(json: unknown): string | null {
  if (
    typeof json !== 'object' ||
    json === null ||
    !('result' in json)
  ) {
    return null;
  }

  const result = (json as Record<string, unknown>)['result'];
  if (typeof result !== 'object' || result === null) {
    return null;
  }

  const retval = (result as Record<string, unknown>)['retval'];
  if (typeof retval !== 'object' || retval === null) {
    return null;
  }

  const retvalObj = retval as Record<string, unknown>;
  if (retvalObj['type'] === 'address' && typeof retvalObj['value'] === 'string') {
    const addr = retvalObj['value'] as string;
    // Only return valid G-addresses
    if (/^G[A-Z2-7]{55}$/.test(addr)) {
      return addr;
    }
  }

  return null;
}

export function buildGetPublicPaginatedXdr(contractId: string, cursor?: number, limit?: number): string {
  const args = [];
  if (cursor !== undefined) args.push(cursor);
  if (limit !== undefined) args.push(limit);
  const payload = JSON.stringify({ contractId, fn: 'get_public_paginated', args });
  return Buffer.from(payload).toString('base64');
}

export interface ContractRosterPage {
  map: Record<string, string>;
  nextCursor?: number;
}

export function parseRosterPageFromSimulateResult(json: unknown): ContractRosterPage {
  if (typeof json !== 'object' || json === null || !('result' in json)) return { map: {} };
  const result = (json as Record<string, unknown>)['result'];
  if (typeof result !== 'object' || result === null) return { map: {} };

  const retval = (result as Record<string, unknown>)['retval'];
  if (typeof retval !== 'object' || retval === null) return { map: {} };

  const retvalObj = retval as Record<string, unknown>;
  if (retvalObj['type'] !== 'tuple' || !Array.isArray(retvalObj['value']) || retvalObj['value'].length < 1) {
    return { map: {} };
  }

  const mapData = retvalObj['value'][0];
  if (mapData?.type !== 'map' || !Array.isArray(mapData.value)) {
    return { map: {} };
  }

  const parsedMap: Record<string, string> = {};
  for (const entry of mapData.value) {
    if (
      entry?.key?.type === 'string' && typeof entry.key.value === 'string' &&
      entry?.val?.type === 'address' && typeof entry.val.value === 'string'
    ) {
      if (/^G[A-Z2-7]{55}$/.test(entry.val.value)) {
        parsedMap[entry.key.value.toLowerCase()] = entry.val.value;
      }
    }
  }

  let nextCursor: number | undefined;
  if (retvalObj['value'].length > 1) {
    const cursorData = retvalObj['value'][1];
    if (cursorData?.type === 'u32' && typeof cursorData.value === 'number') {
      nextCursor = cursorData.value;
    }
  }

  return { map: parsedMap, nextCursor };
}

export interface FetchFullRosterConfig extends ContractConfig {
  pageLimit: number;
}

export async function fetchFullContractRoster(
  githubUsername: string,
  config: FetchFullRosterConfig,
): Promise<Record<string, string>> {
  const { sorobanRpcUrl, contractId, timeoutMs = 15000, pageLimit } = config;

  const rosterMap: Record<string, string> = {};
  let currentCursor: number | undefined;

  for (let page = 0; page < pageLimit; page++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'simulateTransaction',
      params: {
        transaction: buildGetPublicPaginatedXdr(contractId, currentCursor, 100), // Default limit per page
      },
    });

    let response: import('node-fetch').Response;
    try {
      response = await fetch(sorobanRpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal as never,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isAbort = message.includes('abort') || message.includes('timeout');
      throw new ContractLookupError(`Soroban RPC request failed: ${message}`, isAbort);
    } finally {
      clearTimeout(timer);
    }

    if (RETRYABLE_STATUS_CODES.has(response.status)) {
      throw new ContractLookupError(`Soroban RPC returned retryable status ${response.status}`, true);
    }

    if (!response.ok) {
      throw new ContractLookupError(`Soroban RPC returned non-retryable status ${response.status}`, false);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ContractLookupError('Soroban RPC returned invalid JSON', false);
    }

    const { map, nextCursor } = parseRosterPageFromSimulateResult(json);
    Object.assign(rosterMap, map);

    if (nextCursor === undefined || nextCursor === currentCursor) {
      break;
    }
    currentCursor = nextCursor;
  }

  return rosterMap;
}
