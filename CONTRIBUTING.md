# Contributing to TrustBridge Action

Thank you for helping improve **trustbridge-action**! This guide covers local setup, coding standards, and the pull request process.

Related docs: [README](README.md) · [Structure](docs/STRUCTURE.md) · [Architecture](docs/ARCHITECTURE.md) · [Breaking Changes](docs/BREAKING_CHANGES.md) · [Dependabot Policy](docs/DEPENDABOT.md) · [License Report](docs/LICENSE_REPORT.md)

---

## Code of conduct

Be respectful and constructive. We follow standard open-source community norms: welcome newcomers, assume good intent, and focus feedback on the work.

---

## Ways to contribute

- **Bug reports** — Horizon edge cases, comment formatting, GitHub API quirks
- **Features** — multi-asset checks, PR comments, improved address extraction examples
- **Documentation** — clearer remediation text, translations, workflow recipes
- **Tests** — expand coverage for `horizon.ts` with mocked fetch

---

## Local development

### Requirements

- Node.js **20 LTS or 22 LTS** (both are tested in CI — see `.github/workflows/ci.yml`)
- npm **9+**

### Setup

```bash
git clone https://github.com/Stellar-TrustBridge/trustbridge-action.git
cd trustbridge-action
npm ci
```

### Commands

| Command | Purpose |
|---------|---------|
| `npm test` | Run Jest unit tests |
| `npm run test:coverage` | Coverage report in `coverage/` |
| `npm run test:mock` | Smoke tests against local mock Horizon (requires `npm run mock:start` first) |
| `npm run lint` | ESLint on `src/` and `__tests__/` |
| `npm run typecheck` | Type-check `src/` only (matches `tsconfig.json`) |
| `npm run typecheck:tests` | Type-check `src/` + `__tests__/` together (uses `tsconfig.test.json`) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run mock:start` | Start mock Horizon container on `http://localhost:8089` |
| `npm run mock:stop` | Stop and remove mock Horizon container |

All commands except `mock:*` and `test:mock` must pass before opening a PR. CI runs the same pipeline (see `.github/workflows/ci.yml`).

### Typechecking test files

Jest uses `ts-jest` for transpilation, which means test files that import
broken types or call async functions without `await` can silently pass `npm test`.
To catch these issues at the type level, run:

```bash
npm run typecheck:tests
```

This invokes `tsc --project tsconfig.test.json --noEmit`, which type-checks
both `src/**/*` and `__tests__/**/*` together using a relaxed strict configuration
(see `tsconfig.test.json`). CI runs both the source typecheck and the test typecheck
steps on every push and pull request.

**Writing new test files**: New test files must be type-clean. Do not add
`// @ts-nocheck` to new files — use proper `await` on async calls and ensure
imported types match. The `@ts-nocheck` comments in existing test files mark
pre-existing `await`-omission patterns that are tracked for future cleanup.

---

## Mock Horizon for local development

