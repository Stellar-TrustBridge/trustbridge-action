/**
 * Tests for Issue #303: Optional TLS certificate pinning for Horizon endpoint.
 *
 * We use jest.mock('tls') at the top level because `tls.connect` is a
 * non-configurable property in Node — jest.spyOn cannot redefine it.
 */
import * as crypto from 'crypto';

// Must be hoisted before any import that transitively loads 'tls'
jest.mock('tls');

import * as tlsMock from 'tls';
import { checkCertificatePin, HorizonPinMismatchError, HorizonTlsError } from '../src/horizon';

// Convenience type for the mocked tls module
const mockedTlsConnect = tlsMock.connect as jest.MockedFunction<typeof tlsMock.connect>;

const FAKE_FINGERPRINT =
  'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';

/** Build a mock socket that calls the connect callback immediately. */
function buildMockSocket(rawCert: Buffer | null): {
  getPeerCertificate: jest.Mock;
  destroy: jest.Mock;
  on: jest.Mock;
  setTimeout: jest.Mock;
} {
  return {
    getPeerCertificate: jest.fn().mockReturnValue(rawCert ? { raw: rawCert } : {}),
    destroy: jest.fn(),
    on: jest.fn(),
    setTimeout: jest.fn(),
  };
}

describe('Certificate pinning (Issue #303)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('skips pin check for non-HTTPS URLs', async () => {
    // tls.connect should never be called for an http:// URL
    await expect(
      checkCertificatePin('http://horizon.stellar.org', FAKE_FINGERPRINT),
    ).resolves.toBeUndefined();

    expect(mockedTlsConnect).not.toHaveBeenCalled();
  });

  it('throws HorizonPinMismatchError when fingerprint does not match', async () => {
    // Fake cert whose SHA-256 will not match FAKE_FINGERPRINT
    const mockSocket = buildMockSocket(Buffer.from('fakecert'));
    mockedTlsConnect.mockImplementation((_opts: unknown, cb: unknown) => {
      setImmediate(cb as () => void);
      return mockSocket as unknown as ReturnType<typeof tlsMock.connect>;
    });

    await expect(
      checkCertificatePin('https://horizon.stellar.org', FAKE_FINGERPRINT),
    ).rejects.toThrow(HorizonPinMismatchError);
  });

  it('HorizonPinMismatchError carries expected and actual fingerprints', async () => {
    const rawCert = Buffer.from('mismatch-cert');
    const actualFp = crypto
      .createHash('sha256')
      .update(rawCert)
      .digest('hex')
      .toUpperCase()
      .match(/.{2}/g)!
      .join(':');

    const mockSocket = buildMockSocket(rawCert);
    mockedTlsConnect.mockImplementation((_opts: unknown, cb: unknown) => {
      setImmediate(cb as () => void);
      return mockSocket as unknown as ReturnType<typeof tlsMock.connect>;
    });

    let caught: HorizonPinMismatchError | undefined;
    try {
      await checkCertificatePin('https://horizon.stellar.org', FAKE_FINGERPRINT);
    } catch (err) {
      if (err instanceof HorizonPinMismatchError) caught = err;
    }

    expect(caught).toBeDefined();
    expect(caught!.expectedFingerprint).toBe(FAKE_FINGERPRINT.toUpperCase().replace(/\s/g, ''));
    expect(caught!.actualFingerprint).toBe(actualFp);
    expect(caught!.name).toBe('HorizonPinMismatchError');
  });

  it('throws HorizonTlsError on TLS connection error', async () => {
    // Socket fires 'error' event, no connect callback called
    const errorSocket: {
      getPeerCertificate: jest.Mock;
      destroy: jest.Mock;
      on: jest.Mock;
      setTimeout: jest.Mock;
    } = {
      getPeerCertificate: jest.fn(),
      destroy: jest.fn(),
      on: jest.fn().mockImplementation((event: string, handler: (err: Error) => void) => {
        if (event === 'error') {
          setImmediate(() => handler(new Error('ECONNREFUSED')));
        }
        return errorSocket as unknown as ReturnType<typeof tlsMock.connect>;
      }),
      setTimeout: jest.fn(),
    };

    mockedTlsConnect.mockReturnValue(errorSocket as unknown as ReturnType<typeof tlsMock.connect>);

    await expect(
      checkCertificatePin('https://horizon.stellar.org', FAKE_FINGERPRINT),
    ).rejects.toThrow(HorizonTlsError);
  });

  it('throws HorizonTlsError when certificate has no raw field', async () => {
    const noRawSocket = {
      getPeerCertificate: jest.fn().mockReturnValue({}), // missing .raw
      destroy: jest.fn(),
      on: jest.fn(),
      setTimeout: jest.fn(),
    };

    mockedTlsConnect.mockImplementation((_opts: unknown, cb: unknown) => {
      setImmediate(cb as () => void);
      return noRawSocket as unknown as ReturnType<typeof tlsMock.connect>;
    });

    await expect(
      checkCertificatePin('https://horizon.stellar.org', FAKE_FINGERPRINT),
    ).rejects.toThrow(HorizonTlsError);
  });

  it('resolves when fingerprint matches', async () => {
    const rawCert = Buffer.from('exact-cert-data');
    const actualFingerprint = crypto
      .createHash('sha256')
      .update(rawCert)
      .digest('hex')
      .toUpperCase()
      .match(/.{2}/g)!
      .join(':');

    const mockSocket = buildMockSocket(rawCert);
    mockedTlsConnect.mockImplementation((_opts: unknown, cb: unknown) => {
      setImmediate(cb as () => void);
      return mockSocket as unknown as ReturnType<typeof tlsMock.connect>;
    });

    await expect(
      checkCertificatePin('https://horizon.stellar.org', actualFingerprint),
    ).resolves.toBeUndefined();
  });

  it('is case-insensitive and whitespace-tolerant on both sides', async () => {
    const rawCert = Buffer.from('cert-case-test');
    const lowerFp = crypto
      .createHash('sha256')
      .update(rawCert)
      .digest('hex') // lowercase hex
      .match(/.{2}/g)!
      .join(':');

    const mockSocket = buildMockSocket(rawCert);
    mockedTlsConnect.mockImplementation((_opts: unknown, cb: unknown) => {
      setImmediate(cb as () => void);
      return mockSocket as unknown as ReturnType<typeof tlsMock.connect>;
    });

    // Pass a lowercase fingerprint with trailing whitespace — should still match
    await expect(
      checkCertificatePin('https://horizon.stellar.org', lowerFp + '  '),
    ).resolves.toBeUndefined();
  });

  it('uses port 443 by default for standard HTTPS URLs', async () => {
    const rawCert = Buffer.from('default-port-cert');
    const fp = crypto
      .createHash('sha256')
      .update(rawCert)
      .digest('hex')
      .toUpperCase()
      .match(/.{2}/g)!
      .join(':');

    let capturedPort: number | undefined;
    const mockSocket = buildMockSocket(rawCert);
    mockedTlsConnect.mockImplementation((opts: unknown, cb: unknown) => {
      capturedPort = (opts as { port: number }).port;
      setImmediate(cb as () => void);
      return mockSocket as unknown as ReturnType<typeof tlsMock.connect>;
    });

    await checkCertificatePin('https://horizon.stellar.org', fp);
    expect(capturedPort).toBe(443);
  });

  it('uses port from URL when non-standard', async () => {
    const rawCert = Buffer.from('port-8443-cert');
    const fp = crypto
      .createHash('sha256')
      .update(rawCert)
      .digest('hex')
      .toUpperCase()
      .match(/.{2}/g)!
      .join(':');

    let capturedPort: number | undefined;
    const mockSocket = buildMockSocket(rawCert);
    mockedTlsConnect.mockImplementation((opts: unknown, cb: unknown) => {
      capturedPort = (opts as { port: number }).port;
      setImmediate(cb as () => void);
      return mockSocket as unknown as ReturnType<typeof tlsMock.connect>;
    });

    await checkCertificatePin('https://horizon.stellar.org:8443', fp);
    expect(capturedPort).toBe(8443);
  });
});
