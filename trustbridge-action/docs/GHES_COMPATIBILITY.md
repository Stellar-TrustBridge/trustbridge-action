# GHES Compatibility

This document describes how the TrustBridge Action behaves on GitHub Enterprise Server (GHES) and what network access a GHES deployment requires.

## Overview

GitHub Enterprise Server runs in a self-hosted environment, which means outbound (egress) network access is often restricted by corporate firewalls, proxies, or air-gapped network policies. The TrustBridge Action and the services it depends on require specific egress endpoints to function correctly.

## Required Egress Endpoints

GHES operators must allowlist the following hosts and ports for the TrustBridge Action to reach Horizon, Friendbot, and federation services.

### Horizon (Stellar Core API)

Horizon is the primary API used to submit transactions, query account state, and stream ledger events.

| Host | Port | Protocol | Purpose |
| --- | --- | --- | --- |
| `horizon.stellar.org` | 443 | HTTPS | Mainnet Horizon API |
| `horizon-testnet.stellar.org` | 443 | HTTPS | Testnet Horizon API |
| `horizon-futurenet.stellar.org` | 443 | HTTPS | Futurenet Horizon API |

If you operate a private Horizon instance, allowlist its hostname and port instead (commonly `443` for HTTPS or `8000` for plain HTTP in internal deployments).

### Friendbot (Testnet funding)

Friendbot funds new testnet accounts. It is only required when running against testnet.

| Host | Port | Protocol | Purpose |
| --- | --- | --- | --- |
| `friendbot.stellar.org` | 443 | HTTPS | Testnet account funding |

### Federation

Federation lookups resolve human-readable addresses (for example `user*example.com`) to Stellar account IDs. Federation servers are discovered via `stellar.toml`, so egress must also allow the domains referenced by the federation addresses you use.

| Host | Port | Protocol | Purpose |
| --- | --- | --- | --- |
| `*.stellar.org` | 443 | HTTPS | Stellar-operated federation endpoints |
| Customer federation domains | 443 | HTTPS | Federation servers referenced by `stellar.toml` |

### GitHub API

When running on GHES, the action communicates with the GHES instance itself. Allowlist the GHES hostname and port.

| Host | Port | Protocol | Purpose |
| --- | --- | --- | --- |
| `<your-ghes-hostname>` | 443 | HTTPS | GHES API and web endpoints |

## DNS Requirements

All hostnames above must be resolvable from the GHES runner or the network segment where the action executes. If DNS resolution is blocked, the action will fail before any HTTP request is made.

## Proxy Configuration

If egress is routed through an HTTP(S) proxy, configure the standard proxy environment variables for the runner:

- `HTTPS_PROXY`
- `HTTP_PROXY`
- `NO_PROXY` (include the GHES hostname to avoid proxying internal traffic)

Do not embed credentials directly in workflow files. Use your platform's secret management to inject proxy credentials at runtime.

## TLS Requirements

Horizon and Friendbot endpoints present publicly trusted TLS certificates. If your GHES deployment uses a custom certificate authority for internal services, ensure the CA bundle is installed on the runner so TLS verification succeeds.

## Verifying Connectivity

From the runner host, confirm each endpoint is reachable before enabling the action. A successful TLS handshake and HTTP response indicates egress is correctly configured. If any endpoint is unreachable, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for symptom-to-cause mapping.

## Related Documentation

- [USAGE.md](./USAGE.md) — general usage and configuration
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — diagnosing connectivity and runtime failures
