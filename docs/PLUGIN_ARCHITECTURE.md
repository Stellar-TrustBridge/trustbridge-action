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
wall-clock budget. A plugin that exceeds its budget fails closed with a
stable error instead of being treated as passing.
2. **Isolation boundary** — a plugin that throws or times out is recorded as a
failure for that plugin only. Unrelated account validation continues and its
results are not aborted or corrupted.

Neither boundary is a true OS-level sandbox — see
[Resource limits](#resource-limits) for what is and is not enforced.

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

Plugins are synchronous by contract (`CheckPlugin.run` returns, it does not
return a `Promise`). When a plugin's `run()` call returns after exceeding its
configured timeout, the runner:

- records a failure result for that plugin with a clear, stable
  ``timed out after <N>ms`` error message instead of the plugin's own result,
- continues processing the remaining plugins and account validation.

**This is a post-hoc measurement, not preemptive cancellation.** The runner
times how long the synchronous call took *after it returns* — it has no way
to interrupt a plugin that is still running, because JavaScript's single
thread cannot forcibly suspend another synchronous call on the same thread.
A plugin with an infinite loop (or any call that never returns, such as a
blocking network request with no client-side timeout) still hangs the job
indefinitely; the timeout boundary only protects against a plugin that is
merely *slow* and eventually returns. Keep plugin logic non-blocking and
avoid any I/O without its own timeout.

### Configuring the budget

- `options.timeoutMs` passed to `runPlugins()` sets the default budget for
  every plugin (`DEFAULT_PLUGIN_TIMEOUT_MS` = 5000ms when omitted).
- A plugin may declare its own `timeoutMs` field (`CheckPlugin.timeoutMs`),
  which overrides the runner-wide default for that plugin only — useful for
  a plugin that is known to need more (or less) time than average without
  loosening the budget for every other plugin.

Operators should size timeouts to their slowest expected plugin while keeping
them short enough that a hung plugin cannot stall the job.

## Resource limits

TrustBridge plugins run **in-process**, in the same Node.js runtime and
GitHub Actions job as the action itself — there is no subprocess, container,
or worker-thread sandbox around a plugin's `run()` call. This is a deliberate
v1 simplicity trade-off (see "Execute the check synchronously" in
`src/plugin.ts`), and it means the resource boundaries work differently from
what "sandbox" might suggest:

| Resource | Enforced by | What actually happens |
|---|---|---|
| Wall clock | `pluginRunner.ts` (`options.timeoutMs` / `plugin.timeoutMs`) | A plugin whose `run()` call returns late fails closed for that plugin, as described above. Not preemptive — see the caveat above. |
| CPU | Not enforced by TrustBridge | A plugin shares the single Node.js thread with the action and every other plugin. A CPU-heavy plugin slows down (and, if it never yields, can stall) the whole job; the GitHub Actions runner's own CPU allocation (2-core on standard Linux runners at the time of writing) is the only ceiling. |
| Memory | Not enforced by TrustBridge | A plugin shares the action's V8 heap. A plugin that allocates excessively can trigger an out-of-memory crash of the whole job (not just that plugin), or get killed by the runner's own memory limit. There is no per-plugin memory cap or accounting. |

**Fail-closed behavior in practice:**

- **Exceeds its wall-clock budget but returns:** fails closed — recorded as
  a failed check for that plugin only; every other plugin and core check
  still runs and reports normally (see "Isolation behavior" below).
- **Exceeds CPU/memory enough to crash the Node process, or never returns
  at all:** there is no fail-closed outcome — the whole job fails (killed by
  the runner), because nothing short of process-level isolation can recover
  from that. Review third-party plugin code before registering it; the
  timeout boundary is not a substitute for that review.

A future version could move plugin execution into a worker thread or
subprocess to add real CPU/memory isolation; that is out of scope for the
synchronous, in-process v1 contract described here (see
[ARCHITECTURE.md — Extension points](ARCHITECTURE.md#extension-points)).

## Isolation behavior

Failures are scoped per plugin. A thrown error or timeout from one plugin does
not abort the run and does not alter the results produced by other plugins.
This fail-closed, per-plugin isolation is what allows unreliable third-party
checks to be included without risking unrelated account validation.

## Testing

Unit tests under `__tests__/plugin.test.ts` cover the plugin runner's happy
path, the timeout boundary (a slow plugin that returns late fails closed
with a stable error, including the per-plugin `timeoutMs` override — Issue
#797), and the isolation boundary (a failing or timing-out plugin does not
abort or corrupt results for unrelated validation). When changing runner
behavior, keep `src/pluginRunner.ts`, `src/plugin.ts`, and the tests
consistent.
