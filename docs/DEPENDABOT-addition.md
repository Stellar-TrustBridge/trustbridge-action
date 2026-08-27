<!--
  Append this section to docs/DEPENDABOT.md (adjust heading level to match
  the existing doc). It documents *why* actions are pinned to SHAs and how
  Dependabot keeps those pins current, so contributors don't "helpfully"
  revert a pin back to a tag.
-->

## GitHub Actions

All third-party GitHub Actions used in this repo — in `.github/workflows/`
and in `docs/examples/` — are pinned to a full commit SHA rather than a
mutable tag (e.g. `@v4`) or branch (e.g. `@main`).

**Why:** a tag can be moved to point at different code after the fact, and
a compromised or malicious action maintainer (or a hijacked account) can
publish new code under an existing tag. Pinning to a SHA means the exact
code that runs is fixed and auditable, and Dependabot still surfaces
version bumps as PRs since it resolves the SHA back to its tag internally.

Add or confirm this in `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
    groups:
      github-actions:
        patterns:
          - "*"
```

**CI enforcement:** `.github/workflows/workflow-security.yml` runs
`actionlint` (workflow correctness) and `zizmor` (workflow security,
including the `unpinned-uses` check) on every PR that touches
`.github/workflows/**` or `docs/examples/**`. A PR that introduces an
unpinned action reference will fail CI.

**Exceptions:** if an action genuinely cannot be pinned to a SHA (rare —
e.g. some actions only publish via a Docker tag), document the exception
inline as a comment next to the `uses:` line and add a matching narrow
suppression with a reason in `.github/zizmor.yml`. Do not disable the
`unpinned-uses` rule repo-wide.
