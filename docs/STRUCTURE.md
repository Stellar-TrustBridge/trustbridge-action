# Project Structure

This page is a quick map of the repository. Design decisions and runtime data
flow live in [ARCHITECTURE.md](ARCHITECTURE.md); extension points live in
[PLUGIN_ARCHITECTURE.md](PLUGIN_ARCHITECTURE.md).

## Repository tree

```text
trustbridge-action/
├── .github/
│   ├── actions/                 # Composite actions
│   ├── dependabot.yml           # npm and GitHub Actions update policy
│   └── workflows/               # CI, release, security, and reusable workflows
├── __tests__/                   # Jest tests, fixtures, snapshots, and benchmarks
├── docs/                        # Consumer, contributor, design, and operations docs
│   └── examples/                # Workflow and plugin examples
├── fixtures/                    # Shared offline fixture data
├── mock/horizon/                # WireMock Horizon server and mappings
├── schemas/                     # Action input and output schemas
├── scripts/                     # Build, bundle, license, and maintenance tools
├── src/                         # TypeScript implementation
├── action.yml                   # GitHub Action metadata and inputs/outputs
├── package.json                 # Scripts and dependency declarations
├── package-lock.json            # Reproducible npm dependency lockfile
└── README.md / CONTRIBUTING.md  # User and contributor entry points
```

Generated locally and intentionally ignored: `node_modules/`, `coverage/`, and
the compiled `dist/` bundle (when not preparing a release artifact).

## Source modules

| Area | Modules | Responsibility |
| --- | --- | --- |
| Entry point | `index.ts`, `inputs.ts`, `outputs.ts` | Read action inputs, orchestrate validation, and publish outputs |
| Horizon | `horizon.ts`, `resilience.ts`, `freshness.ts`, `proxy.ts`, `toml.ts` | Fetch account and issuer data, retry/fail over, enforce budgets, and protect transport |
| Validation | `checks.ts`, `validation.ts`, `assets.ts`, `ssrf.ts` | Validate Stellar data, assets, URLs, and security-sensitive inputs |
| GitHub UX | `comment.ts`, `markdown.ts`, `links.ts`, `summary.ts`, `badge.ts`, `snooze.ts` | Build comments, remediation links, summaries, and badges |
| Integrations | `roster.ts`, `codeowners.ts`, `soroban.ts`, `webhook.ts`, `federation.ts`, `projects.ts` | Resolve identities and connect optional GitHub, Stellar, and dashboard services |
| Extensibility | `plugin.ts`, `pluginLoader.ts`, `pluginRunner.ts`, `corePlugins.ts`, `template.ts` | Load plugins and safe comment partials; see [plugin docs](PLUGIN_ARCHITECTURE.md) |
| Observability | `logger.ts`, `metrics.ts`, `diagnostics.ts`, `tracing.ts`, `checks-run.ts` | Redacted logs, metrics, diagnostics, traces, and check-run annotations |
| Supporting logic | `batch.ts`, `cache.ts`, `configReader.ts`, `delta.ts`, `preflight.ts`, `sarif.ts` | Shared caching, configuration, batch, artifact, and reporting behavior |

## Tests and fixtures

Tests are grouped by behavior in `__tests__/`: core checks and parsers,
Horizon and resilience, comments and i18n, workflows and schemas, plugins,
security guards, and integration-style harnesses. `fixtures/` and
`__tests__/fixtures/` hold deterministic inputs; `__tests__/__snapshots__/`
holds approved comment and workflow output.

The optional `horizon-mock-smoke.test.ts` suite uses `mock/horizon/` and is run
with `HORIZON_MOCK_URL` set. Its scenarios and addresses are documented in
[mock/horizon/README.md](../mock/horizon/README.md).

## Documentation map

Start with [docs/README.md](README.md) for the complete index. The most useful
paths are:

- [ARCHITECTURE.md](ARCHITECTURE.md) for control flow and module boundaries.
- [PLUGIN_ARCHITECTURE.md](PLUGIN_ARCHITECTURE.md) for plugin contracts.
- [USAGE.md](USAGE.md) for action inputs and workflow configuration.
- [FAQ.md](FAQ.md) and [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for operator-facing failures.
- [DEPENDABOT.md](DEPENDABOT.md) for dependency, bundle, and SHA-pinning maintenance.

## Common commands

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the locked dependency tree |
| `npm test` | Run the Jest suite |
| `npm run lint` | Lint source and tests |
| `npm run typecheck` | Check production TypeScript |
| `npm run build` | Build the committed GitHub Action bundle |
| `npm run mock:start` / `npm run test:mock` | Run the optional WireMock Horizon smoke suite |

[← Back to README](../README.md)
