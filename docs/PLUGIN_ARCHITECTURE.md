# Plugin API architecture and versioning

This document defines the compatibility policy for a future TrustBridge
plugin API. The current action has no `plugin.ts`, `pluginLoader.ts`, plugin
manifest, or runtime negotiation path; consumers cannot load plugins yet. When
those modules are introduced, they must implement the contract below before
plugins are advertised as supported.

## Version surfaces

Keep these versions independent:

- **Action version** is the Git tag consumers pin (for example, `v2`). A new
  action major signals a breaking change to action inputs, outputs, defaults,
  or behavior.
- **Plugin API version** is a `major.minor.patch` contract version describing
  the host hooks, context, and result types available to a plugin.
- **Plugin package version** is owned by each plugin author and follows that
  package's own compatibility policy.

An action major is not a plugin API version. An action release may add a
backward-compatible plugin API minor without requiring an action major bump.
Removing or changing a plugin API contract incompatibly requires a plugin API
major and, because it changes a supported action surface, an action major.

## Semver rules for the plugin API

- **Patch:** bug fixes and clarifications that do not change accepted inputs,
  outputs, ordering guarantees, or failure behavior.
- **Minor:** additive optional hooks, optional context fields, new capabilities,
  and new non-fatal result metadata. Existing plugins must continue to work.
- **Major:** removal or rename of hooks/fields, changed types or requiredness,
  changed lifecycle ordering, changed error semantics, or tightened validation
  that rejects previously valid plugins.

Never reuse a removed field or hook name for a different meaning. Deprecate it
for at least one plugin API major cycle where practical, emit an actionable
warning, and document the removal in `docs/BREAKING_CHANGES.md`.

## Negotiation and action majors

When implemented, each plugin should declare a supported plugin API range,
using a standard semver range such as `^1.2.0`. The loader must compare this
range with the API version exposed by the selected action release before
initializing the plugin. It must fail closed with a stable diagnostic when
there is no compatible version; it must never silently load against an
incompatible major.

The action's own major selects the host release line, while negotiation
selects the plugin API within that host. For example, a plugin declaring
`^1.2.0` can run with action `v2` exposing API `1.4.0`. If action `v3` exposes
API `2.0.0`, it cannot load that plugin unless the plugin also declares a
compatible `2.x` range. Supporting multiple API majors would require the host
to explicitly expose and test both; action-major compatibility alone does not
imply plugin compatibility.

## Author examples

An additive optional context capability is a minor API change:

```json
{
  "name": "stellar-audit",
  "version": "1.3.0",
  "trustbridgePluginApi": "^1.2.0"
}
```

If a plugin starts using an optional hook introduced in API `1.3`, make that
minimum explicit instead:

```json
{
  "name": "stellar-audit",
  "version": "2.0.0",
  "trustbridgePluginApi": "^1.3.0"
}
```

An API `2.0.0` release that renames a required hook is a major API change. The
loader should report the plugin's declared range, the host API version, and a
remediation (upgrade the plugin or use a compatible action release), without
printing secrets from plugin configuration.

## Compatibility test requirements

The future loader must have tests for a compatible range, an unsupported API
major, and malformed or missing version declarations. Runtime implementation
and tests belong with the future `src/plugin.ts` and `src/pluginLoader.ts`;
this policy does not imply that plugin execution is currently available.
