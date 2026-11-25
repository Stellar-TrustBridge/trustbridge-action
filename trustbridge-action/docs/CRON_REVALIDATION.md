# Cron Revalidation

This document describes how the scheduled revalidation workflow operates and how
`privacy_mode` affects the delta artifacts it produces.

## Overview

The revalidation cron runs on a schedule (see `.github/workflows/`), re-checks
the trust state of tracked dependencies, and emits a **delta export** — a ZIP
archive containing only the changes since the last run.

## Delta exports and `privacy_mode`

`privacy_mode` controls how much identifying information is written into the
delta ZIP and its contents. It applies to every delta flow (scheduled cron runs
and manual delta exports alike).

| `privacy_mode` | Delta ZIP contents |
| --- | --- |
| `off` (default) | Full detail: repository names, file paths, commit SHAs, and raw evidence are included. |
| `redacted` | Identifying fields (repository names, file paths, commit SHAs, author metadata) are replaced with stable hashes or placeholders. Evidence is summarized. |
| `strict` | Only aggregate counts and status codes are emitted. No paths, names, SHAs, or evidence payloads are written. |

### What gets redacted

When `privacy_mode` is not `off`, the following are redacted in the delta ZIP:

- Repository and organization names
- File paths and directory structure
- Commit SHAs and refs
- Author/committer identity metadata
- Raw evidence blobs (replaced with summaries or hashes)

### Safe vs redacted output

**Safe (non-redacted) — `privacy_mode: off`:**

```json
{
  "repo": "acme/payments",
  "path": "src/auth/token.ts",
  "sha": "9f2c1a4b7e8d0f3a5c6b1d2e4f7a8b9c0d1e2f3a",
  "status": "changed",
  "evidence": "raw diff payload"
}
```

**Redacted — `privacy_mode: redacted`:**

```json
{
  "repo": "repo_3f9a1c",
  "path": "path_7b2e40",
  "sha": "sha_1d8c55",
  "status": "changed",
  "evidence": "summary: 1 file changed"
}
```

**Strict — `privacy_mode: strict`:**

```json
{
  "status": "changed",
  "count": 1
}
```

## Recommended settings

- Use `privacy_mode: off` only in trusted, private environments where artifacts
  never leave the organization.
- Use `privacy_mode: redacted` for shared artifact stores or CI logs that may be
  visible to a wider audience.
- Use `privacy_mode: strict` when artifacts are published externally or when
  regulatory constraints forbid emitting identifying data.

## Notes

- Redaction is applied at export time, so the underlying trust state is
  unaffected.
- Hashes used for redaction are stable across runs, allowing correlation without
  revealing the original values.
- See `docs/USAGE.md` for the full `privacy_mode` reference and `action.yml` for
  the input definition.
