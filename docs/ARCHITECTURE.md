# Architecture

This document describes the internal structure of the TrustBridge Action and how its components interact. For operational guidance and FAQs, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

## Logging and Stellar address masking

The action emits diagnostics through `src/logger.ts`. Before any line reaches the Actions log, the logger runs a redaction pass so that Stellar addresses are not leaked into CI logs, which may be retained and shared by reviewers.

### Redacted patterns

Redaction is driven by two regular expressions in `src/logger.ts`:

- `STELLAR_ADDRESS_REGEX` — matches standard Stellar account (`G...`) and contract (`C...`) addresses (56-character StrKey encodings).
- `MUXED_ADDRESS_REGEX` — matches muxed account (`M...`) addresses, which embed a 64-bit memo ID alongside the underlying `G` address.

When a match is found, the address is replaced with a masked placeholder (e.g. `GABC...WXYZ` style truncation) so operators can still correlate log lines without exposing the full value. The redaction helpers are applied to every `core.info`, `core.debug`, `core.warning`, and `core.error` call routed through the logger.

### Context key allowlist

The logger accepts a structured context object. Only keys on an explicit allowlist (e.g. `operation`, `status`, `count`, `durationMs`) are serialized verbatim. Unknown keys are dropped rather than stringified, preventing accidental leakage of raw payload fields that may contain addresses.

### Exceptions

- **Comment bodies** posted to GitHub are *not* passed through the logger redactor. Comments are user-facing output and may legitimately contain full addresses (for example, a confirmation of the account that was funded). Review comment templates before enabling them in public repos.
- **Webhook payloads** received from GitHub are logged only after passing through the same redaction helpers; raw payloads are never emitted directly.
- **Federation responses** may contain addresses in free-form fields. These are redacted when logged, but partial addresses embedded in error messages are only masked if they match the regexes above — malformed or truncated addresses may slip through, so avoid logging raw error strings from federation calls.

### Example

Before redaction:

```
Funding account GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV
```

After redaction:

```
Funding account GABC...STUV
```

### Behavioral contract

`__tests__/logger.test.ts` is the authoritative specification for redaction behavior. It covers `G`, `C`, and `M` address masking, context allowlist enforcement, and the comment-body exception. Any change to `src/logger.ts` must keep these tests green; treat them as the source of truth when in doubt.

### privacy_mode

`privacy_mode` is a separate control from log redaction and affects *outputs* (comments and webhook responses) rather than the Actions log itself:

- When `privacy_mode` is enabled, generated comment bodies omit full addresses and use masked forms, and webhook responses redact address fields.
- When disabled, comments and webhook responses may include full addresses, while the Actions log remains redacted regardless.

Log redaction is always on and must not be disabled in production workflows. See TROUBLESHOOTING.md for the FAQ on missing addresses in logs.
