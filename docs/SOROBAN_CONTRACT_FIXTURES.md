# Soroban Contract Fixtures

This document explains the checked-in fixture for Soroban contract compatibility tests
(`__tests__/fixtures/soroban/get_address_simulate_result.json`) introduced in issue #294.

---

## What the fixture is

`get_address_simulate_result.json` is a versioned golden snapshot of the JSON-RPC
`simulateTransaction` response shapes produced by the `trustbridge-contract` on-chain
registry when its `get_address(github_username)` function is invoked.

The fixture covers seven scenarios:

| Scenario | Description |
|----------|-------------|
| `found` | Username registered — returns a Stellar G-address |
| `found_alt_address` | Second registered address (exercises a different valid G-address) |
| `not_found` | Username not registered — returns `void` ScVal (Option::None) |
| `null_retval` | Malformed/legacy response where `retval` is `null` |
| `missing_retval` | Response with no `retval` key in `result` |
| `missing_result` | RPC error response (no `result` field at top level) |
| `invalid_address_in_retval` | `retval.type` is `"address"` but value is not a valid G-address |

The parser (`parseAddressFromSimulateResult` in `src/soroban.ts`) is tested against
every scenario in the CI step `Soroban contract compatibility tests`.

---

## Fixture versioning

The fixture uses semver in the `_fixture_version` field:

| Change | Bump |
|--------|------|
| New scenario added | `minor` (e.g. `1.0.0` → `1.1.0`) |
| Existing scenario shape changed (ABI update) | `major` (e.g. `1.x.x` → `2.0.0`) |
| Typo / comment / description fix | `patch` (e.g. `1.0.0` → `1.0.1`) |

Always bump the version and describe the change in the version history section of
`scripts/regen-soroban-fixture.sh` when updating the fixture.

---

## How to regenerate the fixture from the contract

Run `scripts/regen-soroban-fixture.sh` and follow the inline step-by-step instructions.
The script documents the exact `curl` / `stellar` CLI commands needed to capture live
`simulateTransaction` responses from the testnet Soroban RPC endpoint.

**Quick summary:**

1. Identify the deployed testnet contract ID from the `trustbridge-contract` repo.
2. Capture a `simulateTransaction` response for a **registered** username (found).
3. Capture a response for an **unregistered** username (not_found / void retval).
4. Merge into the fixture JSON, redacting real addresses (use the canonical test address).
5. Bump `_fixture_version`.
6. Run `npm test -- --testPathPattern 'soroban' --no-coverage` to verify.
7. Commit the updated fixture alongside any `parseAddressFromSimulateResult` changes.

---

## CI integration

The `.github/workflows/ci.yml` `build-and-test` job includes a dedicated step:

```yaml
- name: Soroban contract compatibility tests
  run: npm test -- --testPathPattern 'soroban' --no-coverage
```

This step runs on every push and pull request. A change to the contract ABI that
breaks the parser will fail this step before any release tag is created.

---

## Relationship to `src/soroban.ts`

`parseAddressFromSimulateResult` in `src/soroban.ts` is the only consumer of these
fixture shapes. When the `trustbridge-contract` changes its ABI:

1. Update the contract client code in `src/soroban.ts`.
2. Update the fixture with the new response shape.
3. Confirm all fixture compatibility tests pass.

The fixture is intentionally separate from self-made test objects in
`__tests__/soroban.test.ts` so that contract-representative payloads are clearly
distinguished from synthetic test data.
