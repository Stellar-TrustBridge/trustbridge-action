# Plugin Architecture

This document describes how TrustBridge discovers, loads, and runs third-party
plugins. It is intended for plugin authors and operators who rely on plugin
behavior in CI.

## Overview

Plugins are discovered by `src/pluginLoader.ts`, described by the `Plugin`
interface in `src/plugin.ts`, and executed by `src/pluginRunner.ts`. The runner
is responsible for enforcing two boundaries that keep a single misbehaving
plugin from poisoning an entire run:

1. **Timeout boundary** — every plugin invocation is bounded by a configured
timeout. A plugin that exceeds its timeout fails closed with a stable error
instead of hanging the Actions job.
2. **Isolation boundary** — a plugin that throws or times out is recorded as a
failure for that plugin only. Unrelated account validation continues and its
results are not aborted or corrupted.

## Plugin contract

A plugin implements the `Plugin` interface from `src/plugin.ts`. The runner
invokes the plugin and collects its results. Plugins must not assume they are
the only plugin running; they should treat their inputs as read-only and return
structured results.

## Built-in plugins

`src/corePlugins.ts` registers these plugins (in this order) before any user
plugin is loaded by `src/pluginLoader.ts`. The list is frozen by
`__tests__/core-plugins-freeze.test.ts`: adding, removing, renaming or
reordering a core plugin fails CI until this table is updated too.

| Order | Plugin id | Label |
|---|---|---|
| 1 | `trustbridge/account-funded` | Account funded |
| 2 | `trustbridge/trustline` | Trustline |
| 3 | `trustbridge/xlm-reserve` | XLM reserve |
| 4 | `trustbridge/home-domain` | SEP-0001 home domain |

User plugins must not reuse a `trustbridge/` id; the `trustbridge/` prefix is
reserved for built-in checks.

<!-- core-plugins:start -->
| Export | Plugin id | Label |
|---|---|---|
| `accountFundedPlugin` | `trustbridge/account-funded` | Account funded |
| `trustlinePlugin` | `trustbridge/trustline` | Trustline |
| `xlmReservePlugin` | `trustbridge/xlm-reserve` | XLM reserve |
| `homeDomainPlugin` | `trustbridge/home-domain` | SEP-0001 home domain |
<!-- core-plugins:end -->

Table above is machine-checked by `__tests__/plugin.test.ts`: export names
must resolve to the same plugin objects as `corePlugins`, in order.

## Timeout behavior

When a plugin exceeds its configured timeout, the runner:

- stops waiting on the plugin,
- records a failure result for that plugin with a clear, stable error message,
- continues processing the remaining plugins and account validation.

Operators should size timeouts to their slowest expected plugin while keeping
them short enough that a hung plugin cannot stall the job.

## Isolation behavior

Failures are scoped per plugin. A thrown error or timeout from one plugin does
not abort the run and does not alter the results produced by other plugins.
This fail-closed, per-plugin isolation is what allows unreliable third-party
checks to be included without risking unrelated account validation.

## Testing

Unit tests under `__tests__/` cover the plugin runner's happy path, the timeout
boundary (a plugin that hangs fails closed with a stable error), and the
isolation boundary (a failing or timing-out plugin does not abort or corrupt
results for unrelated validation). When changing runner behavior, keep
`src/pluginRunner.ts`, `src/plugin.ts`, and the tests consistent.

## Sandbox resource limits (CPU, memory, and wall-clock)

`src/pluginRunner.ts` executes plugins synchronously against a read-only `CheckPluginContext` snapshot (`account`, `config`, `stellarAddress`) after Horizon account pre-fetching completes. Because plugins run in-process on the GitHub Actions Node.js runner, resource consumption is bounded across three dimensions:

| Resource | Limit / Enforcement Mechanism | Source / Constant | Fail-Closed Behavior When Exceeded |
|---|---|---|---|
| **Wall-clock time** | `5000 ms` per plugin by default (configurable via `RunPluginsOptions.timeoutMs`) | `DEFAULT_PLUGIN_TIMEOUT_MS = 5000` in `src/pluginRunner.ts` (`runWithTimeout`) | `runWithTimeout` measures elapsed wall-clock time (`Date.now() - startedAt > timeoutMs`) around `plugin.run(ctx)` and replaces the plugin's output with `{ passed: false, detail: "Plugin `<id>` timed out after <timeoutMs>ms.", remediation: "Contact the plugin author to fix `<id>`." }`. Overall `ValidationResult.valid` becomes `false`. |
| **CPU** | Synchronous single-turn execution bounded by the per-plugin wall-clock budget (`timeoutMs`) | `CheckPlugin.run(ctx): CheckPluginResult` (synchronous ABI in `src/plugin.ts`) | Because `CheckPlugin.run` is synchronous (no `Promise` / background timer leaks), any CPU-bound loop that runs longer than `timeoutMs` breaches the wall-clock check and fails closed with the stable timeout result above. Subsequent plugins still execute. |
| **Memory** | Read-only shared `CheckPluginContext` (no network/Horizon payload cloning) within the Node.js V8 heap | `CheckPluginContext` (`readonly` fields in `src/plugin.ts`) + `try/catch` in `runPlugins` | If a plugin throws an allocation or runtime error (e.g. `RangeError` / unexpected `Error`), `runPlugins` catches it in its per-plugin `try/catch` and fails closed with `{ passed: false, detail: "Plugin `<id>` threw an unexpected error: <message>", remediation: "Contact the plugin author to fix `<id>`." }` without aborting other plugins. |

### Fail-closed examples

#### 1. Wall-clock / CPU budget exceeded (`elapsed > timeoutMs`)

When a third-party plugin `acme/slow-check` takes `5200 ms` under the default `DEFAULT_PLUGIN_TIMEOUT_MS` (`5000 ms`), `runPlugins` discards the late return value and records a failed check (with Markdown special characters escaped for non-`trustbridge/` plugin IDs):

```json
{
  "passed": false,
  "label": "Slow check",
  "detail": "Plugin \\`acme/slow\\-check\\` timed out after 5000ms."
}
```

And appends the escaped remediation to `ValidationResult.remediation`:

```text
Contact the plugin author to fix \`acme/slow\-check\`.
```

#### 2. Runtime / memory error thrown (`try/catch` isolation boundary)

When a plugin `acme/bad-alloc` throws `new RangeError('Invalid array length')`, `runPlugins` catches the exception, records a failed check for `acme/bad-alloc`, and continues evaluating the remaining registered plugins (such as `trustbridge/account-funded`, `trustbridge/trustline`, and `trustbridge/xlm-reserve`) so core account diagnostics are never lost.
