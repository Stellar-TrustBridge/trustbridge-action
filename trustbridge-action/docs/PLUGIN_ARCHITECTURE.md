# Plugin Architecture

This document describes how the TrustBridge action discovers, loads, and
resolves plugins at runtime.

## Overview

Plugins are small modules that extend the action with additional checks or
reporting. The plugin loader is responsible for:

1. Discovering plugin entry points.
2. Resolving plugin paths relative to the action root.
3. Loading and validating each plugin module.

## Path Resolution

Plugin paths must resolve correctly on every supported platform, including
Windows runners. Follow these cross-platform rules:

- **Never hardcode path separators.** Do not build paths with `'/'` or `'\\'`
  string concatenation. Use `path.join` / `path.resolve` (or the equivalent
  platform-aware helper) so the correct separator is chosen per platform.
- **Do not assume the current working directory.** Resolve plugin paths against
  an explicit base directory (for example the action root) rather than relying
  on `process.cwd()`. The working directory differs between local runs and CI
  runners.
- **Normalize incoming separators.** Plugin paths supplied by configuration may
  use either `/` or `\`. Normalize them before joining so Windows-style
  separators resolve correctly in tests and at runtime.
- **Keep Unix behavior unchanged.** On POSIX systems the resolved paths must
  remain identical to the previous behavior so existing Unix path tests keep
  passing.

## Loading

After a plugin path is resolved, the loader verifies that the entry point
exists and imports it. Resolution failures should surface a clear error that
includes the attempted path.

## Testing

Path resolution is covered by `__tests__/plugin-loader.test.ts`. Tests exercise
both Unix-style and Windows-style separators to guard against regressions on
Windows runners.
