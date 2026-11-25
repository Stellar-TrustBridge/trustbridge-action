# TrustBridge Action — Input JSON Schema

`schemas/action-inputs.schema.json` exports a [JSON Schema (Draft 7)](https://json-schema.org/draft-07/json-schema-validation.html) that mirrors every input declared in `action.yml`. Use it to validate `.trustbridge.yml` consumer config files or CI policy checks **before runtime**, catching misconfigurations at the point of change rather than at assignment time.

---

## Why a schema?

Invalid Horizon URLs, malformed asset issuers, or out-of-range numeric inputs are common misconfiguration footguns that only surface when the action runs against a live issue. A schema enables:

- **Editor validation** — VS Code, JetBrains IDEs, and any JSON-schema-aware editor can highlight errors inline.
- **CI policy checks** — Validate config files in a dedicated pre-merge job so bad defaults never reach production workflows.
- **Documentation** — The schema is the single authoritative source of allowed values, patterns, and defaults.

---

## Schema location

```
schemas/action-inputs.schema.json
```

Raw URL (for editor references):

```
https://raw.githubusercontent.com/Stellar-TrustBridge/trustbridge-action/main/schemas/action-inputs.schema.json
```

---

## Using the schema in VS Code

Add a `$schema` key to your `.trustbridge.yml`:

```yaml
# .trustbridge.yml
# $schema: https://raw.githubusercontent.com/Stellar-TrustBridge/trustbridge-action/main/schemas/action-inputs.schema.json
horizon_url: https://horizon.stellar.org
asset_code: USDC
asset_issuer: GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
min_xlm_reserve: '1.5'
```

Or add a workspace-level mapping in `.vscode/settings.json`:

```json
{
  "yaml.schemas": {
    "https://raw.githubusercontent.com/Stellar-TrustBridge/trustbridge-action/main/schemas/action-inputs.schema.json": [
      ".trustbridge.yml",
      ".trustbridge.yaml"
    ]
  }
}
```

---

## Validating in CI

Use [`ajv-cli`](https://github.com/ajv-validator/ajv-cli) or any JSON Schema validator. Example CI step (GitHub Actions):

```yaml
- name: Validate .trustbridge.yml against schema
  run: |
    npm install -g ajv-cli
    # Convert YAML to JSON first (requires js-yaml or yq)
    npx js-yaml .trustbridge.yml > /tmp/config.json
    ajv validate \
      -s schemas/action-inputs.schema.json \
      -d /tmp/config.json \
      --strict=false
```

Or using [`check-jsonschema`](https://check-jsonschema.readthedocs.io/) (no conversion needed for YAML):

```yaml
- uses: actions/checkout@v4
- uses: python-jsonschema/check-jsonschema@v0.28.0
  with:
    schema: schemas/action-inputs.schema.json
    checklist-file-pattern: .trustbridge.yml
```

---

## Security-relevant fields

The following fields have format or pattern constraints that prevent common security footguns:

| Field | Constraint | Reason |
|-------|-----------|--------|
| `horizon_url` | `format: uri`, `pattern: ^https://` | Prevents non-HTTPS (unencrypted) Horizon calls |
| `horizon_url_fallback` | Same | Same protection for fallback URL |
| `webhook_url` | `format: uri`, `pattern: ^(https://\|$)` | Webhook endpoint must use TLS |
| `stellar_address_input` | `pattern: ^G[A-Z2-7]{55}$` | Enforces valid G-address format |
| `asset_issuer` | `pattern: ^[GC][A-Z2-7]{55}$` | Enforces G- or C-address format |
| `webhook_secret` | Secret field — value never logged | Shared HMAC signing secret |
| `webhook_secret_previous` | Secret field — value never logged | Previous HMAC secret, only during rotation; signs `X-TrustBridge-Signature-Previous` (Issue #795) |
| `github_token` | Secret field — value never logged | GitHub API token |

> **Note:** The schema validates format and structure. Runtime SSRF blocking, StrKey checksum validation, and secret redaction are enforced by the action itself regardless of schema validation.

---

## Keeping the schema in sync with `action.yml`

A test in `__tests__/schema.test.ts` asserts that every input declared in `action.yml` has a corresponding property in the schema. Run it as part of your normal test suite:

```bash
npm test -- --testPathPattern schema
```

The CI workflow also runs this check on every push and pull request via the standard `build-and-test` job.

### Sync process

When adding a new input to `action.yml`:

1. Add the input to `action.yml` as normal.
2. Add a corresponding property to `schemas/action-inputs.schema.json` with at minimum:
   - `type`
   - `description` (copy from `action.yml`)
   - `default` (must match `action.yml`)
   - Format/pattern constraints for URL, address, or numeric fields.
3. Run `npm test` — the schema sync test will fail if any `action.yml` input is missing from the schema.
4. Update `docs/SCHEMA.md` if the field has security implications.

> The schema lives alongside the action rather than being auto-generated so that human-readable descriptions, examples, and security annotations can be maintained deliberately.

---

## Orphan detection and schema sync rules

`__tests__/action-schema-sync.test.ts` enforces strict bidirectional sync between `action.yml` and `schemas/action-inputs.schema.json`. The test **fails CI** when any of these invariants is violated:

| Invariant | What causes a failure |
|-----------|----------------------|
| **No missing inputs** | An `action.yml` input has no matching `properties` entry in the schema |
| **No orphaned properties** | A schema `properties` entry has no matching `action.yml` input |
| **Required alignment** | A `required: true` input in `action.yml` is absent from schema `required[]`, or vice-versa |
| **Type consistency** | All schema properties must use `type: "string"` (GitHub Actions passes every input as a string at runtime) |
| **Count parity** | The number of schema properties must equal the number of `action.yml` inputs |
| **No ghost inputs** | Every `core.getInput('key')` call in `src/index.ts` must correspond to a declared `action.yml` input |

### Fixing orphaned or missing inputs

The **only** way to green the `action-schema-sync` test after a sync failure is to resolve the mismatch:

- **Input in `action.yml` missing from schema** → add it to `schemas/action-inputs.schema.json` `properties`.
- **Schema property not in `action.yml`** (orphan) → either add the input to `action.yml` or remove the property from the schema.
- **`required[]` mismatch** → align `required: true/false` in `action.yml` with the `required[]` array in the schema.

There is no suppression mechanism for sync failures — they must be fixed before a PR can merge.

---

## Output schema validation (Issue #969)

`src/outputs.ts` validates every JSON-encoded output before any
`core.setOutput` call. The schemas are declared in
`STRUCTURED_OUTPUT_SCHEMAS` and compiled with Ajv (`allErrors: true`); scalar
outputs remain plain strings and are covered by the `action.yml` output
contract.

| Output | Expected JSON shape |
|--------|---------------------|
| `checks_json` | Array of `{ label: string, passed: boolean, detail: string }` |
| `timings_json` | Object with the five numeric phase timings (`input_parse_ms`, `horizon_fetch_ms`, `checks_ms`, `comment_post_ms`, `total_ms`) |
| `assignee_results_json` | Map of GitHub login → `{ ready, stellar_address, xlm_balance, account_funded, trustline_exists, reason_code, validated_at }` |
| `matrix_ready_map` | Map of GitHub login → boolean |
| `conflict_report` | `""` when absent, otherwise `{ hasConflicts, conflicts[], generatedAt }` |
| `assets_trustline_status` | Array of `{ asset_code, asset_issuer, trustline_exists, balance }` |
| `batch_summary_json` | `""` in single-address mode, otherwise the `BatchSummary` object (`total`, `passed`, `failed`, `failures[]`, `failureTaxonomy`, `clawbackStrictFailures`, `clawbackStrictMode`, optional `fatal`/`fatalReasonCodes`) |

Validation is all-or-nothing: `setValidationOutputs()` builds the complete
output set, calls `validateActionOutputs()`, and only then publishes it. A
failure throws `ActionOutputSchemaError` with one message per violation, for
example:

```text
Invalid action output — $.checks_json[0].passed: must be boolean
```

Path segments use `$.outputName[arrayIndex].property` syntax, and missing
required properties point at the missing field. Batch mode and the milestone
skip path validate their JSON outputs explicitly before publishing them, so no
`fromJSON()` consumer sees a half-written output set. No new output name or
reason code is introduced by this guard; `__tests__/output-schema-validation.test.ts`
covers the happy path plus malformed JSON, wrong-typed nested values, missing
required fields, and empty-string sentinels.

---

## Webhook and reason-code versioning policy

Two machine-readable contracts besides the input schema are consumed by Wave
dashboards and integrators. Both carry an explicit version, and both follow the
same compatibility rules. The full classification of breaking vs. additive
changes lives in [`docs/BREAKING_CHANGES.md`](BREAKING_CHANGES.md).

| Contract | Schema file | Version field | Current version | Runtime source |
|----------|-------------|---------------|-----------------|----------------|
| Webhook payload | `schemas/webhook-payload.schema.json` | `schema_version` (body) and `X-TrustBridge-Schema-Version` (header) | `1` | `WEBHOOK_SCHEMA_VERSION` in `src/webhook.ts` |
| Reason codes | `schemas/reason-codes.json` | top-level `version`; per-code `since` | `1` | `src/checks.ts` |

The JSON catalog has a compile-time mirror at [`src/reasonCodes.ts`](../src/reasonCodes.ts): the `ReasonCode` union type and `REASON_CODES` tuple. `ValidationResult.reasonCode` (`src/checks.ts`) is typed `ReasonCode`, so a check branch that returns a code outside this union fails `tsc` before it can reach CI or a Wave dashboard. `__tests__/reason-codes-exhaustiveness.test.ts` asserts the union and the JSON catalog list the exact same codes.

### Compatibility rules

- **Additive (any minor/patch release, no version bump):** new optional
  webhook fields, new `result.checks[]` items, new reason codes. Every new
  reason code records the release that introduced it in `since`.
- **Breaking (MAJOR release and version bump):** removing, renaming or
  retyping a frozen webhook field; removing or renaming a reason code;
  changing the meaning of an existing reason code.
- **Version bump procedure:** publish the new schema alongside the old one
  (e.g. `schemas/webhook-payload-v2.schema.json`), bump
  `WEBHOOK_SCHEMA_VERSION` / the catalog `version`, add an entry to
  `docs/BREAKING_CHANGES.md`, and keep emitting the previous version for at
  least one deprecation window.

### Webhook body size cap (Issue #894)

Outbound webhook bodies are capped at **900 000 UTF-8 bytes**
(`WEBHOOK_MAX_BODY_BYTES` in `src/webhook.ts`). Oversized payloads are
truncated deterministically — trailing `assets[]` entries first, then trailing
`result.checks[]` entries — and marked with `truncated: true` plus a
`dropped_fields` list (`"assets"` and/or `"result.checks"`, in drop order).

Both marker keys are **optional and additive** under `schema_version: "1"`; an
untruncated payload omits them and stays byte-for-byte the frozen v1 shape.
They are declared in `schemas/webhook-payload.schema.json` and mirrored by
`WEBHOOK_PAYLOAD_OPTIONAL_FIELDS` / `WEBHOOK_TRUNCATABLE_FIELDS` in
`src/webhook.ts`.

Two stable reason codes are reported on the delivery result
(`WebhookDeliveryResult.reason`):

| Reason code | Delivery | Meaning |
|-------------|----------|---------|
| `WEBHOOK_PAYLOAD_TRUNCATED` | sent | A truncated body was delivered. |
| `WEBHOOK_SIZE_LIMIT_EXCEEDED` | refused | The body cannot be reduced below the cap; nothing was sent (fail closed). |

Because the marker keys are additive, no `schema_version` bump is required. See
the receiver-facing reference in
[`docs/USAGE.md`](USAGE.md#body-size-cap-and-truncation-markers-issue-894).

### Integrator guidance

- Route on `X-TrustBridge-Schema-Version` (or `schema_version`) and reject or
  quarantine versions you do not recognise; `validateWebhookPayload` in
  `src/webhook.ts` rejects any `schema_version` other than the current one.
- Ignore unknown fields and unknown reason codes rather than failing.

### Enforcement

`__tests__/schema-versioning-policy.test.ts` fails CI when the version in
this table drifts from `WEBHOOK_SCHEMA_VERSION`, the webhook schema `enum`,
or the reason-code catalog `version`, or when a reason code is missing
`since`.

---

## SARIF result fingerprints (Issue #893)

GitHub code scanning matches SARIF findings across runs by their
`partialFingerprints`, not by rule id alone. An unstable fingerprint makes
code scanning open a new alert every time wording or account data moves, which
pollutes the code-scanning history Wave orgs use as a payout-readiness gate.
Every result TrustBridge emits therefore carries one stable fingerprint key:

| Property | Value |
|----------|-------|
| Fingerprint key | `trustbridge/v1` (exported as `SARIF_FINGERPRINT_KEY`) |
| Algorithm | SHA-256 over the NUL-joined identity inputs, UTF-8, truncated to the first 32 hex characters |
| Runtime source | [`src/sarif.ts`](../src/sarif.ts) — `computeSarifFingerprint` / `sarifPartialFingerprints` |

The `v1` suffix versions the algorithm. Any change to the inputs below must be
released with a new key (`trustbridge/v2`), so code scanning treats the new
values as a fresh result identity rather than matching them against values
computed from the old inputs.

### Fingerprint inputs

The fingerprint is a deterministic hash of exactly these `SarifFingerprintInputs`
fields, in this order, joined by `\u0000` (so `a` + `bc` cannot collide with
`ab` + `c`):

| Input | Meaning |
|-------|---------|
| `ruleId` | Stable TB### rule id. See the SARIF rule reference in [`docs/USAGE.md`](USAGE.md#sarif-rule-reference). |
| `checkLabel` | Stable check label, also carried in `result.properties.checkLabel`. |
| `assetCode` | Configured asset code; part of what is being checked. |
| `reasonCode` | Effective run reason code — the explicit `ValidationResult.reasonCode`, or `SUCCESS` / `FAILED` when none is set (`sarifRunReasonCode`). |

Everything that changes between runs without the finding itself changing is
**deliberately excluded**: the result message text (which embeds addresses,
balances and home-domain values), the account address, the Horizon URL, the run
timestamp and the tool version.

### Stability and sensitivity contract

- **Stable across message changes.** Editing a check's wording, an account
  balance, the Horizon URL or the tool version leaves every fingerprint
  unchanged as long as `reason_code` is unchanged.
- **Moves on `reason_code` changes.** Renaming or changing a `reason_code`
  changes every fingerprint that carries it, so code scanning opens a new
  result instead of silently re-labelling the old one.
- **Deterministic and idempotent.** The same inputs yield the same value on
  every runner and across repeated builds of an identical result.
- **Two results never collide.** Two findings under the same rule id (for
  example TB002 for two different checks) stay distinct because `checkLabel`
  and `assetCode` are part of the hash.

### Enforcement

`__tests__/sarif-fingerprint.test.ts` locks the documented algorithm with
golden values in `__tests__/__golden__/sarif-fingerprints.json`: a change to
the inputs, the separator, the hash or the truncation fails CI until the golden
file and this section are updated together. The same suite asserts the
stability and sensitivity contract above and that every emitted
`partialFingerprints` bag stays SARIF 2.1.0 schema-valid
(`schemas/sarif-schema-2.1.0.json`, Issue #679).

Run it with:

```
npx jest __tests__/sarif-fingerprint.test.ts
```
