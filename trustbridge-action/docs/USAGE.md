# TrustBridge Action — Usage

TrustBridge validates trust artifacts (SBOMs, provenance, attestations) and can
emit **delta exports** — ZIP bundles that contain only the artifacts that
changed since a previous run.

## Basic usage

```yaml
- uses: your-org/trustbridge-action@v1
  with:
    mode: validate
    path: ./artifacts
```

## Delta exports

Delta exports are produced when `delta: true` is set. The action compares the
current artifact set against the last recorded state and writes a ZIP containing
only the changed entries.

```yaml
- uses: your-org/trustbridge-action@v1
  with:
    mode: validate
    path: ./artifacts
    delta: true
    delta-output: ./delta.zip
```

### `privacy_mode` and delta redaction

`privacy_mode` controls how much sensitive content is written into delta ZIPs
and their contents. It applies to **every** delta flow (interactive runs and
scheduled revalidation).

| `privacy_mode` | Delta ZIP contents | Notes |
| --- | --- | --- |
| `off` (default) | Full artifact contents, including any embedded PII, paths, and metadata. | Safe only for private/internal artifacts. |
| `redact` | Sensitive fields are replaced with `[REDACTED]`; file names and structure are preserved. | Recommended for shared or uploaded artifacts. |
| `hash` | Sensitive fields are replaced with a stable hash; contents are not recoverable. | Use when you need to compare without exposing values. |

> **Warning:** with `privacy_mode: off`, delta ZIPs may contain PII. Only
> publish or upload delta artifacts when you have confirmed the source
> artifacts are safe to share.

### Examples

**Safe (non-redacted) delta output** — `privacy_mode: off`:

```json
{
  "component": "payments-api",
  "author": "jane.doe@example.com",
  "path": "/home/jane/src/payments-api",
  "license": "Apache-2.0"
}
```

**Redacted delta output** — `privacy_mode: redact`:

```json
{
  "component": "payments-api",
  "author": "[REDACTED]",
  "path": "[REDACTED]",
  "license": "Apache-2.0"
}
```

**Hashed delta output** — `privacy_mode: hash`:

```json
{
  "component": "payments-api",
  "author": "sha256:9f2c…",
  "path": "sha256:1a7b…",
  "license": "Apache-2.0"
}
```

See `docs/CRON_REVALIDATION.md` for how `privacy_mode` behaves in scheduled
revalidation delta flows.
