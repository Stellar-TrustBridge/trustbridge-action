# Maintainer Checklist

Use this checklist before enabling TrustBridge in a contributor workflow.

## Required setup

- Confirm the workflow grants `issues: write` so comments can be posted.
- Pass `github_token: ${{ secrets.GITHUB_TOKEN }}` unless a scoped token is required.
- Provide a real `stellar_address_input` from issue metadata, a form field, or a dispatch input.
- Keep `fail_on_missing` set to `true` for protected assignment and payout gates.

## Before rollout

- Test with one funded Stellar account that already has the expected trustline.
- Test with one unfunded G-address to confirm remediation text is clear.
- Verify maintainers understand that Horizon outages are treated as failed checks.

## Verify dist/ before tagging a release

`dist/index.js` is the bundle consumers run, so it must match `src/` on every release tag. Two things enforce this:

- `.github/workflows/ci.yml` (`check` job) fails when `dist/` differs from a fresh `npm run build`.
- `.github/workflows/refresh-dist.yml` is a manual `workflow_dispatch` job. It runs `npm ci`, `npm run build`, `npm run test:map-paths`, regenerates the manifest and runs `npm run verify:dist`, then commits `dist/` as `chore: refresh dist` when anything changed.

Before you tag, run these steps on the commit you plan to tag:

1. Refresh the bundle, either by running `refresh-dist.yml` from the Actions tab or locally:

   ```bash
   npm ci
   npm run build
   npm run test:map-paths
   node scripts/generate-dist-manifest.js
   ```

   `npm run build` does not write `dist/dist-manifest.json`. The `generate-dist-manifest.js` step must run after every build, or `verify:dist` checks the old bundle hash.

2. Confirm nothing is left to commit: `git status --porcelain dist` must print nothing. If it prints files, commit the refreshed `dist/` before tagging.
3. Check the bundle manifest: `npm run verify:dist` must exit `0`. It compares the SHA-256 of `dist/index.js` against the recorded value.
4. Confirm the tagged commit includes the bundle: `git log -1 --format=%H -- dist` should point at a commit reachable from `main`.

Failure paths and what to do:

- **CI reports `dist/ is out of date`**: run `npm run build` and commit the result. Do not hand-edit anything under `dist/`.
- **`npm run test:map-paths` fails**: source-map entries point outside the repo or at missing sources. Fix the source paths and rebuild. Do not publish a bundle with a failing map check.
- **`refresh-dist.yml` cannot push** (for example, branch protection rejects the bot): build locally, open a PR with only the `dist/` change, and tag after it merges.

