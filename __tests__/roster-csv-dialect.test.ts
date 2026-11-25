import { parseRosterCsv, isCsvFormulaCell } from '../src/roster';

const ADDR_1 = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const ADDR_2 = 'GBHWA4MCSOSLLRWX5D4QUGZMHVHF64EBSKR3JROW474ASGRLHRGV4VA6';

describe('parseRosterCsv dialects (Issue #953)', () => {
  it('parses an Excel "CSV UTF-8" export: BOM + CRLF + quoted commas', () => {
    const csv = `\uFEFFlogin,name,address\r\nalice,"Doe, Alice",${ADDR_1}\r\n"bob","Smith, ""Bobby"" Jr",${ADDR_2}\r\n`;
    const result = parseRosterCsv(csv);
    expect(result.addresses).toEqual([ADDR_1, ADDR_2]);
    expect(result.addressMap).toEqual({ alice: ADDR_1, bob: ADDR_2 });
    expect(result.invalid).toEqual([]);
  });

  it('recognises the header when the BOM precedes it (no contributor skipped)', () => {
    const result = parseRosterCsv(`\uFEFFaddress\n${ADDR_1}\n${ADDR_2}`);
    expect(result.summary.totalDataRows).toBe(2);
    expect(result.summary.validCount).toBe(2);
  });

  it('handles bare CR line endings and whitespace around quoted cells', () => {
    const result = parseRosterCsv(`login,address\r alice , "${ADDR_1}" \r`);
    expect(result.addressMap).toEqual({ alice: ADDR_1 });
  });

  it('rejects rows containing spreadsheet formulas', () => {
    const csv = `login,address\n=HYPERLINK("x"),${ADDR_1}\nbob,${ADDR_2}\n"@SUM(A1)",${ADDR_1}`;
    const result = parseRosterCsv(csv);
    expect(result.addresses).toEqual([ADDR_2]);
    expect(result.invalid.map((r) => r.lineNumber)).toEqual([2, 4]);
    expect(result.invalid[0].reason).toMatch(/formula/);
  });

  it('rejects a row with an unterminated quoted field without blocking the rest', () => {
    const result = parseRosterCsv(`login,address\nalice,"${ADDR_1}\nbob,${ADDR_2}`);
    expect(result.addresses).toEqual([ADDR_2]);
    expect(result.invalid[0]).toMatchObject({ lineNumber: 2, reason: 'Roster CSV has an unterminated quoted field.' });
  });

  it('still throws a stable error for BOM-only input', () => {
    expect(() => parseRosterCsv('\uFEFF')).toThrow('Roster CSV is empty');
  });

  it.each([['=1+1', true], ['+1', true], ['-2', true], ['@x', true], ['alice', false], ['', false]])(
    'isCsvFormulaCell(%p) === %p',
    (cell, expected) => expect(isCsvFormulaCell(cell as string)).toBe(expected),
  );
});
