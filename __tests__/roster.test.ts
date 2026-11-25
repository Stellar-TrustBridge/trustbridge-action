import { fetchDashboardRoster, parseRosterCsv } from '../src/roster';

// Mock validateSsrfSafeUrl so we don't need real network
jest.mock('../src/validation', () => {
  const original = jest.requireActual('../src/validation');
  return {
    ...original,
    validateSsrfSafeUrl: jest.fn((url: string, fieldName: string, opts: any = {}) => {
      if (url.includes('ssrf-invalid')) {
        return { valid: false, errors: ['disallowed IP'] };
      }
      if (url.startsWith('http://') && !opts.allowHttp) {
        return { valid: false, errors: ['must use https'] };
      }
      return { valid: true, errors: [] };
    }),
  };
});

describe('fetchDashboardRoster', () => {
  const mockFetch = jest.fn();

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('rejects an empty URL', async () => {
    await expect(fetchDashboardRoster('', 'secret', 1000, true, mockFetch as any)).rejects.toThrow('empty');
  });

  it('rejects an SSRF-invalid URL even if HTTP is allowed', async () => {
    await expect(fetchDashboardRoster('http://ssrf-invalid.local', 'secret', 1000, true, mockFetch as any)).rejects.toThrow('security validation');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects an HTTP URL if allowHttp is false', async () => {
    await expect(fetchDashboardRoster('http://valid.com', 'secret', 1000, false, mockFetch as any)).rejects.toThrow('security validation');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a redirect leading to SSRF-invalid destination', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 302,
      headers: {
        get: (name: string) => name === 'location' ? 'http://ssrf-invalid.local' : null
      }
    });
    await expect(fetchDashboardRoster('https://valid.com', 'secret', 1000, true, mockFetch as any)).rejects.toThrow('redirect failed security validation');
  });

  it('handles an HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({ status: 500, ok: false });
    await expect(fetchDashboardRoster('https://valid.com', 'secret', 1000, true, mockFetch as any)).rejects.toThrow('HTTP 500');
  });

  it('rejects an oversize body', async () => {
    const reader = {
      read: jest.fn()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array(1024 * 1024 + 1) })
        .mockResolvedValueOnce({ done: true }),
      releaseLock: jest.fn(),
    };
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: { getReader: () => reader }
    });
    await expect(fetchDashboardRoster('https://valid.com', 'secret', 1000, true, mockFetch as any)).rejects.toThrow('size limit');
  });

  it('handles invalid JSON', async () => {
    const reader = {
      read: jest.fn()
        .mockResolvedValueOnce({ done: false, value: Buffer.from('not json') })
        .mockResolvedValueOnce({ done: true }),
      releaseLock: jest.fn(),
    };
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: { getReader: () => reader }
    });
    await expect(fetchDashboardRoster('https://valid.com', 'secret', 1000, true, mockFetch as any)).rejects.toThrow('invalid JSON');
  });

  it('parses a valid map (unsigned request)', async () => {
    const jsonStr = JSON.stringify({ "GABC": "G123", "  gdef  ": "  g456  " });
    const reader = {
      read: jest.fn()
        .mockResolvedValueOnce({ done: false, value: Buffer.from(jsonStr) })
        .mockResolvedValueOnce({ done: true }),
      releaseLock: jest.fn(),
    };
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: { getReader: () => reader }
    });
    const result = await fetchDashboardRoster('https://valid.com', '', 1000, true, mockFetch as any);
    expect(result).toEqual({ gabc: 'G123', gdef: 'g456' });
    
    // Check that HMAC headers were NOT sent
    const callArgs = mockFetch.mock.calls[0][1];
    expect(callArgs.headers['X-TrustBridge-Signature']).toBeUndefined();
  });

  it('parses a valid map (signed request)', async () => {
    const jsonStr = JSON.stringify({ "GABC": "G123" });
    const reader = {
      read: jest.fn()
        .mockResolvedValueOnce({ done: false, value: Buffer.from(jsonStr) })
        .mockResolvedValueOnce({ done: true }),
      releaseLock: jest.fn(),
    };
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: { getReader: () => reader }
    });
    const result = await fetchDashboardRoster('https://valid.com', 'my-secret', 1000, true, mockFetch as any);
    expect(result).toEqual({ gabc: 'G123' });
    
    // Check that HMAC headers WERE sent
    const callArgs = mockFetch.mock.calls[0][1];
    expect(callArgs.headers['X-TrustBridge-Signature']).toMatch(/^sha256=[0-9a-f]+$/);
    expect(callArgs.headers['X-TrustBridge-Timestamp']).toBeDefined();
  });

  it('handles an async iterable body (Node stream)', async () => {
    const jsonStr = JSON.stringify({ "GABC": "G123" });
    const asyncIterable = {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(jsonStr.slice(0, 5));
        yield Buffer.from(jsonStr.slice(5));
      }
    };
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: asyncIterable
    });
    const result = await fetchDashboardRoster('https://valid.com', '', 1000, true, mockFetch as any);
    expect(result).toEqual({ gabc: 'G123' });
  });

  it('handles a fallback arrayBuffer body (No stream)', async () => {
    const jsonStr = JSON.stringify({ "GABC": "G123" });
    const buffer = Buffer.from(jsonStr);
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: {}, // No getReader or Symbol.asyncIterator
      arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    });
    const result = await fetchDashboardRoster('https://valid.com', '', 1000, true, mockFetch as any);
    expect(result).toEqual({ gabc: 'G123' });
  });

  it('enforces timeout on fetch requests', async () => {
    // Test that AbortSignal timeout is passed to fetch
    const mockFetchWithTimeout = jest.fn().mockImplementationOnce(() => {
      throw new Error('AbortError: The operation was aborted.');
    });
    await expect(fetchDashboardRoster('https://valid.com', '', 500, true, mockFetchWithTimeout as any)).rejects.toThrow('Failed to fetch dashboard roster');

    // Verify fetch was called with the correct signal
    expect(mockFetchWithTimeout).toHaveBeenCalledWith(
      'https://valid.com',
      expect.objectContaining({
        method: 'GET',
        signal: expect.any(AbortSignal)
      })
    );
  });
});

