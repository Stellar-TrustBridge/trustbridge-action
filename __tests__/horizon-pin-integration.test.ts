/**
 * Integration tests for Issue #303: Optional TLS certificate pinning for Horizon endpoint.
 *
 * These tests spin up a local TLS server with a known self-signed certificate
 * and validate that checkCertificatePin correctly:
 *   - Accepts a matching fingerprint
 *   - Rejects a mismatched fingerprint with HorizonPinMismatchError
 *   - Skips the probe when the fingerprint is empty
 *
 * The TLS server is created inline using Node.js tls.createServer() so no
 * external infrastructure (Docker, public Horizon) is required.
 */
import * as tls from 'tls';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as childProcess from 'child_process';
import { checkCertificatePin, HorizonPinMismatchError } from '../src/horizon';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('checkCertificatePin — integration (local TLS server)', () => {
  let server: tls.TLSServer;
  let serverUrl: string;
  let certFingerprint: string;
  let tmpDir: string;

  beforeAll((done) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-pin-integration-'));
    const certPath = path.join(tmpDir, 'cert.pem');
    const keyPath = path.join(tmpDir, 'key.pem');

    // Generate a self-signed certificate using openssl.
    // openssl is available on all CI runners (macOS, Linux, Docker).
    childProcess.execSync(
      [
        'openssl req -x509 -newkey rsa:2048',
        '-keyout', keyPath,
        '-out', certPath,
        '-days', '1',
        '-nodes',
        '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ].join(' '),
      { stdio: 'ignore' },
    );

    const certPem = fs.readFileSync(certPath);
    const keyPem = fs.readFileSync(keyPath);

    server = tls.createServer({ cert: certPem, key: keyPem });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as tls.TLSSocketAddress;
      serverUrl = `https://127.0.0.1:${addr.port}`;

      // Connect once to get the server's certificate and compute its fingerprint.
      const client = tls.connect(
        { host: '127.0.0.1', port: addr.port, servername: 'localhost', rejectUnauthorized: false },
        () => {
          const peerCert = client.getPeerCertificate();
          client.destroy();

          if (!peerCert || !peerCert.raw) {
            done(new Error('Could not retrieve server certificate for fingerprint computation'));
            return;
          }

          certFingerprint = crypto
            .createHash('sha256')
            .update(peerCert.raw)
            .digest('hex')
            .toUpperCase()
            .match(/.{2}/g)!
            .join(':');

          done();
        },
      );

      client.on('error', (err: Error) => {
        done(err);
      });
    });

    server.on('error', (err: Error) => {
      done(err);
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('fingerprint matching', () => {
    it('resolves when the fingerprint matches the server certificate', async () => {
      await expect(checkCertificatePin(serverUrl, certFingerprint)).resolves.toBeUndefined();
    });

    it('accepts fingerprint with lowercase hex characters', async () => {
      const lowerFingerprint = certFingerprint.toLowerCase();
      await expect(checkCertificatePin(serverUrl, lowerFingerprint)).resolves.toBeUndefined();
    });

    it('accepts fingerprint with whitespace (colons stripped)', async () => {
      const spacedFingerprint = certFingerprint.replace(/:/g, ' ');
      await expect(checkCertificatePin(serverUrl, spacedFingerprint)).resolves.toBeUndefined();
    });
  });

  describe('fingerprint mismatch', () => {
    it('rejects with HorizonPinMismatchError when the fingerprint does not match', async () => {
      const wrongFingerprint = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
      await expect(checkCertificatePin(serverUrl, wrongFingerprint)).rejects.toThrow(HorizonPinMismatchError);
    });

    it('HorizonPinMismatchError includes expected and actual fingerprints', async () => {
      const wrongFingerprint = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
      await expect(checkCertificatePin(serverUrl, wrongFingerprint)).rejects.toThrow(
        expect.objectContaining({
          expectedFingerprint: expect.any(String),
          actualFingerprint: expect.any(String),
        }),
      );
    });
  });

  describe('empty fingerprint', () => {
    it('skips the TLS probe and resolves when pinFingerprint is empty', async () => {
      await expect(checkCertificatePin(serverUrl, '')).resolves.toBeUndefined();
    });
  });

  describe('non-HTTPS URL', () => {
    it('skips the TLS probe for http URLs regardless of fingerprint', async () => {
      await expect(checkCertificatePin('http://127.0.0.1:8089', certFingerprint)).resolves.toBeUndefined();
    });
  });
});
