# CODEOWNERS Pattern Precedence Fixtures

These fixture files are used by `__tests__/codeowners.test.ts` to validate
GitHub CODEOWNERS **last-match-wins** precedence semantics and to serve as
reproducible examples for Wave PR review routing documentation.

## Precedence rule

GitHub evaluates CODEOWNERS rules **top to bottom**. The **last** rule whose
pattern matches a file is authoritative. All earlier matches are overridden.

This mirrors the behaviour documented in
[GitHub Docs — About code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners#syntax-exceptions).

## Fixture files

| File | Scenario |
|------|----------|
| `conflict-glob-vs-specific.CODEOWNERS` | Broad glob (`*`, `src/**`) followed by a specific path (`src/payments`) — specific path wins for files under it |
| `conflict-team-override.CODEOWNERS` | Team rule overridden by an individual-contributor rule for a sub-path |
| `conflict-negation-gap.CODEOWNERS` | Type-glob (`**/*.ts`) overridden for a generated sub-tree |
| `conflict-duplicate-pattern.CODEOWNERS` | Identical pattern listed twice — the later occurrence wins |

## Using fixtures in tests

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { parseCodeownersRules, findCoveringRule } from '../src/codeowners';

const fixture = fs.readFileSync(
  path.join(__dirname, '../fixtures/codeowners/conflict-glob-vs-specific.CODEOWNERS'),
  'utf8',
);
const rules = parseCodeownersRules(fixture);
const winner = findCoveringRule('src/payments/invoice.ts', rules);
// winner.pattern === 'src/payments', winner.owners === ['payments-team']
```

## Citability in preflight comments

When `checkCodeownersCoverageWithDetail` or `formatMatchedPatternNote` is used,
preflight PR comments include a line like:

```
src/payments/invoice.ts → matched pattern `src/payments` → owners: @payments-team
```

This makes the winning rule visible to contributors without them needing to
read and interpret the full CODEOWNERS file themselves.
