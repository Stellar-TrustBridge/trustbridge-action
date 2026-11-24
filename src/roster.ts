import * as crypto from 'crypto';
import { AssigneeAddressMap } from './inputs';
import { validateSsrfSafeUrl } from './validation';
import { isValidStellarAddress } from './checks';

const MAX_ROSTER_SIZE_BYTES = 1024 * 1024; // 1 MB limit

export interface RosterFilterOptions {
  /** Exact addresses or bounded globs using `*` and `?`. */
  allowlist?: string[];
  /** Exact addresses or bounded globs using `*` and `?`; deny wins. */
  denylist?: string[];
}

const MAX_PATTERN_LENGTH = 256;
const MAX_WILDCARDS = 32;

function validateRosterPattern(pattern: string): string {
  const normalized = normalizeRosterAddress(pattern);
  if (normalized.length > MAX_PATTERN_LENGTH) throw new Error('Roster pattern exceeds the 256-character limit.');
  const wildcards = (normalized.match(/[?*]/g) ?? []).length;
  if (wildcards > MAX_WILDCARDS) throw new Error('Roster pattern exceeds the 32-wildcard limit.');
  return normalized;
}

/** Linear-time glob matcher. It does not compile user input into a RegExp. */
export function matchesRosterPattern(value: string, pattern: string): boolean {
  const text = normalizeRosterAddress(value);
  const glob = validateRosterPattern(pattern);
  let i = 0; let j = 0; let star = -1; let mark = 0;
  while (i < text.length) {
    if (j < glob.length && (glob[j] === '?' || glob[j] === text[i])) { i++; j++; continue; }
    if (j < glob.length && glob[j] === '*') { star = j++; mark = i; continue; }
    if (star !== -1) { j = star + 1; i = ++mark; continue; }
    return false;
  }
  while (j < glob.length && glob[j] === '*') j++;
  return j === glob.length;
}

function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesRosterPattern(value, pattern));
}

