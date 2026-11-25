import * as core from '@actions/core';
import * as github from '@actions/github';
/** Standard locations where CODEOWNERS can reside in a repository. */
export declare const CODEOWNERS_STANDARD_PATHS: string[];
/**
 * Parse the contents of a CODEOWNERS file into a normalized Set of owner handles.
 * Handles `@username`, `@org/team`, emails, and raw usernames.
 * Comments (`#`) and empty lines are ignored.
 */
export declare function parseCodeowners(content: string): Set<string>;
/**
 * Normalize an owner handle from CODEOWNERS or allowlist (lowercase, strip leading @).
 */
export declare function normalizeOwnerHandle(handle: string): string;
export interface CodeownersRule {
    /** Raw pattern token from the CODEOWNERS line (e.g. `src/payments/**`). */
    pattern: string;
    /** Normalized owner handles for this rule. */
    owners: string[];
}
/**
 * Parse CODEOWNERS content into ordered rules (pattern + owners).
 * Comments and empty lines are ignored. Rules with no owners are skipped.
 */
export declare function parseCodeownersRules(content: string): CodeownersRule[];
/**
 * Determine whether a given file path is covered by any CODEOWNERS rule.
 * Returns the matching rule (last match wins, per GitHub semantics) or null.
 */
export declare function findCoveringRule(filePath: string, rules: CodeownersRule[]): CodeownersRule | null;
export interface CodeownersCoverageResult {
    /** Paths that have at least one owner. */
    covered: string[];
    /** Paths with no matching CODEOWNERS rule (or a rule with no owners). */
    uncovered: string[];
    /** True when no CODEOWNERS rules were loaded at all. */
    missingCodeowners: boolean;
}
/**
 * Check reviewer coverage for a set of TrustBridge-touched paths against parsed
 * CODEOWNERS rules. Used by preflight to surface missing reviewer coverage.
 */
export declare function checkCodeownersCoverage(touchedPaths: string[], rules: CodeownersRule[]): CodeownersCoverageResult;
/**
 * Per-file detail produced by {@link checkCodeownersCoverageWithDetail}.
 */
export interface CodeownersCoverageDetail {
    /** The file path that was checked. */
    filePath: string;
    /** Whether the file has at least one owner via a matching rule. */
    covered: boolean;
    /**
     * The CODEOWNERS pattern that won (last-match-wins), or `null` when no rule
     * matched. This is the value cited in preflight PR comments.
     */
    matchedPattern: string | null;
    /** Owners assigned by the winning rule, or an empty array when uncovered. */
    owners: string[];
}
/**
 * Like {@link checkCodeownersCoverage} but returns per-file detail including
 * the winning rule's pattern so preflight comments can cite it precisely.
 *
 * **Precedence rule (GitHub semantics):** the last matching rule in the
 * CODEOWNERS file wins. When multiple patterns match a path, the one that
 * appears latest in the file is authoritative.
 *
 * Example — given this CODEOWNERS file:
 * ```
 * *            @global-owner
 * src/**       @backend-team
 * src/payments @payments-team
 * ```
 * The file `src/payments/invoice.ts` matches all three rules; the winning rule
 * is `src/payments` (last) and the owners are `['payments-team']`.
 *
 * @param touchedPaths - File paths relative to the repository root.
 * @param rules        - Parsed rules in file order (first → last).
 */
export declare function checkCodeownersCoverageWithDetail(touchedPaths: string[], rules: CodeownersRule[]): {
    details: CodeownersCoverageDetail[];
    covered: string[];
    uncovered: string[];
    missingCodeowners: boolean;
};
/**
 * Build a human-readable note for a preflight PR comment that cites the
 * winning CODEOWNERS rule for a given file.
 *
 * Returns a string like:
 * ```
 * src/payments/invoice.ts → matched pattern `src/payments` → owners: @payments-team
 * ```
 * or, when the file is uncovered:
 * ```
 * src/payments/invoice.ts → no CODEOWNERS rule matched
 * ```
 *
 * @param detail - One entry from {@link checkCodeownersCoverageWithDetail}.
 */
