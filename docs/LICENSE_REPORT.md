# Third-Party License Report

This document describes how TrustBridge Action generates a third-party license report for every release, where to find it, what licenses are blocked by the automated policy gate, and how to request an exception.

Related docs: [README](https://github.com/Stellar-TrustBridge/trustbridge-action/blob/main/README.md) · [CONTRIBUTING](https://github.com/Stellar-TrustBridge/trustbridge-action/blob/main/CONTRIBUTING.md) · [Release Checklist](https://github.com/Stellar-TrustBridge/trustbridge-action/blob/main/docs/RELEASE_CHECKLIST.md) · [Breaking Changes](https://github.com/Stellar-TrustBridge/trustbridge-action/blob/main/docs/BREAKING_CHANGES.md)

---

## Why a license report?

Enterprise consumers of GitHub Actions frequently require license compliance evidence before approving a dependency in their CI/CD pipelines. A machine-generated, repeatable report eliminates manual audit work and provides a clear paper trail for every release.

---

## License policy gate (Issue #334)

TrustBridge Action ships an automated license policy gate that runs on every CI push, pull request, and release tag. The gate scans all **runtime** (production) dependencies and hard-fails if any package carries a license that is incompatible with TrustBridge's own MIT license.

### Running the gate locally

```bash
license-checker --production
```

The script exits `0` when all runtime deps pass and exits `1` (with a clear error listing the offending packages) when a violation is found.

### Blocked license categories

The following license identifiers cause an automatic failure:

| License class | Example identifiers | Why blocked |
|--------------|--------------------|------------|
| **GPL|** | `GPL-2.0-only`, `GPL-2.0-or-later`, `GPL-3.0-only`, `GPL-3.0-or-later` | Strong copyleft; would require the entire action to be GPL-licensed |
| **AGPL|** | `AGPL-3.0-only`, `AGPL-3.0-or-later` | Network copyleft; most restrictive form — incompatible with MIT distribution |
| **SSPL|** | `SSPL-1.0` | Not OSI-approved source-available license; incompatible |
| **BUSL|** | `BUSL-1.1` | Business Source License — not open-source; incompatible |
| **UNLICENSED|** | `UNLICENSED` | No license declared; cannot be redistributed |
| **UNKNOWN|** | `UNKNOWN` | `license-checker` could not determine the license |

Pattern matching is case-insensitive and uses substring matching (e.g. `gpl` matches `GPL-2.0-or-later`).

### How the gate works

The script (`scripts/check-licenses.js`) uses `license-checker --production` to enumerate all production dependencies and their resolved license strings. For each package it:

1. Checks the license against the blocked-pattern list.
2. Skips packages in the `EXCEPTIONS` array (see below).
3. Separates top-level `dependencies` violations (hard-fail) from transitive violations (warning only).
4. Exits `1` with a detailed error if any top-level runtime dep has a blocked license.

### CI integration

The gate runs as the `license-policy` job in `.github/workflows/ci.yml` on every push and pull request:

```
Checkout → Install deps (npm ci) → npm run license:check
```

The job is independent of the `build-and-test` matrix so a license violation surfaces immediately without waiting for compilation.

### Release integration

The gate also runs in `.github/workflows/release.yml` as a dedicated step _before_ the build, immediately after `npm test`:

```
Lint → Test → Check runtime dependency licenses → Build → Generate SBOM → Upload to Release
```

A release tag push (`v*`) that introduces a blocked runtime dep will fail before a bundle is built or published, preventing a non-compliant release from reaching consumers.

---

## Exception registry

Some packages may be technically GPL-licensed but safe to use under a dual-license arrangement, a contributor licence agreement (CLA), or a specific contractual carve-out. These must be explicitly allowed in `scripts/check-licenses.js` and documented here.

**Current exceptions: none.**

### How to add an exception

1. **Verify** the legal basis: confirm the package is dual-licensed under a permissive license, that a CLA grants sufficient rights, or that explicit written permission has been obtained from the copyright holder.
2. **Add the entry** to the `EXCEPTIONS` array in `scripts/check-licenses.js`. Use the exact key produced by `license-checker` (package name + `@` + version, e.g. `some-package@1.2.3`).
3. **Document the rationale** in the table below, including: package name, version range, blocked license, legal basis, and a link to the issue or PR where the exception was approved.
4. **Get maintainer approval** — a PR adding an exception must be reviewed and approved by a project maintainer before merge.

| Package | Version | License | Legal basis | Approved in |
|---------|---------|---------|------------|------------|
| _(none)_ | — | — | — | — |

### Template for new exception entries

```js
// scripts/check-licenses.js — EXCEPTIONS array
'package-name@1.2.3',  // dual-licensed MIT/GPL: MIT available via upstream CLA (PR #NNN)
```

---

## Generating the report locally

After cloning the repository and running `npm ci`, produce the report with:

```bash
license-checker --production --json --out licenses-report.json --excludePrivatePackages
```

This creates `licenses-report.json` in the repository root.

**What the command does:**

```
license-checker --production --json --out licenses-report.json --excludePrivatePackages
```

| Flag | Effect |
|------|--------|
| `--production` | Scans only runtime dependencies; excludes all `devDependencies` (Jest, ENSLint, `@vercel/ncc`, etc.) |
| `--json` | Writes JSON output — one entry per package |
| `--out licenses-report.json` | Path for the generated file |
| `--excludePrivatePackages` | Omits the root `trustbridge-action` package, which is marked `"private"` in `package.json` |

The report contains only: package name, resolved version, SPDX license identifier, and repository URL. **No secrets, tokens, or private metadata are written.**

---

## Output formats

Three files are generated during the release workflow and attached to every GitHub Release as downloadable assets:

| File | Format | Purpose |
|------|--------|---------|
| `licenses-report.json` | JSON | Machine-readable; suitable for policy engines, SBOM tooling, and automated compliance pipelines |
| `licenses-report.md` | Markdown | Human-readable table; suitable for audit emails and the GitHub Release description |
| `sbom.cyclonedx.json` | CycloneDV JSON | Machine-readable SBOM for dependency trackability (SBOM generation is separate from the license report) |

These files are **not committed to the repository**. They are generated fresh on every tagged release and live exclusively in the GitHub Release Assets section.

---

## Finding the report for a release

1. Go to the [Releases page](https://github.com/Stellar-TrustBridge/trustbridge-action/releases).
2. Open the release you are auditing (e.g., `v1.0.1`).
3. Scroll to the **Assets** section at the bottom of the release.
4. Download `licenses-report.json` (machine-readable) or `licenses-report.md` (human-readable table).

---

## Current production runtime dependencies

The table below lists every production package (direct and transitive) resolved in `package-lock.json`. It is **generated** — do not edit it by hand.

### Regenerating the table (Issue #791)

```bash
npm run license:report         # rewrite the generated block from package-lock.json
npm run license:report:check   # exit 1 if the committed block is stale
```

`scripts/generate-license-report.js` reads only `package-lock.json` (no `node_modules`, no network), skips `dev`/`devOptional` entries, and rewrites only the text between the `license-report:begin` / `license-report:end` markers. Packages without license metadata are listed as `UNKNOWN`.

The **License policy check** CI job runs `npm run license:report:check`, so any change to `package-lock.json` without a regenerated report fails CI before release. Fix it by running `npm run license:report` and committing the result.

| Exit code | Meaning |
|-----------|---------|
| `0` | Report written / already up to date |
| `1` | `--check`: report is out of date with the lockfile |
| `2` | Usage or input error (malformed lockfile, missing markers, missing file) |

<!-- license-report:begin (generated by scripts/generate-license-report.js — do not edit by hand) -->

102 production package(s) resolved from `package-lock.json`. Licenses: `MIT` × 87, `ISC` × 6, `Apache-2.0` × 4, `0BSD` × 2, `(Apache-2.0 AND BSD-3-Clause)` × 1, `BlueOak-1.0.0` × 1, `BSD-2-Clause` × 1.

| Package | Version | License |
|---------|---------|---------|
| `@actions/cache` | 4.1.0 | MIT |
| `@actions/core` | 1.11.1 | MIT |
| `@actions/exec` | 1.1.1 | MIT |
| `@actions/github` | 6.0.1 | MIT |
| `@actions/glob` | 0.1.2 | MIT |
| `@actions/http-client` | 2.2.3 | MIT |
| `@actions/io` | 1.1.3 | MIT |
| `@azure/abort-controller` | 1.1.0 | MIT |
| `@azure/abort-controller` | 2.2.0 | MIT |
| `@azure/core-auth` | 1.11.0 | MIT |
| `@azure/core-client` | 1.11.1 | MIT |
| `@azure/core-http-compat` | 2.5.0 | MIT |
| `@azure/core-lro` | 2.7.2 | MIT |
| `@azure/core-paging` | 1.7.0 | MIT |
| `@azure/core-rest-pipeline` | 1.25.0 | MIT |
| `@azure/core-tracing` | 1.4.0 | MIT |
| `@azure/core-util` | 1.14.0 | MIT |
| `@azure/core-xml` | 1.6.0 | MIT |
| `@azure/logger` | 1.4.0 | MIT |
| `@azure/ms-rest-js` | 2.7.0 | MIT |
| `@azure/storage-blob` | 12.34.0 | MIT |
| `@azure/storage-common` | 12.5.0 | MIT |
| `@fastify/busboy` | 2.1.1 | MIT |
| `@nodable/entities` | 3.1.0 | MIT |
| `@octokit/auth-token` | 4.0.0 | MIT |
| `@octokit/core` | 5.2.2 | MIT |
| `@octokit/endpoint` | 9.0.6 | MIT |
| `@octokit/graphql` | 7.1.1 | MIT |
| `@octokit/openapi-types` | 20.0.0 | MIT |
| `@octokit/openapi-types` | 24.2.0 | MIT |
| `@octokit/plugin-paginate-rest` | 9.2.2 | MIT |
| `@octokit/plugin-rest-endpoint-methods` | 10.4.1 | MIT |
| `@octokit/request` | 8.4.1 | MIT |
| `@octokit/request-error` | 5.1.1 | MIT |
| `@octokit/types` | 12.6.0 | MIT |
| `@octokit/types` | 13.10.0 | MIT |
| `@protobuf-ts/runtime` | 2.11.1 | (Apache-2.0 AND BSD-3-Clause) |
| `@protobuf-ts/runtime-rpc` | 2.11.1 | Apache-2.0 |
| `@types/node` | 25.9.9 | MIT |
| `@typespec/ts-http-runtime` | 0.3.9 | MIT |
| `abort-controller` | 3.0.0 | MIT |
| `agent-base` | 7.1.4 | MIT |
| `anynum` | 1.0.1 | MIT |
| `apache-arrow` | 21.2.0 | Apache-2.0 |
| `asynckit` | 0.4.0 | MIT |
| `balanced-match` | 1.0.2 | MIT |
| `before-after-hook` | 2.2.3 | Apache-2.0 |
| `brace-expansion` | 1.1.21 | MIT |
| `call-bind-apply-helpers` | 1.0.2 | MIT |
| `combined-stream` | 1.0.8 | MIT |
| `concat-map` | 0.0.1 | MIT |
| `debug` | 4.4.3 | MIT |
| `delayed-stream` | 1.0.0 | MIT |
| `deprecation` | 2.3.1 | ISC |
| `dunder-proto` | 1.0.1 | MIT |
| `es-define-property` | 1.0.1 | MIT |
| `es-errors` | 1.3.0 | MIT |
| `es-object-atoms` | 1.1.2 | MIT |
| `es-set-tostringtag` | 2.1.0 | MIT |
| `event-target-shim` | 5.0.1 | MIT |
| `events` | 3.3.0 | MIT |
| `fast-xml-builder` | 1.3.1 | MIT |
| `fast-xml-parser` | 5.11.2 | MIT |
| `flatbuffers` | 25.9.23 | Apache-2.0 |
| `form-data` | 2.5.6 | MIT |
| `function-bind` | 1.1.2 | MIT |
| `get-intrinsic` | 1.3.0 | MIT |
| `get-proto` | 1.0.1 | MIT |
| `gopd` | 1.2.0 | MIT |
| `has-symbols` | 1.1.0 | MIT |
| `has-tostringtag` | 1.0.2 | MIT |
| `hasown` | 2.0.4 | MIT |
| `http-proxy-agent` | 7.0.2 | MIT |
| `https-proxy-agent` | 7.0.6 | MIT |
| `is-unsafe` | 2.0.2 | MIT |
| `json-with-bigint` | 3.5.12 | MIT |
| `math-intrinsics` | 1.1.0 | MIT |
| `mime-db` | 1.52.0 | MIT |
| `mime-types` | 2.1.35 | MIT |
| `minimatch` | 3.1.5 | ISC |
| `ms` | 2.1.3 | MIT |
| `node-fetch` | 2.7.0 | MIT |
| `once` | 1.4.0 | ISC |
| `path-expression-matcher` | 1.6.2 | MIT |
| `safe-buffer` | 5.2.1 | MIT |
| `sax` | 1.6.1 | BlueOak-1.0.0 |
| `semver` | 6.3.1 | ISC |
| `strnum` | 2.5.1 | MIT |
| `tr46` | 0.0.3 | MIT |
| `tslib` | 1.14.1 | 0BSD |
| `tslib` | 2.8.1 | 0BSD |
| `tunnel` | 0.0.6 | MIT |
| `undici` | 5.29.0 | MIT |
| `undici-types` | 7.24.6 | MIT |
| `universal-user-agent` | 6.0.1 | ISC |
| `uuid` | 8.3.2 | MIT |
| `webidl-conversions` | 3.0.1 | BSD-2-Clause |
| `whatwg-url` | 5.0.0 | MIT |
| `wrappy` | 1.0.2 | ISC |
| `xml-naming` | 0.3.0 | MIT |
| `xml2js` | 0.5.0 | MIT |
| `xmlbuilder` | 11.0.1 | MIT |

<!-- license-report:end -->

---

## Copyleft and license compatibility

TrustBridge Action is published under the **MIT License** ([LICENSE](https://github.com/Stellar-TrustBridge/trustbridge-action/blob/main/LICENSE)). When adding new runtime dependencies (in `dependencies`, not `devDependencies`), contributors must review the license class of the new package:

### Compatible — safe to add

| SPDX identifier | Class | Notes |
|-----------------|-------|-------|
| MIT | Permissive | ✅ Compatible |
| ISC | Permissive | ✅ Compatible |
| JSD-2-Clause | Permissive | ✅ Compatible |
| BSD-3-Clause | Permissive | ✅ Compatible |
| Apache-2.0 | Permissive | ✅ Compatible (with patent grant) |
| 0BSD | Permissive | ✅ Compatible |
| CC0-1.0 | Public domain | ✅ Compatible |

### Requires maintainer review before adding

| SPDX identifier | Class | Risk |
|-----------------|-------|------|
| LGPL-2.1-only / LGPL-2.1-or-later | Weak copyleft | Permissible with dynamic linking; review carefully |
| MPL-2.0 | Weak copyleft | File-level copyleft; typically permissible in npm packages |
| CC-BY-4.0 | Attribution | Generally fine for data/docs, unusual for code |

### Do not add without explicit maintainer approval

| SPDX identifier | Class | Risk |
|-----------------|-------|------|
| GPL-2.0-only / GPL-2.0-or-later | Strong copyleft | Would require the entire action to be GPL |
| GPL-3.0-only / GPL-3.0-or-later | Strong copyleft | Would require the entire action to be GPL |
| AGPL-3.0-only / AGPL-3.0-or-later | Network copyleft | Most restrictive; incompatible with MIT distribution |
| SSPL-1.0 | Source-available | Not OSI-approved; incompatible |
| BUSL-1.1 | Source-available | Not open-source; incompatible |
| UNLICENSED / UNKNOWN | Unknown | Block until clarified |

> **Note:** This table covers the most common cases. It is not legal advice. When in doubt, open an issue and tag a maintainer before merging a dependency with an unfamiliar tlicense.

---

## Release workflow integration

The license report is generated automatically in `.github/workflows/release.yml` on every `v*` tag push:

```
Install deps (npm ci)
  └─ Check runtime dep licenses (npm run license:check)      ← GPL policy gate (Issue #334)
       └─ Generate JSON report (npm run license:report)
            └─ Convert to Markdown (inline Node.js script)
                 └─ Upload both files to GitHub Release assets
```

`workflow_dispatch` (manual dry-run triggers) skip the upload step so that draft or exploratory runs do not publish incomplete reports.

---

## SLSA Provenance and SBOM integration

The release workflow produces SLSA Provenance attestations and a CycloneDX SBOM alongside the license report. Together these artifacts satisfy the SLSA v1.0 Build Level 3 requirements for provenance and dependency trackability.

### Release assets

Every tagged release attaches the following auditable assets:

| Asset | Format | Purpose |
|-------|--------|---------|
| `licenses-report.json` | JSON | Machine-readable license inventory |
| `licenses-report.md` | Markdown | Human-readable license table |
| `sbom.cyclonedx.json` | CycloneDV JSON | Machine-readable SBOM for dependency trackability |
| `attestations.json` | SLSA Provenance | SLSA v1.0 Build Level 3 provenance attestation |
