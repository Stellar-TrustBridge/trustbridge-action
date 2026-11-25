# Troubleshooting

This guide covers common issues when running the TrustBridge action against GitHub Enterprise Server (GHES) and Stellar services.

## GHES egress blocks

Many GHES deployments run in restricted networks where outbound traffic is denied by default. When egress is blocked, the action fails with connection, DNS, or TLS errors that can look unrelated to networking. If you see any of the symptoms below, verify that the required egress hosts and ports are allowed. See [GHES_COMPATIBILITY.md](./GHES_COMPATIBILITY.md) for the full egress allowlist.

### Symptoms and likely egress causes

| Symptom | Likely cause |
| --- | --- |
| `dial tcp: i/o timeout` or `context deadline exceeded` when contacting Horizon | Outbound TCP to Horizon host/port blocked by firewall or security group |
| `no such host` or `server misbehaving` resolving `horizon*.stellar.org` | DNS egress blocked or internal resolver cannot reach public DNS |
| `x509: certificate signed by unknown authority` or `tls: handshake failure` | TLS inspection/proxy intercepting egress, or required CA not trusted |
| `connection refused` to Friendbot | Friendbot egress host/port not allowed |
| Federation lookup hangs or returns `lookup failed` | Federation endpoint egress blocked |
| `403 Forbidden` or `407 Proxy Authentication Required` from a proxy | Egress proxy requires allowlisting or credentials |

### Diagnosing egress blocks

1. Confirm the failing host and port from the action logs.
2. From the runner or GHES host, test connectivity to the host/port (for example with `curl -v` or `nc -vz`).
3. Check firewall, security group, and proxy allowlists against the egress requirements in [GHES_COMPATIBILITY.md](./GHES_COMPATIBILITY.md).
4. If a proxy is in use, ensure the proxy allows the required hosts and that the action is configured to use it.

### Related

- [GHES_COMPATIBILITY.md](./GHES_COMPATIBILITY.md) — required egress hosts and ports for Horizon, Friendbot, and federation.
- [USAGE.md](./USAGE.md) — configuration and usage details.
