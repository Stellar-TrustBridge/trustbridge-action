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

## Checks

Before opening a pull request, run the available checks from the `trustbridge-action` directory:

```bash
cd trustbridge-action
npm run check-error-catalog
```

The `check-error-catalog` script runs `scripts/check-error-catalog.js` and verifies that the error catalog is in sync with the code. If it exits non-zero, the catalog has drifted and must be regenerated/updated before the change can be merged. See `trustbridge-action/docs/ERROR_HANDLING.md` for details on the error catalog and how to fix drift.

## Pull Requests

- Reference the issue your change addresses.
- Describe what changed and why.
- Ensure the checks above pass.

## Reporting Issues

Open a GitHub issue with a clear description, reproduction steps, and expected behavior.
