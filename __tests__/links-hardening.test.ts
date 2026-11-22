/**
 * Open-redirect / Markdown-injection hardening tests for `src/links.ts`
 * (Issue #853).
 *
 * `isSafeExternalLink` is the shared guard every URL `links.ts` renders as
 * a clickable Markdown link now goes through: `buildFaqLink`'s
 * `baseUrl` override, `isValidDashboardUrl` (SEP-0010 proof links), and
 * `buildSep0007TxLink`'s wallet `callback`. This suite proves malicious
 * inputs are rejected (never thrown into the rendered comment) and that
 * the existing happy-path links are unaffected. `__tests__/markdown.test.ts`
 * covers the parallel fix in `buildAssetChecklist` (the `deepLink` field).
 */
import {
  isSafeExternalLink,
  isValidDashboardUrl,
  buildFaqLink,
  buildSep0007TxLink,
  FAQ_ANCHORS,
  DEFAULT_FAQ_BASE_URL,
} from '../src/links';

const MALICIOUS_URLS = [
  'javascript:alert(1)',
  'javascript:/*https://trusted.example/*/alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox("x")',
  'http://evil.example.com', // not https
  'https://user:pass@evil.example.com/',
  'https://127.0.0.1/steal',
  'https://10.0.0.5/internal',
  'https://192.168.1.1/',
  'https://172.16.0.1/',
  'https://169.254.169.254/latest/meta-data/', // cloud metadata (AWS IMDS)
  'https://metadata.google.internal/computeMetadata/v1/',
  'https://localhost/',
  'https://LOCALHOST/',
  'https://[::1]/',
  'https://0.0.0.0/',
  'not a url at all',
  '',
  '   ',
  '//evil.example.com/open-redirect',
  'https://dashboard.stellar.org/proof?a=1)[pwned](https://evil.example.com',
];

describe('isSafeExternalLink (Issue #853)', () => {
  it.each(MALICIOUS_URLS)('rejects %j', (url) => {
    expect(isSafeExternalLink(url)).toBe(false);
  });

  it('accepts a well-formed https URL with no credentials and a public host', () => {
    expect(isSafeExternalLink('https://stellar.expert/explorer/public/account/GABC')).toBe(true);
    expect(isSafeExternalLink('https://github.com/Stellar-TrustBridge/trustbridge-action')).toBe(true);
  });

  it('accepts a URL with query parameters and a fragment', () => {
    expect(isSafeExternalLink('https://example.com/path?x=1&y=2#frag')).toBe(true);
  });
});

describe('buildFaqLink baseUrl override hardening (Issue #853)', () => {
  it('falls back to the default base for every malicious override', () => {
    for (const malicious of MALICIOUS_URLS) {
      if (malicious.trim() === '') continue; // falsy baseUrl is "no override", not "rejected override"
      const link = buildFaqLink(FAQ_ANCHORS.TRUSTLINE_MISSING, malicious);
      expect(link).toBe(`${DEFAULT_FAQ_BASE_URL}#${FAQ_ANCHORS.TRUSTLINE_MISSING}`);
    }
  });

  it('a malicious override never appears anywhere in the rendered link', () => {
    const malicious = 'javascript:alert(document.cookie)//https://trusted.example';
    const link = buildFaqLink(FAQ_ANCHORS.ACCOUNT_NOT_FUNDED, malicious);
    expect(link).not.toContain('javascript:');
    expect(link).not.toContain('alert');
  });

  it('still honors a legitimate HTTPS mirror override', () => {
    const link = buildFaqLink(FAQ_ANCHORS.HORIZON_ERROR, 'https://my-fork.example.com/docs/FAQ.md');
    expect(link).toBe('https://my-fork.example.com/docs/FAQ.md#horizon-error');
  });

  it('matches the golden snapshot for the default (no override) case', () => {
    expect(buildFaqLink(FAQ_ANCHORS.XLM_RESERVE_TOO_LOW)).toMatchSnapshot();
  });
});

describe('isValidDashboardUrl still rejects every malicious input (Issue #853 regression)', () => {
  it.each(MALICIOUS_URLS)('rejects %j', (url) => {
    expect(isValidDashboardUrl(url)).toBe(false);
  });

  it('still rejects dashboard.stellar.org specifically', () => {
    expect(isValidDashboardUrl('https://dashboard.stellar.org/proof')).toBe(false);
  });

  it('still accepts a legitimate https dashboard host', () => {
    expect(isValidDashboardUrl('https://my-dashboard.example.com/proof/abc123')).toBe(true);
  });
});

describe('buildSep0007TxLink callback hardening (Issue #853)', () => {
  it('drops a malicious callback instead of embedding it in the URI', () => {
    for (const malicious of MALICIOUS_URLS) {
      if (malicious.trim() === '') continue;
      const uri = buildSep0007TxLink({ xdr: 'AAAA', callback: malicious });
      expect(uri).not.toContain('callback=');
      expect(decodeURIComponent(uri)).not.toContain(malicious);
    }
  });

  it('keeps a legitimate https callback', () => {
    const uri = buildSep0007TxLink({ xdr: 'AAAA', callback: 'https://wallet.example.com/sign-callback' });
    expect(uri).toContain('callback=https%3A%2F%2Fwallet.example.com%2Fsign-callback');
  });

  it('matches the golden snapshot with a legitimate callback and msg', () => {
    const uri = buildSep0007TxLink({
      xdr: 'AAAAAQ',
      msg: 'Add USDC trustline',
      callback: 'https://wallet.example.com/sign-callback',
      network: 'testnet',
    });
    expect(uri).toMatchSnapshot();
  });

  it('matches the golden snapshot when the callback is malicious and must be dropped', () => {
    const uri = buildSep0007TxLink({
      xdr: 'AAAAAQ',
      callback: 'javascript:alert(1)//https://evil.example.com',
      network: 'public',
    });
    expect(uri).toMatchSnapshot();
  });
});
