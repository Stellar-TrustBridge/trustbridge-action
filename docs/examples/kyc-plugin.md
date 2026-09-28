# KYC plugin - hardened reference example

> **This is consumer logic, not a built-in check.**
> TrustBridge's core checks (account funded, trustline, XLM reserve, SEP-0001 home domain)
> always run via `runAccountChecks`. The KYC plugin is an optional extension
> you register only when your program requires identity verification before
> payout. KYC is never enforced by default.

Frozen contract:
- Workspace path: `plugins/kyc.ts`
- Environment variable: `KYC_API_KEY`
- Action input: `trustbridge_plugins_path: plugins/kyc.ts`

Related docs: [Plugin Architecture](../PLUGIN_ARCHITECTURE.md) · [Usage](../USAGE.md) · [README](../../README.md)

---

## What this example provides

`docs/examples/kyc-plugin.ts` is a hardened, copy-paste-safe starting point for
adding a KYC gate to a TrustBridge-powered wave program. Copy it into
`plugins/kyc.ts` and keep the workspace-relative layout frozen. It demonstrates:

- How to call an external KYC provider without logging PII.
- How to surface pass/fail status in the issue comment without embedding secrets.
- How to escape every dynamic value with `escapeMarkdownInline()` / `inlineCode()`.
- How to keep the plugin optional so it never runs unless explicitly registered.

---

## Safety rules

Read these before modifying the example.

### 1. No PII in logs

Never pass names, email addresses, national IDs, dates of birth, or any other
personally identifying information to `core.info()`, `core.debug()`, or
`core.warning()`. Log only:

- The boolean outcome (`status: approved | pending | rejected | not_found`).
- A pseudonymous reference token, such as a UUID or hash with no PII content.

```ts
// Safe - logs only status and a pseudonymous token
core.info(`[kyc-plugin] KYC status=${kycStatus.status} ref=${kycStatus.referenceToken}`);

// Unsafe - logs PII
core.info(`[kyc-plugin] KYC failed for ${contributorName} (${email})`);
```

### 2. No secrets in comment output

The `detail` and `remediation` strings land verbatim in a public GitHub issue
comment. Never embed:

- API keys or tokens
- Internal user IDs
- Rejection reasons that may reveal PII from the provider response

```ts
// Safe - public reference token only
detail: `KYC verification approved for \`GADDR...\` (ref: \`abc-123\`).`

// Unsafe - embeds a secret or internal ID
detail: `KYC approved. API key used: sk_live_...`
```

### 3. Escape all dynamic values

Any string that comes from outside this file - a Stellar address, a provider
response, a config value - must be escaped before embedding in `detail` or
`remediation`.

```ts
import { escapeMarkdownInline, inlineCode } from '../../src/markdown';

const safeAddress = inlineCode(ctx.stellarAddress);
const safeUrl = escapeMarkdownInline(kycUrl);
```

### 4. No eval / no untrusted dynamic import

Do not evaluate strings from the KYC response as code. Do not `import()` paths
that contain provider-supplied data, issue-body text, or any other untrusted
input.

TrustBridge itself loads plugins with a dynamic `import()` in
`src/pluginLoader.ts`, but only for **trusted repository files** that are on the
allowlist and live under the workspace root. See
[Plugin Architecture > Security model](../PLUGIN_ARCHITECTURE.md#security-model)
for the full threat model. Your plugin code must not widen that surface by
importing untrusted paths.

### 5. Fixed KYC URL only

The `kycUrl` option must be a known, hardcoded URL set by maintainers.
Never construct it from issue body text, comment content, or provider data.

---

## Plugin interface

The plugin is created via a factory function so `lookupFn` can be injected in
tests without live API calls:

```ts
import { createKycPlugin } from './docs/examples/kyc-plugin';

