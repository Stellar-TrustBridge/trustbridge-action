import { ValidationResult } from './checks';
import { ValidationDelta, ValidationArtifact } from './delta';
export interface ActionTimings {
    input_parse_ms?: number;
    horizon_fetch_ms?: number;
    checks_ms?: number;
    comment_post_ms?: number;
    total_ms?: number;
}
export interface ActionOutputExtras {
    horizonUrl?: string;
    assetCode?: string;
    assetIssuer?: string;
    timings?: ActionTimings;
    validatedAt?: string;
}
export interface ActionOutputs {
    trustline_exists: string;
    xlm_balance: string;
    account_funded: string;
    comment_url: string;
    full_report_path: string;
    ready: string;
    validated_at: string;
    reason_code: string;
    horizon_url: string;
    asset_code: string;
    asset_issuer: string;
    checks_json: string;
    asset_balance: string;
    native_balance: string;
    badge_markdown: string;
    badge_url: string;
    timings_json: string;
    timing_input_parse_ms: string;
    timing_horizon_fetch_ms: string;
    timing_checks_ms: string;
    timing_comment_post_ms: string;
    timing_total_ms: string;
    num_sponsoring: string;
    num_sponsored: string;
}
export declare function toActionOutputs(result: ValidationResult, commentUrl?: string, fullReportPath?: string, extras?: ActionOutputExtras): ActionOutputs;
export declare function setValidationOutputs(result: ValidationResult, commentUrl?: string, fullReportPath?: string, extras?: ActionOutputExtras): void;
export interface WriteValidationJsonOptions {
    result: ValidationResult;
    stellarAddress: string;
    assetCode: string;
    assetIssuer: string;
    horizonUrl?: string;
    outputPath: string;
    delta?: ValidationDelta | null;
    privacyMode?: boolean;
    workspaceRoot?: string;
}
/**
 * Write a structured `validation.json` artifact for security review and
 * cross-run delta comparison. Never includes `github_token` or auth headers.
 */
export declare function writeValidationJson(options: WriteValidationJsonOptions): ValidationArtifact;
