# Dependabot Maintenance & Auto-Merge Policy

This document details the automated dependency maintenance and auto-merge policy for `Stellar-TrustBridge/trustbridge-action`.

---

## 1. Overview & Auto-Merge Boundary

To balance supply-chain hygiene with security and stability, automated PR merging is strictly confined to **low-risk patch updates of GitHub Actions toolkits (`@actions/*`)**.

### Allowed for Auto-Merge
| Scope | Condition | Rationale |
|---|---|---|
| `@actions/*` packages | **Patch updates only** (`~1.x.y` → `~1.x.z`) | Official GitHub Action runner toolkits (e.g. `@actions/core`, `@actions/github`, `@actions/http-client`) with minor bug/security fixes that do not change runtime interfaces. |

### Never Auto-Merged (Manual Review Required)
| Dependency Scope | Reason |
|---|---|
| `stellar-sdk` / `@stellar/stellar-sdk` | Core Stellar blockchain protocol interface. Any update must be manually reviewed for cryptographic correctness, Soroban XDR changes, and Horizon protocol breaking changes. |
| Any Minor (`semver-minor`) or Major (`semver-major`) update | Minor and major updates can introduce behavioral or API breaking changes that require explicit test verification and documentation updates. |
| Any non-`@actions/*` npm dependency | Tooling, build plugins, linters, and external utilities must be reviewed by maintainers before landing. |
| GitHub Actions workflow dependencies (`github-actions`) | Changes to actions used in CI workflows require maintainer review to prevent pipeline tampering. |

---

## 2. Automation Architecture

### Dependabot Configuration (`.github/dependabot.yml`)
- Schedules weekly dependency updates every Monday at 06:00 UTC.
- Groups `@actions/*` patch updates under `actions-patches`.
- Applies the `dependencies` and `javascript` labels.

### Auto-Merge Workflow (`.github/workflows/dependabot-auto-merge.yml`)
1. **Actor Verification**: Only runs when triggered by `dependabot[bot]`.
2. **Metadata Inspection**: Uses `@dependabot/fetch-metadata` to query update severity and target dependencies.
3. **Strict Policy Evaluation**:
   - `update-type == 'version-update:semver-patch'`
   - `package-ecosystem == 'npm'`
   - Every updated package name matches `@actions/*`.
4. **CI Status & Merge Queue**:
   - Executes `gh pr review --approve` with an audit note.
   - Executes `gh pr merge --auto --squash` so GitHub will merge the pull request **only after all required branch protection status checks pass**.

---

## 3. Security & Safety Guarantees

- **Branch Protection & Green CI**: GitHub auto-merge will **never** merge a pull request if required CI checks fail or are pending.
- **Least Privilege**: The auto-merge workflow requests only `contents: write` and `pull-requests: write`.
- **Auditability**: Every auto-merged PR contains an explicit automated review approval comment linking back to this policy.

---

## 4. Maintainer Setup Checklist

For repositories deploying this workflow:
1. Ensure **Allow auto-merge** is enabled in Repository Settings > General > Pull Requests.
2. In Repository Settings > Branches, ensure the default branch (`main`) has **Require status checks to pass before merging** enabled.
