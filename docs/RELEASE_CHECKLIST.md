# Release Checklist

Use this lightweight checklist before tagging a new action release.

Related docs: [Breaking Changes](BREAKING_CHANGES.md) · [License Report](LICENSE_REPORT.md) · [Maintainer Checklist](MAINTAINER_CHECKLIST.md)

## Verify

- Run the unit test suite (`npm test`).
- Run test coverage and verify comment golden snapshots and Jest coverage gate pass (`npm run test:coverage`).
- Run linting (`npm run lint`).
- Run the build so `dist/` matches `src/` (`npm run build`). CI fails the build if `dist/` drifts from a fresh `npm run build` (see `.github/workflows/ci.yml`), but re-run it locally before tagging to be sure.
- Confirm `action.yml` inputs and README inputs stay aligned.
- Confirm the release workflow still passes on the tag you plan to ship. The repo-level release job is a dry run gate for `v*` tags and should stay green before moving a major tag.
- **SLSA provenance**: for a `v*` tag, confirm the `Generate SLSA provenance for dist/index.js` step succeeds. A manual `workflow_dispatch` run intentionally validates the build without publishing release provenance.
- Confirm the provenance step receives only `subject-path: dist/index.js`; do not pass secrets or secret-derived values to the attestation action.
- Keep an eye on XLM fee buffer guidance in the docs if the validation defaults change; the release checklist should point maintainers back to the current remediation copy.
- **License report**: verify the release workflow attached `licenses-report.json` and `licenses-report.md` to the GitHub Release assets. If a new runtime dependency was added since the last release, check its SPDX identifier against the compatibility table in [docs/LICENSE_REPORT.md](LICENSE_REPORT.md) before publishing.

## Verify build provenance

The tag-triggered release workflow publishes a signed SLSA provenance attestation for the freshly built `dist/index.js` to GitHub's attestations API. Verify the exact bundle from the release tag before moving a major tag:

```bash
TAG=v1.0.1
git clone --depth 1 --branch "$TAG" https://github.com/Stellar-TrustBridge/trustbridge-action.git
cd trustbridge-action

gh attestation verify dist/index.js \
  --repo Stellar-TrustBridge/trustbridge-action \
  --signer-workflow Stellar-TrustBridge/trustbridge-action/.github/workflows/release.yml \
  --source-ref "refs/tags/$TAG"
```

Replace `v1.0.1` with the release tag. A successful result proves that the bundle digest matches a SLSA provenance statement signed by the repository's release workflow for that tag. If verification fails, do not publish or move the major tag; inspect the release run and rebuild from a clean tag.

## Scheduled re-validation

Before tagging a release that changes inputs consumed by the cron sweep, verify the sweep workflow remains compatible:

- Check that `docs/examples/cron-revalidation.yml` still reflects the current input names and defaults.
- If any input used by the cron example was renamed or removed, update the example workflow and `docs/CRON_REVALIDATION.md` before tagging.
- Confirm the `fail_on_missing: false` and `sticky_comment: true` defaults in the example match the released action's defaults.

See [CRON_REVALIDATION.md](CRON_REVALIDATION.md) for the full guide.

## Tagging

- Create a semantic tag such as `v1.0.1`.
- Move the major tag, such as `v1`, only after the release is verified.
- Include one short note about any behavior or input changes.