// ---------------------------------------------------------------------------
// parseRosterCsv (Issue #798)
// ---------------------------------------------------------------------------

describe('parseRosterCsv', () => {
  // Real, checksum-valid G-addresses (StrKey) — isValidStellarAddress performs
  // full CRC16/XMODEM validation, so arbitrary strings will not pass.
  const ADDR_1 = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  const ADDR_2 = 'GBHWA4MCSOSLLRWX5D4QUGZMHVHF64EBSKR3JROW474ASGRLHRGV4VA6';
  const ADDR_3 = 'GBNGW7ENT2X4BUPC6MCBKJRXJBMWU64MTWXL7UHB6IBRIJJWI5MGS27V';
  // A structurally-valid Soroban contract ("C...") address — contract
  // addresses are validated structurally (StrKey shape), not by checksum.
  const C_ADDR = 'C' + 'A'.repeat(55);

  describe('happy path', () => {
    it('parses a single-column CSV of addresses (no header)', () => {
      const csv = `${ADDR_1}\n${ADDR_2}\n${ADDR_3}`;
      const result = parseRosterCsv(csv);

      expect(result.addresses).toEqual([ADDR_1, ADDR_2, ADDR_3]);
      expect(result.addressMap).toEqual({});
      expect(result.duplicates).toEqual([]);
      expect(result.invalid).toEqual([]);
      expect(result.summary).toEqual({
        totalDataRows: 3,
        validCount: 3,
        duplicateCount: 0,
        invalidCount: 0,
      });
    });

    it('parses a login,address CSV with a header row', () => {
      const csv = `login,address\nalice,${ADDR_1}\nbob,${ADDR_2}`;
      const result = parseRosterCsv(csv);

      expect(result.addressMap).toEqual({ alice: ADDR_1, bob: ADDR_2 });
      expect(result.addresses).toEqual([ADDR_1, ADDR_2]);
    });

    it('parses a login,address CSV with no header, assuming login,address column order', () => {
      const csv = `alice,${ADDR_1}\nbob,${ADDR_2}`;
      const result = parseRosterCsv(csv);

      expect(result.addressMap).toEqual({ alice: ADDR_1, bob: ADDR_2 });
      expect(result.addresses).toEqual([ADDR_1, ADDR_2]);
    });

    it('honors a header that reverses column order (address,login)', () => {
      const csv = `address,username\n${ADDR_1},alice\n${ADDR_2},bob`;
      const result = parseRosterCsv(csv);

      expect(result.addressMap).toEqual({ alice: ADDR_1, bob: ADDR_2 });
    });

    it('accepts Soroban contract (C...) addresses alongside G-addresses', () => {
      const csv = `${ADDR_1}\n${C_ADDR}`;
      const result = parseRosterCsv(csv);

      expect(result.addresses).toEqual([ADDR_1, C_ADDR]);
      expect(result.invalid).toEqual([]);
    });

    it('skips blank lines', () => {
      const csv = `${ADDR_1}\n\n   \n${ADDR_2}`;
      const result = parseRosterCsv(csv);

      expect(result.addresses).toEqual([ADDR_1, ADDR_2]);
      expect(result.summary.totalDataRows).toBe(2);
    });

    it('strips quoted cells', () => {
      const csv = `"login","address"\n"alice","${ADDR_1}"`;
      const result = parseRosterCsv(csv);
      expect(result.addressMap).toEqual({ alice: ADDR_1 });
    });

    it('lowercases login keys for case-insensitive GitHub username matching', () => {
      const csv = `login,address\nAlIcE,${ADDR_1}`;
      const result = parseRosterCsv(csv);
      expect(result.addressMap).toEqual({ alice: ADDR_1 });
    });
  });

  describe('duplicate address detection', () => {
    it('rejects a duplicate address, keeping the first occurrence in the roster', () => {
      const csv = `login,address\nalice,${ADDR_1}\nbob,${ADDR_1}`;
      const result = parseRosterCsv(csv);

      expect(result.addresses).toEqual([ADDR_1]);
      expect(result.addressMap).toEqual({ alice: ADDR_1 });
      expect(result.duplicates).toEqual([
        { address: ADDR_1, firstLineNumber: 2, lineNumber: 3 },
      ]);
      expect(result.summary.duplicateCount).toBe(1);
    });

    it('detects a duplicate even with surrounding whitespace on the repeated row', () => {
      const csv = `${ADDR_1}\n  ${ADDR_1}  `;
      const result = parseRosterCsv(csv);

      expect(result.addresses).toEqual([ADDR_1]);
      expect(result.duplicates).toHaveLength(1);
    });

    it('reports every duplicate occurrence, not just the second', () => {
      const csv = `${ADDR_1}\n${ADDR_1}\n${ADDR_1}`;
      const result = parseRosterCsv(csv);

      expect(result.addresses).toEqual([ADDR_1]);
      expect(result.duplicates).toHaveLength(2);
      expect(result.duplicates.map((d) => d.lineNumber)).toEqual([2, 3]);
    });

    it('includes rejected duplicates in the Markdown summary', () => {
      const csv = `${ADDR_1}\n${ADDR_1}`;
      const result = parseRosterCsv(csv);
      expect(result.summaryMarkdown).toContain('Rejected duplicates: **1**');
      expect(result.summaryMarkdown).toContain('Duplicate addresses');
      expect(result.summaryMarkdown).toContain(ADDR_1);
    });
  });

  describe('invalid address rejection', () => {
    it('rejects a structurally invalid address and excludes it from the roster', () => {
      const csv = `${ADDR_1}\nNOT-A-VALID-ADDRESS`;
      const result = parseRosterCsv(csv);

      expect(result.addresses).toEqual([ADDR_1]);
      expect(result.invalid).toEqual([
        {
          lineNumber: 2,
          raw: 'NOT-A-VALID-ADDRESS',
          reason: expect.stringContaining('not a valid Stellar G- or C-address'),
        },
      ]);
      expect(result.summary.invalidCount).toBe(1);
    });

    it('rejects an address that fails StrKey checksum validation even though it has the right shape', () => {
      // Right length and alphabet, wrong checksum bytes.
      const badChecksum = 'G' + 'A'.repeat(55);
      const csv = `${ADDR_1}\n${badChecksum}`;
      const result = parseRosterCsv(csv);

      expect(result.addresses).toEqual([ADDR_1]);
      expect(result.invalid).toHaveLength(1);
      expect(result.invalid[0].raw).toBe(badChecksum);
    });

    it('rejects an empty address cell', () => {
      const csv = `login,address\nalice,${ADDR_1}\nbob,`;
      const result = parseRosterCsv(csv);

      expect(result.addresses).toEqual([ADDR_1]);
      expect(result.invalid).toEqual([
        { lineNumber: 3, raw: 'bob,', reason: 'Address column is empty.' },
      ]);
    });

    it('does not let one invalid row block the rest of the roster (partial-batch tolerance)', () => {
      const csv = `${ADDR_1}\nNOT-VALID\n${ADDR_2}\nALSO-NOT-VALID\n${ADDR_3}`;
      const result = parseRosterCsv(csv);

      expect(result.addresses).toEqual([ADDR_1, ADDR_2, ADDR_3]);
      expect(result.invalid).toHaveLength(2);
    });

    it('includes rejected invalid rows in the Markdown summary', () => {
      const csv = `${ADDR_1}\nNOT-VALID`;
      const result = parseRosterCsv(csv);
      expect(result.summaryMarkdown).toContain('Rejected invalid addresses: **1**');
      expect(result.summaryMarkdown).toContain('Invalid rows');
      expect(result.summaryMarkdown).toContain('NOT-VALID');
    });
  });

  describe('malformed input (stable errors)', () => {
    it('throws a clear error for empty input', () => {
      expect(() => parseRosterCsv('')).toThrow('Roster CSV is empty');
    });

    it('throws a clear error for whitespace-only input', () => {
      expect(() => parseRosterCsv('   \n\n  ')).toThrow('Roster CSV is empty');
    });

    it('throws a clear error for a header-only CSV with no data rows', () => {
      expect(() => parseRosterCsv('login,address')).toThrow(
        'Roster CSV has a header row but no data rows.',
      );
    });

    it('throws a clear error when the header does not name a recognised address column', () => {
      expect(() => parseRosterCsv('login,foo\nalice,GABC')).toThrow(
        'Roster CSV header row does not name an address column',
      );
    });
  });

  describe('summary reporting', () => {
    it('reports accurate totals across a mixed-outcome roster', () => {
      const csv = [
        'login,address',
        `alice,${ADDR_1}`,
        `bob,${ADDR_1}`, // duplicate
        `carol,${ADDR_2}`,
        'dave,NOT-VALID', // invalid
        `erin,${ADDR_3}`,
      ].join('\n');

      const result = parseRosterCsv(csv);

      expect(result.summary).toEqual({
        totalDataRows: 5,
        validCount: 3,
        duplicateCount: 1,
        invalidCount: 1,
      });
      expect(result.addresses).toEqual([ADDR_1, ADDR_2, ADDR_3]);
      expect(result.addressMap).toEqual({ alice: ADDR_1, carol: ADDR_2, erin: ADDR_3 });
    });

    it('produces a Markdown summary with no rejection sections when the roster is fully clean', () => {
      const csv = `${ADDR_1}\n${ADDR_2}`;
      const result = parseRosterCsv(csv);

      expect(result.summaryMarkdown).toContain('Valid, unique addresses: **2**');
      expect(result.summaryMarkdown).not.toContain('Duplicate addresses');
      expect(result.summaryMarkdown).not.toContain('Invalid rows');
    });

    it('caps the number of example rows listed per rejected category', () => {
      const invalidRows = Array.from({ length: 25 }, (_, i) => `NOT-VALID-${i}`).join('\n');
      const result = parseRosterCsv(`${ADDR_1}\n${invalidRows}`);

      expect(result.invalid).toHaveLength(25);
      expect(result.summaryMarkdown).toContain('…and 5 more invalid row(s).');
    });
  });
});
