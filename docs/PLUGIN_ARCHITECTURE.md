



# Plugin Architecture

This document describes how TrustBridge discovers, loads, and runs third-party
plugins. It is intended for plugin authors and operators who rely on plugin
behavior in CI.

Clarified whether plugins may perform network I/O, which hosts are allowlisted, and how SSRF controls apply. Add a negative test if enforcement exists.

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

## Plugin loading and security

Plugins are loaded by `src/pluginLoader.ts`. The loader enforces several
security checks before a plugin file is imported:

1. **Path must be relative** — absolute paths are rejected with reason
   `path_traversal`.
2. **Lexical path must stay inside the workspace root** — `../` segments that
   escape the workspace root are rejected with reason `path_traversal`.
3. **Realpath must stay inside the workspace root** — after confirming the file
   exists, the loader calls `fs.realpathSync` to resolve any symlinks or
   Windows junctions and checks that the resolved path is still under the
   workspace root. A symlink (or junction) whose target lands outside the
   workspace root is rejected with reason `symlink_escape`. This prevents
   attackers from placing a symlink inside the workspace that points to an
   untrusted file outside it. A symlink whose target is still inside the
   workspace is accepted.
4. **Path must resolve to a regular file** — directories and other special
   files are rejected with reason `not_file`.
5. **Module must export a valid `CheckPlugin` interface** — missing `id`,
   `label`, or `run()` are rejected with reason `invalid_export`.

### `PluginLoadError` reason codes

| Reason | Meaning |
|---|---|
| `path_traversal` | Path is absolute or escapes the workspace root lexically |
| `symlink_escape` | Realpath of the file or a directory component resolves outside the workspace root (symlink/junction escape) |
| `not_found` | File does not exist at the resolved path |
| `not_file` | Path resolves to a directory or non-regular file |
| `load_failed` | Module threw an error during `import()` |
| `invalid_export` | Module export does not match the `CheckPlugin` interface |
| `duplicate_id` | Two allowlisted plugins export the same `id` |

Unit tests under `__tests__/plugin.test.ts` cover the plugin runner's happy
path, the timeout boundary (a slow plugin that returns late fails closed
with a stable error, including the per-plugin `timeoutMs` override — Issue
#797), and the isolation boundary (a failing or timing-out plugin does not
abort or corrupt results for unrelated validation). When changing runner
behavior, keep `src/pluginRunner.ts`, `src/plugin.ts`, and the tests
consistent.

The plugin loader tests under `__tests__/plugin-loader.test.ts` cover:

- Happy path: a valid plugin loads and runs.
- Path traversal via `../` segments.
- Absolute path rejection.
- Symlink escape: a symlink inside the workspace whose target is outside the
  workspace is rejected with reason `symlink_escape`.
- Windows junction escape: a directory junction inside the workspace that
  points to an outside directory causes any file accessed through it to be
  rejected with reason `symlink_escape`.
- Safe intra-workspace symlinks: symlinks whose targets remain inside the
  workspace are accepted.
- Failure isolation: a bad plugin in the allowlist is skipped; remaining
  plugins still load.
- Duplicate id detection.
