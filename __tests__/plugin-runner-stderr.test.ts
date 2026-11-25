import { PluginRegistry, CheckPlugin, CheckPluginContext } from '../src/plugin';
import {
  runPlugins,
  captureStderr,
  PluginStderrCapture,
  PLUGIN_STDERR_TRUNCATION_MARKER,
} from '../src/pluginRunner';
import { buildPluginStderrDiagnostics } from '../src/diagnostics';

const ADDR = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const ctx = { account: null, config: {}, stellarAddress: ADDR } as unknown as CheckPluginContext;

function registryWith(...plugins: CheckPlugin[]): PluginRegistry {
  const r = new PluginRegistry();
  plugins.forEach((p) => r.register(p));
  return r;
}

function plugin(id: string, run: CheckPlugin['run']): CheckPlugin {
  return { id, label: id, run } as CheckPlugin;
}

describe('pluginRunner stderr capture (Issue #954)', () => {
  it('happy path: captures stderr, does not leak it raw, restores the writer', () => {
    const original = process.stderr.write;
    const captures: PluginStderrCapture[] = [];
    const result = runPlugins(
      ctx,
      registryWith(
        plugin('acme/noisy', () => {
          process.stderr.write('warming cache\n');
          return { passed: true, detail: 'ok' };
        }),
      ),
      { onPluginStderr: (c) => captures.push(c) },
    );
    expect(result.valid).toBe(true);
    expect(captures).toEqual([
      { pluginId: 'acme/noisy', text: 'warming cache\n', totalBytes: 14, truncated: false },
    ]);
    expect(process.stderr.write).toBe(original);
  });

  it('caps output at stderrMaxBytes and flags truncation', () => {
    const captures: PluginStderrCapture[] = [];
    runPlugins(
      ctx,
      registryWith(
        plugin('acme/flood', () => {
          for (let i = 0; i < 1000; i++) process.stderr.write('x'.repeat(100));
          return { passed: true, detail: 'ok' };
        }),
      ),
      { stderrMaxBytes: 256, onPluginStderr: (c) => captures.push(c) },
    );
    expect(captures[0].truncated).toBe(true);
    expect(captures[0].totalBytes).toBe(100_000);
    expect(captures[0].text).toBe('x'.repeat(256) + PLUGIN_STDERR_TRUNCATION_MARKER);
  });

  it('redacts addresses and secrets in captured stderr', () => {
    const { capture } = captureStderr(() => {
      process.stderr.write(`checking ${ADDR} token=ghp_supersecretvalue123\n`);
    });
    expect(capture.text).not.toContain(ADDR);
    expect(capture.text).not.toContain('ghp_supersecretvalue123');
  });

  it('keeps capture and fails closed when the plugin throws', () => {
    const original = process.stderr.write;
    const captures: PluginStderrCapture[] = [];
    const result = runPlugins(
      ctx,
      registryWith(
        plugin('acme/broken', () => {
          process.stderr.write('about to fail\n');
          throw new Error(`boom for ${ADDR}`);
        }),
      ),
      { onPluginStderr: (c) => captures.push(c) },
    );
    expect(result.valid).toBe(false);
    expect(result.checks[0].detail).not.toContain(ADDR);
    expect(captures[0].text).toBe('about to fail\n');
    expect(process.stderr.write).toBe(original);
  });

  it('skips the callback for silent plugins and renders diagnostics', () => {
    const captures: PluginStderrCapture[] = [];
    runPlugins(ctx, registryWith(plugin('acme/quiet', () => ({ passed: true, detail: 'ok' }))), {
      onPluginStderr: (c) => captures.push(c),
    });
    expect(captures).toEqual([]);
    expect(buildPluginStderrDiagnostics([])).toBe('');
    const md = buildPluginStderrDiagnostics([
      { pluginId: 'acme/x', text: 'hi', totalBytes: 9000, truncated: true },
    ]);
    expect(md).toContain('`acme/x`** — 9000 byte(s), truncated');
  });
});
