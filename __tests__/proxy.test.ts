import { redactProxyCredentials, safeProxyErrorMessage } from '../src/proxy';
import { redactString } from '../src/logger';
import { getErrorMessage } from '../src/inputs';
import { HorizonError } from '../src/horizon';

describe('proxy credential redaction', () => {
  it('redacts proxy userinfo while preserving scheme and host', () => {
    expect(redactProxyCredentials('ECONNRESET http://alice:s3cret@proxy.example:8080/tunnel'))
      .toBe('ECONNRESET http://***@proxy.example:8080/tunnel');
  });

  it('redacts encoded credentials in errors and logger strings', () => {
    const message = 'request failed via https://user%40corp:p%40ss@proxy.example';
    expect(safeProxyErrorMessage(new Error(message))).toBe(
      'request failed via https://***@proxy.example',
    );
    expect(redactString(message)).not.toContain('p%40ss');
  });

  it('leaves malformed and credential-free text safe without throwing', () => {
    expect(redactProxyCredentials('proxy=http://user:secret@')).toBe('proxy=http://***@');
    expect(safeProxyErrorMessage({ code: 'ETIMEDOUT' })).toBe('[object Object]');
    expect(redactProxyCredentials('')).toBe('');
  });

  it('redacts proxy credentials at action and Horizon error boundaries', () => {
    const url = 'http://user:password@proxy.example:8080';
    expect(getErrorMessage(new Error(`fetch failed: ${url}`)))
      .toBe('fetch failed: http://***@proxy.example:8080');
    expect(new HorizonError(`request via ${url}`, 503).message)
      .toBe('request via http://***@proxy.example:8080');
  });
});
