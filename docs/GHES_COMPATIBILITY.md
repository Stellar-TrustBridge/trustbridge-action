# GHES Compatibility Matrix

> **Status:** Best-effort. TrustBridge is not tested against a live GHES instance in CI.
> The matrix below reflects what the code path supports and what has been verified via mocked-API-base tests.

## API Feature Matrix

| Feature | github.com | GHES 3.x | GHES 4.x | Notes |
|---------|:----------:|:--------:|:--------:|-------|
| **Issue Comments** (post / update / sticky) | ✅ | ✅ | ✅ | Uses `GITHUB_API_URL` for Octokit `baseUrl`. Core Issues API endpoints present since early GHES. |
| **Pull Request Comments** | ✅ | ✅ | ✅ | PRs are issues under the hood; same REST path. |
| **Discussion Comments** (GraphQL) | ✅ | ✅ | ✅ | Uses `GITHUB_GRAPHQL_URL`. Requires `discussions: write` permission. |
| **Checks API** (`use_check_runs`) | ✅ | ✅ | ✅ | Same `@actions/github` Octokit client. Requires `checks: write` permission. Fail-open on 403. See [USAGE.md — GitHub Checks API](USAGE.md#github-checks-api-for-required-status-gates). |
| **OIDC Federation** (`webhook_auth_mode: oidc`) | ✅ | ⚠️ | ⚠️ | Requires GHES OIDC provider support (GHES 3.8+). Issuer differs from github.com — see the [OIDC webhook matrix](#oidc-webhook-authentication-matrix-issue-677). |
| **SARIF Output** (`sarif_output_path`) | ✅ | ✅ | ✅ | File write only; no API calls. |
| **Artifact Upload** (`actions/upload-artifact`) | ✅ | ✅ | ✅ | Uses standard Actions artifact API. Works identically on GHES self-hosted runners. |
| **Artifacts API** (auto-discover previous) | ✅ | ✅ | ✅ | `GET /repos/{owner}/{repo}/actions/runs/{id}/artifacts`. Standard REST endpoint. |
| **GitHub Projects v2** (`project_id`) | ✅ | ⚠️ | ⚠️ | Projects v2 availability depends on GHES version. Check your instance's Projects support. |
| **Webhook Delivery** (`webhook_url`) | ✅ | ✅ | ✅ | Standard HTTPS POST. Ensure network egress from runner to webhook endpoint. |
| **Stellar Horizon API** | ✅ | ✅ | ✅ | Not a GitHub API — requires network egress from GHES runner to `horizon.stellar.org`. |
| **Corporate Proxy Support** | ✅ | ✅ | ✅ | Reads `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`. See [Proxy configuration](#proxy-configuration-issue-451) below. |

### Legend

- ✅ — Supported and verified (mocked tests or standard API)
- ⚠️ — Supported in principle but depends on GHES version or configuration
- ❌ — Not supported or known incompatible

## Comment Size Limits

| Environment | Max Comment Body (bytes) | TrustBridge Constant | Behavior |
|-------------|:------------------------:|:--------------------:|----------|
| github.com | 65,536 | `COMMENT_SIZE_LIMIT_BYTES` | Truncation with report file fallback |
| GHES 3.x | 65,536 (default) | `COMMENT_SIZE_LIMIT_BYTES` | Same as github.com unless admin changed limits |
| GHES 4.x | 65,536 (default) | `COMMENT_SIZE_LIMIT_BYTES` | Same as github.com unless admin changed limits |

**GHES-specific consideration:** Some GHES administrators configure custom comment size limits. If your instance uses a smaller limit, set `COMMENT_SIZE_LIMIT_BYTES` via a wrapper or contact your GHES admin. TrustBridge's truncation logic (`buildTruncatedCommentBody`) automatically handles any body exceeding the configured limit.

## Checks API Annotation Limits

| Environment | Max Annotations per Request | TrustBridge Behavior |
|-------------|:---------------------------:|----------------------|
| github.com | 50 | Truncates to first 50 checks |
| GHES 3.x | 50 | Same as github.com |
| GHES 4.x | 50 | Same as github.com |

## Permissions Matrix

| Feature | Required Permissions | Notes |
|---------|---------------------|-------|
| Issue Comments | `issues: write` | Standard across all environments |
| Discussion Comments | `discussions: write` | GraphQL endpoint; same permission model |
| Check Runs | `checks: write` | Fail-open on 403; validation continues |
| OIDC Webhook | `id-token: write` | Only when `webhook_auth_mode: oidc`; see the [OIDC webhook matrix](#oidc-webhook-authentication-matrix-issue-677) |
| Artifact Upload | `actions: write` (or repository default) | Standard Actions permissions |
| Projects v2 | `project` or `write:org` | Depends on GHES Projects support |

## OIDC Webhook Authentication Matrix (Issue #677)

With `webhook_auth_mode: oidc`, TrustBridge calls `core.getIDToken(webhook_oidc_audience)` and sends the token to your dashboard receiver as `Authorization: Bearer <token>` (no `X-TrustBridge-Signature` header). TrustBridge never validates the token itself; your receiver does. That makes the **issuer** and **JWKS location** the main differences between github.com and GHES. For setup and the receiver contract, see [USAGE.md — OIDC Federation for Dashboard Webhooks](USAGE.md#oidc-federation-for-dashboard-webhooks-issue-224).

> **Unsupported: GHES releases older than 3.8.** TrustBridge does not support OIDC webhook authentication there. Without a usable OIDC provider, `core.getIDToken` fails, TrustBridge logs `OIDC token minting failed … Ensure the workflow has 'permissions: id-token: write'`, and the webhook is sent **without** an `Authorization` header (the run itself does not fail). Use `webhook_auth_mode: hmac` with `webhook_secret` on those instances.

`HOSTNAME` below is your GHES host, i.e. `GITHUB_SERVER_URL` without the scheme. The first column holds stable row keys that `__tests__/ghes-oidc-matrix.test.ts` checks against the constants in `src/webhook.ts` and the inputs in `action.yml`. Update the code, this table, and the test together.

<!-- GHES_OIDC_MATRIX_BEGIN -->
| Key | Aspect | github.com | GHES 3.8+ | GHES < 3.8 | Permissions | Notes |
|-----|--------|------------|-----------|------------|-------------|-------|
| `token-minting` | Token minting (`core.getIDToken`) | ✅ Supported | ✅ Supported | ❌ Unsupported — use HMAC | `id-token: write` | Failure is a non-fatal warning; the webhook is sent without `Authorization`. |
| `permission` | Job permission | ✅ `id-token: write` | ✅ `id-token: write` | ❌ Unsupported | `id-token: write` | Any explicit `permissions:` block drops unlisted scopes, so list `id-token: write` explicitly. |
| `runtime-env` | Runner request variables | ✅ `ACTIONS_ID_TOKEN_REQUEST_URL`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN` | ✅ `ACTIONS_ID_TOKEN_REQUEST_URL`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN` | ❌ Unsupported | `id-token: write` | Set by the runner only when the job has `id-token: write`. TrustBridge never reads or logs them directly. |
| `issuer` | Issuer (`iss` claim) | ✅ `https://token.actions.githubusercontent.com` | ✅ `https://HOSTNAME/_services/token` | ❌ Unsupported | `id-token: write` | Receivers configured only for the github.com issuer reject GHES tokens. `resolveOidcIssuer()` derives the value from `GITHUB_SERVER_URL`. |
| `jwks-discovery` | Discovery / JWKS | ✅ `https://token.actions.githubusercontent.com/.well-known/openid-configuration` | ✅ `https://HOSTNAME/_services/token/.well-known/openid-configuration` | ❌ Unsupported | None | The receiver fetches signing keys from here, so it needs network access to the GHES host. |
| `audience` | Audience (`aud` claim) | ✅ `webhook_oidc_audience`, default `trustbridge-dashboard` | ✅ `webhook_oidc_audience`, default `trustbridge-dashboard` | ❌ Unsupported | `id-token: write` | Must exactly match the audience the receiver accepts. TrustBridge always passes an explicit audience, so GHES's default audience never applies. |
| `fork-pull-request` | Fork `pull_request` runs | ❌ No token issued | ❌ No token issued | ❌ Unsupported | `id-token: write` (not granted to forks) | Use HMAC mode for fork-triggered workflows, or run from a trusted event such as `issues` or `issue_comment`. |
| `runner-type` | Runner type | ✅ GitHub-hosted or self-hosted | ⚠️ Self-hosted only | ❌ Unsupported | None | GHES has no GitHub-hosted runners. Replace `runs-on: ubuntu-latest` in the USAGE examples with your self-hosted labels. |
| `air-gapped` | Air-gapped receivers | ⚠️ Receiver needs internet egress to fetch JWKS | ⚠️ Receiver must reach `HOSTNAME`, or cache the JWKS | ❌ Unsupported | None | TrustBridge cannot validate tokens against a live provider on your behalf. Offline receivers must pre-load and rotate the JWKS themselves. |
| `hmac-fallback` | HMAC mode (`webhook_auth_mode: hmac`) | ✅ Supported | ✅ Supported | ✅ Supported | None | Default mode. No OIDC provider or `id-token` permission needed. Works on every GHES version. |
<!-- GHES_OIDC_MATRIX_END -->

### Version skew notes

- GHES feature releases can lag behind github.com OIDC changes (for example new custom claims or issuer customisation). TrustBridge only depends on the standard claims listed in [USAGE.md — OIDC Claims & Dashboard Verification Contract](USAGE.md#oidc-claims--dashboard-verification-contract): `iss`, `aud`, `repository`, `repository_owner`, `workflow`, `actor`.
- On github.com, an enterprise can customise the issuer (`https://token.actions.githubusercontent.com/<enterprise>`). If you do, configure the receiver for that issuer. TrustBridge does not change the token.
- These matrix rows were checked against code constants and GitHub's published GHES OIDC documentation, not against a live GHES instance (see the status note at the top).

## Proxy Configuration (Issue #451)

GHES self-hosted runners behind a corporate proxy require standard proxy environment variables to be set so TrustBridge can reach both the GitHub API and the Stellar Horizon API.

### Required environment variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `HTTPS_PROXY` | Proxy URL for all HTTPS requests (preferred) | `http://proxy.corp:8080` |
| `HTTP_PROXY` | Fallback proxy URL when `HTTPS_PROXY` is unset | `http://proxy.corp:8080` |
| `NO_PROXY` | Comma-separated bypass list (see below) | `ghes.corp.example.com,.corp.local` |

> **Note:** `https_proxy` (lowercase) and `http_proxy` (lowercase) are also honoured. Uppercase takes precedence.

### Bypass list (`NO_PROXY`) patterns

TrustBridge evaluates `NO_PROXY` entries using the following matching rules (case-insensitive):

| Pattern | Matches | Example |
|---------|---------|---------|
| `*` | All hostnames (bypass proxy entirely) | `NO_PROXY=*` |
| `exact.hostname.com` | Exact hostname only | `ghes.corp.example.com` |
| `.corp.local` | Any subdomain of `corp.local` (leading dot) | `.corp.local` → `api.corp.local`, `horizon.corp.local` |
| `corp.local` | Any subdomain of `corp.local` (no dot required) | `corp.local` → `api.corp.local` |

#### Typical GHES + Horizon setup

```yaml
# workflow.yml
env:
  HTTPS_PROXY: http://proxy.corp:8080
  NO_PROXY: ghes.corp.example.com,api.corp.example.com,.corp.internal
```

With this configuration:
- Requests to your GHES instance (`ghes.corp.example.com`, `api.corp.example.com`) bypass the proxy (direct connection).
- Requests to `horizon.stellar.org` go through the corporate proxy.
- Any internal Horizon mirror at `*.corp.internal` also bypasses the proxy.

### Invalid proxy URL soft-fail

If `HTTPS_PROXY` / `HTTP_PROXY` contains a malformed URL, TrustBridge logs a warning and falls back to a **direct connection** rather than hard-failing the run. The action continues to operate without a proxy agent; an operator alert is emitted so the configuration issue can be corrected without breaking CI.

### Security notes

- Proxy URLs containing `username:password` userinfo are **redacted** in logs — the password is never written to GitHub Actions output.
- SSRF protections (private IP blocklist, `horizon_url_allowlist`) remain **fully active** when a proxy is configured. The proxy only handles transport; the SSRF guard runs before any request is dispatched.
- TrustBridge does **not** support `CONNECT` tunnelling to non-HTTPS endpoints. Only HTTPS Horizon and GitHub API requests are proxied.

## Known GHES Limitations

1. **No GitHub-hosted runners:** All GHES workflows must use self-hosted runners.
2. **OIDC provider:** TrustBridge supports `webhook_auth_mode: oidc` on GHES 3.8 and later. On older releases use HMAC mode. See the [OIDC webhook matrix](#oidc-webhook-authentication-matrix-issue-677).
3. **Projects v2:** May not be available on older GHES instances.
4. **Network egress:** GHES runners are often on restricted networks. Ensure access to:
   - `horizon.stellar.org` (or your configured `horizon_url`) — may require proxy configuration (see above).
   - Your GHES instance's API and GraphQL endpoints — typically bypassed via `NO_PROXY`.
5. **Custom API limits:** GHES admins can configure custom rate limits, comment size limits, and annotation caps that differ from github.com defaults.

## Verification Without a Live GHES Instance

See [USAGE.md — Verification checklist](USAGE.md#verification-checklist-no-live-ghes-instance-required) for steps to validate TrustBridge on your GHES org.
