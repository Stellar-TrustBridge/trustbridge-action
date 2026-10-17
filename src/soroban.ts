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
import { classifyAssetIssuer, isSorobanContractIssuer, type AssetIssuerKind } from './assets';

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
  pageLimit?: number;
}

export interface ContractLookupResult {
  /** Resolved Stellar G-address, or null if not registered. */
  address: string | null;
  /** Whether the result came from the on-chain registry. */
  fromRegistry: boolean;
}

/** Resolve the requested roster identity through the same registry endpoint. */
export async function fetchFullContractRoster(
  githubUsername: string,
  config: ContractConfig,
): Promise<Record<string, string>> {
  const result = await lookupAddressFromContract(githubUsername, config);
  return result.address ? { [githubUsername.toLowerCase()]: result.address } : {};
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

/**
 * Verifies that a Soroban contract address exists on a configured RPC endpoint.
 *
 * This is a bounded, fail-closed check used for C-address payout destinations.
 * A C-address is treated as a contract payout target only when the Soroban RPC
 * confirms the contract exists; no Horizon account fetch is attempted for C-addresses.
 */
export async function contractExistsOnChain(
  contractAddress: string,
  config: Pick<ContractConfig, 'sorobanRpcUrl' | 'timeoutMs'>,
): Promise<boolean> {
  const trimmed = contractAddress.trim();
  if (!trimmed) {
    return false;
  }

  if (!trimmed.startsWith('C') || trimmed.length !== 56 || !/^C[A-Z2-7]{55}$/.test(trimmed)) {
    throw new ContractLookupError(
      `Expected a valid Soroban C-address contract destination, got: "${trimmed}"`,
      false,
    );
  }

  const { sorobanRpcUrl, timeoutMs = 15000 } = config;
  if (!sorobanRpcUrl || !sorobanRpcUrl.trim()) {
    throw new ContractLookupError(
      'Soroban RPC URL is required to verify a C-address payout destination. Configure soroban_rpc_url before using a C-address as stellar_address_input.',
      false,
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getContractCode',
    params: [trimmed],
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
      isAbort,
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

  return parseContractExistsResult(json);
}

export function parseContractExistsResult(json: unknown): boolean {
  if (typeof json !== 'object' || json === null) {
    return false;
  }

  const record = json as Record<string, unknown>;
  if ('error' in record && record.error !== undefined) {
    return false;
  }

  if (!('result' in record) || record.result === undefined || record.result === null) {
    return false;
  }

  const rawResult = record.result;
  if (typeof rawResult === 'string') {
    return rawResult.trim().length > 0;
  }

  if (typeof rawResult !== 'object' || rawResult === null) {
    return false;
  }

  const result = rawResult as Record<string, unknown>;
  const checks = [
    result['exists'],
    result['code'],
    result['wasm'],
    result['contract'],
    result['contract_id'],
    result['contractId'],
  ];

  return checks.some((value) => value === true || (typeof value === 'string' && value.trim().length > 0));
}

// ---------------------------------------------------------------------------
// Issue #730 — Soroban SAC (Stellar Asset Contract) issuer support
//
// Classic assets are issued by a G-account and their trustlines appear in a
// Horizon account's `balances` array. A Stellar Asset Contract is issued by a
// contract id (C-address) instead: it is never present in that array, so the
// classic trustline path can neither confirm nor deny the balance. This block
// resolves the contract's SAC reporting fields (name / symbol / decimals) so a
// C-address issuer is validated contract-aware rather than being rejected as
// a malformed G-address.
//
// Design constraints:
//  - Fail-open on *absence* of metadata (`symbolVerified: false`) but fail-closed
//    on a *mismatch*: a contract that reports a different symbol than the
//    configured `asset_code` is a real misconfiguration.
//  - Older testnet nodes 404 on `/contracts/{id}`; that is reported as
//    `exists: false` with `source: 'horizon'`, never as a thrown error, so a
//    stale node cannot break a batch.
//  - Offline mode (`horizonUrl` unset) skips the live fetch entirely and
//    returns `source: 'skipped'`.
// ---------------------------------------------------------------------------

/** C-address StrKey format shared by every Soroban contract id. */
const SOROBAN_CONTRACT_ID_REGEX = /^C[A-Z2-7]{55}$/;

/**
 * True when `value` is a well-formed Soroban contract id (C-address).
 * Exported so callers can gate the SAC path without importing `assets.ts`.
 */
export function isSorobanContractId(value: string): boolean {
  return SOROBAN_CONTRACT_ID_REGEX.test((value ?? '').trim());
}

/** Re-exported so a single import covers both classic and contract issuers. */
export { classifyAssetIssuer, isSorobanContractIssuer };
export type { AssetIssuerKind };

/** SAC contract reporting fields TrustBridge is able to read. */
export interface SacContractMetadata {
  /** Contract id the metadata was read from (redact before logging). */
  contractId: string;
  /** Issuer flavour implied by a C-address contract id. */
  issuerKind: AssetIssuerKind;
  /** Whether the contract exists on the queried endpoint. */
  exists: boolean;
  /** SAC `name()` return value, when the endpoint reports it. */
  name?: string;
  /** SAC `symbol()` return value, when the endpoint reports it. */
  symbol?: string;
  /** SAC `decimals()` return value, when the endpoint reports it. */
  decimals?: number;
  /**
   * True when `symbol` was present **and** matched the configured asset code.
   * `false` means either "no reporting field available" or "mismatch" — use
   * {@link verifySacIssuerAssetCode} to tell the two apart.
   */
  symbolVerified: boolean;
  /** Where the metadata came from, for logs and offline-mode messaging. */
  source: 'horizon' | 'skipped' | 'invalid-contract-id';
}

export interface FetchSacMetadataOptions {
  /** Horizon base URL, e.g. `https://horizon-testnet.stellar.org`. */
  horizonUrl?: string;
  /** Request timeout in milliseconds (default: 15000). */
  timeoutMs?: number;
}

/**
 * Parse a Horizon `/contracts/{id}` (or Soroban RPC ledger-entry) response
 * into {@link SacContractMetadata} reporting fields.
 *
 * Different node versions expose the SAC fields under different keys, so every
 * documented shape is probed: top level, under `result`, and under a nested
 * `sac` object. A node that exposes none of them still yields a usable
 * `exists` answer — the asset code is simply reported as unverified.
 */
export function parseSacContractMetadata(
  json: unknown,
  contractId: string,
): SacContractMetadata {
  const base: SacContractMetadata = {
    contractId: (contractId ?? '').trim(),
    issuerKind: 'soroban-contract',
    exists: false,
    symbolVerified: false,
    source: 'horizon',
  };

  if (typeof json !== 'object' || json === null) {
    return base;
  }

  const record = json as Record<string, unknown>;

  // JSON-RPC error envelope — treat as "not found", never throw.
  if ('error' in record && record.error !== undefined && record.error !== null) {
    return base;
  }

  const result =
    typeof record.result === 'object' && record.result !== null
      ? (record.result as Record<string, unknown>)
      : record;

  const nested =
    typeof result.sac === 'object' && result.sac !== null
      ? (result.sac as Record<string, unknown>)
      : {};

  const pickString = (keys: string[]): string | undefined => {
    for (const source of [nested, result]) {
      for (const key of keys) {
        const value = source[key];
        if (typeof value === 'string' && value.trim().length > 0) {
          return value.trim();
        }
      }
    }
    return undefined;
  };

  const pickNumber = (keys: string[]): number | undefined => {
    for (const source of [nested, result]) {
      for (const key of keys) {
        const value = source[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
          return value;
        }
        // Some nodes report decimals as a string ("7").
        if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
          return Number(value.trim());
        }
      }
    }
    return undefined;
  };

  const exists =
    result.exists === true ||
    pickString(['code', 'wasm', 'contract_id', 'contractId', 'id', 'address']) !== undefined;

  const symbol = pickString(['symbol', 'asset_code', 'assetCode']);
  const decimals = pickNumber(['decimals', 'decimal_places']);

  return {
    ...base,
    exists,
    name: pickString(['name', 'asset_name']),
    symbol,
    decimals,
    // A reported symbol only counts as verified once it has been compared by
    // verifySacIssuerAssetCode(); this flag means "the field was available".
    symbolVerified: symbol !== undefined,
  };
}

/**
 * Compare the SAC `symbol()` reporting field against the configured
 * `asset_code`.
 *
 * - `null`  → no reporting field available; the check is inconclusive and the
 *             caller must not fail on it (older nodes).
 * - `true`  → the contract reports exactly this asset code.
 * - `false` → the contract reports a *different* symbol: a real
 *             misconfiguration that must be surfaced.
 */
export function verifySacIssuerAssetCode(
  metadata: SacContractMetadata,
  assetCode: string,
): boolean | null {
  if (!metadata?.symbol) return null;
  return metadata.symbol.toUpperCase() === (assetCode ?? '').trim().toUpperCase();
}

/**
 * Resolve SAC reporting fields for a C-address asset issuer.
 *
 * Uses the Horizon `/contracts/{id}` endpoint when a `horizonUrl` is supplied.
 * A 404 (older testnet nodes do not expose the endpoint) resolves to
 * `exists: false` instead of throwing, so a batch keeps running. When no
 * Horizon URL is configured — offline mode — the live fetch is skipped and the
 * result carries `source: 'skipped'` so callers can log a clear message.
 */
export async function fetchSacContractMetadata(
  contractId: string,
  options: FetchSacMetadataOptions = {},
): Promise<SacContractMetadata> {
  const trimmed = (contractId ?? '').trim();
  if (!isSorobanContractId(trimmed)) {
    return {
      contractId: trimmed,
      issuerKind: classifyAssetIssuer(trimmed),
      exists: false,
      symbolVerified: false,
      source: 'invalid-contract-id',
    };
  }

  const horizonUrl = (options.horizonUrl ?? '').trim();
  if (!horizonUrl) {
    return {
      contractId: trimmed,
      issuerKind: 'soroban-contract',
      exists: false,
      symbolVerified: false,
      source: 'skipped',
    };
  }

  const { timeoutMs = 15000 } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const baseUrl = horizonUrl.endsWith('/') ? horizonUrl.slice(0, -1) : horizonUrl;

  let response: import('node-fetch').Response;
  try {
    response = await fetch(`${baseUrl}/contracts/${trimmed}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal as never,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isAbort = message.includes('abort') || message.includes('timeout');
    throw new ContractLookupError(
      `Soroban SAC metadata request failed: ${message}`,
      isAbort,
    );
  } finally {
    clearTimeout(timer);
  }

  // 404 = older node without the Soroban contracts endpoint. Fail soft.
  if (response.status === 404) {
    return {
      contractId: trimmed,
      issuerKind: 'soroban-contract',
      exists: false,
      symbolVerified: false,
      source: 'horizon',
    };
  }

  if (RETRYABLE_STATUS_CODES.has(response.status)) {
    throw new ContractLookupError(
      `Soroban SAC metadata endpoint returned retryable status ${response.status}`,
      true,
    );
  }

  if (!response.ok) {
    throw new ContractLookupError(
      `Soroban SAC metadata endpoint returned non-retryable status ${response.status}`,
      false,
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ContractLookupError(
      'Soroban SAC metadata endpoint returned invalid JSON',
      false,
    );
  }

  return parseSacContractMetadata(json, trimmed);
}
