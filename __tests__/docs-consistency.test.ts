/**
 * Docs consistency for #785 (STRUCTURE.md), #786 (DEPENDABOT.md grouping),
 * and #787 (rate budget exhaustion FAQ playbook).
 */
import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('STRUCTURE.md (#785)', () => {
  const structure = read('docs/STRUCTURE.md');

  it.each(['snooze', 'roster'])('documents src/%s.ts and its test file', (mod) => {
    expect(fs.existsSync(path.join(root, 'src', `${mod}.ts`))).toBe(true);
    expect(fs.existsSync(path.join(root, '__tests__', `${mod}.test.ts`))).toBe(true);
    expect(structure).toContain(`\`src/${mod}.ts\``);
    expect(structure).toContain(`\`__tests__/${mod}.test.ts\``);
  });

  it('does not reference source modules that no longer exist', () => {
    const referenced = [...structure.matchAll(/`src\/([\w-]+)\.ts`/g)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    const missing = referenced.filter((m) => !fs.existsSync(path.join(root, 'src', `${m}.ts`)));
    expect(missing).toEqual([]);
  });
});

describe('DEPENDABOT.md grouping (#786)', () => {
  const config = read('.github/dependabot.yml');
  const doc = read('docs/DEPENDABOT.md');

  it('documents every group name declared in dependabot.yml', () => {
    const groupsBlock = config.split('groups:')[1] ?? '';
    const groups = [...groupsBlock.matchAll(/^ {6}([\w-]+):\s*$/gm)].map((m) => m[1]);
    expect(groups).toContain('actions-patches');
    for (const group of groups) expect(doc).toContain(`\`${group}\``);
  });

  it('matches PR limits and commit prefixes per ecosystem', () => {
    const limits = [...config.matchAll(/open-pull-requests-limit:\s*(\d+)/g)].map((m) => m[1]);
    const prefixes = [...config.matchAll(/prefix:\s*"([^"]+)"/g)].map((m) => m[1]);
    ['npm', 'github-actions'].forEach((eco, i) => {
      expect(doc).toMatch(
        new RegExp(`\\| \`${eco}\` \\|[^\\n]*\\| ${limits[i]} \\| \`${escapeRegExp(prefixes[i])}\``),
      );
    });
  });

  it('states that github-actions updates are not grouped', () => {
    const ghBlock = config.slice(config.indexOf('package-ecosystem: "github-actions"'));
    expect(ghBlock).not.toContain('groups:');
    expect(doc).toMatch(/\| `github-actions` \|[^\n]*\| none/);
  });
});

describe('FAQ rate budget exhaustion playbook (#787)', () => {
  const faq = read('docs/FAQ.md');

  it('has an anchored entry covering backoff, batch size, and budget raise', () => {
    const start = faq.indexOf('{#rate-budget-exhausted}');
    expect(start).toBeGreaterThan(-1);
    const section = faq.slice(start, faq.indexOf('\n## ', start));
    expect(section).toContain('RATE_BUDGET_EXHAUSTED');
    expect(section).toMatch(/Back off/);
    expect(section).toMatch(/Reduce batch size/);
    expect(section).toMatch(/Raise the budget/);
    expect(section).toContain('horizon_max_requests');
  });

  it('is linked from TROUBLESHOOTING.md and USAGE.md', () => {
    expect(read('docs/TROUBLESHOOTING.md')).toContain('FAQ.md#rate-budget-exhausted');
    expect(read('docs/USAGE.md')).toContain('FAQ.md#rate-budget-exhausted');
  });

  it('matches the reason code emitted by src/checks.ts', () => {
    expect(read('src/checks.ts')).toContain("reasonCode: 'RATE_BUDGET_EXHAUSTED'");
  });
});
