# Third-Party License Report

This document describes how TrustBridge Action generates a third-party license report for every release, where to find it, what licenses are blocked by the automated policy gate, and how to request an exception.

Related docs: [README](../README.md) · [CONTRIBUTING](../CONTRIBUTING.md) · [Release Checklist](RELEASE_CHECKLIST.md) · [Breaking Changes](BREAKING_CHANGES.md)

---

## Why a license report?

Enterprise consumers of GitHub Actions frequently require license compliance evidence before approving a dependency in their CI/CD pipelines. A machine-generated, repeatable report eliminates manual audit work and provides a clear paper trail for every release.

---

## License policy gate (Issue #334)

TrustBridge Action ships an automated license policy gate that runs on every CI push, pull request, and release tag. The gate scans all **runtime** (production) dependencies and hard-fails if any package carries a license that is incompatible with TrustBridge's own MIT license.

### Running the gate locally

```bash
npm run license:check
```

The script exits `0` when all runtime deps pass and exits `1` (with a clear error listing the offending packages) when a violation is found.

### Blocked license categories

The following license identifiers cause an automatic failure:

| License class | Example identifiers | Why blocked |
|--------------|--------------------|----|
| **GPL** | `GPL-2.0-only`, `GPL-2.0-or-later`, `GPL-3.0-only`, `GPL-3.0-or-later` | Strong copyleft; would require the entire action to be GPL-licensed |
| **AGPL** | `AGPL-3.0-only`, `AGPL-3.0-or-later` | Network copyleft; most restrictive form — incompatible with MIT distribution |
| **SSPL** | `SSPL-1.0` | Not OSI-approved source-available license; incompatible |
| **BUSL** | `BUSL-1.1` | Business Source License — not open-source; incompatible |
| **UNLICENSED** | `UNLICENSED` | No license declared; cannot be redistributed |
| **UNKNOWN** | `UNKNOWN` | `license-checker` could not determine the license |

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
|---------|---------|---------|-------------|------------|
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
npm run license:report
```

This creates `licenses-report.json` in the repository root.

**What the command does:**

```
license-checker --production --json --out licenses-report.json --excludePrivatePackages
```

| Flag | Effect |
|------|--------|
| `--production` | Scans only runtime dependencies; excludes all `devDependencies` (Jest, ESLint, `@vercel/ncc`, etc.) |
| `--json` | Writes JSON output — one entry per package |
| `--out licenses-report.json` | Path for the generated file |
| `--excludePrivatePackages` | Omits the root `trustbridge-action` package, which is marked `"private"` in `package.json` |

The report contains only: package name, resolved version, SPDX license identifier, and repository URL. **No secrets, tokens, or private metadata are written.**

---

## Output formats

Two files are generated during the release workflow and attached to every GitHub Release as downloadable assets:

| File | Format | Purpose |
|------|--------|---------|
| `licenses-report.json` | JSON | Machine-readable; suitable for policy engines, SBOM tooling, and automated compliance pipelines |
| `licenses-report.md` | Markdown | Human-readable table; suitable for audit emails and the GitHub Release description |

These files are **not committed to the repository**. They are generated fresh on every tagged release and live exclusively in the GitHub Release Assets section.

---

## Finding the report for a release

1. Go to the [Releases page](https://github.com/Stellar-TrustBridge/trustbridge-action/releases).
2. Open the release you are auditing (e.g., `v1.0.1`).
3. Scroll to the **Assets** section at the bottom of the release.
4. Download `licenses-report.json` (machine-readable) or `licenses-report.md` (human-readable table).

---

## Current production runtime dependencies

The following are the top-level production runtime dependencies declared in `package.json`. Their transitive dependencies also appear in the generated report.

| Package | Known license | Notes |
|---------|--------------|-------|
| `@actions/core` | MIT | GitHub Actions toolkit |
| `@actions/github` | MIT | Octokit-based GitHub API client |
| `node-fetch` | MIT | Lightweight `fetch` for Node.js |

All three top-level production dependencies are MIT-licensed and fully compatible with TrustBridge Action's own MIT license. Verify their transitive deps in the generated report for each release.

---

## Copyleft and license compatibility

TrustBridge Action is published under the **MIT License** ([LICENSE](../LICENSE)). When adding new runtime dependencies (in `dependencies`, not `devDependencies`), contributors must review the license class of the new package:

### Compatible — safe to add

| SPDX identifier | Class | Notes |
|----------------|-------|-------|
| MIT | Permissive | ✅ Compatible |
| ISC | Permissive | ✅ Compatible |
| BSD-2-Clause | Permissive | ✅ Compatible |
| BSD-3-Clause | Permissive | ✅ Compatible |
| Apache-2.0 | Permissive | ✅ Compatible (with patent grant) |
| 0BSD | Permissive | ✅ Compatible |
| CC0-1.0 | Public domain | ✅ Compatible |

### Requires maintainer review before adding

| SPDX identifier | Class | Risk |
|----------------|-------|------|
| LGPL-2.1-only / LGPL-2.1-or-later | Weak copyleft | Permissible with dynamic linking; review carefully |
| MPL-2.0 | Weak copyleft | File-level copyleft; typically permissible in npm packages |
| CC-BY-4.0 | Attribution | Generally fine for data/docs, unusual for code |

### Do not add without explicit maintainer approval

| SPDX identifier | Class | Risk |
|----------------|-------|------|
| GPL-2.0-only / GPL-2.0-or-later | Strong copyleft | Would require the entire action to be GPL |
| GPL-3.0-only / GPL-3.0-or-later | Strong copyleft | Would require the entire action to be GPL |
| AGPL-3.0-only / AGPL-3.0-or-later | Network copyleft | Most restrictive; incompatible with MIT distribution |
| SSPL-1.0 | Source-available | Not OSI-approved; incompatible |
| BUSL-1.1 | Source-available | Not open-source; incompatible |
| UNLICENSED / UNKNOWN | Unknown | Block until clarified |

> **Note:** This table covers the most common cases. It is not legal advice. When in doubt, open an issue and tag a maintainer before merging a dependency with an unfamiliar license.

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

## Future SBOM integration

A full Software Bill of Materials (SBOM) in CycloneDX or SPDX format would complement this license report for consumers with formal SBOM ingestion pipelines. When an SBOM workflow is added to this repository, it will be documented here and in the release workflow. Track progress in the project issue tracker.

Tooling candidates for a future SBOM step:
- [`@cyclonedx/cyclonedx-npm`](https://github.com/CycloneDX/cyclonedx-node-npm) — CycloneDX JSON/XML from `package-lock.json`
- [`spdx-sbom-generator`](https://github.com/opensbom-generator/spdx-sbom-generator) — SPDX tag-value or JSON

---

[← Back to README](../README.md)
