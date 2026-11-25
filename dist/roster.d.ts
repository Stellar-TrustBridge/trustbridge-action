import { AssigneeAddressMap } from './inputs';
export interface RosterFilterOptions {
    /** Exact addresses or bounded globs using `*` and `?`. */
    allowlist?: string[];
    /** Exact addresses or bounded globs using `*` and `?`; deny wins.
    ocument operator remediation; test both paths in batch mode.
    */
    denylist?: string[];
}
/** Linear-time glob matcher. It does not compile user input into a RegExp. */
export declare function matchesRosterPattern(value: string, pattern: string): boolean;
/**
 * Filter a batch assignee address map against roster allowlist/denylist entries.
 *
 * - Allowlist: when non-empty, only entries whose address is in the allowlist are kept.
 * - Denylist: entries whose address is in the denylist are always removed.
 * - Denylist takes precedence over allowlist.
 * - Empty allowlist means "allow all" (subject to denylist).
 * - Empty map returns an empty map.
 * - Matching is case-insensitive and whitespace-trimmed.
 */
export declare function filterRosterAddressMap(addressMap: AssigneeAddressMap, options?: RosterFilterOptions): AssigneeAddressMap;
/** One rejected duplicate address — kept for the summary, excluded from the usable roster. */
export interface RosterCsvDuplicateEntry {
    /** The address as it first appeared (normalization is for matching only). */
    address: string;
    /** 1-based line number of the first (kept) occurrence. */
    firstLineNumber: number;
    /** 1-based line number of this duplicate occurrence. */
    lineNumber: number;
}
/** One rejected row — kept for the summary, excluded from the usable roster. */
export interface RosterCsvInvalidEntry {
    /** 1-based line number in the original CSV text. */
    lineNumber: number;
    /** Raw, unmodified line content (for operator troubleshooting). */
    raw: string;
    /** Stable, human-readable rejection reason. */
    reason: string;
}
/** Aggregate counts for {@link RosterCsvImportResult}. */
export interface RosterCsvImportSummary {
    totalDataRows: number;
    validCount: number;
    duplicateCount: number;
    invalidCount: number;
}
export interface RosterCsvImportResult {
    /**
     * GitHub login (lowercased) -> Stellar address, for rows that had a login
     * column. Only valid, first-seen-address rows are included — compatible
     * with `resolveAddressFromAssigneeMap` / `filterRosterAddressMap`.
     */
    addressMap: AssigneeAddressMap;
    /**
     * Valid, de-duplicated addresses in first-seen order — the exact shape
     * `src/batch.ts`'s `runBatchValidation` / `parseBatchAddresses` consume.
     */
    addresses: string[];
    /** Addresses rejected because an earlier row already claimed them. */
    duplicates: RosterCsvDuplicateEntry[];
    /** Rows rejected because the address column was not a valid G- or C-address. */
    invalid: RosterCsvInvalidEntry[];
    summary: RosterCsvImportSummary;
    /**
     * Human-readable Markdown summary (counts plus up to
     * `MAX_SUMMARY_ROWS_LISTED` example rows per rejected category), suitable
     * for a job log or an issue/PR comment posted before batch validation runs.
     */
    summaryMarkdown: string;
}
/**
 * True when a cell starts with a spreadsheet formula trigger (`=`, `+`, `-`,
 * `@`, tab or CR). Such cells are rejected rather than imported so an
 * Excel-exported roster can never smuggle a formula (CSV injection) into
 * downstream reports (Issue #953).
 */
export declare function isCsvFormulaCell(cell: string): boolean;
/**
 * Parse a CSV roster of Stellar addresses (optionally paired with GitHub
 * logins) into a validated, de-duplicated roster plus a rejection summary
 * (Issue #798).
 *
 * Accepted shapes (header row optional, detected automatically):
 * - Single column: one address per line.
 * - Two columns: `login,address` (or `address,login` via a named header).
 *
 * Validation rules:
 * - Blank lines are skipped.
 * - A row whose address column fails `isValidStellarAddress` (StrKey
 *   checksum validation for G-addresses, structural validation for
 *   C-addresses) is rejected into `invalid` and excluded from the roster.
 * - A row whose address duplicates an earlier *valid* row's address
 *   (case-insensitive, matching `normalizeRosterAddress`) is rejected into
 *   `duplicates` — the first occurrence wins and stays in the roster.
 * - Only genuinely empty input, or input with zero data rows, throws; a
 *   roster with some bad rows among good ones still returns a usable
 *   (partial) roster plus a complete rejection report, so one typo does not
 *   block an entire Wave payout batch.
 *
 * @param csvText Raw CSV file contents.
 * @throws If `csvText` is empty/whitespace-only, contains no data rows, or
 *         has a header row that does not name a recognised address column.
 */
export declare function parseRosterCsv(csvText: string): RosterCsvImportResult;
export declare function fetchDashboardRoster(url: string, secret: string, timeoutMs: number, allowHttp?: boolean, fetchFn?: typeof fetch): Promise<AssigneeAddressMap>;
