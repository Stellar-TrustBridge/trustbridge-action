export declare function parseBooleanInput(value: string, defaultValue: boolean): boolean;
export declare function parseNumberInput(value: string, defaultValue: number, options?: {
    min?: number;
    max?: number;
}): number;
export declare function getErrorMessage(error: unknown): string;
