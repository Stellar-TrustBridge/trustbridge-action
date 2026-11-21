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

### Why registration order matters

`runPlugins()` (`src/pluginRunner.ts`) does not reorder anything: it runs
every plugin from `registry.list()` and writes one `CheckResultItem` per
plugin into `ValidationResult.checks[]`, **in registration order**. Nothing
downstream re-sorts that array:

- `formatCommentBody` (`src/comment.ts`) renders one comment line per entry
  of `checks[]`, top to bottom, in that order.
- the SARIF exporter (`src/sarif.ts`, `result.checks.map(...)`) emits one
  SARIF `result` per entry, in that order.

So the order `corePlugins` is declared in is the order assignees read check
rows in a Wave comment and the order a SARIF consumer sees results — even
though every plugin's pass/fail outcome is computed completely
independently of the others (there is no actual early-exit short-circuit in
`runPlugins`; each plugin always runs). A reorder of `corePlugins` changes
no outcome, but it reshuffles every downstream row and SARIF result, which
Wave CI diffing and assignee tooling can mistake for a real regression. That
is the "short-circuiting" risk this section and its tests guard against: not
that a later check stops running, but that *where a check's row lands*
silently depends on array order that is easy to disturb with an innocuous
edit (e.g. inserting a new plugin in the middle of the array instead of at
the end).

**Enforcement:** `__tests__/core-plugins-freeze.test.ts` locks `corePlugins`
against the table above, and `__tests__/core-plugins-golden-order.test.ts`
locks it a second time against the standalone golden fixture
`__tests__/__golden__/core-plugin-order.json`. Either test fails if a core
plugin is added, removed, renamed, or reordered without updating both the
table and the golden file in the same change — so a reorder is always an
explicit, reviewed decision instead of an accidental side effect of an
unrelated edit.

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
