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
