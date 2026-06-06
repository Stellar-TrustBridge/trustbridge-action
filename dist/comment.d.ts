import { CheckConfig, ValidationResult } from './checks';
export interface CommentConfig extends CheckConfig {
    stellarAddress: string;
    horizonUrl: string;
}
export declare function formatCommentBody(result: ValidationResult, config: CommentConfig): string;
export declare function postIssueComment(token: string, body: string): Promise<void>;
