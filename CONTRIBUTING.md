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

## CI Checks

The `.github/workflows/ci.yml` workflow runs on pushes and pull requests targeting `main`, and can also be started manually. Jobs that set up Node use Node.js 20; the workflow grants read-only repository contents permissions. Before opening a pull request, run the relevant checks from the repository root:

```bash
npm run typecheck
npm test
npm run lint --if-present
```

CI also runs these gates:

- `check`: verifies the action package files, then runs typecheck, tests, and lint.
- `test-coverage`: runs `npm run test:coverage` and enforces the thresholds in `jest.config.js`.
- `license-check`: runs `npm run license:check`.
- `dist-drift`: typechecks tests, builds the distribution, checks source maps, and fails if the build changes committed files in `dist/`.
- `bundle-size`: runs `npm run test:bundle-size`.
- `verify-dist-manifest`: runs `node scripts/verify-dist-manifest.js`.
- `check-unpinned-actions`: runs `bash scripts/check-unpinned-actions.sh .github/workflows docs/examples`.

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
