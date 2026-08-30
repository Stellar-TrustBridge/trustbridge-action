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
/** Errors thrown by the contract registry client. */
export declare class ContractLookupError extends Error {
    readonly retryable: boolean;
    constructor(message: string, retryable: boolean);
}
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
export declare function buildGetPublicPaginatedXdr(contractId: string, cursor?: number, limit?: number): string;
export interface ContractRosterPage {
    map: Record<string, string>;
    nextCursor?: number;
}
export declare function parseRosterPageFromSimulateResult(json: unknown): ContractRosterPage;
export interface FetchFullRosterConfig extends ContractConfig {
    pageLimit: number;
}
export declare function fetchFullContractRoster(githubUsername: string, config: FetchFullRosterConfig): Promise<Record<string, string>>;
