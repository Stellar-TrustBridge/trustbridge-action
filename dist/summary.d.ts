import { ValidationResult } from './checks';
export interface CheckSummary {
    total: number;
    passed: number;
    failed: number;
    failedLabels: string[];
}
export declare function summarizeChecks(result: ValidationResult): CheckSummary;
export declare function formatFailureSummary(result: ValidationResult): string;
