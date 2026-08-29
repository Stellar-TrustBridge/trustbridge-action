# TrustBridge Plugin Architecture

Design document for the extensible check system.

Related docs: [README](../README.md) · [Usage](USAGE.md) · [Architecture](ARCHITECTURE.md) · [Contributing](../CONTRIBUTING.md)

---

## Why plugins?

The original `runAccountChecks` in `src/checks.ts` hard-codes three checks in a single function. The plugin system makes each check a self-contained unit that composes into the same `ValidationResult` structure.

---

## Core concepts

### `CheckPlugin`

```ts
interface CheckPlugin {
  readonly id: string;
  readonly label: string;
  run(ctx: CheckPluginContext): CheckPluginResult;
}
```

### `CheckPluginContext`

```ts
interface CheckPluginContext {
  readonly account: HorizonAccount | null;
  readonly config: Readonly<CheckConfig>;
  readonly stellarAddress: string;
}
```

### `CheckPluginResult`

```ts
interface CheckPluginResult {
  readonly passed: boolean;
  readonly detail: string;
  readonly remediation?: string;
}
```

---

## Security

Plugins must not execute arbitrary code sourced from issue bodies.

### 1. Typed context only
`run()` receives typed action inputs and Horizon data only.

### 2. No dynamic imports or eval
Plugins are reviewed TypeScript source files. The runner does not evaluate strings.

### 3. Output escaping responsibility
Plugin strings must escape external values before returning them.

### 4. No runtime npm loading
Arbitrary npm packages are out of scope for v1.

### 5. Frozen workspace layout for optional plugins
Optional plugins are loaded from the workspace only, never from `node_modules` or remote URLs.

- Workspace root: `GITHUB_WORKSPACE`
- Example plugin path: `plugins/kyc.ts`
- Enable via action input: `trustbridge_plugins_path: plugins/kyc.ts`
- Example secret source: `process.env.KYC_API_KEY`

The loader rejects absolute paths and any path that escapes the workspace root.

---

## File map

```text
src/
  plugin.ts         - CheckPlugin, CheckPluginContext, CheckPluginResult, PluginRegistry
  pluginRunner.ts   - runPlugins(ctx, registry?) -> ValidationResult
  pluginLoader.ts   - workspace-only plugin loader with allowlist + path guards
  corePlugins.ts    - accountFundedPlugin, trustlinePlugin, xlmReservePlugin
__tests__/
  plugin.test.ts    - registry, runner, core plugins, security contract
  plugin-loader.test.ts - loader path guards and allowlist behavior
docs/
  PLUGIN_ARCHITECTURE.md - this document
```

---

[← Back to Architecture](ARCHITECTURE.md) · [← Back to README](../README.md)
