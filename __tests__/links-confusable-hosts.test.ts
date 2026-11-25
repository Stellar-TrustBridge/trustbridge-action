/**
 * Unicode-confusable / punycode host hardening for explorer, docs and
 * dashboard link overrides — Issue #963.
 */

import {
  buildAccountViewerLink,
  buildFaqLink,
  buildSep0010ChallengeSnippet,
  DEFAULT_FAQ_BASE_URL,
  describeLinkRejection,
  explainLinkRejection,
  isSafeExternalLink,
  isValidDashboardUrl,
  LinkAllowlistError,
  LinkRejectionReason,
  MAX_IDN_HOST_ALLOWLIST_ENTRIES,
  parseIdnHostAllowlist,
} from '../src/links';

// "exаmple.org" with a Cyrillic "а" (U+0430) and its punycode form.
const CYRILLIC_HOST = 'https://exаmple.org/docs';
const PUNYCODE_HOST = 'https://xn--exmple-4nf.org/docs';
const GERMAN_IDN = 'https://bücher.example/docs';
const GERMAN_PUNYCODE = 'xn--bcher-kva.example';

describe('legitimate links are unaffected', () => {
  it.each([
    'https://laboratory.stellar.org/#account-viewer?network=public',
    'https://stellar.expert/explorer/public/account/GABC',
    'https://github.com/Stellar-TrustBridge/trustbridge-action/blob/main/docs/FAQ.md',
    'https://docs.example.co.uk:8443/path?x=1#frag',
  ])('accepts %s', (url) => {
    expect(explainLinkRejection(url)).toBeNull();
    expect(isSafeExternalLink(url)).toBe(true);
  });
});

describe('existing rejections keep their reasons', () => {
  it.each<[string, LinkRejectionReason]>([
    ['', 'invalid_url'],
    ['not a url', 'invalid_url'],
    ['http://example.org', 'not_https'],
    ['javascript:alert(1)', 'not_https'],
    ['https://user:pass@example.org', 'embedded_credentials'],
    ['https://127.0.0.1/x', 'blocked_host'],
    ['https://metadata.google.internal/', 'blocked_host'],
    ['https://example.org/a)b', 'unsafe_characters'],
    ['https://example.org/a b', 'unsafe_characters'],
  ])('%j -> %s', (url, reason) => {
    expect(explainLinkRejection(url)).toBe(reason);
    expect(isSafeExternalLink(url)).toBe(false);
  });
});

describe('confusable and punycode hosts are rejected by default', () => {
  it('rejects a Cyrillic homograph host', () => {
    expect(explainLinkRejection(CYRILLIC_HOST)).toBe('non_ascii_host');
  });

  it('rejects the punycode form of the same look-alike', () => {
    expect(explainLinkRejection(PUNYCODE_HOST)).toBe('punycode_host');
    expect(explainLinkRejection('https://XN--exmple-4nf.org/')).toBe('punycode_host');
  });

  it('rejects punycode in any label, including subdomains', () => {
    expect(explainLinkRejection('https://xn--exmple-4nf.evil.org')).toBe('punycode_host');
    expect(explainLinkRejection('https://docs.xn--exmple-4nf.org')).toBe('punycode_host');
  });

  it('rejects fullwidth look-alikes the URL parser would silently fold to ASCII', () => {
    expect(new URL('https://ｅxample.org').hostname).toBe('example.org');
    expect(explainLinkRejection('https://ｅxample.org/')).toBe('non_ascii_host');
  });

  it('rejects percent-encoded hosts', () => {
    expect(explainLinkRejection('https://ex%61mple.org/')).toBe('non_ascii_host');
  });

  it('rejects legitimate-looking internationalized hosts too unless allowlisted', () => {
    expect(explainLinkRejection(GERMAN_IDN)).toBe('non_ascii_host');
  });

  it('rejects zero-width and bidi-override characters anywhere in the URL', () => {
    expect(explainLinkRejection('https://exam​ple.org/')).toBe('invisible_characters');
    expect(explainLinkRejection('https://example.org/‮txt.exe')).toBe('invisible_characters');
    expect(explainLinkRejection('https://example.org/a­b')).toBe('invisible_characters');
    expect(explainLinkRejection('https://exa\tmple.org/')).toBe('invisible_characters');
  });

  it('keeps explanations actionable', () => {
    expect(describeLinkRejection('non_ascii_host')).toMatch(/idn_host_allowlist/);
    expect(describeLinkRejection('punycode_host')).toMatch(/idn_host_allowlist/);
    for (const reason of ['invalid_url', 'not_https', 'embedded_credentials', 'blocked_host', 'unsafe_characters', 'invisible_characters'] as const) {
      expect(describeLinkRejection(reason).length).toBeGreaterThan(10);
    }
  });
});

