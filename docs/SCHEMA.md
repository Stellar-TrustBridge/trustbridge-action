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
