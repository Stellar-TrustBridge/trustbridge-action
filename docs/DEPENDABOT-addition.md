# SHA Pinning & Dependabot — Supplemental Notes

This document supplements [docs/DEPENDABOT.md](DEPENDABOT.md) with guidance
specific to the SHA-pinning requirement introduced by issues #464 and #465.

---

## Why every `uses:` must be a full commit SHA

A mutable tag such as `@v4` or `@main` can be silently reassigned by the
upstream maintainer at any time. If the tag is moved (accidentally or
maliciously) the workflow runs different code on the next trigger with no
diff in your repository. Pinning to a 40-character commit SHA guarantees
that the exact bytes that ran are auditable and immutable.

---

## Enforcement

Two automated gates prevent unpinned actions from reaching `main`:

1. **`check-unpinned-actions` in CI** (`ci.yml`, job `check-unpinned-actions`)  
   Runs on every push and pull request targeting `main`. Scans
   `.github/workflows/` and `docs/examples/` for any `uses:` line whose ref
   is not a 40-hex-character commit SHA. The job fails immediately so
   unpinned references cannot merge.

2. **`workflow-security.yml`**  
   Adds `check-unpinned-actions` as the first job before `actionlint` and
   `zizmor`. Triggers on pushes and PRs that touch workflow files or examples
   so the gate is always fresh.

Both jobs use `scripts/check-unpinned-actions.sh`, which you can also run
locally before opening a PR:

```bash
bash scripts/check-unpinned-actions.sh .github/workflows docs/examples
```

---

## How to pin a new action

1. Find the tag you want on the action's GitHub Releases page, e.g.
   `https://github.com/actions/checkout/releases/tag/v4.2.2`.

2. Copy the full SHA from the commit linked on that release page.  
   Alternatively, use a pinning tool:

   ```bash
   # suzuki-shunsuke/pinact (Go)
   pinact run .github/workflows/my-workflow.yml

   # mheap/pin-github-action (Node)
   npx pin-github-action .github/workflows/my-workflow.yml
   ```

3. Replace the tag with the SHA and keep the tag in a comment for
   human readability:

   ```yaml
   uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
   ```

---

## Keeping pins up to date with Dependabot

Dependabot understands pinned SHAs. The `github-actions` entry in
`.github/dependabot.yml` is configured to open weekly PRs when a pinned
action has a newer version available. Each PR updates both the SHA and the
comment tag so pins never go stale.

When a Dependabot PR arrives for a GitHub Actions update:

1. Review the release notes for the new version.
2. Verify the SHA in the PR matches the commit on the release page.
3. Merge — no rebuild of `dist/` is required for pure workflow pin bumps.

GitHub Actions bumps are **not grouped**: each action gets its own PR. Only
npm `@actions/*` patch updates are grouped (`actions-patches`); see the
grouping table in [DEPENDABOT.md](DEPENDABOT.md#update-grouping-matches-githubdependabotyml).

---

## Exemptions

Local composite actions (e.g. `./.github/actions/trustbridge-label-gate`)
and `docker://` image references are exempt from the SHA pinning requirement
because they are not third-party supply-chain dependencies. The
`check-unpinned-actions.sh` script already skips these patterns.

If an upstream action genuinely cannot be pinned (e.g. it uses a
non-standard ref scheme), document the exception next to the `uses:` line
and add a narrow suppression in `.github/zizmor.yml` with a justification
comment. Never disable `unpinned-uses` repo-wide.

---

## Reference

- [DEPENDABOT.md](DEPENDABOT.md) — core Dependabot policy and `dist/` rebuild checklist  
- [scripts/check-unpinned-actions.sh](../scripts/check-unpinned-actions.sh) — scanner  
- [.github/zizmor.yml](../.github/zizmor.yml) — narrow suppressions  
- GitHub docs: [Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions#using-third-party-actions)
