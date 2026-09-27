# TrustBridge Action — Usage

TrustBridge runs sponsorship, diagnostics, and tracing checks against a pull
request and reports the results back to the workflow.

## Quick start

```yaml
- uses: your-org/trustbridge-action@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

All inputs are declared in [`action.yml`](../action.yml). The most commonly used
ones are:

| Input | Description | Default |
| --- | --- | --- |
| `github-token` | Token used to read PR data and post results. | — |
| `tracing` | Enable tracing output. See [Tracing](#tracing). | `false` |
| `tracing-level` | Minimum tracing level to emit (`error`, `warn`, `info`, `debug`). | `info` |
| `tracing-format` | Output format for tracing events (`text` or `json`). | `text` |

Refer to [`action.yml`](../action.yml) for the full, authoritative list of
inputs and their descriptions.

## Tracing

Tracing is implemented in [`src/tracing.ts`](../src/tracing.ts). It records the
internal steps the action takes (input parsing, API calls, rule evaluation) so
operators can debug unexpected results.

### Enabling tracing

Tracing is off by default. Enable it with the `tracing` input:

```yaml
- uses: your-org/trustbridge-action@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    tracing: true
    tracing-level: debug
    tracing-format: json
```

Tracing can also be controlled through environment variables, which is useful
when running the action locally or in a wrapper script:

| Variable | Purpose |
| --- | --- |
| `TRUSTBRIDGE_TRACING` | Set to `1`/`true` to enable tracing. |
| `TRUSTBRIDGE_TRACING_LEVEL` | Minimum level to emit (`error`, `warn`, `info`, `debug`). |
| `TRUSTBRIDGE_TRACING_FORMAT` | Output format (`text` or `json`). |

Inputs take precedence over environment variables when both are set.

### Example output

With `tracing-format: text`:

```
[info] trustbridge: starting run
[info] trustbridge: loaded 3 sponsorship rules
[debug] trustbridge: evaluating rule "require-review" for PR #42
[warn] trustbridge: rule "require-review" matched with 1 warning
[info] trustbridge: run complete in 812ms
```

With `tracing-format: json`, each line is a JSON object suitable for log
aggregation:

```json
{"level":"info","message":"starting run","timestamp":"2024-01-01T00:00:00.000Z"}
{"level":"debug","message":"evaluating rule \"require-review\" for PR #42","timestamp":"2024-01-01T00:00:00.010Z"}
```

### Interpreting tracing output

- `error` — the run failed or a required step could not complete.
- `warn` — a rule matched with a warning, or a recoverable problem occurred.
- `info` — high-level progress (run start/end, rules loaded).
- `debug` — per-rule and per-request detail; use this when investigating why a
  specific rule did or did not match.

Raise `tracing-level` to `debug` only while investigating; lower it back to
`info` for normal runs.

### Performance overhead

Tracing adds a small amount of work per event (formatting and writing a line).
At `info` the overhead is negligible. At `debug`, expect noticeably more output
and a modest increase in run time, especially on large pull requests with many
rules. Tracing does not change the action's results — it only adds output.

## Further reading

- [`action.yml`](../action.yml) — authoritative input descriptions.
- [`src/tracing.ts`](../src/tracing.ts) — tracing implementation.
