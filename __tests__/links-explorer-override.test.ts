/**
 * Issue #910 — explorer base URL override validation per network.
 *
 * Proves that overrides are host-allowlisted per network, that http is
 * rejected on pubnet (and tolerated on testnet only for allowlisted hosts),
 * that every rejection carries a stable reason code, and that the rendering
 * path falls back to the documented safe default.
 *
 * Validate with: npm test -- --testPathPattern links-explorer-override
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  buildExplorerAccountLink,
  DEFAULT_EXPLORER_BASE_URLS,
  EXPLORER_HOST_ALLOWLIST,
  MAX_EXPLORER_URL_LENGTH,
  resolveExplorerBaseUrl,
  StellarNetwork,
  validateExplorerBaseUrl,
} from '../src/links';
import { parseExplorerBaseUrlInput } from '../src/inputs';

const ADDRESS = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

describe('validateExplorerBaseUrl — accepted overrides', () => {
  it.each<[string, StellarNetwork, string]>([
    ['https://stellar.expert/explorer/public', 'public', 'https://stellar.expert/explorer/public'],
    ['https://stellar.expert/explorer/public/', 'public', 'https://stellar.expert/explorer/public'],
    ['https://STELLARCHAIN.IO', 'public', 'https://stellarchain.io'],
    ['https://stellar.expert/explorer/testnet?x=1#frag', 'testnet', 'https://stellar.expert/explorer/testnet'],
    ['https://testnet.stellarchain.io', 'testnet', 'https://testnet.stellarchain.io'],
    ['http://stellar.expert/explorer/testnet', 'testnet', 'http://stellar.expert/explorer/testnet'],
  ])('%s on %s → %s', (url, network, expected) => {
    expect(validateExplorerBaseUrl(url, network)).toEqual({ ok: true, baseUrl: expected });
  });
});

describe('validateExplorerBaseUrl — rejected overrides', () => {
  it.each<[string, StellarNetwork, string]>([
    ['', 'public', 'EXPLORER_URL_EMPTY'],
    ['   ', 'testnet', 'EXPLORER_URL_EMPTY'],
    [`https://stellar.expert/${'a'.repeat(MAX_EXPLORER_URL_LENGTH)}`, 'public', 'EXPLORER_URL_TOO_LONG'],
    ['stellar.expert/explorer/public', 'public', 'EXPLORER_URL_MALFORMED'],
    ['http://stellar.expert/explorer/public', 'public', 'EXPLORER_URL_INSECURE_SCHEME'],
    ['javascript:alert(1)', 'testnet', 'EXPLORER_URL_INSECURE_SCHEME'],
    ['data:text/html,<script>alert(1)</script>', 'public', 'EXPLORER_URL_INSECURE_SCHEME'],
    ['https://user:pass@stellar.expert/', 'public', 'EXPLORER_URL_CREDENTIALS'],
    ['https://evil.example.com/explorer/public', 'public', 'EXPLORER_URL_HOST_NOT_ALLOWED'],
    ['https://stellar.expert.attacker.example/', 'public', 'EXPLORER_URL_HOST_NOT_ALLOWED'],
    ['https://evil-stellar.expert/', 'public', 'EXPLORER_URL_HOST_NOT_ALLOWED'],
    ['https://testnet.stellarchain.io', 'public', 'EXPLORER_URL_HOST_NOT_ALLOWED'],
    ['http://evil.example.com', 'testnet', 'EXPLORER_URL_HOST_NOT_ALLOWED'],
    ['https://127.0.0.1/', 'testnet', 'EXPLORER_URL_HOST_NOT_ALLOWED'],
    ["https://stellar.expert/x')[phish](https://evil.example", 'public', 'EXPLORER_URL_UNSAFE'],
  ])('%j on %s → %s', (url, network, code) => {
    const result = validateExplorerBaseUrl(url, network);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(code);
    }
  });

  it('names pubnet and the https requirement when http is used on public', () => {
    const result = validateExplorerBaseUrl('http://stellar.expert/explorer/public', 'public');
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining('must use https:// on public'),
    });
  });

  it('never echoes the full override path in the rejection message', () => {
    const result = validateExplorerBaseUrl('https://evil.example.com/secret-path?token=abc', 'public');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('evil.example.com');
      expect(result.message).not.toContain('secret-path');
      expect(result.message).not.toContain('token=abc');
    }
  });
});

describe('resolveExplorerBaseUrl / buildExplorerAccountLink', () => {
  it('uses the safe default per network when no override is set', () => {
    expect(resolveExplorerBaseUrl('public')).toBe(DEFAULT_EXPLORER_BASE_URLS.public);
    expect(resolveExplorerBaseUrl('testnet', '  ')).toBe(DEFAULT_EXPLORER_BASE_URLS.testnet);
  });

  it('falls back to the default instead of rendering a rejected override', () => {
    expect(buildExplorerAccountLink(ADDRESS, 'public', 'http://stellar.expert/explorer/public')).toBe(
      `${DEFAULT_EXPLORER_BASE_URLS.public}/account/${ADDRESS}`,
    );
    expect(buildExplorerAccountLink(ADDRESS, 'public', 'https://evil.example.com')).toBe(
      `${DEFAULT_EXPLORER_BASE_URLS.public}/account/${ADDRESS}`,
    );
  });

  it('honors an accepted override', () => {
    expect(buildExplorerAccountLink(ADDRESS, 'public', 'https://stellarchain.io/')).toBe(
      `https://stellarchain.io/account/${ADDRESS}`,
    );
  });

  it('every default is itself accepted by the validator', () => {
    for (const network of Object.keys(DEFAULT_EXPLORER_BASE_URLS) as StellarNetwork[]) {
      expect(validateExplorerBaseUrl(DEFAULT_EXPLORER_BASE_URLS[network], network).ok).toBe(true);
    }
  });
});

describe('parseExplorerBaseUrlInput', () => {
  it('returns "" for an empty input (use the default)', () => {
    expect(parseExplorerBaseUrlInput('', 'public')).toBe('');
    expect(parseExplorerBaseUrlInput(undefined, 'testnet')).toBe('');
  });

  it('returns the normalized base for a valid override', () => {
    expect(parseExplorerBaseUrlInput(' https://stellar.expert/explorer/public/ ', 'public')).toBe(
      'https://stellar.expert/explorer/public',
    );
  });

  it('throws with the stable reason code for http on pubnet', () => {
    expect(() => parseExplorerBaseUrlInput('http://stellar.expert', 'public')).toThrow(
      /^explorer_base_url rejected \(EXPLORER_URL_INSECURE_SCHEME\):/,
    );
  });

  it('throws with the stable reason code for a host outside the allowlist', () => {
    expect(() => parseExplorerBaseUrlInput('https://phish.example', 'testnet')).toThrow(
      /^explorer_base_url rejected \(EXPLORER_URL_HOST_NOT_ALLOWED\):/,
    );
  });
});

describe('docs/USAGE.md stays aligned with the explorer allowlist', () => {
  const usage = fs.readFileSync(path.resolve(__dirname, '..', 'docs', 'USAGE.md'), 'utf8');

  it('documents every default and allowlisted host', () => {
    for (const network of Object.keys(EXPLORER_HOST_ALLOWLIST) as StellarNetwork[]) {
      expect(usage).toContain(`\`${DEFAULT_EXPLORER_BASE_URLS[network]}\``);
      for (const host of EXPLORER_HOST_ALLOWLIST[network]) {
        expect(usage).toContain(`\`${host}\``);
      }
    }
  });
});
