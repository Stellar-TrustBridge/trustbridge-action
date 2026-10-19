# Mock Horizon — local development server

A lightweight [WireMock](https://wiremock.org) container that serves deterministic,
offline Horizon API responses so contributors can develop and test TrustBridge
without hitting the public Stellar Horizon API or consuming rate-limit quota.

---

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine + Compose v2)
- Node.js 20+ and `npm ci` already run in the repo root

---

## Quick start

```bash
# 1. From the repository root, start the mock server
npm run mock:start
# → Mock Horizon is now listening on http://localhost:8089

# 2. Run the smoke tests against the mock
npm run test:mock

# 3. Stop the mock server when done
npm run mock:stop
```

Or point any local run at the mock directly:

```bash
HORIZON_MOCK_URL=http://localhost:8089 npm run test:mock
```

---

## What is served

The stubs in `mock/horizon/mappings/` cover the four most important scenarios:

| Address (56-char) | Stub file | Scenario |
|---|---|---|
| `GAAA...AWHF` | `account-funded.json` | Funded, USDC trustline present, 10 XLM balance |
| `GBBB...BBBB` | `account-unfunded.json` | 404 — account not yet funded |
| `GCCC...CCCC` | `account-low-balance.json` | Funded, USDC trustline, but only 0.5 XLM |
| `GDDD...DDDD` | `account-no-trustline.json` | Funded, 10 XLM, but no USDC trustline |
| `GEEE...EEEE` | `rate-limited.json` | 429 Too Many Requests with `Retry-After: 1` |
| `GFFF...FFFF` | `error-503.json` | 503 Service Unavailable |
| `GGGG...GGGG` | `error-502.json` | 502 Bad Gateway |
| `GHHH...HHHH` | `failover-scenario*.json` | 503 then 200 on retry (Failover) |
| _(root)_ `/` | `health.json` | Horizon root metadata probe |

Any address not matched by a stub returns WireMock's built-in 404 for
unmatched requests — useful for testing the unfunded path with arbitrary addresses.

---

## Adding new stubs

1. Create a new JSON file in `mock/horizon/mappings/`.
2. Follow the WireMock [stub mapping format](https://wiremock.org/docs/stubbing/).
3. Restart the container: `docker compose -f mock/horizon/docker-compose.yml restart`

Minimal stub template:

```json
{
  "id": "my-new-stub",
  "name": "Describe what this stub simulates",
  "request": {
    "method": "GET",
    "urlPathPattern": "/accounts/G<YOUR_56_CHAR_ADDRESS>"
  },
  "response": {
    "status": 200,
    "headers": { "Content-Type": "application/json" },
    "jsonBody": { }
  }
}
```

---

## Pointing `horizon_url` at the mock

### In unit / integration tests

Set the `HORIZON_MOCK_URL` environment variable before running Jest:

```bash
HORIZON_MOCK_URL=http://localhost:8089 npx jest --testPathPattern horizon-mock-smoke
```

The smoke test (`__tests__/horizon-mock-smoke.test.ts`) checks for this variable
and skips automatically when it is absent — so the standard `npm test` pipeline
is never affected.

### In a local workflow run (act)

```yaml
# In your workflow step
with:
  horizon_url: http://localhost:8089
  stellar_address_input: GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF
```

If you use [`act`](https://github.com/nektos/act) to run workflows locally,
start the mock first (`npm run mock:start`) and point `horizon_url` at `http://localhost:8089`.

### In the opt-in CI job

The `.github/workflows/ci.yml` file includes an optional `mock-horizon-smoke`
job (disabled by default via `if: false`). Remove or change that condition to
run the smoke tests in CI with the mock container:

```yaml
# In ci.yml — change this to enable the mock Horizon CI job:
if: false  # change to: github.event_name == 'workflow_dispatch'
```

---

## Container management

| Command | Effect |
|---------|--------|
| `npm run mock:start` | Start mock in background (`docker compose up -d`) |
| `npm run mock:stop` | Stop and remove the container (`docker compose down`) |
| `docker compose -f mock/horizon/docker-compose.yml logs` | View WireMock request logs |
| `curl http://localhost:8089/__admin/requests` | Inspect all received requests (JSON) |
| `curl http://localhost:8089/__admin/mappings` | List all active stub mappings |
| `curl -X POST http://localhost:8089/__admin/reset` | Reset request journal |

---

## Troubleshooting

**Port 8089 is already in use**

Change the host port in `docker-compose.yml`:

```yaml
ports:
  - "8090:8080"   # use 8090 instead
```

Then set `HORIZON_MOCK_URL=http://localhost:8090`.

**Container fails health check**

```bash
docker compose -f mock/horizon/docker-compose.yml logs mock-horizon
```

WireMock takes ~5 s to start. If the healthcheck times out, increase
`start_period` in `docker-compose.yml`.

**WireMock returns 404 for an address I added**

Make sure the `urlPathPattern` in your stub exactly matches `/accounts/<address>`
(no trailing slash, correct case). Restart after editing:

```bash
docker compose -f mock/horizon/docker-compose.yml restart
```

---

## Design notes

- **WireMock** was chosen over a custom Node.js server because it is
  a mature, well-documented HTTP mock with built-in admin API, request
  journal, and pattern matching — no custom server code to maintain.
- **Static JSON stubs** keep the mock deterministic and reviewable in PRs.
  Scenarios that need dynamic logic (sequence numbers, timestamps) can use
  WireMock's [response templating](https://wiremock.org/docs/response-templating/).
- The mock is **intentionally not started in default CI** (`npm test`) to keep
  the standard test pipeline fast and dependency-free. Use `npm run test:mock`
  or the opt-in CI job for integration-level coverage.

---

[← Back to CONTRIBUTING.md](../../CONTRIBUTING.md) · [← Back to README](../../README.md)