function normalizeRosterAddress(address: string): string {
  return address.trim().toLowerCase();
}

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
export function filterRosterAddressMap(
  addressMap: AssigneeAddressMap,
  options: RosterFilterOptions = {}
): AssigneeAddressMap {
  const allowlist = (options.allowlist ?? []).map(validateRosterPattern).filter(Boolean);
  const denylist = (options.denylist ?? []).map(validateRosterPattern).filter(Boolean);

  const result: AssigneeAddressMap = {};
  for (const [key, value] of Object.entries(addressMap)) {
    const normalized = normalizeRosterAddress(value);
    if (matchesAny(normalized, denylist)) continue;
    if (allowlist.length > 0 && !matchesAny(normalized, allowlist)) continue;
    result[key] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// CSV roster import (Issue #798)
// ---------------------------------------------------------------------------

/** Maximum rows listed per category in {@link RosterCsvImportResult.summaryMarkdown}. */
const MAX_SUMMARY_ROWS_LISTED = 20;

/** Header column names recognised as the GitHub login/username column (case-insensitive). */
const LOGIN_HEADER_NAMES = new Set(['login', 'username', 'github', 'github_username', 'assignee']);
/** Header column names recognised as the Stellar address column (case-insensitive). */
const ADDRESS_HEADER_NAMES = new Set(['address', 'stellar_address', 'wallet', 'account', 'g_address']);

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
 * Split one CSV record into trimmed cells (Issue #953).
 *
 * Accepted dialect (RFC 4180 subset, what Excel / Google Sheets export):
 * - Comma delimiter.
 * - Optional double quotes around a cell; a quoted cell may contain commas
 *   (`"Doe, Jane"`) and escaped quotes written as `""`.
 * - Surrounding whitespace outside quotes is trimmed.
 *
 * Records are split on CRLF, CR or LF before this is called, so multi-line
 * quoted cells are not supported (a roster never needs them).
 *
 * @throws If a quoted cell is not terminated on the same line.
 */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let i = 0;
  const n = line.length;
  for (;;) {
    while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
    let cell = '';
    if (line[i] === '"') {
      i++;
      let closed = false;
      while (i < n) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            cell += '"';
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        cell += line[i++];
      }
      if (!closed) {
        throw new Error('Roster CSV has an unterminated quoted field.');
      }
      while (i < n && line[i] !== ',') i++;
    } else {
      while (i < n && line[i] !== ',') cell += line[i++];
    }
    cells.push(cell.trim());
    if (i >= n) break;
    i++; // skip comma
  }
  return cells;
}

/**
 * True when a cell starts with a spreadsheet formula trigger (`=`, `+`, `-`,
 * `@`, tab or CR). Such cells are rejected rather than imported so an
 * Excel-exported roster can never smuggle a formula (CSV injection) into
 * downstream reports (Issue #953).
 */
export function isCsvFormulaCell(cell: string): boolean {
  return /^[=+\-@\t\r]/.test(cell);
}

/** Column count of a record, tolerating a malformed row (rejected later). */
function countCsvColumns(line: string): number {
  try {
    return splitCsvLine(line).length;
  } catch {
    return line.split(',').length;
  }
}

/** UTF-8 byte order mark that Excel prepends to "CSV UTF-8" exports. */
const UTF8_BOM = '\uFEFF';

/** True when `cells` looks like a header row naming known login/address columns. */
function looksLikeHeaderRow(cells: string[]): boolean {
  return cells.some(
    (cell) =>
      LOGIN_HEADER_NAMES.has(cell.toLowerCase()) || ADDRESS_HEADER_NAMES.has(cell.toLowerCase()),
  );
}

/**
 * Locate the login and address column indices.
 *
 * With a recognised header row, columns are matched by name (order-
 * independent). Without one, a single-column CSV is treated as
 * address-only; a multi-column CSV assumes `login,address` order, matching
 * the shape documented in docs/USAGE.md.
 */
function resolveColumns(
  headerCells: string[] | null,
  columnCount: number,
): { loginIndex: number | null; addressIndex: number } {
  if (headerCells) {
    const lower = headerCells.map((c) => c.toLowerCase());
    const loginIndex = lower.findIndex((c) => LOGIN_HEADER_NAMES.has(c));
    const addressIndex = lower.findIndex((c) => ADDRESS_HEADER_NAMES.has(c));
    if (addressIndex === -1) {
      throw new Error(
        'Roster CSV header row does not name an address column. ' +
          `Expected one of: ${[...ADDRESS_HEADER_NAMES].join(', ')}.`,
      );
    }
    return { loginIndex: loginIndex === -1 ? null : loginIndex, addressIndex };
  }

  if (columnCount <= 1) {
    return { loginIndex: null, addressIndex: 0 };
  }
  return { loginIndex: 0, addressIndex: 1 };
}

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
export function parseRosterCsv(csvText: string): RosterCsvImportResult {
  const trimmedInput = (csvText ?? '').trim();
  if (!trimmedInput) {
    throw new Error('Roster CSV is empty. Provide at least a header row and one address row.');
  }

  // Excel "CSV UTF-8" exports start with a BOM, which would otherwise glue
  // itself onto the first header cell and hide the header (Issue #953).
  const withoutBom = csvText.startsWith(UTF8_BOM) ? csvText.slice(1) : csvText;
  const rawLines = withoutBom.split(/\r\n|\r|\n/);
  // (line numbers are 1-based against the original, un-trimmed input)
  const nonBlankLineNumbers: number[] = [];
  rawLines.forEach((line, i) => {
    if (line.trim().length > 0) nonBlankLineNumbers.push(i + 1);
  });

  if (nonBlankLineNumbers.length === 0) {
    throw new Error('Roster CSV contains no non-empty lines.');
  }

  let firstDataLineIndex = 0;
  const firstCells = splitCsvLine(rawLines[nonBlankLineNumbers[0] - 1]);
  const hasHeader = looksLikeHeaderRow(firstCells);
  if (hasHeader) {
    firstDataLineIndex = 1;
  }

  const dataLineNumbers = nonBlankLineNumbers.slice(firstDataLineIndex);
  if (dataLineNumbers.length === 0) {
    throw new Error('Roster CSV has a header row but no data rows.');
  }

  const { loginIndex, addressIndex } = resolveColumns(
    hasHeader ? firstCells : null,
    countCsvColumns(rawLines[dataLineNumbers[0] - 1]),
  );

  const addressMap: AssigneeAddressMap = {};
  const addresses: string[] = [];
  const duplicates: RosterCsvDuplicateEntry[] = [];
  const invalid: RosterCsvInvalidEntry[] = [];
  const seenAddresses = new Map<string, { address: string; lineNumber: number }>();

  for (const lineNumber of dataLineNumbers) {
    const raw = rawLines[lineNumber - 1];
    let cells: string[];
    try {
      cells = splitCsvLine(raw);
    } catch (err) {
      invalid.push({ lineNumber, raw, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const formulaCell = cells.find(isCsvFormulaCell);
    if (formulaCell !== undefined) {
      invalid.push({
        lineNumber,
        raw,
        reason: 'Row contains a spreadsheet formula cell (starts with =, +, -, @); formulas are rejected.',
      });
      continue;
    }
    const address = (cells[addressIndex] ?? '').trim();
    const login = loginIndex !== null ? (cells[loginIndex] ?? '').trim() : '';

    if (!address) {
      invalid.push({ lineNumber, raw, reason: 'Address column is empty.' });
      continue;
    }

    if (!isValidStellarAddress(address)) {
      invalid.push({
        lineNumber,
        raw,
        reason: `"${address}" is not a valid Stellar G- or C-address (StrKey checksum failed).`,
      });
      continue;
    }

    const normalized = normalizeRosterAddress(address);
    const existing = seenAddresses.get(normalized);
    if (existing) {
      duplicates.push({ address, firstLineNumber: existing.lineNumber, lineNumber });
      continue;
    }
    seenAddresses.set(normalized, { address, lineNumber });

    addresses.push(address);
    if (login) {
      addressMap[login.toLowerCase()] = address;
    }
  }

  const summary: RosterCsvImportSummary = {
    totalDataRows: dataLineNumbers.length,
    validCount: addresses.length,
    duplicateCount: duplicates.length,
    invalidCount: invalid.length,
  };

  const summaryMarkdown = buildRosterCsvSummaryMarkdown(summary, duplicates, invalid);

  return { addressMap, addresses, duplicates, invalid, summary, summaryMarkdown };
}

/** Render the Markdown summary for a parsed roster CSV (Issue #798). */
function buildRosterCsvSummaryMarkdown(
  summary: RosterCsvImportSummary,
  duplicates: RosterCsvDuplicateEntry[],
  invalid: RosterCsvInvalidEntry[],
): string {
  const lines: string[] = [
    '### Roster CSV import summary',
    '',
    `- Rows read: **${summary.totalDataRows}**`,
    `- Valid, unique addresses: **${summary.validCount}**`,
    `- Rejected duplicates: **${summary.duplicateCount}**`,
    `- Rejected invalid addresses: **${summary.invalidCount}**`,
  ];

  if (duplicates.length > 0) {
    lines.push('', '**Duplicate addresses (first occurrence kept):**');
    for (const dup of duplicates.slice(0, MAX_SUMMARY_ROWS_LISTED)) {
      lines.push(`- Line ${dup.lineNumber}: \`${dup.address}\` already seen at line ${dup.firstLineNumber}`);
    }
    if (duplicates.length > MAX_SUMMARY_ROWS_LISTED) {
      lines.push(`- _…and ${duplicates.length - MAX_SUMMARY_ROWS_LISTED} more duplicate row(s)._`);
    }
  }

  if (invalid.length > 0) {
    lines.push('', '**Invalid rows (excluded from the roster):**');
    for (const row of invalid.slice(0, MAX_SUMMARY_ROWS_LISTED)) {
      lines.push(`- Line ${row.lineNumber}: ${row.reason}`);
    }
    if (invalid.length > MAX_SUMMARY_ROWS_LISTED) {
      lines.push(`- _…and ${invalid.length - MAX_SUMMARY_ROWS_LISTED} more invalid row(s)._`);
    }
  }

  return lines.join('\n');
}

export async function fetchDashboardRoster(
  url: string,
  secret: string,
  timeoutMs: number,
  allowHttp: boolean = false,
  fetchFn: typeof fetch = fetch
): Promise<AssigneeAddressMap> {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) {
    throw new Error('Dashboard roster URL cannot be empty.');
  }

  const ssrfCheck = validateSsrfSafeUrl(trimmedUrl, 'dashboard_roster_url', { allowHttp });
  if (!ssrfCheck.valid) {
    throw new Error(`Dashboard roster URL failed security validation: ${ssrfCheck.errors.join(', ')}`);
  }

  const timestamp = Date.now().toString();
  const signature = secret
    ? crypto.createHmac('sha256', secret).update(timestamp).digest('hex')
    : '';

  const headers: Record<string, string> = {
    'Accept': 'application/json',
  };

  if (signature) {
    headers['X-TrustBridge-Timestamp'] = timestamp;
    headers['X-TrustBridge-Signature'] = `sha256=${signature}`;
  }

  let currentResponse: Response;
  let targetUrl = trimmedUrl;
  let redirects = 0;

  while (true) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      currentResponse = await fetchFn(targetUrl, {
        method: 'GET',
        headers,
        signal: controller.signal as AbortSignal,
        redirect: 'manual', // We handle redirects manually for SSRF validation
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to fetch dashboard roster: ${msg}`);
    } finally {
      clearTimeout(timeoutId);
    }

    if ([301, 302, 303, 307, 308].includes(currentResponse.status)) {
      if (redirects >= 5) throw new Error('Too many redirects');
      redirects++;
      const location = currentResponse.headers.get('location');
      if (!location) throw new Error('Redirect missing location');

      const redirectUrl = new URL(location, targetUrl).toString();
      const redirectSsrf = validateSsrfSafeUrl(redirectUrl, 'dashboard_roster_redirect', { allowHttp });
      if (!redirectSsrf.valid) {
        throw new Error(`Dashboard roster redirect failed security validation: ${redirectSsrf.errors.join(', ')}`);
      }

      targetUrl = redirectUrl;
      continue;
    }

    break;
  }

  if (!currentResponse.ok) {
    throw new Error(`Dashboard roster returned HTTP ${currentResponse.status}`);
  }

  if (!currentResponse.body) {
     throw new Error('Response body is empty');
  }

  // Stream body to enforce size limit safely
  const body = currentResponse.body;
  let receivedBytes = 0;
  const chunks: Uint8Array[] = [];

  if (body && typeof body.getReader === 'function') {
    // Web Streams API
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          receivedBytes += value.length;
          if (receivedBytes > MAX_ROSTER_SIZE_BYTES) {
            throw new Error('Response exceeded size limit');
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
  } else if (body && typeof (body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
    // Node streams or other AsyncIterables
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      const data = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
      receivedBytes += data.length;
      if (receivedBytes > MAX_ROSTER_SIZE_BYTES) {
        throw new Error('Response exceeded size limit');
      }
      chunks.push(data);
    }
  } else {
    // Fallback to arrayBuffer if no streaming is available
    const buffer = await currentResponse.arrayBuffer();
    if (buffer.byteLength > MAX_ROSTER_SIZE_BYTES) {
      throw new Error('Response exceeded size limit');
    }
    chunks.push(new Uint8Array(buffer));
  }

  const text = Buffer.concat(chunks).toString('utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Dashboard roster returned invalid JSON');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Dashboard roster JSON must be an object');
  }

  const result: AssigneeAddressMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') {
       throw new Error(`Dashboard roster entry for "${key}" must be a string Stellar G-address.`);
    }
    result[key.trim().toLowerCase()] = value.trim();
  }

  return result;
}
