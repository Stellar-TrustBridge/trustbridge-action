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
import { classifyAssetIssuer, isSorobanContractIssuer, type AssetIssuerKind } from './assets';
/** Errors thrown by the contract registry client. */
export declare class ContractLookupError extends Error {
    readonly retryable: boolean;
    constructor(message: string, retryable: boolean);
}
/**
 * Canonical Soroban contract fixtures shared by docs and tests.
 *
 * These are the single source of truth referenced by
 * `docs/SOROBAN_CONTRACT_FIXTURES.md` and `__tests__/soroban.test.ts` so
 * contributors do not invent invalid C-addresses or SAC examples.
 *
 * Each value is a syntactically valid Stellar strkey:
 *   - C-addresses: `C` + 55 base32 chars (contract IDs)
 *   - G-addresses: `G` + 55 base32 chars (account IDs)
 *   - SAC asset strings: `CODE:ISSUER` (classic asset wrapped as a contract)
 */
export declare const SOROBAN_CONTRACT_FIXTURES: {
    /** Registry contract ID used by the trustbridge-contract lookup. */
    readonly registryContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    /** A second valid C-address for negative/alternate-path tests. */
    readonly alternateContractId: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    /** Valid Stellar G-address used as a resolved registry value. */
    readonly resolvedAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    /** SAC example: USDC classic asset wrapped as a Soroban contract. */
    readonly sacUsdc: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    /** SAC example: native XLM wrapped as a Soroban contract. */
    readonly sacNative: "native";
    /** Malformed C-address (too short) for failure-path tests. */
    readonly malformedContractId: "C123";
    /** Malformed G-address (invalid base32 chars) for failure-path tests. */
    readonly malformedAddress: "G000000000000000000000000000000000000000000000000000000";
};
export type SorobanContractFixture = keyof typeof SOROBAN_CONTRACT_FIXTURES;
/**
 * Returns a canonical fixture value by name.
 *
 * Throws a stable `ContractLookupError` for unknown fixture names so tests
 * and docs fail loudly instead of silently using an invalid address.
 */
export declare function getSorobanContractFixture(name: SorobanContractFixture): string;
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
export declare function fetchFullContractRoster(githubUsername: string, config: ContractConfig): Promise<Record<string, string>>;
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
export declare function lookupAddressFromContract(githubUsername: string, config: ContractConfig): Promise<ContractLookupResult>;
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
export declare function buildGetAddressXdr(contractId: string, githubUsername: string): string;
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
export declare function parseAddressFromSimulateResult(json: unknown): string | null;
/**
 * Verifies that a Soroban contract address exists on a configured RPC endpoint.
 *
 * This is a bounded, fail-closed check used for C-address payout destinations.
 * A C-address is treated as a contract payout target only when the Soroban RPC
 * confirms the contract exists; no Horizon account fetch is attempted for C-addresses.
 */
export declare function contractExistsOnChain(contractAddress: string, config: Pick<ContractConfig, 'sorobanRpcUrl' | 'timeoutMs'>): Promise<boolean>;
export declare function parseContractExistsResult(json: unknown): boolean;
/**
 * True when `value` is a well-formed Soroban contract id (C-address).
 * Exported so callers can gate the SAC path without importing `assets.ts`.
 */
export declare function isSorobanContractId(value: string): boolean;
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
export declare function parseSacContractMetadata(json: unknown, contractId: string): SacContractMetadata;
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
export declare function verifySacIssuerAssetCode(metadata: SacContractMetadata, assetCode: string): boolean | null;
/**
 * Resolve SAC reporting fields for a C-address asset issuer.
 *
 * Uses the Horizon `/contracts/{id}` endpoint when a `horizonUrl` is supplied.
 * A 404 (older testnet nodes do not expose the endpoint) resolves to
 * `exists: false` instead of throwing, so a batch keeps running. When no
 * Horizon URL is configured — offline mode — the live fetch is skipped and the
 * result carries `source: 'skipped'` so callers can log a clear message.
 */
export declare function fetchSacContractMetadata(contractId: string, options?: FetchSacMetadataOptions): Promise<SacContractMetadata>;
