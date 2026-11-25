# Breaking changes policy

TrustBridge action releases use semantic versioning. Action major versions
cover breaking changes to the public GitHub Action contract: inputs, outputs,
defaults, supported events, permissions, and documented runtime behavior.

The plugin API has an independent semantic version. See
[PLUGIN_ARCHITECTURE.md](PLUGIN_ARCHITECTURE.md) for compatibility ranges,
negotiation rules, and examples. An incompatible plugin API change must also
ship in an action major because it changes an action-supported integration
surface. Do not infer plugin API compatibility from the action major number.

For a breaking release, record the change here with the affected versions,
behavior, and migration steps. For a compatible additive release, document the
new behavior in its feature guide without implying that consumers must upgrade
their action major.

## Recorded changes

No breaking changes are recorded yet.
