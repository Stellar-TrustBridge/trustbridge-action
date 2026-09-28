import { fetchDashboardRoster } from '../src/roster';

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
});
