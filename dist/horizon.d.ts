export interface HorizonBalanceNative {
    balance: string;
    asset_type: 'native';
    buying_liabilities: string;
    selling_liabilities: string;
}
export interface HorizonBalanceCredit {
    balance: string;
    asset_type: 'credit_alphanum4' | 'credit_alphanum12';
    asset_code: string;
    asset_issuer: string;
    buying_liabilities: string;
    selling_liabilities: string;
}
export type HorizonBalance = HorizonBalanceNative | HorizonBalanceCredit;
export interface HorizonAccount {
    id: string;
    account_id: string;
    sequence: string;
    subentry_count: number;
    balances: HorizonBalance[];
    num_sponsoring: number;
    num_sponsored: number;
}
export interface HorizonErrorResponse {
    type?: string;
    title?: string;
    status?: number;
    detail?: string;
}
export declare class HorizonError extends Error {
    readonly statusCode: number;
    readonly retryable: boolean;
    constructor(message: string, statusCode: number, retryable?: boolean);
}
export interface FetchAccountOptions {
    timeoutMs?: number;
    maxRetries?: number;
}
export declare function normalizeHorizonUrl(baseUrl: string): string;
export declare function isRetryableStatus(status: number): boolean;
export declare function parseRetryAfterMs(response: import('node-fetch').Response): number | null;
export declare function fetchAccount(horizonUrl: string, stellarAddress: string, options?: FetchAccountOptions): Promise<HorizonAccount>;
export declare function isCreditBalance(balance: HorizonBalance): balance is HorizonBalanceCredit;
export declare function getNativeBalance(account: HorizonAccount): string;
export declare function hasTrustline(account: HorizonAccount, assetCode: string, assetIssuer: string): boolean;
export declare function parseHorizonBalance(balance: string): number;
