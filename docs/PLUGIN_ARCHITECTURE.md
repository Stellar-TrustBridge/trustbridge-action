# TrustBridge Plugin Architecture

Design document for the extensible check system.

Related docs: [README](../README.md) · [Usage](USAGE.md) · [Architecture](ARCHITECTURE.md) · [Contributing](../CONTRIBUTING.md)

---

## Why plugins?

The original `runAccountChecks` in `src/checks.ts` hard-coded checks in a single function. The plugin system makes each check a self-contained unit that composes into the same `ValidationResult` structure.

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

### `PluginRegistry`

A deduplication-safe registry storing `CheckPlugin` instances.
- **First-wins semantics**: Registering a plugin with an already existing `id` is a no-op.
- Maintains insertion order for running plugins.

### `ValidationResult` Composition

`runPlugins(ctx, registry)` executes plugins sequentially and builds a composite `ValidationResult`:
- `valid`: true only when *all* plugins pass.
- Top-level flags (`accountFunded`, `trustlineExists`, `xlmReserveMet`) are derived dynamically from well-known plugin ids (e.g., `'account-funded'`, `'trustline'`, `'xlm-reserve'`).
- `checks`: One `CheckResultItem` array item per plugin, preserving execution order.
- `remediation`: Aggregates all non-empty `remediation` strings from failed plugins.

---

## Lifecycle & Loader (`pluginLoader`)

### Asynchronous Loading

Plugins are dynamically imported at runtime via `file://` URLs. The `pluginLoader` resolves plugins relative to the workspace root (`GITHUB_WORKSPACE`).

- `loadPlugin`: Asynchronously loads and validates a single plugin. It looks for a `default` export, a named `plugin` export, or the first exported object matching the `CheckPlugin` interface.
- `loadPluginsFromAllowlist`: Loads multiple plugins defined in an allowlist. Missing or invalid plugins log warnings but **fail-open** so the core action is not blocked.

### Core Plugins (`corePlugins`)

The core checks are shipped as built-in plugins:
- `accountFundedPlugin` (`trustbridge/account-funded`)
- `trustlinePlugin` (`trustbridge/trustline`)
- `xlmReservePlugin` (`trustbridge/xlm-reserve`)
- `homeDomainPlugin` (`trustbridge/home-domain`)

These are pre-registered into the `defaultRegistry` at action startup via `registerCorePlugins()`.

---

## Core plugins

`src/corePlugins.ts` exports these built-in plugins. `corePlugins` lists them in this order, which is the order they appear in the comment table.

<!-- core-plugins:start -->
| Export | Plugin id | Label |
| ------ | --------- | ----- |
| `accountFundedPlugin` | `trustbridge/account-funded` | Account funded |
| `trustlinePlugin` | `trustbridge/trustline` | Trustline |
| `xlmReservePlugin` | `trustbridge/xlm-reserve` | XLM reserve |
| `homeDomainPlugin` | `trustbridge/home-domain` | SEP-0001 home domain |
<!-- core-plugins:end -->

`__tests__/plugin.test.ts` parses this table and fails when it drifts from `corePlugins`. When adding a core plugin, export it from `src/corePlugins.ts`, append it to `corePlugins`, and add a row here in the same change.

---

## Loading external plugins

`loadPluginsFromAllowlist()` loads each allowlisted path with `loadPlugin()`:

- A missing file, a failed import, or an export without `id`, `label` and `run()` throws `PluginLoadError` (`not_found`, `load_failed`, `invalid_export`). The allowlist loader logs a warning and skips that plugin (fail-open).
- Two allowlisted plugins that export the same `id` throw `PluginLoadError` with reason `duplicate_id`, naming both paths. The action then warns and continues with core plugins only, rather than silently dropping one of them.

---

## Security

Plugins are trusted repository files. The loader dynamically `import()`s allowlisted modules, so the security boundary is *which files may be imported*, not whether dynamic imports happen at all.

### 1. Typed context only
`run()` receives typed action inputs and Horizon data only.

### 2. Allowlist + workspace-root confinement
External plugins are loaded only when their path is explicitly listed in the allowlist (the `trustbridge_plugins_path` action input). Each path is resolved against the workspace root (`GITHUB_WORKSPACE`) and dynamically imported via a `file://` URL. The loader actively rejects:

- Absolute paths.
- Path traversal sequences (`../`) attempting to escape the workspace root.
- Non-file targets (e.g., directories or symlinks).
- Paths outside the workspace root, including `node_modules` and remote URLs.

Dynamic `import()` is therefore confined to trusted repository files under the workspace root that appear on the allowlist. The runner never evaluates strings and never imports code supplied through issue bodies or other untrusted input.

### 3. Shape validation
After import, the loader validates the module's shape before use: it accepts a `default` export, a named `plugin` export, or the first exported object matching the `CheckPlugin` interface, and requires `id`, `label`, and `run()`. Modules that fail validation throw `PluginLoadError` (`invalid_export`) and are skipped (fail-open).

### 4. Output escaping
The runner automatically escapes Markdown metacharacters in plugin `label`, `detail`, and `remediation` strings for all external plugins. Plugins should return plain text and must not attempt to include Markdown formatting (like `**bold**` or links), as it will be escaped and rendered literally. Core plugins (`trustbridge/*`) are trusted and may use Markdown formatting.

### 5. No runtime npm loading
Arbitrary npm packages are out of scope for v1.

### Threat model

- **Trusted**: repository files under the workspace root that are explicitly allowlisted. These are reviewed like any other source file and may be dynamically imported.
- **Untrusted**: issue bodies, comments, and any other external input. Code from these sources is never imported or evaluated; only typed action inputs and Horizon data reach `run()`.
- **Boundary**: the allowlist plus workspace-root path guards decide what may be imported. Anything not on the allowlist, or resolving outside the workspace root, is rejected before import.

---

## File map

```text
src/
  plugin.ts         - CheckPlugin, CheckPluginContext, CheckPluginResult, PluginRegistry
  pluginRunner.ts   - runPlugins(ctx, registry?) -> ValidationResult
  pluginLoader.ts   - Workspace-only async plugin loader with allowlist + path guards
  corePlugins.ts    - accountFundedPlugin, trustlinePlugin, xlmReservePlugin, homeDomainPlugin
__tests__/
  plugin.test.ts    - Registry, runner, core plugins, security contract
  plugin-loader.test.ts - Loader path guards and allowlist behavior
docs/
  PLUGIN_ARCHITECTURE.md - This document
```

---

[← Back to Architecture](ARCHITECTURE.md) · [← Back to README](../README.md)
