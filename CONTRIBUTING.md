# Contributing

Thanks for your interest in contributing to TrustBridge! This document explains how to get involved.

## Getting Started

1. Fork the repository and clone your fork.
2. Install dependencies for the action package:

   ```bash
   cd trustbridge-action
   npm install
   ```
3. Create a branch for your change.

## Development Workflow

- Make focused changes that address a single issue.
- Keep existing code style, naming, and structure.
- Run the relevant checks before opening a pull request.

## Running the action locally with `act`

`trustbridge-action` is a GitHub Action that executes the compiled bundle in `dist/index.js` (see `action.yml`). If you are testing the workflow locally with [`act`](https://github.com/nektos/act), remember that the action does not run directly from `src/index.ts` unless you explicitly build it first.

### 1. Pick the job to run

Use `act -j <job-name>` to run a specific workflow job instead of trying to execute the whole workflow graph. For example:

```bash
act pull_request -W .github/workflows/ci.yml -j check --container-architecture linux/amd64
```

If you are simulating a reusable workflow or a local issue-triggered run, the job name is the safest selector. `act` will still need a GitHub event payload, so the simplest path is usually to trigger the same event type the workflow expects (`pull_request`, `issue`, or `workflow_dispatch`).

### 2. Use a `.secrets` file for tokens and private values

Create a local `.secrets` file in the repo root (do not commit it):

```bash
GITHUB_TOKEN=ghp_your_test_token
STELLAR_SECRET_KEY=S...your_private_key_if_needed
```

Then pass it to `act`:

```bash
act pull_request -W .github/workflows/ci.yml -j check --secret-file .secrets
```

Useful tips:

- Put only the values you need for the job. TrustBridge logs redacted values, but local runs still should avoid leaking real tokens into stdout.
- If the workflow expects a fine-grained PAT or app token, provide it via the exact input name the workflow reads (`github_token`, `github_app_token`, etc.).
- For issue-comment flows, the event payload must include the right issue or pull request context; otherwise the action may fail before it reaches the Horizon checks.

### 3. Rebuild the bundle when you change `src/`

Because `action.yml` resolves to the shipped bundle, local runs can behave differently if you changed TypeScript sources but did not rebuild the action bundle. After editing `src/**/*.ts`, run:

```bash
npm run build
```

Then rerun `act` with the same workflow/job. This avoids the common case where the action appears to ignore local source changes because `dist/index.js` is still stale.

### 4. Use the offline mock Horizon during local runs

For comment- or validation-driven debugging, prefer the repo's mock Horizon service instead of the public network. Start it first:

```bash
npm run mock:start
```

Then point the action to the mock in your workflow inputs or environment:

```yaml
with:
  horizon_url: http://host.docker.internal:8089
  stellar_address_input: GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF
```

Use `host.docker.internal` inside `act` containers rather than `localhost`; `localhost` inside the container refers to the container itself, not your host machine. On Linux, this can also be sensitive to Docker Desktop vs. native Docker networking differences, so if `host.docker.internal` is unavailable in your environment, use the Docker host bridge address or run the workload on a Docker host that exposes it explicitly.

A good local debug pattern is:

```bash
npm run mock:start
act pull_request -W .github/workflows/ci.yml -j check --secret-file .secrets
```

The mock is intentionally deterministic and helps reproduce offline / Horizon 404 / retry cases without consuming network quota.

### 5. Docker socket and container pitfalls

`act` runs job steps in containers. Common setup failures include:

- Docker Engine or Docker Desktop not running.
- No access to the Docker socket (`/var/run/docker.sock`).
- `act` trying to mount the repository without the right permissions.
- The workflow expecting a `docker`-hosted service that is not reachable from the job container.

Typical fixes:

```bash
docker ps
act --list
```

If container networking is failing, check whether your Docker setup exposes the host on `host.docker.internal` and whether the service you are targeting is listening on the expected port before blaming the action logic. `localhost` is almost never the right target inside a containerized act job.

### 6. Event payloads and workflow inputs matter

For debugging comment-posting bugs, a minimal issue or pull request payload is often required. If `act` is missing the event payload or the repository context, the action can fail before it reaches the validation logic. Keep a small sample payload under the workspace and pass it with `act` when needed:

```bash
act issue_comment -e .github/test-events/issue_comment.json -W .github/workflows/ci.yml -j check --secret-file .secrets
```

If you do not have the event JSON file locally, start with the exact event type your workflow expects and fill in only the fields the action actually uses (`issue`, `pull_request`, `repository`, and any assignee or label metadata relevant to the job).

## CI Checks

The `.github/workflows/ci.yml` workflow runs on pushes and pull requests targeting `main`, and can also be started manually. Jobs that set up Node use Node.js 20; the workflow grants read-only repository contents permissions. Before opening a pull request, run the relevant checks from the repository root:

```bash
npm run typecheck
npm run typecheck:tests
npm test
npm run lint --if-present
```

`npm run typecheck` uses the root `tsconfig.json`, which covers `src/` only and loads the `node` types. `npm run typecheck:tests` uses `tsconfig.test.json`, which covers `src/` **and** `__tests__/` with the `jest` types added. Run both: the root project cannot see a type error in a test file, mock, or fixture, so a green `npm run typecheck` does not imply the test suite typechecks.

CI also runs these gates:

- `check`: verifies the action package files, then runs typecheck, the `Typecheck (tests)` step (`npm run typecheck:tests`, no `|| true` fallback), tests, and lint.
- `test-coverage`: runs `npm run test:coverage` and enforces the thresholds in `jest.config.js`.
- `license-check`: runs `npm run license:check`.
- `dist-drift`: typechecks tests, builds the distribution, checks source maps, and fails if the build changes committed files in `dist/`.
- `bundle-size`: runs `npm run test:bundle-size`.
- `verify-dist-manifest`: runs `node scripts/verify-dist-manifest.js`.
- `reason_code docs in sync with catalog`: runs `npm run reason-codes:check` and fails when the generated table in `docs/USAGE.md` drifts from `schemas/reason-codes.json`. Fix with `npm run reason-codes:doc`.
- `check-unpinned-actions`: runs `bash scripts/check-unpinned-actions.sh .github/workflows docs/examples`.

## Reason code catalog and generated docs

[`schemas/reason-codes.json`](schemas/reason-codes.json) is the single source of truth for every `reason_code` the action emits. It is a **public API surface** — dashboards and workflow gates switch on these strings — so renames and removals are BREAKING CHANGES requiring a MAJOR version bump. Adding a code is additive and safe in a minor/patch release.

The operator-facing table in [`docs/USAGE.md`](docs/USAGE.md#reason_code-reference-issue-297) is **generated** from the catalog, between these sentinel comments:

```markdown
<!-- BEGIN GENERATED: reason-codes (source: schemas/reason-codes.json) -->
<!-- END GENERATED: reason-codes -->
```

### Adding or changing a reason code

1. Add the entry to `schemas/reason-codes.json` (`code`, `description`, `accountFunded`, `trustlineExists`, `xlmReserveMet`, `valid`, `emittedBy`, `since`). Set `deprecated: true` when retiring a code — it is then rendered with strikethrough instead of being deleted.
2. Regenerate the docs table:

   ```bash
   npm run reason-codes:doc
   ```

3. Verify there is no drift (this is what CI runs):

   ```bash
   npm run reason-codes:check
   ```

4. Extend `KNOWN_REASON_CODES` in `__tests__/reason-codes.test.ts` when introducing a new code so the rename lock covers it.

### Rules for the generated region

- **Never hand-edit** between the sentinel comments — the next `npm run reason-codes:doc` run overwrites it and the `reason-codes:check` CI step fails on drift.
- Column order is fixed (`reason_code`, `valid`, `account_funded`, `trustline_exists`, `xlm_reserve_met`, `Description`) so a regeneration produces a minimal diff.
- Prose *outside* the sentinels is preserved verbatim; put any narrative explanation there.
- `|` characters in a description are escaped so they cannot break the Markdown table.

### Running it in a pre-commit hook

`npm run reason-codes:check` exits non-zero on drift and writes nothing, so it is safe to run from a hook or a CI step:

```json
{
  "scripts": {
    "pre-commit": "npm run reason-codes:check"
  }
}
```

The script uses only Node built-ins, so it runs on Node 20+ with no install step.

## Mutation Testing

For changes to security-critical code in `src/validation.ts` (SSRF validation and StrKey address checks), run mutation tests locally to ensure test coverage catches weakened checks:

```bash
cd trustbridge-action
npm run mutation
```

Mutation testing generates synthetic code defects (mutants) and verifies that your test suite catches each one. For changes to security-critical validation, run `npm run mutation`; results are saved to `stryker-report.html`. Mutation testing is not part of `.github/workflows/ci.yml`. See `stryker.config.mjs` for score thresholds and configuration.

## Pull Requests

- Reference the issue your change addresses.
- Describe what changed and why.
- Ensure the checks above pass.

## Reporting Issues

Open a GitHub issue with a clear description, reproduction steps, and expected behavior.
