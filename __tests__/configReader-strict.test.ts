/**
 * Issue #927: unknown-key handling in strict mode.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  findUnknownConfigKeys,
  readTrustbridgeConfig,
  readTrustbridgeConfigs,
  suggestConfigKey,
} from '../src/configReader';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-strict-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

describe('configReader strict mode (Issue #927)', () => {
  it('accepts a config with only known keys in strict mode', () => {
    write('.trustbridge.yml', 'asset_code: USDC\nfail_on_missing: true\n');
    const result = readTrustbridgeConfig('.trustbridge.yml', root, { strict: true });
    expect(result.validation.valid).toBe(true);
    expect(result.config).toEqual({ asset_code: 'USDC', fail_on_missing: true });
  });

  it('rejects a typo with a did-you-mean hint in strict mode', () => {
    write('.trustbridge.yml', 'asset_code: USDC\nmin_xlm_reserv: "2"\n');
    const result = readTrustbridgeConfig('.trustbridge.yml', root, { strict: true });
    expect(result.validation.valid).toBe(false);
    expect(result.config).toBeNull();
    expect(result.validation.errors.join('\n')).toContain(
      'Unknown trustbridge config key "min_xlm_reserv" (did you mean "min_xlm_reserve"?)',
    );
  });

  it('rejects completely unknown keys without a suggestion', () => {
    expect(findUnknownConfigKeys({ zzzzzzzzzz: 1 })[0]).not.toContain('did you mean');
    expect(suggestConfigKey('asset-code')).toBe('asset_code');
  });

  it('keeps lenient mode unchanged: unknown keys are ignored', () => {
    write('.trustbridge.yml', 'asset_code: USDC\nmin_xlm_reserv: "2"\n');
    const result = readTrustbridgeConfig('.trustbridge.yml', root);
    expect(result.validation.valid).toBe(true);
    expect(result.validation.errors).toEqual([]);
    expect(result.config).toEqual({ asset_code: 'USDC' });
  });

  it('applies strict mode to both org and repo configs', () => {
    write('.github/trustbridge.yml', 'asset_cod: USDC\n');
    write('.trustbridge.yml', 'asset_code: USDC\n');
    const result = readTrustbridgeConfigs(undefined, root, { strict: true });
    expect(result.validation.valid).toBe(false);
    expect(result.validation.errors.join('\n')).toContain('"asset_cod"');
  });
});
