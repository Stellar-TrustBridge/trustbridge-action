import { HorizonAccount } from './horizon';
/** Stellar public network base reserve per ledger entry (XLM). */
export declare const STELLAR_BASE_RESERVE_XLM = 0.5;
/** Minimum balance required to activate a new account (XLM). */
export declare const STELLAR_MIN_ACCOUNT_BALANCE_XLM = 1;
export interface CheckConfig {
    assetCode: string;
    assetIssuer: string;
    minXlmReserve: number;
}
export interface CheckResultItem {
    passed: boolean;
    label: string;
    detail: string;
}
export interface ValidationResult {
    valid: boolean;
    accountFunded: boolean;
    trustlineExists: boolean;
    xlmBalance: string;
    xlmReserveMet: boolean;
    checks: CheckResultItem[];
    remediation?: string;
}
export declare function normalizeStellarAddress(address: string): string;
export declare function isValidStellarAddress(address: string): boolean;
export declare function validateStellarAddress(address: string): void;
export declare function parseMinXlmReserve(value: string): number;
export declare function estimateTrustlineSetupCost(): number;
export declare function formatXlmDeficit(required: number, actual: number): string;
export declare function runAccountChecks(account: HorizonAccount, config: CheckConfig): ValidationResult;
export declare function unfundedAccountResult(stellarAddress: string, config: CheckConfig): ValidationResult;
export declare function getFailedCheckLabels(result: ValidationResult): string[];
export declare function horizonFailureResult(message: string, config: CheckConfig): ValidationResult;
export interface ReserveRequirement {
    required: number;
    actual: number;
    missing: string;
    met: boolean;
}
export declare function buildReserveRequirement(required: number, actual: number): ReserveRequirement;