export declare function formatMatchedPatternNote(detail: CodeownersCoverageDetail): string;
export interface LoadCodeownersOptions {
    workspaceRoot?: string;
    customPath?: string;
    githubToken?: string;
    octokit?: ReturnType<typeof github.getOctokit>;
    isForkPr?: boolean;
    baseRef?: string;
    owner?: string;
    repo?: string;
    /**
     * What to do when no CODEOWNERS file exists at any searched path
     * (Issue #912). Defaults to `'warn'`.
     */
    missingMode?: CodeownersMissingMode;
    /**
     * Injectable warning sink for tests. Defaults to `core.warning`, which
     * emits a GitHub warning annotation.
     */
    warn?: (message: string, properties?: core.AnnotationProperties) => void;
}
/**
 * How a missing CODEOWNERS file is handled (Issue #912).
 *
 * - `warn` (default): emit a warning annotation and continue with no
 *   CODEOWNERS-derived maintainers (`maintainers_allowlist` still applies).
 * - `strict`: throw {@link CodeownersMissingError} so the run fails.
 */
export type CodeownersMissingMode = 'warn' | 'strict';
/** Every supported {@link CodeownersMissingMode}. */
export declare const CODEOWNERS_MISSING_MODES: readonly CodeownersMissingMode[];
/** Stable reason code carried by {@link CodeownersMissingError}. */
export declare const CODEOWNERS_MISSING_REASON_CODE = "CODEOWNERS_MISSING";
/** Title of the warning annotation emitted in `warn` mode. */
export declare const CODEOWNERS_MISSING_ANNOTATION_TITLE = "TrustBridge: CODEOWNERS not found";
/**
 * Parse a CODEOWNERS missing-mode value. Empty input yields `'warn'`.
 *
 * @throws On any value other than `warn` / `strict` (case-insensitive).
 */
export declare function parseCodeownersMissingMode(value: string | undefined): CodeownersMissingMode;
/** Thrown in `strict` mode when no CODEOWNERS file is found (Issue #912). */
export declare class CodeownersMissingError extends Error {
    readonly reasonCode = "CODEOWNERS_MISSING";
    /** Repository-relative paths that were searched, in order. */
    readonly searchedPaths: string[];
    constructor(searchedPaths: string[]);
}
/** Human-readable, actionable message for a missing CODEOWNERS file. */
export declare function formatCodeownersMissingMessage(searchedPaths: readonly string[], mode: CodeownersMissingMode): string;
/**
 * Load CODEOWNERS content with strict Branch Safety guarantees:
 * - On pull requests from forks (or untrusted PR heads), NEVER reads from the local PR workspace.
 * - Instead, fetches the trusted CODEOWNERS file from the base branch / default branch via GitHub API.
 * - When running in a trusted context (push, default branch, or workflow_dispatch), reads from local workspace.
 *
 * Issue #912: when no CODEOWNERS file exists at any searched path, the default
 * `missingMode: 'warn'` emits a warning annotation and returns an empty set;
 * `missingMode: 'strict'` throws {@link CodeownersMissingError} instead.
 */
export declare function loadCodeowners(options?: LoadCodeownersOptions): Promise<Set<string>>;
/**
 * Load CODEOWNERS rules (pattern + owners) using the same branch-safety guarantees
 * as {@link loadCodeowners}. Returns an empty array when no CODEOWNERS file is found
 * (after a warning annotation, or throws in `strict` missing mode — Issue #912).
 */
export declare function loadCodeownersRules(options?: LoadCodeownersOptions): Promise<CodeownersRule[]>;
/**
 * Check if the given actor is a maintainer according to CODEOWNERS or an explicit maintainers list.
 */
export declare function isMaintainerActor(actor: string, codeowners: Set<string>, maintainersAllowlist?: string[]): boolean;
