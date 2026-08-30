/**
 * Tests for src/template.ts — custom comment template loader (#312).
 *
 * Covers:
 * - Path validation and traversal prevention
 * - Size cap enforcement
 * - Content security (XSS / HTML injection / prototype pollution)
 * - Variable interpolation and escaping
 * - {{locale:KEY}} i18n integration
 * - Unknown placeholder suppression
 * - Integration via loadCommentTemplate()
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  validateTemplatePath,
  validateTemplateContent,
  interpolateTemplate,
  loadCommentTemplate,
  buildTemplateContext,
  MAX_TEMPLATE_BYTES,
} from '../src/template';
import type { TemplateContext } from '../src/template';

// ── Helpers ──────────────────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tb-template-test-'));
}

function writeFile(dir: string, name: string, content: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

const BASE_CTX: TemplateContext = {
  account: 'GABC...WXYZ',
  asset: 'USDC',
  issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  network: 'mainnet',
  horizon: 'https://horizon.stellar.org',
  status: '✅ ready',
  locale: 'en',
};

// ── validateTemplatePath ──────────────────────────────────────────────────────

describe('validateTemplatePath', () => {
  it('accepts a relative path inside workspace', () => {
    const workspace = '/workspace/repo';
    const resolved = validateTemplatePath('.trustbridge/comment.md', workspace);
    expect(resolved).toBe('/workspace/repo/.trustbridge/comment.md');
  });

  it('accepts an absolute path inside workspace', () => {
    const workspace = '/workspace/repo';
    const resolved = validateTemplatePath('/workspace/repo/templates/partial.md', workspace);
    expect(resolved).toBe('/workspace/repo/templates/partial.md');
  });

  it('rejects path traversal with ../', () => {
    const workspace = '/workspace/repo';
    expect(() => validateTemplatePath('../../etc/passwd', workspace)).toThrow(
      /resolves outside the workspace root/,
    );
  });

  it('rejects absolute path outside workspace', () => {
    const workspace = '/workspace/repo';
    expect(() => validateTemplatePath('/etc/shadow', workspace)).toThrow(
      /resolves outside the workspace root/,
    );
  });

  it('rejects normalized traversal (./../../etc)', () => {
    const workspace = '/workspace/repo';
    expect(() => validateTemplatePath('./../../etc/hosts', workspace)).toThrow(
      /resolves outside the workspace root/,
    );
  });

  it('accepts a path exactly at workspace root (edge case)', () => {
    const workspace = '/workspace/repo';
    // The root itself resolves to exactly resolvedRoot — not a child, but not outside.
    // validateTemplatePath allows this (resolved === resolvedRoot).
    const resolved = validateTemplatePath('/workspace/repo', workspace);
    expect(resolved).toBe('/workspace/repo');
  });
});

// ── validateTemplateContent ───────────────────────────────────────────────────

describe('validateTemplateContent', () => {
  it('accepts valid plain Markdown', () => {
    const markdown = '## Custom section\n\nSome _plain_ **markdown** text.\n';
    expect(() => validateTemplateContent(markdown)).not.toThrow();
  });

  it('accepts markdown with allowed {{variable}} placeholders', () => {
    const markdown = 'Account: {{account}}\nAsset: {{asset}}\nStatus: {{status}}';
    expect(() => validateTemplateContent(markdown)).not.toThrow();
  });

  it('rejects <script> tags', () => {
    expect(() => validateTemplateContent('<script>alert(1)</script>')).toThrow(
      /disallowed pattern/,
    );
  });

  it('rejects javascript: URIs', () => {
    expect(() => validateTemplateContent('[click](javascript:alert(1))')).toThrow(
      /disallowed pattern/,
    );
  });

  it('rejects vbscript: URIs', () => {
    expect(() => validateTemplateContent('[vb](vbscript:MsgBox())')).toThrow(
      /disallowed pattern/,
    );
  });

  it('rejects data:text/html URIs', () => {
    expect(() => validateTemplateContent('src="data:text/html,<h1>xss</h1>"')).toThrow(
      /disallowed pattern/,
    );
  });

  it('rejects inline event handlers (onclick=)', () => {
    expect(() => validateTemplateContent('<div onclick="alert(1)">click</div>')).toThrow(
      /disallowed pattern/,
    );
  });

  it('rejects inline event handlers (onmouseover=)', () => {
    expect(() => validateTemplateContent('<a onmouseover=alert(1)>hover</a>')).toThrow(
      /disallowed pattern/,
    );
  });

  it('rejects {{constructor}} placeholder', () => {
    expect(() => validateTemplateContent('Value: {{constructor}}')).toThrow(
      /forbidden placeholder name/,
    );
  });

  it('rejects {{__proto__}} placeholder', () => {
    expect(() => validateTemplateContent('Value: {{__proto__}}')).toThrow(
      /forbidden placeholder name/,
    );
  });

  it('rejects {{prototype}} placeholder', () => {
    expect(() => validateTemplateContent('Value: {{prototype}}')).toThrow(
      /forbidden placeholder name/,
    );
  });

  it('rejects {{__defineGetter__}} placeholder', () => {
    expect(() => validateTemplateContent('{{__defineGetter__}}')).toThrow(
      /forbidden placeholder name/,
    );
  });

  it('rejects constructor with mixed case', () => {
    expect(() => validateTemplateContent('{{Constructor}}')).toThrow(
      /forbidden placeholder name/,
    );
  });
});

// ── interpolateTemplate ───────────────────────────────────────────────────────

describe('interpolateTemplate', () => {
  it('substitutes {{account}} with escaped account', () => {
    const result = interpolateTemplate('Account: {{account}}', BASE_CTX);
    // escapeMarkdownInline escapes [ ] ( ) etc but GABC...WXYZ has no special chars
    expect(result).toContain('GABC...WXYZ');
  });

  it('substitutes {{asset}}', () => {
    const result = interpolateTemplate('Asset: {{asset}}', BASE_CTX);
    expect(result).toContain('USDC');
  });

  it('substitutes {{issuer}}', () => {
    const result = interpolateTemplate('Issuer: {{issuer}}', BASE_CTX);
    expect(result).toContain('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');
  });

  it('substitutes {{network}}', () => {
    const result = interpolateTemplate('Net: {{network}}', BASE_CTX);
    expect(result).toContain('mainnet');
  });

  it('substitutes {{horizon}}', () => {
    const result = interpolateTemplate('Horizon: {{horizon}}', BASE_CTX);
    expect(result).toContain('https://horizon.stellar.org');
  });

  it('substitutes {{status}} without escaping (safe emoji string)', () => {
    const result = interpolateTemplate('Status: {{status}}', BASE_CTX);
    expect(result).toContain('✅ ready');
  });

  it('replaces unknown placeholders with empty string', () => {
    const result = interpolateTemplate('X: {{unknownVar}} Y', BASE_CTX);
    expect(result).toBe('X:  Y');
  });

  it('substitutes {{locale:resultsHeading}} with en string', () => {
    const result = interpolateTemplate('## {{locale:resultsHeading}}', BASE_CTX);
    expect(result).toContain('Results');
  });

  it('substitutes {{locale:remediationHeading}} with es string', () => {
    const esCtx: TemplateContext = { ...BASE_CTX, locale: 'es' };
    const result = interpolateTemplate('## {{locale:remediationHeading}}', esCtx);
    expect(result).toContain('Remediación');
  });

  it('substitutes {{locale:balancesHeading}} with pt string', () => {
    const ptCtx: TemplateContext = { ...BASE_CTX, locale: 'pt' };
    const result = interpolateTemplate('## {{locale:balancesHeading}}', ptCtx);
    expect(result).toContain('Saldos');
  });

  it('returns empty string for unknown {{locale:nonexistentKey}}', () => {
    const result = interpolateTemplate('{{locale:nonexistentKey}}', BASE_CTX);
    expect(result).toBe('');
  });

  it('does not substitute function-typed locale fields', () => {
    // accountFundedPassDetail is a function, not a string — must be empty
    const result = interpolateTemplate('{{locale:accountFundedPassDetail}}', BASE_CTX);
    expect(result).toBe('');
  });

  it('escapes Markdown special characters in account', () => {
    const ctx: TemplateContext = {
      ...BASE_CTX,
      account: 'GA[EVIL](https://malicious.example)',
    };
    const result = interpolateTemplate('{{account}}', ctx);
    // Should have escaped [ ] ( )
    expect(result).not.toContain('[EVIL]');
    expect(result).toContain('\\[EVIL\\]');
  });

  it('escapes backticks in asset code', () => {
    const ctx: TemplateContext = {
      ...BASE_CTX,
      asset: 'USD`C',
    };
    const result = interpolateTemplate('{{asset}}', ctx);
    expect(result).toContain('\\`');
  });

  it('escapes asterisks in horizon URL', () => {
    const ctx: TemplateContext = {
      ...BASE_CTX,
      horizon: 'https://horizon*.example.com',
    };
    const result = interpolateTemplate('{{horizon}}', ctx);
    expect(result).toContain('\\*');
  });

  it('handles multiple placeholders in one template', () => {
    const template = '**{{asset}}** on {{network}} — {{status}}';
    const result = interpolateTemplate(template, BASE_CTX);
    expect(result).toContain('USDC');
    expect(result).toContain('mainnet');
    expect(result).toContain('✅ ready');
  });

  it('handles whitespace in placeholder names ({{  account  }})', () => {
    const result = interpolateTemplate('{{  account  }}', BASE_CTX);
    expect(result).toContain('GABC...WXYZ');
  });

  it('treats nested braces without double-brace gracefully (plain text)', () => {
    const result = interpolateTemplate('No placeholder here {single}', BASE_CTX);
    expect(result).toBe('No placeholder here {single}');
  });
});

// ── loadCommentTemplate ───────────────────────────────────────────────────────

describe('loadCommentTemplate', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('returns undefined when templatePath is empty', () => {
    expect(loadCommentTemplate('', BASE_CTX, workspace)).toBeUndefined();
  });

  it('returns undefined when templatePath is undefined', () => {
    expect(loadCommentTemplate(undefined, BASE_CTX, workspace)).toBeUndefined();
  });

  it('returns undefined when templatePath is null', () => {
    expect(loadCommentTemplate(null, BASE_CTX, workspace)).toBeUndefined();
  });

  it('returns undefined when file does not exist (non-fatal)', () => {
    expect(loadCommentTemplate('nonexistent.md', BASE_CTX, workspace)).toBeUndefined();
  });

  it('loads and interpolates a valid template', () => {
    writeFile(workspace, 'partial.md', '## Custom Help\n\nChecked: {{account}} ({{asset}} on {{network}})');
    const result = loadCommentTemplate('partial.md', BASE_CTX, workspace);
    expect(result).toContain('Custom Help');
    expect(result).toContain('GABC...WXYZ');
    expect(result).toContain('USDC');
    expect(result).toContain('mainnet');
  });

  it('throws on path traversal', () => {
    expect(() =>
      loadCommentTemplate('../../etc/passwd', BASE_CTX, workspace),
    ).toThrow(/resolves outside the workspace root/);
  });

  it('throws when file exceeds MAX_TEMPLATE_BYTES', () => {
    const bigContent = 'x'.repeat(MAX_TEMPLATE_BYTES + 1);
    writeFile(workspace, 'big.md', bigContent);
    expect(() => loadCommentTemplate('big.md', BASE_CTX, workspace)).toThrow(
      /exceeds the maximum allowed size/,
    );
  });

  it('accepts a file exactly at MAX_TEMPLATE_BYTES', () => {
    const exactContent = 'x'.repeat(MAX_TEMPLATE_BYTES);
    writeFile(workspace, 'exact.md', exactContent);
    const result = loadCommentTemplate('exact.md', BASE_CTX, workspace);
    expect(result).toBe(exactContent);
  });

  it('throws on template with <script> tag', () => {
    writeFile(workspace, 'evil.md', 'Hello <script>alert(1)</script>');
    expect(() => loadCommentTemplate('evil.md', BASE_CTX, workspace)).toThrow(
      /disallowed pattern/,
    );
  });

  it('throws on template with javascript: URI', () => {
    writeFile(workspace, 'jsuri.md', '[click me](javascript:alert(document.domain))');
    expect(() => loadCommentTemplate('jsuri.md', BASE_CTX, workspace)).toThrow(
      /disallowed pattern/,
    );
  });

  it('throws on template with {{constructor}}', () => {
    writeFile(workspace, 'proto.md', 'Value: {{constructor.prototype.isAdmin}}');
    expect(() => loadCommentTemplate('proto.md', BASE_CTX, workspace)).toThrow(
      /forbidden placeholder name/,
    );
  });

  it('uses GITHUB_WORKSPACE env as default workspace root', () => {
    const originalEnv = process.env['GITHUB_WORKSPACE'];
    process.env['GITHUB_WORKSPACE'] = workspace;
    writeFile(workspace, 'env-partial.md', 'Status: {{status}}');
    try {
      const result = loadCommentTemplate('env-partial.md', BASE_CTX);
      expect(result).toContain('✅ ready');
    } finally {
      if (originalEnv === undefined) {
        delete process.env['GITHUB_WORKSPACE'];
      } else {
        process.env['GITHUB_WORKSPACE'] = originalEnv;
      }
    }
  });

  it('handles subdirectory paths inside workspace', () => {
    const subdir = path.join(workspace, '.trustbridge');
    fs.mkdirSync(subdir);
    writeFile(subdir, 'help.md', '## Campaign Help\n\nNetwork: {{network}}');
    const result = loadCommentTemplate('.trustbridge/help.md', BASE_CTX, workspace);
    expect(result).toContain('Campaign Help');
    expect(result).toContain('mainnet');
  });
});

// ── buildTemplateContext ──────────────────────────────────────────────────────

describe('buildTemplateContext', () => {
  it('builds valid context with ready status', () => {
    const ctx = buildTemplateContext({
      stellarAddress: 'GABC...XYZ',
      assetCode: 'USDC',
      assetIssuer: 'GAAAAAA',
      horizonUrl: 'https://horizon.stellar.org',
      network: 'mainnet',
      valid: true,
      locale: 'en',
    });
    expect(ctx.status).toBe('✅ ready');
    expect(ctx.account).toBe('GABC...XYZ');
    expect(ctx.asset).toBe('USDC');
    expect(ctx.locale).toBe('en');
  });

  it('builds valid context with blocked status', () => {
    const ctx = buildTemplateContext({
      stellarAddress: 'GABC...XYZ',
      assetCode: 'USDC',
      assetIssuer: 'GAAAAAA',
      horizonUrl: 'https://horizon.stellar.org',
      network: 'mainnet',
      valid: false,
      locale: 'es',
    });
    expect(ctx.status).toBe('❌ blocked');
    expect(ctx.locale).toBe('es');
  });
});

// ── Injection scenario integration tests ─────────────────────────────────────

describe('injection prevention integration', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('prevents Markdown link injection via {{account}} with injected link syntax', () => {
    const injectedCtx: TemplateContext = {
      ...BASE_CTX,
      account: '](https://steal-credentials.example)',
    };
    writeFile(workspace, 'partial.md', 'Account: [{{account}}](https://lab.stellar.org)');
    const result = loadCommentTemplate('partial.md', injectedCtx, workspace);
    // escapeMarkdownInline escapes ] ( ) but NOT - or .
    // So the injected value becomes: \]\(https://steal-credentials.example\)
    // This breaks the Markdown link syntax — the injected URL is not rendered as a live link.
    expect(result).toContain('\\]\\(https://steal-credentials.example\\)');
    // The outer template link target (lab.stellar.org) should remain
    expect(result).toContain('https://lab.stellar.org');
  });

  it('prevents heading injection via {{asset}} with # characters', () => {
    const injectedCtx: TemplateContext = {
      ...BASE_CTX,
      asset: '# INJECTED HEADING\n## Sub',
    };
    writeFile(workspace, 'partial.md', 'Asset: {{asset}}');
    const result = loadCommentTemplate('partial.md', injectedCtx, workspace);
    // # is escaped by escapeMarkdownInline
    expect(result).toContain('\\#');
  });

  it('prevents emphasis injection via {{issuer}} with ** markers', () => {
    const injectedCtx: TemplateContext = {
      ...BASE_CTX,
      issuer: '**bold** or _italic_',
    };
    writeFile(workspace, 'partial.md', 'Issuer: {{issuer}}');
    const result = loadCommentTemplate('partial.md', injectedCtx, workspace);
    expect(result).toContain('\\*\\*bold\\*\\*');
    expect(result).toContain('\\_italic\\_');
  });

  it('prevents code injection via {{network}} with backtick', () => {
    const injectedCtx: TemplateContext = {
      ...BASE_CTX,
      network: '`rm -rf /`',
    };
    writeFile(workspace, 'partial.md', 'Network: {{network}}');
    const result = loadCommentTemplate('partial.md', injectedCtx, workspace);
    expect(result).toContain('\\`');
    expect(result).not.toContain('`rm -rf /`');
  });

  it('does not let unknown placeholders echo through', () => {
    // An attacker might try to embed a raw Markdown link via an unknown key
    writeFile(workspace, 'partial.md', 'Click: {{evil_var}}');
    const result = loadCommentTemplate('partial.md', BASE_CTX, workspace);
    // Unknown var → empty string
    expect(result).toBe('Click: ');
  });

  it('rejects template with inline event handler onload=', () => {
    writeFile(workspace, 'evil2.md', '<img onload="fetch(\'https://evil.com\')" src="x">');
    expect(() => loadCommentTemplate('evil2.md', BASE_CTX, workspace)).toThrow(
      /disallowed pattern/,
    );
  });

  it('allows plain safe links in template (not injection)', () => {
    writeFile(workspace, 'safe.md', 'See [Stellar Lab](https://laboratory.stellar.org) for help.');
    const result = loadCommentTemplate('safe.md', BASE_CTX, workspace);
    expect(result).toContain('https://laboratory.stellar.org');
  });
});
