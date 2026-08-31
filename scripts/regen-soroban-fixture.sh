#!/usr/bin/env bash
# scripts/regen-soroban-fixture.sh
#
# Documents how to regenerate __tests__/fixtures/soroban/get_address_simulate_result.json
# from the trustbridge-contract repository.
#
# Run this script to VERIFY the process is still current; edit it when the
# contract ABI changes. The fixture itself is checked in and versioned — you
# only need to run through these steps when the contract changes shape.
#
# ────────────────────────────────────────────────────────────────────────────
# PREREQUISITES
#   - Stellar Soroban CLI  (https://soroban.stellar.org/docs/getting-started/setup)
#   - Access to a testnet Soroban RPC endpoint  (https://soroban-testnet.stellar.org)
#   - The deployed trustbridge-contract contract ID on testnet
#
# STEP 1 — Identify the deployed contract ID
# ────────────────────────────────────────────────────────────────────────────
# The contract ID is maintained in the trustbridge-contract repo:
#   https://github.com/Stellar-TrustBridge/trustbridge-contract
#
# Check the contract README or deployments/ directory for the testnet contract ID.
# Example (replace with the real value):
#   CONTRACT_ID="CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM"
#
# STEP 2 — Capture a real simulateTransaction response (registered address)
# ────────────────────────────────────────────────────────────────────────────
# Use soroban CLI to simulate the get_address call for a registered username:
#
#   stellar contract invoke \
#     --network testnet \
#     --id "$CONTRACT_ID" \
#     --fn get_address \
#     -- --github_username alice \
#     --simulate-only \
#     --output json \
#     > /tmp/found_raw.json
#
# The JSON-RPC simulateTransaction request body can also be captured with curl:
#
#   curl -s -X POST https://soroban-testnet.stellar.org \
#     -H 'Content-Type: application/json' \
#     -d '{
#       "jsonrpc": "2.0",
#       "id": 1,
#       "method": "simulateTransaction",
#       "params": {
#         "transaction": "<XDR from buildGetAddressXdr(CONTRACT_ID, \"alice\")>"
#       }
#     }' > /tmp/found_raw.json
#
# STEP 3 — Capture a not_found response (unregistered username)
# ────────────────────────────────────────────────────────────────────────────
# Repeat step 2 with a username that is NOT registered (e.g. "not-registered-user-xyz"):
#
#   curl -s -X POST https://soroban-testnet.stellar.org \
#     -H 'Content-Type: application/json' \
#     -d '{
#       "jsonrpc": "2.0",
#       "id": 3,
#       "method": "simulateTransaction",
#       "params": {
#         "transaction": "<XDR for not-registered-user-xyz>"
#       }
#     }' > /tmp/not_found_raw.json
#
# STEP 4 — Assemble the fixture file
# ────────────────────────────────────────────────────────────────────────────
# Merge the captured responses into the fixture format:
#   __tests__/fixtures/soroban/get_address_simulate_result.json
#
# Key things to preserve:
#   1. Bump _fixture_version (semver) when the ABI or fixture shape changes.
#   2. Redact any real contributor G-addresses — use the canonical test address
#      GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF in "found".
#   3. Keep null_retval, missing_retval, and missing_result scenarios as
#      hand-crafted defensive cases (they don't come from live RPC calls).
#   4. Keep invalid_address_in_retval as a hand-crafted rejection test case.
#
# STEP 5 — Update the version field
# ────────────────────────────────────────────────────────────────────────────
# Edit the fixture and bump _fixture_version:
#   "1.0.0" -> "1.1.0"  (minor: new field or scenario added)
#   "1.0.0" -> "2.0.0"  (major: breaking ABI change in contract)
#
# STEP 6 — Verify
# ────────────────────────────────────────────────────────────────────────────
# Run the soroban compatibility tests locally:
#
#   npm test -- --testPathPattern 'soroban' --no-coverage
#
# All tests must pass before committing the updated fixture.
#
# ────────────────────────────────────────────────────────────────────────────
# FIXTURE VERSION HISTORY
#   1.0.0  Initial fixture — matches get_address(Symbol) -> Option<Address>
#          ABI in trustbridge-contract v0.1.x
# ────────────────────────────────────────────────────────────────────────────

set -euo pipefail

echo "This script documents the fixture regeneration process."
echo "See the inline comments above for the manual steps."
echo ""
echo "To verify the existing fixture is still valid:"
echo "  npm test -- --testPathPattern 'soroban' --no-coverage"
echo ""
echo "Fixture location:"
echo "  __tests__/fixtures/soroban/get_address_simulate_result.json"