Once the tag is pushed, follow the build provenance and checksum steps in [RELEASE_CHECKLIST](RELEASE_CHECKLIST.md#verify-build-provenance).

## Wave freeze labeling

Run these steps in order before a Drips Wave opens so every repository in the org freezes the same way:

1. **Label** — apply the Wave label (e.g. `wave`) plus the complexity/points labels to every eligible issue, and confirm `pass_label` / `fail_label` (or `ready_pass_label` / `ready_fail_label`) match the labels your [label gate](LABEL_GATE_DESIGN.md) filters on.
2. **Snooze** — set `snooze_window_minutes` so repeated re-runs during the Wave do not spam contributors; outputs still update while snoozed. See [USAGE](USAGE.md).
3. **Freeze** — stop merging changes to the TrustBridge workflow and pin the action to a release tag for the duration of the Wave. Remove or add Wave labels only through the checklist, never ad hoc.
4. **Unfreeze** — after the Wave closes, reset `snooze_window_minutes`, use `force_comment: true` once if contributors need a fresh comment, and remove the Wave label from unfinished issues.

Contributors who ask why their comment did not update during a Wave should be pointed to the [FAQ](FAQ.md).

## CODEOWNERS pattern precedence

GitHub evaluates CODEOWNERS rules **top to bottom**. The **last** rule whose
pattern matches a file is authoritative; all earlier matches are overridden.

```
# Example CODEOWNERS
*                 @global-owner        # 1 — catch-all
src/**            @backend-team        # 2 — overrides rule 1 for src/
src/payments      @payments-team       # 3 — overrides rule 2 for src/payments/
```

For the file `src/payments/invoice.ts` all three patterns match, but rule 3 wins because it
appears last. For `src/horizon.ts` only rules 1 and 2 match — rule 2 wins.

### Conflict scenarios

| Scenario | Example | Winner |
|----------|---------|--------|
| Broad glob then specific path | `*` then `src/payments` | Specific path (later in file) |
| Team rule then individual override | `docs/**` then `docs/api/**` | Individual rule (later) |
| Identical pattern listed twice | `src/**` repeated | Second occurrence |
| Type-glob then subdirectory rule | `**/*.ts` then `src/generated/**` | Subdirectory rule (later) |

Reproducible examples are in [`fixtures/codeowners/`](../fixtures/codeowners/README.md).

### Preflight comment citation

When TrustBridge runs coverage analysis, each touched file reports which pattern
won and which owners it resolved to:

```
src/payments/invoice.ts → matched pattern `src/payments` → owners: @payments-team
scripts/build.sh → no CODEOWNERS rule matched
```

This output is generated by `checkCodeownersCoverageWithDetail` and
`formatMatchedPatternNote` in `src/codeowners.ts`. Maintainers can use it to
diagnose unexpected ownership routing in Wave PR reviews without reading the
full CODEOWNERS file.

### Ignoring generated paths

Build output such as `dist/` and `coverage/` is regenerated, never hand-reviewed,
and usually has no CODEOWNERS entry. Listing it as "no owner" only adds noise to
Wave PR preflight, so coverage checks can skip it:

```ts
import { evaluateOwnershipPreflight } from './preflight';

// dist/ and coverage/ are ignored by default; add more patterns as needed.
const { warnings, ignored } = evaluateOwnershipPreflight(touchedPaths, rules, {
  ignorePatterns: ['*.min.js', 'src/generated/'],
});
```

`checkCodeownersCoverage` and `checkCodeownersCoverageWithDetail` accept the same
options (`ignoreGenerated`, `ignorePatterns`) and list skipped files under
`ignored`. Without options their behavior is unchanged. An ignored path is skipped
**before** any CODEOWNERS rule is consulted, so it is never reported as covered or
uncovered.

| Pattern | Matches | Does not match |
|---------|---------|----------------|
| `dist/` | `dist/index.js`, `packages/app/dist/a.js` (a directory named `dist` at any depth) | `distribution/x`, `src/redist/x` |
| `/dist/` | only the root-level `dist/` | `packages/app/dist/a.js` |
| `build/out/` | `build/out/x.js` (a slash anywhere anchors to the repo root) | `pkg/build/out/x.js` |
| `*.min.js` | `app.min.js`, `assets/app.min.js` | `assets/app.js` |
| `**/generated/` | `a/b/generated/c.ts` | `generated.ts` |

Separate patterns with commas or newlines; blank entries and `#` comments are
skipped. These inputs fail with a stable `CodeownersIgnoreError.code` instead of
being silently dropped:

| Code | Cause |
|------|-------|
| `IGNORE_PATTERN_INVALID` | negation (`!pattern`), a backslash, a NUL byte, a `..` segment, or a drive path such as `C:/x` |
| `IGNORE_PATTERN_TOO_LONG` | a pattern longer than 200 characters |
| `IGNORE_TOO_MANY_PATTERNS` | more than 100 patterns |

Preflight warnings name at most 10 uncovered paths followed by `(+N more)`.

### Checklist before a Wave opens

- [ ] Review CODEOWNERS for conflicting patterns using the precedence table above.
- [ ] Confirm the last matching rule for each protected path resolves to the
      intended reviewer(s).
- [ ] Run `checkCodeownersCoverageWithDetail` on the set of files modified by
      the Wave PR and verify every file is covered.
- [ ] Check that no two rules assign ownership of the same path to different
      teams when that was not intentional.

## Label gate and comment safety (Issues #867–#868)

- [ ] Confirm `gate_skipped` is checked before any forwarded validation output.
- [ ] Treat a missing gate label as an intentional short-circuit: no Horizon call and no `fail_on_missing` failure.
- [ ] Use `force_validation: true` only for an explicit maintainer rerun; record why the override was needed.
- [ ] Give the token comment update permission and verify sticky comments carry a TrustBridge marker.
- [ ] Do not rely on marker-like prose or a human-authored comment being edited in place.
- [ ] Treat skip-comment posting as best effort; a permission failure must not convert a gate skip into a validation failure.
