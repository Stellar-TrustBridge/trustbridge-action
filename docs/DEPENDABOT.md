# Dependabot & Release/CI Compatibility Policy

This document describes how Dependabot (and similar automated dependency update PRs) interact with **trustbridge-action** versioning, committed `dist/` bundles, and CI workflows.

---

## Overview & Why This Matters

As a GitHub JavaScript Action, `trustbridge-action` commits its compiled distribution bundle (`dist/index.js`) to the repository so consumers can reference the action without needing to run `npm build` at execution time.

When Dependabot opens a pull request to update dependencies (e.g. bumping `@actions/core` or `node-fetch` in `package.json` and `package-lock.json`), it only updates the lockfile — **it does not rebuild `dist/`**. Merging a Dependabot PR without rebuilding `dist/` results in a stale bundle that does not contain the updated dependencies or security fixes.

---

## File Maintenance Boundaries

Dependabot is configured to update NPM dependencies. Maintainers should enforce the following boundaries:

| File / Path | Dependabot Permitted | Maintainer Action Required |
|---|---|---|
| `package.json` | ✅ Yes | Review changes |
| `package-lock.json` | ✅ Yes | Review lockfile changes |
| `dist/index.js` | ❌ No (Dependabot will not modify `dist/`) | **Rebuild required** via `npm run build` |
| `action.yml` | ❌ No | Update manually if action specs change |

---

## Maintainer Checklist for Dependabot PRs

When reviewing and merging Dependabot PRs affecting runtime dependencies, maintainers must follow this checklist:

1. **Verify lockfile changes**: Ensure `package-lock.json` changes match `package.json`.
2. **Rebuild `dist/`**: Checkout the Dependabot branch locally, run `npm run build`, commit `dist/index.js`, and push.
3. **Verify CI**: Ensure the `CI` workflow (`.github/workflows/ci.yml`) passes.
4. **Merge PR**: Once `dist/` matches the updated dependencies and CI passes, merge the PR.

---

## Recommended Workflow Patterns

- Rebuild locally with `npm run build` and commit `dist/` on Dependabot branches before merge.
- Optional auto-build pattern: Maintainers may add a branch-protection trigger or GitHub Action that runs `npm run build` on `dependabot/*` branches and pushes the updated `dist/` back to the pull request before merging.
