# Release Checklist

Use this lightweight checklist before tagging a new action release.

## Verify

- Run the unit test suite.
- Run linting.
- Run the build so `dist/` matches `src/`.
- Confirm `action.yml` inputs and README inputs stay aligned.

## Tagging

- Create a semantic tag such as `v1.0.1`.
- Move the major tag, such as `v1`, only after the release is verified.
- Include one short note about any behavior or input changes.
