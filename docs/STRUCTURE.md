# Project structure

File and directory reference for **trustbridge-action**. For design rationale see [Architecture](ARCHITECTURE.md); for usage see [Usage](USAGE.md).

Related docs: [README](../README.md) · [Architecture](ARCHITECTURE.md) · [Contributing](../CONTRIBUTING.md)

---

## Tree overview

```
trustbridge-action/
├── .github/
│   └── workflows/
│       └── ci.yml                 # Lint, test, build on push/PR
├── __tests__/
│   └── checks.test.ts             # Unit tests for validation logic
├── docs/
│   ├── ARCHITECTURE.md            # System design
│   ├── ERROR_HANDLING.md          # Failure modes and retries
│   ├── STRUCTURE.md               # This file
│   └── USAGE.md                   # Workflow examples
├── src/
│   ├── index.ts                   # Action entrypoint
│   ├── horizon.ts                 # Horizon API client
│   ├── checks.ts                  # Validation rules
│   └── comment.ts                 # GitHub comment builder
├── action.yml                     # GitHub Action manifest
├── CONTRIBUTING.md                # Contribution guide
├── eslint.config.mjs              # ESLint flat config
├── jest.config.js                 # Jest + ts-jest
├── LICENSE                        # MIT
├── package.json                   # Dependencies and scripts
├── package-lock.json              # Lockfile (generated)
├── README.md                      # Project overview
└── tsconfig.json                  # TypeScript compiler options
```

Generated / ignored (not committed):

```
dist/                              # Compiled JavaScript (build output)
node_modules/                      # npm dependencies
coverage/                          # Jest coverage reports
```

---

## Root files

| File | Purpose |
|------|---------|
| `action.yml` | Declares action name, inputs, outputs, and `runs.main` entry (`dist/index.js`) |
| `package.json` | npm metadata, scripts (`build`, `test`, `lint`), runtime and dev dependencies |
| `tsconfig.json` | `target: ES2020`, `module: commonjs`, `outDir: dist`, `rootDir: src` |
| `jest.config.js` | Runs tests in `__tests__/` via ts-jest |
| `eslint.config.mjs` | TypeScript-aware lint rules for `src/` and `__tests__/` |
| `LICENSE` | MIT license |
| `README.md` | Primary documentation entry point |
| `CONTRIBUTING.md` | Contributor workflow and standards |

---

## Source modules (`src/`)

### `index.ts`

**Role:** Orchestrator — the only file executed at runtime.

**Flow:**

1. Parse and validate inputs via `@actions/core`
2. Call `fetchAccount` or catch `HorizonError`
3. Delegate to `runAccountChecks`, `unfundedAccountResult`, or `horizonFailureResult`
4. Set outputs
5. Post comment via `postIssueComment`
6. `setFailed` or `warning` based on `fail_on_missing`

**Dependencies:** `checks.ts`, `horizon.ts`, `comment.ts`, `@actions/core`, `@actions/github`

---

### `horizon.ts`

**Role:** Stellar Horizon HTTP layer.

**Exports:**

| Export | Description |
|--------|-------------|
| `HorizonAccount`, `HorizonBalance` | Response types |
| `HorizonError` | Typed error with `statusCode` and `retryable` |
| `fetchAccount` | GET account with timeout and retries |
| `getNativeBalance` | Extract XLM balance string |
| `hasTrustline` | Match asset code + issuer in balances |

**Dependencies:** `node-fetch` (dynamic import)

---

### `checks.ts`

**Role:** Pure business logic — no GitHub or HTTP.

**Exports:**

| Export | Description |
|--------|-------------|
| `validateStellarAddress` | Throws on invalid G-address |
| `isValidStellarAddress` | Regex test helper |
| `parseMinXlmReserve` | Parse and validate reserve input |
| `runAccountChecks` | Full validation for funded accounts |
| `unfundedAccountResult` | Result template for 404 |
| `horizonFailureResult` | Result template for API errors |
| `STELLAR_*_XLM` | Documented reserve constants |

**Test coverage:** `__tests__/checks.test.ts`

---

### `comment.ts`

**Role:** User-facing Markdown and GitHub API.

**Exports:**

| Export | Description |
|--------|-------------|
| `formatCommentBody` | Build full comment from `ValidationResult` |
| `postIssueComment` | Octokit `issues.createComment` |

**Dependencies:** `@actions/core`, `@actions/github`, types from `checks.ts`

---

## Tests (`__tests__/`)

| File | Scope |
|------|-------|
| `checks.test.ts` | Address validation, trustline matching, reserve checks, unfunded results |

Horizon HTTP is not integration-tested in CI (no live network calls). Retry behavior is covered by unit structure in `horizon.ts` and documented in [ERROR_HANDLING.md](ERROR_HANDLING.md). Future work: mock `node-fetch` in dedicated horizon tests.

---

## CI (`.github/workflows/`)

| Workflow | Trigger | Steps |
|----------|---------|-------|
| `ci.yml` | push/PR to main, `workflow_dispatch` | checkout → Node 20 → `npm ci` → lint → test → build → verify `dist/index.js` |

---

## Documentation (`docs/`)

| Doc | Audience | Links from README |
|-----|----------|-------------------|
| `ARCHITECTURE.md` | Maintainers, reviewers | “How it works” |
| `STRUCTURE.md` | New contributors | “Repository layout” |
| `USAGE.md` | Action consumers | “Quick start”, inputs |
| `ERROR_HANDLING.md` | Operators debugging failures | “Error handling” |

All docs cross-link to `README.md` and `CONTRIBUTING.md`.

---

## npm scripts

| Script | Command | When to use |
|--------|---------|-------------|
| `build` | `tsc` | Before commit / release; produces `dist/` |
| `test` | `jest` | Local verification and CI |
| `test:coverage` | `jest --coverage` | Coverage reports |
| `lint` | `eslint src __tests__ --ext .ts` | CI and pre-PR |
| `prepare` | `npm run build` | Runs on `npm install` (ensures `dist/` exists) |

---

## Release artifact

Published action consumers need:

1. `action.yml`
2. `dist/index.js` (+ `.map` optional)
3. `package.json` (for metadata; runtime deps bundled in dist if using ncc in future)

Current build uses `@vercel/ncc` to produce a single bundled `dist/index.js` for GitHub Actions runtime. Run `npm run build` before release and commit `dist/`.

---

[← Back to README](../README.md)