const kycPlugin = createKycPlugin({
  lookupFn: myRealKycProvider,
  apiKey: process.env.KYC_API_KEY ?? '',
  kycUrl: 'https://kyc.example.com',
});
```

### `KycLookupFn`

Your provider integration must match this signature:

```ts
type KycLookupFn = (stellarAddress: string, apiKey: string) => KycStatus;
```

- Receives only the G-address and the API key - never PII from the issue body.
- Must be synchronous in v1 because the plugin runner does not await plugins.
- Should throw on provider errors; the plugin catches and returns a safe failure.

### `KycStatus`

```ts
interface KycStatus {
  status: 'approved' | 'pending' | 'rejected' | 'not_found';
  referenceToken?: string;
}
```

---

## Comment output layout

When registered, the KYC plugin adds one row to the comment results table.
Examples:

| Status | Comment row |
|--------|-------------|
| `approved` | `KYC verification approved for \`GADDR...\` (ref: \`abc-123\`).` |
| `pending` | `KYC verification is in progress for \`GADDR...\`.` |
| `rejected` | `KYC verification was not approved for \`GADDR...\`.` |
| `not_found` | `No KYC record found for \`GADDR...\`.` |

Failed rows produce a remediation entry pointing contributors to your KYC portal.
The URL is escaped and hardcoded, so it never contains PII.

---

## Workflow integration

### 1. Store your KYC API key as a secret

In your repository: **Settings** > **Secrets and variables** > **Actions** > **New repository secret**

- Name: `KYC_API_KEY`
- Value: your provider API key

### 2. Add the plugin to the workspace

Place the file at:

```text
plugins/kyc.ts
```

### 3. Add a KYC check step before TrustBridge

```yaml
name: Verify Stellar wallet + KYC on assignment

on:
  issues:
    types: [assigned]

jobs:
  trustbridge-kyc:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      contents: read
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2

      - name: Set up Node
        uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Run TrustBridge + KYC check
        uses: Stellar-TrustBridge/trustbridge-action@c0f10f03bcd5c13f25cd38eb7a57c6f3a1e4f3db # v1
        with:
          stellar_address_input: ${{ steps.addr.outputs.value }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          trustbridge_plugins_path: plugins/kyc.ts
        env:
          KYC_API_KEY: ${{ secrets.KYC_API_KEY }}
```

> **Note:** The reference plugin reads `apiKey` from `process.env.KYC_API_KEY`.
> TrustBridge only loads plugins from the workspace when
> `trustbridge_plugins_path: plugins/kyc.ts` is set. The loader resolves the
> path against the workspace root, checks it against the allowlist, and
> validates the exported plugin shape before running it - see
> [Plugin Architecture > Security model](../PLUGIN_ARCHITECTURE.md#security-model).

### 4. Consuming the KYC plugin in your custom action wrapper

If you fork TrustBridge or build a wrapper action:

```ts
import * as core from '@actions/core';
import { createKycPlugin } from './docs/examples/kyc-plugin';
import { PluginRegistry } from './src/plugin';
import { corePlugins } from './src/corePlugins';
import { runPlugins } from './src/pluginRunner';

const apiKey = process.env.KYC_API_KEY ?? '';
if (!apiKey) {
  core.warning('[kyc-plugin] KYC_API_KEY is not set - skipping KYC check.');
}

const registry = new PluginRegistry();
corePlugins.forEach((p) => registry.register(p));

if (apiKey) {
  registry.register(
    createKycPlugin({
      lookupFn: myKycProvider,
      apiKey,
      kycUrl: 'https://kyc.example.com',
    }),
  );
}

const result = runPlugins(ctx, registry);
```

---

## Testing the plugin

The test suite at `__tests__/kyc-plugin-example.test.ts` covers:

- Pass path: `lookupFn` returns `approved` -> `passed: true`, no PII in output.
- Fail paths: `pending`, `rejected`, `not_found` -> `passed: false`, remediation present.
- Provider error: `lookupFn` throws -> safe failure, no key in output.
- Escape hardening: Markdown-injectable values in `referenceToken` and `kycUrl` are escaped.
- No-secret check: `apiKey` never appears in `detail` or `remediation`.
- Optional behaviour: plugin absent from registry -> core checks unaffected.

Run with:

```bash
npm test -- --testPathPattern kyc-plugin-example
```

---

## What this example does NOT do

- It does not implement a real KYC provider integration (`myKycProvider` is a stub).
- It does not store, cache, or persist any KYC data.
- It does not make network requests on its own - your `lookupFn` does.
- It does not modify the core TrustBridge checks.
- It is not enforced by default - you opt in by registering it.

---

[<- Plugin Architecture](../PLUGIN_ARCHITECTURE.md) · [<- Usage](../USAGE.md) · [<- README](../../README.md)