TrustBridge ships a [WireMock](https://wiremock.org)-based mock Horizon server
so contributors can develop and test the action offline without hitting public
Horizon or consuming rate-limit quota.

### Quick start

```bash
# Requires Docker Desktop (or Docker Engine + Compose v2)
npm run mock:start                                # start on http://localhost:8089
HORIZON_MOCK_URL=http://localhost:8089 npm run test:mock   # run smoke tests
npm run mock:stop                                 # stop container
```

### What is mocked

| Scenario | Address | Response |
|----------|---------|----------|
| All checks pass | `GAAA...AWHF` | 200, 10 XLM, USDC trustline |
| Unfunded account | `GBBB...BBBB` | 404 Not Found |
| Low XLM balance | `GCCC...CCCC` | 200, 0.5 XLM, USDC trustline |
| No trustline | `GDDD...DDDD` | 200, 10 XLM, no trustline |
| Rate limited | `GEEE...EEEE` | 429 with `Retry-After: 1` |

Stub definitions live in `mock/horizon/mappings/`. Full documentation:
[mock/horizon/README.md](mock/horizon/README.md).

### Skip behaviour

The smoke test file (`__tests__/horizon-mock-smoke.test.ts`) skips all suites
automatically when `HORIZON_MOCK_URL` is not set — so `npm test` is never
affected by whether Docker is running.

---

## Live testnet integration job (Issue #156)

TrustBridge includes an optional CI job (`testnet-live-integration` in `.github/workflows/ci.yml`)
that runs the action against live **Stellar testnet Horizon** with a real funded test account,
validating end-to-end comment posting without touching mainnet.

### Why

Mocked Horizon tests catch most issues, but integration bugs (GitHub API quirks, Horizon API
changes, etc.) can slip through. A guarded live testnet job increases confidence before
releases while staying opt-in to avoid flaky default CI.

### When the job runs

- ✅ **On maintainer pushes** to `main` / `master` when secrets are set
- ✅ **On explicit `workflow_dispatch` trigger** (manual testing)
- ❌ **Skip on pull requests** (even from maintainers — secrets not available)
- ❌ **Skip on forks** (no access to repository secrets)
- ❌ **Skip on default CI** (opt-in only via secrets)

### Setup (for maintainers)

1. **Create a funded testnet account**
   ```bash
   # Use Stellar Laboratory (testnet mode) to create and fund a new account
   # https://laboratory.stellar.org/#account-creator?network=test
   # Fund with friendbot or request XLM via Stellar community channels
   ```

2. **Add repository secrets** (Settings → Secrets → Actions)
   - **`TEST_STELLAR_ADDRESS`**: The G-address of your funded testnet account
     (if this secret is empty, the job is skipped)
   - **`TEST_ISSUE_NUMBER`** (optional): Issue number for comment posting
     (defaults to using a test issue; comment will be posted there)

3. **Run manually or wait for next maintainer push**
   ```bash
   # Manual run from GitHub Actions UI:
   # 1. Go to Actions → CI workflow
   # 2. "Run workflow" → Branch: main
   # 3. Watch the testnet-live-integration job
   ```

### What the job tests

- ✅ Horizon connection to testnet
- ✅ Account lookup and validation
- ✅ Comment posting via GitHub API
- ✅ Output generation (`account_funded`, `xlm_balance`, etc.)
- ✅ Sticky comment updates (if run multiple times)
- ✅ No accidental mainnet contact

### Failure modes

| Failure | Likely cause | Fix |
|---------|--------------|-----|
| Job skipped entirely | Repository secrets not set | Add `TEST_STELLAR_ADDRESS` to repo secrets |
| "account_funded: false" | Testnet account not funded or wrong account | Use Stellar Lab to fund or verify address |
| "Comment posting failed" | Token or permissions issue | Check `GITHUB_TOKEN` has `issues: write` |
| Rate limit (429) | Testnet Horizon overloaded | Wait a few minutes and retry |
| Timeout | Network connectivity | Check internet and Horizon endpoint availability |

### Security

- **Secrets are not printed** — Job uses `GITHUB_TOKEN` scoped to the repository only
- **Testnet only** — No real XLM or production accounts involved
- **Forks skip gracefully** — Secrets aren't available on forks, so no failures
- **Comments posted to test issues only** — Never production workflows

---

## Project conventions

### TypeScript

- Strict mode enabled (`tsconfig.json`)
- Prefer pure functions in `checks.ts` — no I/O
- HTTP and GitHub API code stay in `horizon.ts` and `comment.ts`
- Use explicit types for Horizon responses

### Module boundaries

```
index.ts     → orchestration only
horizon.ts   → Horizon HTTP + types
checks.ts    → validation (unit tested)
comment.ts   → Markdown + Octokit
```

Do not import `@actions/github` outside `comment.ts` / `index.ts`.

### Testing

- Add tests in `__tests__/` for validation logic changes
- Mock external HTTP; avoid live Horizon calls in CI
- Name tests after behavior: `fails when XLM balance is below minimum reserve`

### Comments and docs

- Update [README.md](README.md) for user-facing input/output changes
- Update [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for design changes
- Update [docs/ERROR_HANDLING.md](docs/ERROR_HANDLING.md) for new failure modes
- Cross-link new docs from README “Documentation index”

---


## Keeping the schema in sync with action.yml

`schemas/action-inputs.schema.json` is the single source of truth for
integrator tooling and editor validation. **Every time you add, rename, or
remove an `action.yml` input you must also update the schema.**

### What is the schema?

A [JSON Schema (draft-07)](http://json-schema.org/draft-07/schema#) document
that mirrors the `inputs:` section of `action.yml`. Each property:

- Has `"type": "string"` (GitHub Actions passes all inputs as strings).
- Carries the same `description` and `default` as the corresponding `action.yml` input.
- May include an `"enum"` constraint for boolean flags (`"true"/"false"`) or named-option fields (`"warn"/"strict"`).
- May include a `"pattern"` constraint for numeric inputs.

`additionalProperties: false` is set so any unknown key is rejected immediately.

### Checklist when adding an input

1. Add the input to `action.yml` with `description`, `required`, and `default`.
2. Add a matching property to `schemas/action-inputs.schema.json` under `"properties"` with at minimum `"type": "string"` and `"description"`.
3. If the new input is `required: true` in `action.yml`, add its name to the `"required"` array in the schema.
4. Run `npm test -- --testPathPattern action-schema-sync` locally � it must pass.
5. Document the new input in `docs/USAGE.md` and `README.md`.
6. Update `docs/BREAKING_CHANGES.md` if the change is breaking.

### Checklist when removing or renaming an input

1. Remove or rename the property in `schemas/action-inputs.schema.json`.
2. Remove or rename the input in `action.yml`.
3. Update `docs/USAGE.md`, `README.md`, and `docs/BREAKING_CHANGES.md`.
4. Run `npm test -- --testPathPattern action-schema-sync` locally.

### How CI enforces the sync

`__tests__/action-schema-sync.test.ts` parses `action.yml` at test time using Node's built-in `fs` module (no extra YAML-parser dependency) and asserts:

| Check | What it catches |
|-------|-----------------|
| Every `action.yml` input in schema | Input added to action but schema not updated |
| Every schema property in `action.yml` | Property added to schema but input removed |
| `required: true` inputs in `required[]` | Required input missing from schema array |
| Schema `required[]` matches action | Schema marks an optional input as required |
| All properties have `type: "string"` | Accidental non-string type in schema |
| Property count parity | Fast sanity check for bulk additions/removals |

CI runs a dedicated step on every push and PR:

```yaml
- name: Verify action.yml ? schema sync
  run: npm test -- --testPathPattern action-schema-sync --no-coverage
```

---
## Pull request process

1. **Fork** the repository and create a feature branch from `main`
2. **Implement** your change with tests where applicable
3. **Run** `npm run lint && npm test && npm run build`
4. **Open a PR** with:
   - Clear title (e.g. `fix: retry Horizon 504 with longer backoff`)
   - Summary of what and why
   - Test plan checklist
   - Links to related issues

### PR checklist

- [ ] Tests pass locally (`npm test`)
- [ ] Lint passes (`npm run lint`)
- [ ] Build succeeds (`npm run build`)
- [ ] `dist/` updated if runtime code changed (commit compiled output for releases)
- [ ] README / docs updated if behavior or inputs changed
- [ ] `docs/BREAKING_CHANGES.md` consulted — change classified as breaking or non-breaking and version bump applied accordingly
- [ ] No secrets or real contributor addresses in commits
- [ ] If a new **runtime** dependency was added to `dependencies` (not `devDependencies`), its SPDX license identifier has been checked against the compatibility table in [docs/LICENSE_REPORT.md](docs/LICENSE_REPORT.md)

---

## Commit messages

Use concise, imperative subjects:

```
feat: add testnet defaults example workflow
fix: honor Retry-After on Horizon 429
docs: clarify fail_on_missing in USAGE guide
test: cover zero-trustline account path
```

---

## Releasing (maintainers)

### Release checklist

Before cutting a release tag, ensure:

1. **All CI checks pass** — Push to a feature branch and verify CI passes completely
2. **Run coverage gates** — `npm run test:coverage` must pass (statement/branch/function/line thresholds)
3. **Build and verify dist/** — Run `npm run build` and commit the rebuilt `dist/`
4. **dist/ matches src/** — After any code change, `dist/` must be up-to-date. CI enforces this via `git diff --exit-code -- dist`
5. **Update action.yml if inputs/outputs changed** — Ensure new or changed inputs have descriptions and defaults
6. **Update JSON Schema** — When adding or modifying inputs in `action.yml`, also update `schemas/action-inputs.schema.json` with the matching property (type, description, default, pattern/format for URLs and addresses). Run `npm test -- --testPathPattern schema` to verify no drift. See [docs/SCHEMA.md](docs/SCHEMA.md) for the full sync process.
7. **Update docs** — If behavior or inputs changed, update [docs/USAGE.md](docs/USAGE.md) and [README.md](README.md)
7. **Smoke test via SHA reference** — Clone a fresh copy of the repository and test the action by SHA to ensure the bundled dist/ works as a GitHub Action
8. **Prepare SBOM** — If releasing with Issue #69 (SBOM attachment), generate the SBOM before tagging
9. **Create GitHub Release** — Once the tag is pushed, create a Release page with a changelog (use `v1.0.0` format for tag names)

### Packaging essentials

**Why packaging matters:**
- Consumers pin the action by SHA (`@<commit>`) or tag (`@v1`). Missing or stale `dist/` silently breaks comment posting.
- GitHub Actions require `dist/index.js` to exist; missing it causes "action not found" errors.
- `ncc` bundles dependencies so Node.js isn't required at runtime; if `dist/` isn't committed, the compiled code won't be available to runners.

**Build process:**
```bash
npm run build
# Outputs: dist/index.js, dist/index.js.map, dist/licenses.txt
```

This step:
1. Runs `tsc --noEmit` to typecheck (fails if there are errors)
2. Runs `@vercel/ncc` to bundle all dependencies into a single `dist/index.js`
3. Generates source maps for debugging
4. Extracts license information

**CI enforcement:**
- `.github/workflows/ci.yml` runs `npm run build` and verifies `dist/index.js` exists
- It also runs `git diff --exit-code -- dist/` to fail if committed `dist/` is stale relative to src/

**Manual smoke test:**
```bash
# In a fresh clone of the release tag:
git checkout v1.0.0
ls -la dist/index.js  # Must exist
node dist/index.js    # Should not throw (though it needs GitHub env to run fully)
```

### Release and SBOM workflow

Once packaging is complete and tagged:

1. **Push tag to repository** — `git push origin v1.0.0`
2. **Wait for release workflow** — `.github/workflows/release.yml` runs `verify-release` job on the tag
3. **Generate SBOM** (if using Issue #69) — The release workflow can generate and attach an SBOM asset
4. **Create GitHub Release** — Link to the tag, add changelog, attach SBOM if generated

---

## Semver guidance

- **MAJOR** (v2.0.0) — Breaking changes to inputs, outputs, or behavior; major feature additions
- **MINOR** (v1.1.0) — New non-breaking features, new locales, new output formats
- **PATCH** (v1.0.1) — Bug fixes, dependency updates, documentation improvements

**`runs.using` note:** `action.yml` currently specifies `runs.using: node20`. Bumping this to `node22` requires waiting for GitHub Actions to ship an official `node22` label — this is deferred to a future major/minor release. Node 22 compatibility is already verified in the CI matrix.

---

## Security

- **Do not** commit API keys, tokens, or `.env` files
- Report security issues privately to repository maintainers before public disclosure

### Validation performance budget

CI includes a deterministic performance budget test (`__tests__/validation.performance.test.ts`) that times a full validation run of the action handler (`run` in `src/index.ts`) with **mocked Horizon** (no live network).

| Setting | Value |
|---------|--------|
| Metric | p95 wall-clock duration over 25 samples (after warmup) |
| Budget | **2000 ms** (`VALIDATION_PERFORMANCE_BUDGET_P95_MS`) |
| Why generous | Standard GitHub-hosted runners vary; headroom avoids flakes |

The test fails when p95 exceeds the budget. Failure messages call out likely causes: **Horizon retries**, **extra fetches**, or **logging/metrics bloat** on the validation path.

#### Updating the baseline intentionally

1. Confirm the slowdown is expected (new required work, not an accidental regression).
2. Change `VALIDATION_PERFORMANCE_BUDGET_P95_MS` in `__tests__/validation.performance.test.ts`.
3. Update the budget value in this section to match.
4. Explain the new baseline in the PR description.

Do not raise the budget to silence an unexplained regression.

---

## License compliance

TrustBridge Action is published under the **MIT License**. All runtime dependencies (packages in `dependencies`, not `devDependencies`) must carry a compatible license.

**Safe to add:** MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, CC0-1.0.

**Requires maintainer review:** LGPL-2.1, LGPL-3.0, MPL-2.0.

**Do not add without explicit approval:** GPL-2.0, GPL-3.0, AGPL-3.0, SSPL-1.0, BUSL-1.1, or any `UNLICENSED`/`UNKNOWN` package.

The full compatibility table, the local generation command (`npm run license:report`), and instructions for finding the report in GitHub Release assets are documented in [docs/LICENSE_REPORT.md](docs/LICENSE_REPORT.md).

A license report (`licenses-report.json` + `licenses-report.md`) is generated automatically by the release workflow and attached to every GitHub Release — no manual step is needed.

---

## Questions

Open a [GitHub Discussion](https://github.com/Stellar-TrustBridge/trustbridge-action/discussions) or issue if setup steps are unclear — improvements to this doc are welcome too.

---

[← Back to README](README.md)

---

## Bundle size budget

The action runs from `dist/index.js` — a single-file bundle compiled by
`@vercel/ncc` that includes all dependencies. Size regressions slow every
assignment job and hint at accidental imports.

### Current budget

| Metric | Value |
|--------|-------|
| **Budget (hard limit)** | 2,097,152 bytes (2 MB) |
| **Baseline (as of 2024-12-29)** | 1,688,671 bytes (~1.6 MB) |
| **Headroom** | 408,481 bytes (~24%) |
| **Warn threshold** | 1,887,436 bytes (90% of budget) |

### How it works

`__tests__/bundle-size.test.ts` measures `dist/index.js` using Node's
`fs.statSync` (deterministic across platforms — no shell `wc -c` variance)
and fails CI when the bundle exceeds the budget.

The test always logs current size, budget usage, and headroom so PR reviewers
see the trend before merge.

### Checking locally

```bash
# Quick check — just the bundle size test
npm run bundle-size

# Full build + check
npm run build && npm run bundle-size
```

### When to increase the budget

**Before** bumping `MAX_BUNDLE_SIZE_BYTES` in `__tests__/bundle-size.test.ts`:

1. ✅ Confirm the size increase is from a **necessary** dependency (e.g., a
   new Stellar SDK function, required polyfill, localization strings).
2. ✅ Verify the increase is **proportional** to the value delivered (not
   just bloat).
3. ✅ Check that no **lighter alternative** exists:
   - Can you import a single function instead of the entire library?
   - Is there a micro-package alternative (e.g., `date-fns` vs `moment`)?
   - Can the logic be implemented directly in ~50 lines instead of adding
     a 200 KB dependency?
4. ✅ Analyze **what's contributing** the bytes:
   ```bash
   npx ncc build src/index.ts -o dist-test --stats
   ```
   This outputs a module-by-module breakdown. Look for surprises (dev
   fixtures, test helpers, entire libraries imported when only one function
   is used).
5. ✅ **Document the reason** in the `MAX_BUNDLE_SIZE_BYTES` comment block:
   ```typescript
   /**
    * CURRENT BASELINE: X bytes (as of YYYY-MM-DD)
    * BUDGET:           Y bytes (Z% headroom)
    *
    * Last increase: [PR #123] Added foo-sdk (150 KB) for feature X.
    */
   ```
6. ✅ Update the budget table in this CONTRIBUTING.md section.

### When CI fails with "Bundle size exceeds budget"

The failure message includes:
- Current size vs budget
- Overage in bytes and percentage
- Actionable next steps

Common causes:
- A new dependency was added without checking size (`npm ls --depth=0` shows
  direct deps; use `npm why <package>` to see why a transitive dep is present).
- A dev-only fixture was accidentally imported into `src/` (check recent
  `git diff` for new imports).
- A heavyweight library was used when a lighter alternative exists.

### Intentional budget increase checklist

When you've verified the increase is justified:

1. Update `MAX_BUNDLE_SIZE_BYTES` in `__tests__/bundle-size.test.ts`.
2. Update the comment block in that file with the new baseline and reason.
3. Update the budget table in this CONTRIBUTING.md section.
4. Run `npm run bundle-size` locally — it must pass.
5. Include the bundle size analysis output (`ncc build --stats`) in the PR
   description so reviewers can see what changed.
