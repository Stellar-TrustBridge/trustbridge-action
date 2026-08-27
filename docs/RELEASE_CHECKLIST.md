# Release Checklist

Use this lightweight checklist before tagging a new action release.

Related docs: [Breaking Changes](BREAKING_CHANGES.md) · [License Report](LICENSE_REPORT.md) · [Maintainer Checklist](MAINTAINER_CHECKLIST.md)

## Verify

- Run the unit test suite (`npm test`).
- Run test coverage and verify comment golden snapshots and Jest coverage gate pass (`npm run test:coverage`).
- Run linting (`npm run lint`).
- Run the build so `dist/` matches `src/` (`npm run build`). CI fails the build if `dist/` drifts from a fresh `npm run build` (see `.github/workflows/ci.yml`), but re-run it locally before tagging to be sure.
- Confirm `action.yml` inputs and README inputs stay aligned.
- Confirm the release workflow passes for the commit you plan to tag. The release guard accepts only a new full SemVer tag such as `v1.2.3`; major aliases such as `v1` are rejected.
- Keep an eye on XLM fee buffer guidance in the docs if the validation defaults change; the release checklist should point maintainers back to the current remediation copy.
- **License report**: verify the release workflow attached `licenses-report.json` and `licenses-report.md` to the GitHub Release assets. If a new runtime dependency was added since the last release, check its SPDX identifier against the compatibility table in [docs/LICENSE_REPORT.md](LICENSE_REPORT.md) before publishing.

## Scheduled re-validation

Before tagging a release that changes inputs consumed by the cron sweep, verify the sweep workflow remains compatible:

- Check that `docs/examples/cron-revalidation.yml` still reflects the current input names and defaults.
- If any input used by the cron example was renamed or removed, update the example workflow and `docs/CRON_REVALIDATION.md` before tagging.
- Confirm the `fail_on_missing: false` and `sticky_comment: true` defaults in the example match the released action's defaults.

See [CRON_REVALIDATION.md](CRON_REVALIDATION.md) for the full guide.

## Tagging

- Choose an unused full SemVer tag such as `v1.0.1`. Do not create major-only or minor-only aliases such as `v1` or `v1.0`.
- Confirm the tag does not already exist locally, on the remote, or as a GitHub Release.
- Create the tag from the reviewed commit on `main`, then push it exactly once.
- Never move, delete, reuse, or force-push a published tag.
- Never force-push `main`.
- Confirm the release workflow passes and attaches the expected assets.
- Include release notes describing behavior or input changes.

See [BREAKING_CHANGES.md](BREAKING_CHANGES.md#immutable-release-tag-contract) for the complete immutable-tag policy and enforcement limitations.

## Rollback

If a release is faulty:

1. Leave the faulty tag unchanged and direct consumers to the last known-good full version or commit SHA.
2. Revert the faulty change on a new branch and merge it through a reviewed PR; do not rewrite `main`.
3. Run lint, tests, and the build so the corrected `dist/` is committed.
4. Publish the correction under the next unused patch tag, for example replace faulty `v1.2.3` with corrective `v1.2.4`.
5. Document which release was superseded and verify the corrective release workflow.

Never delete or retarget the faulty tag. The command-by-command procedure is in [BREAKING_CHANGES.md](BREAKING_CHANGES.md#rollback-recipe).
