import * as fs from 'fs';
import * as path from 'path';
import {
  ASSET_REASON_CODES,
  BATCH_ONLY_REASON_CODES,
  REASON_CODES,
  REASON_CODE_ALIASES,
  WEBHOOK_DELIVERY_REASON_CODES,
  ReasonCodeAlias,
  deprecatedReasonCodesFor,
  validateReasonCodeAliases,
} from '../src/reasonCodes';
import { BATCH_REASON_CODES } from '../src/batch';
import { WEBHOOK_ASSET_REASON_CODES, buildWebhookPayload, validateWebhookPayload } from '../src/webhook';

const doc = (name: string): string => fs.readFileSync(path.resolve(__dirname, '../docs', name), 'utf8');
const day = (d: string): Date => new Date(`${d}T12:00:00Z`);
const alias: ReasonCodeAlias = {
  deprecated: 'NO_TRUSTLINE',
  canonical: 'TRUSTLINE_MISSING',
  deprecatedOn: '2026-01-01',
  removeAfter: '2026-03-31',
};

describe('reason code registry (#944)', () => {
  const all = [...REASON_CODES, ...BATCH_ONLY_REASON_CODES, ...WEBHOOK_DELIVERY_REASON_CODES];

  it('has no duplicates and documents every code in SCHEMA.md', () => {
    expect(new Set(all).size).toBe(all.length);
    const schema = doc('SCHEMA.md');
    expect(all.filter((c) => !schema.includes(`\`${c}\``))).toEqual([]);
  });

  it('covers batch and webhook codes', () => {
    for (const code of Object.values(BATCH_REASON_CODES)) expect(all).toContain(code);
    expect(WEBHOOK_ASSET_REASON_CODES).toBe(ASSET_REASON_CODES);
  });

  it('rejects undeclared literals at compile time', () => {
    // @ts-expect-error undeclared codes are not assignable
    const bad: (typeof REASON_CODES)[number] = 'MADE_UP';
    expect(REASON_CODES).not.toContain(bad);
  });
});

describe('reason code aliases (#945)', () => {
  it('registry is valid, unexpired and in the calendar', () => {
    expect(validateReasonCodeAliases()).toEqual([]);
    for (const a of REASON_CODE_ALIASES) {
      expect(doc('BREAKING_CHANGES.md')).toContain(
        `| \`${a.deprecated}\` | \`${a.canonical}\` | ${a.deprecatedOn} | ${a.removeAfter} |`,
      );
    }
  });

  it.each([
    ['2025-12-31', []],
    ['2026-01-01', ['NO_TRUSTLINE']],
    ['2026-03-31', ['NO_TRUSTLINE']],
    ['2026-04-01', []],
  ])('window on %s', (d, expected) => {
    expect(deprecatedReasonCodesFor('TRUSTLINE_MISSING', day(d), [alias])).toEqual(expected);
  });

  it('fails expired and malformed aliases', () => {
    expect(validateReasonCodeAliases([alias], day('2026-02-01'))).toEqual([]);
    expect(validateReasonCodeAliases([alias], day('2026-04-01'))[0]).toContain('expired');
    const bad = { ...alias, deprecated: 'SUCCESS', canonical: 'NOPE', removeAfter: '2026-02-30' } as unknown as ReasonCodeAlias;
    expect(validateReasonCodeAliases([bad, bad], day('2026-02-01'))).toHaveLength(7);
  });

  it('dual-emits in webhook assets during the window and validates the field', () => {
    const registry = REASON_CODE_ALIASES as ReasonCodeAlias[];
    registry.push({ ...alias, deprecatedOn: '2000-01-01', removeAfter: '9999-12-31' });
    try {
      const G = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
      const payload = buildWebhookPayload(
        { valid: false, accountFunded: true, trustlineExists: false, xlmBalance: '5', checks: [{ label: 'a', passed: false, detail: '' }] } as never,
        G, 'o/r', 1,
        [{ assetCode: 'USDC', assetIssuer: G, primary: true, trustlineExists: false, clawbackEnabled: false, reasonCode: 'TRUSTLINE_MISSING' }],
      );
      expect(payload.assets?.[0]).toMatchObject({ reason_code: 'TRUSTLINE_MISSING', deprecated_reason_codes: ['NO_TRUSTLINE'] });
      const before = JSON.stringify(validateWebhookPayload(payload));
      expect(before).not.toContain('deprecated_reason_codes');
      payload.assets![0].deprecated_reason_codes = [];
      expect(JSON.stringify(validateWebhookPayload(payload))).toContain('deprecated_reason_codes');
    } finally {
      registry.pop();
    }
  });
});

describe('Friendbot FAQ (#929)', () => {
  const section = doc('FAQ.md').split('{#friendbot-testnet-false-negatives}')[1]?.split('\n## ')[0] ?? '';

  it('uses only cataloged reason codes', () => {
    const codes = [...section.matchAll(/`([A-Z]+(?:_[A-Z]+)+)`/g)].map((m) => m[1]);
    expect(codes).toContain('ACCOUNT_NOT_FUNDED');
    for (const c of codes) expect(REASON_CODES).toContain(c);
  });

  it('is linked from related docs and links to an existing example', () => {
    for (const f of ['USAGE.md', 'TROUBLESHOOTING.md', 'examples/friendbot-testnet-onboarding.yml']) {
      expect(doc(f)).toContain('FAQ.md#friendbot-testnet-false-negatives');
    }
    expect(section).toContain('(examples/friendbot-testnet-onboarding.yml)');
  });
});