describe('parseIdnHostAllowlist', () => {
  it('normalizes Unicode and punycode entries to lowercase punycode and deduplicates', () => {
    expect(parseIdnHostAllowlist('bücher.example, XN--BCHER-KVA.EXAMPLE\n# comment\n\n')).toEqual([GERMAN_PUNYCODE]);
    expect(parseIdnHostAllowlist(['EXAMPLE.org'])).toEqual(['example.org']);
    expect(parseIdnHostAllowlist(undefined)).toEqual([]);
    expect(parseIdnHostAllowlist('')).toEqual([]);
  });

  it.each([
    'https://example.org',
    'example.org/path',
    'example.org:8443',
    '*.example.org',
    'user@example.org',
    'exa mple.org',
    'example.org?x=1',
    'exa\\mple.org',
  ])('rejects the broader-than-a-host entry %j', (entry) => {
    try {
      parseIdnHostAllowlist(entry);
      throw new Error('expected failure');
    } catch (err) {
      expect(err).toBeInstanceOf(LinkAllowlistError);
      expect((err as LinkAllowlistError).code).toBe('INVALID_ALLOWLIST_ENTRY');
    }
  });

  it('rejects an unparseable host and an oversized list with stable codes', () => {
    expect(() => parseIdnHostAllowlist('exa..mple\u0000.org')).toThrow(expect.objectContaining({ code: 'INVALID_ALLOWLIST_ENTRY' }));
    const many = Array.from({ length: MAX_IDN_HOST_ALLOWLIST_ENTRIES + 1 }, (_, i) => `host${i}.example`);
    expect(() => parseIdnHostAllowlist(many)).toThrow(expect.objectContaining({ code: 'ALLOWLIST_TOO_LARGE' }));
    expect(parseIdnHostAllowlist(many.slice(0, MAX_IDN_HOST_ALLOWLIST_ENTRIES))).toHaveLength(MAX_IDN_HOST_ALLOWLIST_ENTRIES);
  });
});

describe('allowlisted internationalized hosts', () => {
  const policy = { allowedIdnHosts: parseIdnHostAllowlist('bücher.example') };

  it('permits exactly the allowlisted host in Unicode or punycode form', () => {
    expect(explainLinkRejection(GERMAN_IDN, policy)).toBeNull();
    expect(explainLinkRejection(`https://${GERMAN_PUNYCODE}/x`, policy)).toBeNull();
  });

  it('does not extend to other hosts, subdomains, or look-alikes', () => {
    expect(explainLinkRejection(CYRILLIC_HOST, policy)).toBe('non_ascii_host');
    expect(explainLinkRejection(PUNYCODE_HOST, policy)).toBe('punycode_host');
    expect(explainLinkRejection('https://sub.bücher.example/', policy)).toBe('non_ascii_host');
  });

  it('never relaxes the other safety checks', () => {
    expect(explainLinkRejection(`http://${GERMAN_PUNYCODE}/`, policy)).toBe('not_https');
    expect(explainLinkRejection(`https://${GERMAN_PUNYCODE}/a)b`, policy)).toBe('unsafe_characters');
    expect(explainLinkRejection(`https://u:p@${GERMAN_PUNYCODE}/`, policy)).toBe('embedded_credentials');
  });

  it('is deterministic across repeated calls', () => {
    expect(explainLinkRejection(GERMAN_IDN, policy)).toBe(explainLinkRejection(GERMAN_IDN, policy));
  });
});

describe('policy is applied by the override builders', () => {
  it('buildFaqLink falls back to the default base for a look-alike docs_base_url', () => {
    expect(buildFaqLink('horizon-error', CYRILLIC_HOST)).toBe(`${DEFAULT_FAQ_BASE_URL}#horizon-error`);
    expect(buildFaqLink('horizon-error', PUNYCODE_HOST)).toBe(`${DEFAULT_FAQ_BASE_URL}#horizon-error`);
  });

  it('buildFaqLink honors an allowlisted IDN base', () => {
    const policy = { allowedIdnHosts: [GERMAN_PUNYCODE] };
    expect(buildFaqLink('horizon-error', GERMAN_IDN, policy)).toBe(`${GERMAN_IDN}#horizon-error`);
    expect(buildFaqLink('horizon-error', GERMAN_IDN)).toBe(`${DEFAULT_FAQ_BASE_URL}#horizon-error`);
  });

  it('isValidDashboardUrl and the viewer builder refuse look-alike dashboards', () => {
    expect(isValidDashboardUrl(CYRILLIC_HOST)).toBe(false);
    expect(() => buildAccountViewerLink('GABC', 'public', CYRILLIC_HOST)).toThrow('Invalid dashboard URL');
    expect(isValidDashboardUrl(GERMAN_IDN, { allowedIdnHosts: [GERMAN_PUNYCODE] })).toBe(true);
  });

  it('the SEP-0010 snippet never renders a look-alike dashboard link', () => {
    const none = buildSep0010ChallengeSnippet({ dashboardUrl: CYRILLIC_HOST, stellarAddress: 'GABC' });
    expect(none).toBeUndefined();

    const withXdr = buildSep0010ChallengeSnippet({ dashboardUrl: PUNYCODE_HOST, challengeXdr: 'AAAA'.repeat(10) });
    expect(withXdr).toBeDefined();
    expect(withXdr).not.toContain('xn--');
    expect(withXdr).not.toContain('Open dashboard proof');

    const allowed = buildSep0010ChallengeSnippet({
      dashboardUrl: GERMAN_IDN,
      linkHostPolicy: { allowedIdnHosts: [GERMAN_PUNYCODE] },
    });
    expect(allowed).toContain(`[Open dashboard proof](${GERMAN_IDN})`);
  });
});
